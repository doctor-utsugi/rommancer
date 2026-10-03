/**
 * Obras multiplataforma con Wikidata (CC0): se guarda localmente el subconjunto de videojuegos de las
 * plataformas soportadas y se enlaza cada juego con su elemento por anclas exactas (ids de
 * RetroAchievements o ScreenScraper) o por coincidencia de nombre unica en la plataforma.
 */
import { Prisma } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import type { JobContext } from '../../lib/jobs.js';
import { normalizeTitle, parseRomName } from '../../lib/romname.js';
import { sleep } from './fetch.js';

export const WIKIDATA_PLATFORM: Record<string, string> = {
  nes: 'Q172742', fds: 'Q135321', snes: 'Q183259', gb: 'Q186437', gbc: 'Q203992', gba: 'Q188642', n64: 'Q184839', nds: 'Q170323', gc: 'Q182172', wii: 'Q8079',
  sms: 'Q209868', gg: 'Q751719', md: 'Q10676', psx: 'Q10677', ps2: 'Q10680', psp: 'Q170325', fbneo: 'Q192851', lynx: 'Q753657', a7800: 'Q753600',
};

async function sparql<T = Record<string, { value: string }>>(query: string): Promise<T[]> {
  const r = await fetch(env.wikidata.sparqlUrl, {
    method: 'POST',
    headers: { 'User-Agent': env.userAgent, Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ query }),
  });
  if (r.status === 429) throw new Error('Wikidata rate limit');
  if (!r.ok) throw new Error(`Wikidata HTTP ${r.status}`);
  const j = (await r.json()) as { results: { bindings: T[] } };
  return j.results.bindings;
}

const qid = (uri?: string) => (uri ? uri.split('/').pop()! : null);

/** Descarga (o actualiza) los videojuegos de una plataforma. */
export async function syncWikidataPlatform(slug: string, ctx?: JobContext) {
  const platform = WIKIDATA_PLATFORM[slug];
  if (!platform) return { items: 0, changed: 0 };
  const props = await sparql<Record<string, { value: string }>>(`
    SELECT ?g ?label (MIN(YEAR(?d)) AS ?year) (SAMPLE(?s) AS ?series) (SAMPLE(?f) AS ?franchise)
      (GROUP_CONCAT(DISTINCT ?ra; separator="|") AS ?ras) (GROUP_CONCAT(DISTINCT ?ss; separator="|") AS ?sss) (SAMPLE(?mod) AS ?modified)
    WHERE {
      ?g wdt:P400 wd:${platform} .
      OPTIONAL { ?g rdfs:label ?label FILTER(LANG(?label) = "en") }
      OPTIONAL { ?g wdt:P577 ?d } OPTIONAL { ?g wdt:P179 ?s } OPTIONAL { ?g wdt:P8345 ?f }
      OPTIONAL { ?g wdt:P11393 ?ra } OPTIONAL { ?g wdt:P7756 ?ss } OPTIONAL { ?g schema:dateModified ?mod }
    } GROUP BY ?g ?label`);
  await sleep(1000);
  const names = await sparql<Record<string, { value: string }>>(`
    SELECT ?g (GROUP_CONCAT(DISTINCT ?n; separator="|") AS ?names) WHERE {
      ?g wdt:P400 wd:${platform} .
      { ?g rdfs:label ?n } UNION { ?g skos:altLabel ?n }
      FILTER(LANG(?n) IN ("en", "ja", "es", "fr", "de", "it", "pt", "ko", "zh"))
    } GROUP BY ?g`);
  const nameMap = new Map(names.map((n) => [qid(n.g.value)!, n.names.value.split('|')]));
  const existing = new Map((await prisma.wikidataItem.findMany({ select: { qid: true, modified: true, platforms: true } })).map((i) => [i.qid, i]));
  let changed = 0;
  for (const p of props) {
    const id = qid(p.g.value)!;
    const modified = p.modified?.value ? new Date(p.modified.value) : null;
    const ex = existing.get(id);
    const platforms = [...new Set([...(((ex?.platforms as string[] | undefined) ?? []) as string[]), slug])];
    if (ex && ex.modified && modified && ex.modified.getTime() === modified.getTime() && platforms.length === (ex.platforms as string[]).length) continue;
    const data = {
      label: (p.label?.value ?? nameMap.get(id)?.[0] ?? id).slice(0, 255),
      names: nameMap.get(id) ?? [],
      platforms,
      year: p.year?.value ? Number(p.year.value) : null,
      seriesQid: qid(p.series?.value),
      franchiseQid: qid(p.franchise?.value),
      raIds: p.ras?.value ? p.ras.value.split('|').filter(Boolean) : [],
      ssIds: p.sss?.value ? p.sss.value.split('|').filter(Boolean) : [],
      modified,
      fetchedAt: new Date(),
    };
    await prisma.wikidataItem.upsert({ where: { qid: id }, create: { qid: id, ...data }, update: data });
    changed++;
  }
  ctx?.log(`wikidata ${slug}: ${props.length} items, ${changed} updated`);
  return { items: props.length, changed };
}

/** Etiquetas de sagas y franquicias referenciadas. */
export async function syncWikidataLabels() {
  const refs = await prisma.wikidataItem.findMany({ where: { OR: [{ seriesQid: { not: null } }, { franchiseQid: { not: null } }] }, select: { seriesQid: true, franchiseQid: true } });
  const known = new Set((await prisma.wikidataLabel.findMany({ select: { qid: true } })).map((l) => l.qid));
  const ids = [...new Set(refs.flatMap((r) => [r.seriesQid, r.franchiseQid]).filter((x): x is string => !!x && !known.has(x)))];
  for (let i = 0; i < ids.length; i += 200) {
    const rows = await sparql(`SELECT ?x ?l WHERE { VALUES ?x { ${ids.slice(i, i + 200).map((x) => `wd:${x}`).join(' ')} } ?x rdfs:label ?l FILTER(LANG(?l) = "en") }`);
    for (const r of rows) {
      const id = qid(r.x.value)!;
      await prisma.wikidataLabel.upsert({ where: { qid: id }, create: { qid: id, label: r.l.value.slice(0, 255) }, update: { label: r.l.value.slice(0, 255) } });
    }
    await sleep(1000);
  }
  return ids.length;
}

// Normalizacion que conserva escrituras no latinas (titulos japoneses)
const uniNorm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
const keysOf = (s: string) => [normalizeTitle(s).replace(/ /g, ''), uniNorm(s)].filter((k) => k.length > 1);

export interface WorkStats {
  linked: number;
  anchored: number;
  review: number;
  works: number;
}

/** Enlaza juegos con elementos de Wikidata y crea/actualiza las obras y sagas. */
export async function resolveWorks(systemId?: number, ctx?: JobContext): Promise<WorkStats> {
  const stats: WorkStats = { linked: 0, anchored: 0, review: 0, works: 0 };
  const systems = await prisma.system.findMany({ where: systemId ? { id: systemId } : {} });
  const rules = await prisma.groupingRule.findMany({ where: { kind: 'game-work' } });
  const labels = new Map((await prisma.wikidataLabel.findMany()).map((l) => [l.qid, l.label]));
  for (const system of systems) {
    const items = (await prisma.wikidataItem.findMany()).filter((i) => (i.platforms as string[]).includes(system.slug));
    if (!items.length) continue;
    const byName = new Map<string, typeof items>();
    for (const it of items)
      for (const n of new Set([(it.label as string), ...((it.names as string[]) ?? [])].flatMap(keysOf))) {
        const l = byName.get(n) ?? [];
        if (!l.includes(it)) l.push(it);
        byName.set(n, l);
      }
    const byRa = new Map<string, typeof items[number]>();
    const bySs = new Map<string, typeof items[number]>();
    for (const it of items) {
      for (const r of (it.raIds as string[]) ?? []) byRa.set(r, it);
      for (const s of (it.ssIds as string[]) ?? []) bySs.set(s, it);
    }
    const games = await prisma.game.findMany({
      where: { systemId: system.id, roms: { some: {} } },
      select: { id: true, title: true, releaseYear: true, ssGameId: true, wikidataId: true, roms: { select: { name: true, raGameId: true, localTitle: true } } },
    });
    for (const g of games) {
      const manual = rules.find((r) => r.rule === 'same' && r.aGameId === g.id && r.wikidataId);
      const rejected = new Set(rules.filter((r) => r.rule === 'different' && r.aGameId === g.id).map((r) => r.wikidataId));
      let target: string | null = manual?.wikidataId ?? null;
      let anchored = !!target;
      if (!target) {
        const ra = g.roms.map((r) => r.raGameId).find((x) => x && byRa.has(String(x)));
        const anchor = (ra ? byRa.get(String(ra)) : null) ?? (g.ssGameId ? bySs.get(String(g.ssGameId)) : null);
        if (anchor && !rejected.has(anchor.qid)) {
          target = anchor.qid;
          anchored = true;
        }
      }
      if (!target) {
        const names = new Set([g.title, ...g.roms.map((r) => parseRomName(r.name).title), ...g.roms.map((r) => r.localTitle).filter((x): x is string => !!x)].flatMap(keysOf));
        const cands = new Map<string, typeof items[number]>();
        for (const n of names) for (const it of byName.get(n) ?? []) if (!rejected.has(it.qid)) cands.set(it.qid, it);
        let list = [...cands.values()];
        if (g.releaseYear && list.length > 1) {
          const close = list.filter((it) => it.year && Math.abs(it.year - g.releaseYear!) <= 1);
          if (close.length) list = close;
        }
        // Con un solo candidato se toleran diferencias regionales de fecha (Japon suele salir antes)
        const yearClash = list.length === 1 && g.releaseYear && list[0].year && Math.abs(list[0].year - g.releaseYear) > 3;
        if (list.length === 1 && !yearClash) target = list[0].qid;
        else if (list.length > 1 || yearClash) {
          await prisma.reviewItem.upsert({
            where: { kind_key: { kind: 'wikidata', key: `game:${g.id}` } },
            create: { kind: 'wikidata', key: `game:${g.id}`, systemId: system.id, gameId: g.id, payload: { candidates: list.slice(0, 10).map((it) => ({ qid: it.qid, label: it.label, year: it.year })) } },
            update: { payload: { candidates: list.slice(0, 10).map((it) => ({ qid: it.qid, label: it.label, year: it.year })) } },
          });
          stats.review++;
        }
      }
      if (!target || target === g.wikidataId) continue;
      const it = items.find((x) => x.qid === target) ?? (await prisma.wikidataItem.findUnique({ where: { qid: target } }));
      const work =
        (await prisma.work.findUnique({ where: { wikidataId: target } })) ??
        (await prisma.work.create({ data: { wikidataId: target, title: (it?.label ?? g.title).slice(0, 255), releaseYear: it?.year ?? null } }));
      const fq = it?.franchiseQid ?? it?.seriesQid ?? null;
      if (fq && !work.franchiseId) {
        const fr =
          (await prisma.franchise.findUnique({ where: { wikidataId: fq } })) ??
          (await prisma.franchise.create({ data: { wikidataId: fq, name: (labels.get(fq) ?? fq).slice(0, 255) } }));
        await prisma.work.update({ where: { id: work.id }, data: { franchiseId: fr.id } });
      }
      await prisma.game.update({ where: { id: g.id }, data: { wikidataId: target, workId: work.id } });
      await prisma.reviewItem.updateMany({ where: { kind: 'wikidata', key: `game:${g.id}`, status: 'open' }, data: { status: 'auto', resolvedAt: new Date() } });
      stats.linked++;
      if (anchored) stats.anchored++;
    }
    ctx?.log(`works ${system.slug}: ${games.length} games`);
  }
  // Saga de libretro para obras sin saga de Wikidata
  const orphan = await prisma.game.findMany({ where: { franchiseName: { not: null }, work: { franchiseId: null } }, select: { workId: true, franchiseName: true } });
  for (const o of orphan) {
    if (!o.workId) continue;
    const fr = (await prisma.franchise.findFirst({ where: { name: o.franchiseName! } })) ?? (await prisma.franchise.create({ data: { name: o.franchiseName! } }));
    await prisma.work.update({ where: { id: o.workId }, data: { franchiseId: fr.id } });
  }
  stats.works = await prisma.work.count();
  return stats;
}

export type { Prisma };
