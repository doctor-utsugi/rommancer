/**
 * Data seed for new deployments: everything obtained from external sources (cumulative, never deleted) and manual
 * decisions. Exported from one instance and applied at startup on another, without downloading anything again.
 *
 * SEED_DIR/
 *   dats/<file>.dat           DATs as is
 *   dats/manifest.json        [{ file, system, type, priority }]
 *   ra.json                   { <slug>: [{ ID, Title, NumAchievements, ImageIcon, Hashes }] }
 *   games.json                [{ system, roms, ...metadata, media: [{ type, source, file, region }] }]
 *   removed.json              roms no longer in their DAT (kept even if the source withdraws them)
 *   grouping.json             external evidence (Retool, ScreenScraper), manual rules and "not found"
 *   wikidata.json             local Wikidata subset (items and labels)
 *   patches/                  romhack patches + patches.json
 *   retool/                   Retool clone lists and metadata (frozen repository)
 *   media/<path>              images (same relative path as DATA_DIR/media)
 *   media-large/<path>        manuals and videos
 *
 * Games are identified by their rom names (ids and titles differ between instances).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DatType, MediaType, Prisma } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { enqueue, type JobContext } from '../../lib/jobs.js';
import { importDat } from '../dats/importer.js';
import { storeRaGames } from '../ra/routes.js';
import { rematchAll } from '../scanner/service.js';
import { addRomEvidence, resolveRomGroups, type EvidenceSource } from '../grouping/service.js';
import { normalizeTitle, parseRomName } from '../../lib/romname.js';

interface ManifestEntry {
  file: string;
  system: string;
  type: DatType;
  priority?: number;
}

interface SeedGame {
  system: string;
  // Before: normalized title. Now: the game's rom names
  key?: string;
  roms?: string[];
  releaseYear: number | null;
  developer: string | null;
  publisher: string | null;
  genre: string | null;
  players: string | null;
  description: string | null;
  ssGameId: number | null;
  tgdbGameId?: number | null;
  franchiseName?: string | null;
  metaSources?: Record<string, string> | null;
  media: { type: MediaType; source: string; file: string; region: string | null; language?: string | null }[];
}

interface SeedGrouping {
  evidence: { system: string; rom: string; key: string; source: string }[];
  romRules: { rule: string; a: string; b: string; system: string }[];
  workRules: { rule: string; system: string; rom: string; wikidataId: string | null }[];
  misses: { system: string; rom: string; source: string; at: string }[];
}

interface SeedRemovedRom {
  system: string;
  datType: DatType;
  datName: string;
  name: string;
  description: string | null;
  regions: string[];
  languages: string[];
  revision: string | null;
  flags: string[];
  isBios: boolean;
  serial: string | null;
  parentName: string | null;
  parts: { name: string; size: string; crc32: string | null; md5: string | null; sha1: string | null; headerlessSize: string | null; headerlessCrc: string | null; headerlessMd5: string | null; headerlessSha1: string | null }[];
}

interface SeedPatch {
  system: string;
  hack: string;
  format: string;
  file: string;
  sha1: string;
  baseRom: string | null;
  baseCrc32: string | null;
  targetCrc32: string | null;
  sourceUrl: string | null;
}

const exists = (p: string) => fs.promises.access(p).then(() => true, () => false);
const readJson = async <T>(p: string, fallback: T): Promise<T> => ((await exists(p)) ? (JSON.parse(await fs.promises.readFile(p, 'utf8')) as T) : fallback);
const sha1File = async (p: string) => crypto.createHash('sha1').update(await fs.promises.readFile(p)).digest('hex');

async function copyIfMissing(src: string, dest: string) {
  if (await exists(dest)) return false;
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.copyFile(src, dest);
  return true;
}

// Manuals and videos go to media-large (relative path in DATA_DIR/media: large/...)
const seedMediaPath = (dir: string, rel: string) => (rel.startsWith('large' + path.sep) || rel.startsWith('large/') ? path.join(dir, 'media-large', rel.slice(6)) : path.join(dir, 'media', rel));

// Roms of DAT games (not user uploads) as a stable identifier
async function romNamesByGame(gameIds: number[]) {
  const map = new Map<number, string[]>();
  for (let i = 0; i < gameIds.length; i += 5000) {
    const roms = await prisma.rom.findMany({ where: { gameId: { in: gameIds.slice(i, i + 5000) }, datSource: { type: { not: 'USER' } } }, select: { gameId: true, name: true }, orderBy: { id: 'asc' } });
    for (const r of roms) map.set(r.gameId, [...(map.get(r.gameId) ?? []), r.name]);
  }
  return map;
}

export async function exportSeed(ctx?: JobContext) {
  const dir = env.seedDir;
  await fs.promises.mkdir(path.join(dir, 'dats'), { recursive: true });

  // DATs: the file is found by name or, if absent, by sha1 among those downloaded
  const sources = await prisma.datSource.findMany({ where: { type: { not: 'USER' } }, include: { system: true } });
  const datFiles = (await fs.promises.readdir(env.datsDir).catch(() => [] as string[])).filter((f) => /\.(dat|xml)$/i.test(f));
  const bySha: Map<string, string> = new Map();
  const manifest: ManifestEntry[] = [];
  for (const s of sources) {
    let file = s.fileName && datFiles.includes(path.basename(s.fileName)) ? path.basename(s.fileName) : null;
    if (!file) {
      if (!bySha.size) for (const f of datFiles) bySha.set(await sha1File(path.join(env.datsDir, f)), f);
      file = bySha.get(s.fileSha1) ?? null;
    }
    if (!file) {
      // It may already be in the seed (applied from another instance)
      if (s.fileName && (await exists(path.join(dir, 'dats', path.basename(s.fileName))))) file = path.basename(s.fileName);
      else {
        ctx?.log(`DAT file not found for ${s.system.slug} ${s.type} "${s.name}"`);
        continue;
      }
    } else await fs.promises.copyFile(path.join(env.datsDir, file), path.join(dir, 'dats', file));
    manifest.push({ file, system: s.system.slug, type: s.type, priority: s.priority });
  }
  await fs.promises.writeFile(path.join(dir, 'dats', 'manifest.json'), JSON.stringify(manifest, null, 1));

  // Roms withdrawn from their source: the current DAT no longer carries them
  const removedRoms = await prisma.rom.findMany({
    where: { removedFromSource: true, datSource: { type: { not: 'USER' } } },
    include: { parts: true, datSource: { select: { type: true, name: true } }, game: { select: { system: { select: { slug: true } } } } },
  });
  const removed: SeedRemovedRom[] = removedRoms.map((r) => ({
    system: r.game.system.slug,
    datType: r.datSource.type,
    datName: r.datSource.name,
    name: r.name,
    description: r.description,
    regions: r.regions as string[],
    languages: r.languages as string[],
    revision: r.revision,
    flags: r.flags as string[],
    isBios: r.isBios,
    serial: r.serial,
    parentName: r.parentName,
    parts: r.parts.map((p) => ({ name: p.name, size: String(p.size), crc32: p.crc32, md5: p.md5, sha1: p.sha1, headerlessSize: p.headerlessSize != null ? String(p.headerlessSize) : null, headerlessCrc: p.headerlessCrc, headerlessMd5: p.headerlessMd5, headerlessSha1: p.headerlessSha1 })),
  }));
  await fs.promises.writeFile(path.join(dir, 'removed.json'), JSON.stringify(removed));

  // RetroAchievements
  const raGames = await prisma.raGame.findMany({ include: { system: { select: { slug: true } }, hashes: true }, orderBy: { id: 'asc' } });
  const ra: Record<string, unknown[]> = {};
  for (const g of raGames)
    (ra[g.system.slug] ??= []).push({ ID: g.id, Title: g.title, NumAchievements: g.numAchievements, ImageIcon: g.imageIcon, Hashes: g.hashes.map((h) => h.hash) });
  await fs.promises.writeFile(path.join(dir, 'ra.json'), JSON.stringify(ra));

  // Metadata and media
  const games = await prisma.game.findMany({
    where: { OR: [{ scrapedAt: { not: null } }, { media: { some: {} } }, { developer: { not: null } }, { releaseYear: { not: null } }, { genre: { not: null } }, { franchiseName: { not: null } }, { tgdbGameId: { not: null } }] },
    include: { system: { select: { slug: true } }, media: true },
    orderBy: { id: 'asc' },
  });
  const names = await romNamesByGame(games.map((g) => g.id));
  const out: SeedGame[] = [];
  let copied = 0;
  for (const [i, g] of games.entries()) {
    const roms = names.get(g.id);
    if (!roms?.length) continue;
    const media: SeedGame['media'] = [];
    for (const m of g.media) {
      const src = path.join(env.mediaDir, m.path);
      if (!(await exists(src))) continue;
      if (await copyIfMissing(src, seedMediaPath(dir, m.path))) copied++;
      media.push({ type: m.type, source: m.source, file: m.path, region: m.region, language: m.language });
    }
    out.push({
      system: g.system.slug,
      roms,
      releaseYear: g.releaseYear,
      developer: g.developer,
      publisher: g.publisher,
      genre: g.genre,
      players: g.players,
      description: g.description,
      ssGameId: g.ssGameId,
      tgdbGameId: g.tgdbGameId,
      franchiseName: g.franchiseName,
      metaSources: (g.metaSources as Record<string, string> | null) ?? null,
      media,
    });
    if (i % 200 === 0) await ctx?.progress(i + 1, games.length, g.title);
  }
  await fs.promises.writeFile(path.join(dir, 'games.json'), JSON.stringify(out));

  // Grouping: evidence that cannot be regenerated from DATs, and manual decisions
  const romName = new Map<number, { name: string; slug: string }>();
  const loadRoms = async (ids: number[]) => {
    const missing = [...new Set(ids)].filter((id) => !romName.has(id));
    for (let i = 0; i < missing.length; i += 5000)
      for (const r of await prisma.rom.findMany({ where: { id: { in: missing.slice(i, i + 5000) } }, select: { id: true, name: true, game: { select: { system: { select: { slug: true } } } } } }))
        romName.set(r.id, { name: r.name, slug: r.game.system.slug });
  };
  const evidence = await prisma.groupingEvidence.findMany({ where: { kind: 'rom-game', source: { in: ['retool', 'screenscraper', 'manual'] } } });
  const rules = await prisma.groupingRule.findMany();
  const misses = await prisma.scrapeMiss.findMany();
  const missRoms = await prisma.rom.findMany({ where: { gameId: { in: misses.map((m) => m.gameId) } }, select: { id: true, gameId: true }, orderBy: { id: 'asc' } });
  const gameRom = new Map<number, number>();
  for (const r of missRoms) if (!gameRom.has(r.gameId)) gameRom.set(r.gameId, r.id);
  const ruleGames = rules.filter((r) => r.aGameId).map((r) => r.aGameId!);
  for (const r of await prisma.rom.findMany({ where: { gameId: { in: ruleGames } }, select: { id: true, gameId: true }, orderBy: { id: 'asc' } })) if (!gameRom.has(r.gameId)) gameRom.set(r.gameId, r.id);
  await loadRoms([...evidence.map((e) => e.romId!).filter(Boolean), ...rules.flatMap((r) => [r.aRomId, r.bRomId]).filter((x): x is number => !!x), ...gameRom.values()]);
  const grouping: SeedGrouping = {
    evidence: evidence.filter((e) => e.romId && romName.has(e.romId)).map((e) => ({ system: romName.get(e.romId!)!.slug, rom: romName.get(e.romId!)!.name, key: e.key, source: e.source })),
    romRules: rules
      .filter((r) => r.kind === 'rom-game' && r.aRomId && r.bRomId && romName.has(r.aRomId) && romName.has(r.bRomId))
      .map((r) => ({ rule: r.rule, a: romName.get(r.aRomId!)!.name, b: romName.get(r.bRomId!)!.name, system: romName.get(r.aRomId!)!.slug })),
    workRules: rules
      .filter((r) => r.kind === 'game-work' && r.aGameId && gameRom.has(r.aGameId))
      .map((r) => ({ rule: r.rule, system: romName.get(gameRom.get(r.aGameId!)!)!.slug, rom: romName.get(gameRom.get(r.aGameId!)!)!.name, wikidataId: r.wikidataId })),
    misses: misses.filter((m) => gameRom.has(m.gameId)).map((m) => ({ system: romName.get(gameRom.get(m.gameId)!)!.slug, rom: romName.get(gameRom.get(m.gameId)!)!.name, source: m.source, at: m.at.toISOString() })),
  };
  await fs.promises.writeFile(path.join(dir, 'grouping.json'), JSON.stringify(grouping));

  // Wikidata
  const wdItems = await prisma.wikidataItem.findMany({ orderBy: { qid: 'asc' } });
  if (wdItems.length) {
    const labels = await prisma.wikidataLabel.findMany({ orderBy: { qid: 'asc' } });
    await fs.promises.writeFile(path.join(dir, 'wikidata.json'), JSON.stringify({ items: wdItems, labels }));
  }

  // Patches
  const patches = await prisma.romPatch.findMany({ include: { hack: { include: { game: { include: { system: true } } } } } });
  const seedPatches: SeedPatch[] = [];
  const baseNames = new Map((await prisma.rom.findMany({ where: { id: { in: patches.map((p) => p.baseRomId).filter((x): x is number => !!x) } }, select: { id: true, name: true } })).map((r) => [r.id, r.name]));
  for (const p of patches) {
    const src = path.join(env.patchesDir, p.path);
    if (!(await exists(src))) continue;
    await copyIfMissing(src, path.join(dir, 'patches', p.path));
    seedPatches.push({ system: p.hack.game.system.slug, hack: p.hack.title, format: p.format, file: p.path, sha1: p.sha1, baseRom: p.baseRomId ? baseNames.get(p.baseRomId) ?? null : null, baseCrc32: p.baseCrc32, targetCrc32: p.targetCrc32, sourceUrl: p.sourceUrl });
  }
  if (seedPatches.length) await fs.promises.writeFile(path.join(dir, 'patches', 'patches.json'), JSON.stringify(seedPatches, null, 1));

  // Retool (frozen): copy of what was downloaded
  const retoolDir = path.join(env.dataDir, 'retool');
  for (const f of await fs.promises.readdir(retoolDir).catch(() => [] as string[])) {
    await fs.promises.mkdir(path.join(dir, 'retool'), { recursive: true });
    await fs.promises.copyFile(path.join(retoolDir, f), path.join(dir, 'retool', f));
  }

  const res = { dats: manifest.length, removed: removed.length, raGames: raGames.length, games: out.length, mediaCopied: copied, evidence: grouping.evidence.length, wikidata: wdItems.length, patches: seedPatches.length, dir };
  ctx?.log(JSON.stringify(res));
  return res;
}

export async function applySeed(ctx?: JobContext) {
  const dir = env.seedDir;
  if (!(await exists(dir))) return { skipped: 'no seed dir' };
  const systems = new Map((await prisma.system.findMany()).map((s) => [s.slug, s]));
  const res = { datsImported: 0, datsSkipped: 0, removed: 0, raGames: 0, games: 0, media: 0, evidence: 0, wikidata: 0, patches: 0 };

  // 1. DATs (by priority, hacks last so they link to the base roms)
  const manifest = await readJson<ManifestEntry[]>(path.join(dir, 'dats', 'manifest.json'), []);
  manifest.sort((a, b) => Number(a.type === 'HACKS') - Number(b.type === 'HACKS') || (a.priority ?? 0) - (b.priority ?? 0));
  const touched = new Set<number>();
  for (const [i, m] of manifest.entries()) {
    const system = systems.get(m.system);
    const file = path.join(dir, 'dats', m.file);
    if (!system || !(await exists(file))) continue;
    const r = await importDat(await fs.promises.readFile(file, 'utf8'), { systemId: system.id, type: m.type, fileName: m.file, priority: m.priority ?? 0, resolve: false });
    if (r.skipped) res.datsSkipped++;
    else {
      res.datsImported++;
      touched.add(system.id);
      ctx?.log(`Imported ${m.file}`);
      // Working copy for future exports
      await copyIfMissing(file, path.join(env.datsDir, m.file));
    }
    await ctx?.progress(i + 1, manifest.length, m.file);
  }

  // Roms withdrawn from their source that are not already there
  for (const r of await readJson<SeedRemovedRom[]>(path.join(dir, 'removed.json'), [])) {
    const system = systems.get(r.system);
    if (!system || (await prisma.rom.findFirst({ where: { name: r.name, game: { systemId: system.id } }, select: { id: true } }))) continue;
    const ds =
      (await prisma.datSource.findFirst({ where: { systemId: system.id, type: r.datType, name: r.datName } })) ??
      (await prisma.datSource.findFirst({ where: { systemId: system.id, type: r.datType } }));
    if (!ds) continue;
    const title = parseRomName(r.description ?? r.name).title.slice(0, 255);
    const key = normalizeTitle(title).slice(0, 255);
    const game = (await prisma.game.findFirst({ where: { systemId: system.id, titleNormalized: key } })) ?? (await prisma.game.create({ data: { systemId: system.id, title, titleNormalized: key } }));
    const { parts, system: _s, datType: _t, datName: _n, ...fields } = r;
    await prisma.rom.create({
      data: {
        ...fields,
        gameId: game.id,
        datSourceId: ds.id,
        removedFromSource: true,
        parts: { create: parts.map((p) => ({ ...p, size: BigInt(p.size), headerlessSize: p.headerlessSize != null ? BigInt(p.headerlessSize) : null })) },
      },
    });
    touched.add(system.id);
    res.removed++;
  }

  // 2. RetroAchievements
  const ra = await readJson<Record<string, Parameters<typeof storeRaGames>[1]>>(path.join(dir, 'ra.json'), {});
  for (const [slug, games] of Object.entries(ra)) {
    const s = systems.get(slug);
    if (!s || !games.length) continue;
    const known = await prisma.raGame.count({ where: { systemId: s.id } });
    if (known >= games.length) continue;
    res.raGames += (await storeRaGames(s.id, games)).games;
  }

  // Index rom name -> rom (per system)
  const romIndex = new Map<string, { id: number; gameId: number }>();
  for (const r of await prisma.rom.findMany({ select: { id: true, gameId: true, name: true, game: { select: { system: { select: { slug: true } } } } } })) romIndex.set(`${r.game.system.slug}|${r.name}`, { id: r.id, gameId: r.gameId });
  const romOf = (slug: string, name: string) => romIndex.get(`${slug}|${name}`);

  // 3. Grouping: external evidence and manual rules, before resolving
  const grouping = await readJson<SeedGrouping | null>(path.join(dir, 'grouping.json'), null);
  if (grouping) {
    const ev = grouping.evidence
      .map((e) => ({ r: romOf(e.system, e.rom), e }))
      .filter((x) => x.r)
      .map((x) => ({ romId: x.r!.id, systemId: systems.get(x.e.system)!.id, key: x.e.key, source: x.e.source as EvidenceSource }));
    await addRomEvidence(ev);
    res.evidence = ev.length;
    for (const r of grouping.romRules) {
      const a = romOf(r.system, r.a);
      const b = romOf(r.system, r.b);
      if (!a || !b) continue;
      if (await prisma.groupingRule.findFirst({ where: { kind: 'rom-game', OR: [{ aRomId: a.id, bRomId: b.id }, { aRomId: b.id, bRomId: a.id }] } })) continue;
      await prisma.groupingRule.create({ data: { kind: 'rom-game', rule: r.rule, aRomId: a.id, bRomId: b.id } });
    }
    for (const s of systems.values()) touched.add(s.id);
  }
  for (const id of touched) await resolveRomGroups(id);

  // After resolving, the games are the final ones
  for (const r of await prisma.rom.findMany({ select: { id: true, gameId: true, name: true, game: { select: { system: { select: { slug: true } } } } } })) romIndex.set(`${r.game.system.slug}|${r.name}`, { id: r.id, gameId: r.gameId });
  if (grouping) {
    for (const w of grouping.workRules) {
      const r = romOf(w.system, w.rom);
      if (!r || (await prisma.groupingRule.findFirst({ where: { kind: 'game-work', aGameId: r.gameId, wikidataId: w.wikidataId } }))) continue;
      await prisma.groupingRule.create({ data: { kind: 'game-work', rule: w.rule, aGameId: r.gameId, wikidataId: w.wikidataId } });
    }
    for (const m of grouping.misses) {
      const r = romOf(m.system, m.rom);
      if (!r) continue;
      await prisma.scrapeMiss.upsert({ where: { gameId_source: { gameId: r.gameId, source: m.source } }, create: { gameId: r.gameId, source: m.source, at: new Date(m.at) }, update: {} });
    }
  }

  // 4. Metadata and media: only what is missing is filled
  const seedGames = await readJson<SeedGame[]>(path.join(dir, 'games.json'), []);
  for (const sg of seedGames) {
    const s = systems.get(sg.system);
    if (!s) continue;
    let gameId: number | undefined;
    for (const n of sg.roms ?? []) {
      gameId = romOf(sg.system, n)?.gameId;
      if (gameId) break;
    }
    if (!gameId && sg.key) gameId = (await prisma.game.findFirst({ where: { systemId: s.id, titleNormalized: sg.key }, orderBy: { id: 'asc' } }))?.id;
    if (!gameId) continue;
    const game = await prisma.game.findUniqueOrThrow({ where: { id: gameId }, include: { media: true } });
    const data: Record<string, unknown> = {};
    for (const k of ['releaseYear', 'developer', 'publisher', 'genre', 'players', 'description', 'ssGameId', 'tgdbGameId', 'franchiseName'] as const)
      if (game[k] == null && sg[k] != null) data[k] = sg[k];
    if (sg.metaSources && !game.metaSources) data.metaSources = sg.metaSources;
    if (Object.keys(data).length) {
      await prisma.game.update({ where: { id: game.id }, data: { ...data, scrapedAt: game.scrapedAt ?? new Date() } });
      res.games++;
    }
    for (const m of sg.media) {
      if (game.media.some((x) => x.type === m.type && x.source === m.source)) continue;
      const src = seedMediaPath(dir, m.file);
      if (!(await exists(src))) continue;
      // The path includes the original instance's game id: relocated with the local id
      const large = m.file.startsWith('large/') || m.file.startsWith('large' + path.sep);
      const rel = path.join(...(large ? ['large'] : []), s.slug, String(game.id), path.basename(m.file));
      await copyIfMissing(src, path.join(env.mediaDir, rel));
      const size = (await fs.promises.stat(src)).size;
      await prisma.media.create({ data: { gameId: game.id, type: m.type, source: m.source, path: rel, region: m.region, language: m.language ?? null, size } });
      res.media++;
    }
  }

  // 5. Wikidata
  const wd = await readJson<{ items: Prisma.WikidataItemCreateManyInput[]; labels: Prisma.WikidataLabelCreateManyInput[] } | null>(path.join(dir, 'wikidata.json'), null);
  if (wd) {
    const known = await prisma.wikidataItem.count();
    if (known < wd.items.length) {
      for (let i = 0; i < wd.items.length; i += 1000) {
        const r = await prisma.wikidataItem.createMany({ data: wd.items.slice(i, i + 1000).map((x) => ({ ...x, modified: x.modified ? new Date(x.modified) : null, fetchedAt: x.fetchedAt ? new Date(x.fetchedAt) : undefined })), skipDuplicates: true });
        res.wikidata += r.count;
      }
      await prisma.wikidataLabel.createMany({ data: wd.labels, skipDuplicates: true });
    }
  }

  // 6. Patches
  const patches = await readJson<SeedPatch[]>(path.join(dir, 'patches', 'patches.json'), []);
  for (const p of patches) {
    if (await prisma.romPatch.findUnique({ where: { sha1: p.sha1 } })) continue;
    const s = systems.get(p.system);
    const hack = s ? await prisma.romHack.findFirst({ where: { title: p.hack, game: { systemId: s.id } } }) : null;
    if (!hack) continue;
    const src = path.join(dir, 'patches', p.file);
    if (!(await exists(src))) continue;
    await copyIfMissing(src, path.join(env.patchesDir, p.file));
    const base = p.baseRom ? romOf(p.system, p.baseRom) : null;
    await prisma.romPatch.create({ data: { hackId: hack.id, format: p.format, path: p.file, size: (await fs.promises.stat(src)).size, sha1: p.sha1, baseRomId: base?.id ?? null, baseCrc32: p.baseCrc32, targetCrc32: p.targetCrc32, sourceUrl: p.sourceUrl } });
    res.patches++;
  }

  // Retool: working copy
  for (const f of await fs.promises.readdir(path.join(dir, 'retool')).catch(() => [] as string[])) await copyIfMissing(path.join(dir, 'retool', f), path.join(env.dataDir, 'retool', f));

  if (res.datsImported || res.raGames) await rematchAll();
  if (res.wikidata) {
    const { resolveWorks } = await import('../sync/wikidata.js');
    await resolveWorks(undefined, ctx);
  }
  ctx?.log(JSON.stringify(res));
  return res;
}

/** Keeps the seed up to date after importing DATs, syncing RA or scraping. */
export async function scheduleSeedExport() {
  if (!env.seedAutoExport) return;
  const pending = await prisma.job.findFirst({ where: { type: 'seed-export', status: 'PENDING' } });
  if (!pending) await enqueue('seed-export', {});
}
