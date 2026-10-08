/**
 * Sincronizacion global de fuentes externas. Una sola tarea recorre las fuentes en secuencia y cada
 * una solo descarga lo que ha cambiado; al final se re-emparejan ficheros, se recalculan agrupaciones
 * y se exporta la semilla una vez.
 */
import fs from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { enqueue, registerJob, type JobContext } from '../../lib/jobs.js';
import { HttpError } from '../../lib/http.js';
import { normalizeTitle, parseRomName } from '../../lib/romname.js';
import { DAT_PRESETS } from '../dats/presets.js';
import { importDat } from '../dats/importer.js';
import { parseClrMameEntries } from '../dats/parser.js';
import { rematchAll } from '../scanner/service.js';
import { replaceRomEvidence, resolveRomGroups, type EvidenceInput } from '../grouping/service.js';
import { storeRaGames } from '../ra/routes.js';
import { exportSeed } from '../seed/service.js';
import { libretroThumbs } from '../scrape/service.js';
import { ownedGameIds } from '../roms/service.js';
import { applyMeta } from '../scrape/meta.js';
import { conditionalFetch, sleep } from './fetch.js';
import { resolveWorks, syncWikidataLabels, syncWikidataPlatform } from './wikidata.js';

export const SOURCES = ['libretro', 'retool', 'retroachievements', 'wikidata'] as const;
export type Source = (typeof SOURCES)[number];

const LIBRETRO_META = `${env.github.rawUrl}/libretro/libretro-database/master/metadat`;
const RETOOL = `${env.github.rawUrl}/unexpectedpanda/retool-clonelists-metadata/main`;

// Ficheros de Retool por sistema (clonelists y metadata comparten nombre)
const RETOOL_FILES: Record<string, string> = {
  nes: 'Nintendo - Nintendo Entertainment System (No-Intro)',
  fds: 'Nintendo - Family Computer Disk System (No-Intro)',
  snes: 'Nintendo - Super Nintendo Entertainment System (No-Intro)',
  gb: 'Nintendo - Game Boy (No-Intro)',
  gbc: 'Nintendo - Game Boy Color (No-Intro)',
  gba: 'Nintendo - Game Boy Advance (No-Intro)',
  n64: 'Nintendo - Nintendo 64 (No-Intro)',
  nds: 'Nintendo - Nintendo DS (No-Intro)',
  sms: 'Sega - Master System - Mark III (No-Intro)',
  gg: 'Sega - Game Gear (No-Intro)',
  md: 'Sega - Mega Drive - Genesis (No-Intro)',
  lynx: 'Atari - Atari Lynx (No-Intro)',
  a7800: 'Atari - Atari 7800 (No-Intro)',
  psx: 'Sony - PlayStation (Redump)',
  ps2: 'Sony - PlayStation 2 (Redump)',
  psp: 'Sony - PlayStation Portable (Redump)',
  gc: 'Nintendo - GameCube (Redump)',
  wii: 'Nintendo - Wii (Redump)',
};

const META_FIELDS: [string, 'developer' | 'publisher' | 'genre' | 'releaseYear' | 'players' | 'franchise'][] = [
  ['developer', 'developer'],
  ['publisher', 'publisher'],
  ['genre', 'genre'],
  ['releaseyear', 'releaseYear'],
  ['maxusers', 'players'],
  ['franchise', 'franchise'],
];

// --- libretro ---
async function syncLibretro(ctx: JobContext, systemSlug?: string, force = false) {
  const res = { dats: 0, metaGames: 0, thumbs: 0 };
  const systems = await prisma.system.findMany({ where: systemSlug ? { slug: systemSlug } : {} });
  const slugs = new Set(systems.map((s) => s.slug));
  for (const p of DAT_PRESETS.filter((x) => slugs.has(x.system))) {
    const fileName = `${p.type.toLowerCase()} - ${decodeURIComponent(p.url.split('/').pop()!)}`;
    const got = await conditionalFetch(`libretro:${p.id}`, p.url, force);
    if (!got) continue;
    await fs.promises.mkdir(env.datsDir, { recursive: true });
    await fs.promises.writeFile(path.join(env.datsDir, fileName), got.text);
    const sys = systems.find((s) => s.slug === p.system);
    try {
      const r = await importDat(got.text, { systemId: sys?.id, type: p.type, fileName, resolve: false });
      if (!r.skipped) res.dats++;
      ctx.log(`libretro DAT ${p.id}: ${r.skipped ? 'unchanged' : 'imported'}`);
    } catch (e) {
      // One bad DAT does not stop the rest; forgetting its ETag makes the next sync download it again
      await prisma.sourceState.deleteMany({ where: { key: `libretro:${p.id}` } });
      ctx.log(`libretro DAT ${p.id}: failed: ${e instanceof Error ? e.message.split('\n').filter(Boolean).pop() : e}`);
    }
  }
  // Metadatos: solo rellenan campos vacios o de menor prioridad
  for (const s of systems) {
    const romIndex = new Map((await prisma.rom.findMany({ where: { game: { systemId: s.id } }, select: { name: true, gameId: true } })).map((r) => [r.name, r.gameId]));
    const perGame = new Map<number, Record<string, string | number>>();
    for (const [dir, field] of META_FIELDS) {
      const got = await conditionalFetch(`libretro-meta:${dir}:${s.slug}`, `${LIBRETRO_META}/${dir}/${encodeURIComponent(s.datName)}.dat`, force);
      if (!got) continue;
      for (const e of parseClrMameEntries(got.text)) {
        const gameId = romIndex.get(e.comment);
        const value = e[dir];
        if (!gameId || !value) continue;
        const v = perGame.get(gameId) ?? {};
        if (v[field] == null) v[field] = field === 'releaseYear' ? Number(value) : value;
        perGame.set(gameId, v);
      }
      await sleep(200);
    }
    for (const [gameId, v] of perGame) {
      const { franchise, ...rest } = v;
      await applyMeta(gameId, 'libretro', rest as Record<string, string | number>);
      if (franchise) await prisma.game.updateMany({ where: { id: gameId, franchiseName: null }, data: { franchiseName: String(franchise).slice(0, 255) } });
      res.metaGames++;
    }
  }
  // Caratulas (portada, captura, titulo) de juegos que se tienen y no las tienen
  for (const s of systems) {
    const owned = [...(await ownedGameIds(s.id))];
    const games = await prisma.game.findMany({ where: { id: { in: owned }, media: { none: { type: 'COVER' } } }, include: { roms: { select: { id: true, name: true, regions: true } } } });
    for (const g of games) {
      const rom = g.roms[0] ?? null;
      const got = await libretroThumbs({
        gameId: g.id,
        system: s,
        rom: rom ? { id: rom.id, name: rom.name, regions: rom.regions as string[] } : null,
        part: null,
        altNames: g.roms.map((r) => r.name),
        title: g.title,
        missing: ['COVER', 'SCREENSHOT', 'TITLE'],
        regionPrefs: [],
        langPrefs: [],
      });
      res.thumbs += got.length;
    }
  }
  return res;
}

// --- Retool: listas de clones curadas y titulos locales ---
async function syncRetool(ctx: JobContext, systemSlug?: string, force = false) {
  const res = { systems: 0, evidence: 0, localTitles: 0 };
  const systems = await prisma.system.findMany({ where: systemSlug ? { slug: systemSlug } : {} });
  for (const s of systems) {
    const file = RETOOL_FILES[s.slug];
    if (!file) continue;
    const roms = await prisma.rom.findMany({ where: { game: { systemId: s.id } }, select: { id: true, name: true, localTitle: true } });
    const byTitle = new Map<string, number[]>();
    for (const r of roms) {
      const k = normalizeTitle(parseRomName(r.name).title);
      byTitle.set(k, [...(byTitle.get(k) ?? []), r.id]);
    }
    const cl = await conditionalFetch(`retool:clonelists:${s.slug}`, `${RETOOL}/clonelists/${encodeURIComponent(file)}.json`, force);
    if (cl) {
      const json = JSON.parse(cl.text) as { variants?: { group: string; titles: { searchTerm: string }[] }[] };
      const ev: EvidenceInput[] = [];
      for (const v of json.variants ?? []) {
        for (const t of v.titles ?? []) {
          for (const romId of byTitle.get(normalizeTitle(parseRomName(t.searchTerm).title)) ?? []) ev.push({ romId, systemId: s.id, key: `retool:${v.group}`, source: 'retool' });
        }
      }
      await replaceRomEvidence(s.id, 'retool', ev);
      await fs.promises.mkdir(path.join(env.dataDir, 'retool'), { recursive: true });
      await fs.promises.writeFile(path.join(env.dataDir, 'retool', `clonelist-${s.slug}.json`), cl.text);
      res.evidence += ev.length;
      res.systems++;
    }
    const md = await conditionalFetch(`retool:metadata:${s.slug}`, `${RETOOL}/metadata/${encodeURIComponent(file)}.json`, force);
    if (md) {
      const json = JSON.parse(md.text) as Record<string, { localName?: string; languages?: string[] }>;
      for (const r of roms) {
        const m = json[r.name];
        if (m?.localName && m.localName !== r.localTitle) {
          await prisma.rom.update({ where: { id: r.id }, data: { localTitle: m.localName.slice(0, 255) } });
          res.localTitles++;
        }
      }
      await fs.promises.writeFile(path.join(env.dataDir, 'retool', `metadata-${s.slug}.json`), md.text);
    }
    await sleep(200);
  }
  ctx.log(`retool: ${JSON.stringify(res)}`);
  return res;
}

// --- RetroAchievements: una llamada por consola con la clave global del admin ---
async function syncRetroAchievements(ctx: JobContext, systemSlug?: string) {
  if (!env.ra.apiKey) {
    ctx.log('RetroAchievements: RA_API_KEY no configurada');
    return { skipped: true };
  }
  const systems = await prisma.system.findMany({ where: { raConsoleId: { not: null }, ...(systemSlug ? { slug: systemSlug } : {}) } });
  const out: Record<string, unknown> = {};
  for (const s of systems) {
    const q = new URLSearchParams({ i: String(s.raConsoleId), h: '1', f: '1', y: env.ra.apiKey });
    const r = await fetch(`${env.ra.baseUrl}/API_GetGameList.php?${q}`, { headers: { 'User-Agent': env.userAgent } });
    if (r.status === 429) throw new Error('RetroAchievements rate limit');
    if (!r.ok) {
      ctx.log(`RA ${s.slug}: HTTP ${r.status}`);
      continue;
    }
    out[s.slug] = await storeRaGames(s.id, (await r.json()) as Parameters<typeof storeRaGames>[1]);
    ctx.log(`RA ${s.slug}: ${JSON.stringify(out[s.slug])}`);
    await sleep(2000);
  }
  return out;
}

export async function runExternalSync(ctx: JobContext, sources: Source[], systemSlug?: string, force = false) {
  const result: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const s of sources) {
    try {
      if (s === 'libretro') result.libretro = await syncLibretro(ctx, systemSlug, force);
      if (s === 'retool') result.retool = await syncRetool(ctx, systemSlug, force);
      if (s === 'retroachievements') result.retroachievements = await syncRetroAchievements(ctx, systemSlug);
      if (s === 'wikidata') {
        const systems = await prisma.system.findMany({ where: systemSlug ? { slug: systemSlug } : {} });
        const w: Record<string, unknown> = {};
        for (const sys of systems) {
          w[sys.slug] = await syncWikidataPlatform(sys.slug, ctx);
          await sleep(1500);
        }
        w.labels = await syncWikidataLabels();
        result.wikidata = w;
      }
    } catch (e) {
      errors[s] = e instanceof Error ? e.message : String(e);
      ctx.log(`ERROR ${s}: ${errors[s]}`);
    }
    await ctx.progress(sources.indexOf(s) + 1, sources.length + 1, s);
  }
  const system = systemSlug ? await prisma.system.findUnique({ where: { slug: systemSlug } }) : null;
  result.rematch = await rematchAll();
  result.groups = await resolveRomGroups(system?.id, ctx);
  result.works = await resolveWorks(system?.id, ctx);
  result.seed = await exportSeed(ctx);
  if (Object.keys(errors).length) result.errors = errors;
  return result;
}

registerJob('external-sync', async (ctx) => runExternalSync(ctx, (ctx.params.sources as Source[]) ?? [...SOURCES], ctx.params.system, !!ctx.params.force));
/** Sincronizacion forzada: no si ya hay una en curso ni si se forzo lo mismo hace menos del intervalo minimo. */
export async function forceSync(sources: Source[], system: string | undefined, userId: number) {
  const recent = await prisma.job.findMany({ where: { type: 'external-sync', createdAt: { gte: new Date(Date.now() - env.forceSyncMinMinutes * 60_000) } } });
  const running = await prisma.job.findFirst({ where: { type: 'external-sync', status: { in: ['PENDING', 'RUNNING'] } } });
  if (running) throw new HttpError(409, 'SYNC_RUNNING');
  const same = recent.find((j) => {
    const p = j.params as { sources?: string[]; system?: string };
    return (p.system ?? null) === (system ?? null) && (p.sources ?? []).some((x) => sources.includes(x as Source));
  });
  if (same) throw new HttpError(429, 'SYNC_TOO_SOON');
  return enqueue('external-sync', { sources, system, trigger: 'manual' }, userId);
}

export function startExternalSyncCron() {
  if (!env.externalSyncCron || !cron.validate(env.externalSyncCron)) return;
  cron.schedule(env.externalSyncCron, async () => {
    const running = await prisma.job.findFirst({ where: { type: 'external-sync', status: { in: ['PENDING', 'RUNNING'] } } });
    if (!running) await enqueue('external-sync', { sources: [...SOURCES], trigger: 'cron' });
  });
}
