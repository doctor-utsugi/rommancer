/**
 * Semilla de datos para nuevos despliegues: DATs importados, hashes de RetroAchievements y
 * metadatos/multimedia scrapeados. Se exporta desde una instancia y se aplica al arrancar otra,
 * sin volver a descargar nada.
 *
 * SEED_DIR/
 *   dats/<fichero>.dat        DATs tal cual
 *   dats/manifest.json        [{ file, system, type }]
 *   ra.json                   { <slug>: [{ ID, Title, NumAchievements, ImageIcon, Hashes }] }
 *   games.json                [{ system, key, ...metadatos, media: [{ type, source, file, region }] }]
 *   media/<ruta>              ficheros multimedia (misma ruta relativa que DATA_DIR/media)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DatType, MediaType } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { enqueue, type JobContext } from '../../lib/jobs.js';
import { importDat } from '../dats/importer.js';
import { storeRaGames } from '../ra/routes.js';
import { rematchAll } from '../scanner/service.js';

interface ManifestEntry {
  file: string;
  system: string;
  type: DatType;
}

interface SeedGame {
  system: string;
  key: string;
  releaseYear: number | null;
  developer: string | null;
  publisher: string | null;
  genre: string | null;
  players: string | null;
  description: string | null;
  ssGameId: number | null;
  media: { type: MediaType; source: string; file: string; region: string | null }[];
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

export async function exportSeed(ctx?: JobContext) {
  const dir = env.seedDir;
  await fs.promises.mkdir(path.join(dir, 'dats'), { recursive: true });

  // DATs: se localiza el fichero por nombre o, si no consta, por sha1 entre los descargados
  const sources = await prisma.datSource.findMany({ include: { system: true } });
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
      ctx?.log(`DAT file not found for ${s.system.slug} ${s.type} "${s.name}"`);
      continue;
    }
    await fs.promises.copyFile(path.join(env.datsDir, file), path.join(dir, 'dats', file));
    manifest.push({ file, system: s.system.slug, type: s.type });
  }
  await fs.promises.writeFile(path.join(dir, 'dats', 'manifest.json'), JSON.stringify(manifest, null, 1));

  // RetroAchievements
  const raGames = await prisma.raGame.findMany({ include: { system: { select: { slug: true } }, hashes: true } });
  const ra: Record<string, unknown[]> = {};
  for (const g of raGames)
    (ra[g.system.slug] ??= []).push({ ID: g.id, Title: g.title, NumAchievements: g.numAchievements, ImageIcon: g.imageIcon, Hashes: g.hashes.map((h) => h.hash) });
  await fs.promises.writeFile(path.join(dir, 'ra.json'), JSON.stringify(ra));

  // Metadatos y multimedia
  const games = await prisma.game.findMany({
    where: { OR: [{ scrapedAt: { not: null } }, { media: { some: {} } }] },
    include: { system: { select: { slug: true } }, media: true },
  });
  const out: SeedGame[] = [];
  let copied = 0;
  for (const [i, g] of games.entries()) {
    const media: SeedGame['media'] = [];
    for (const m of g.media) {
      const src = path.join(env.mediaDir, m.path);
      if (!(await exists(src))) continue;
      if (await copyIfMissing(src, path.join(dir, 'media', m.path))) copied++;
      media.push({ type: m.type, source: m.source, file: m.path, region: m.region });
    }
    out.push({
      system: g.system.slug,
      key: g.titleNormalized,
      releaseYear: g.releaseYear,
      developer: g.developer,
      publisher: g.publisher,
      genre: g.genre,
      players: g.players,
      description: g.description,
      ssGameId: g.ssGameId,
      media,
    });
    await ctx?.progress(i + 1, games.length, g.title);
  }
  await fs.promises.writeFile(path.join(dir, 'games.json'), JSON.stringify(out));
  const res = { dats: manifest.length, raGames: raGames.length, games: out.length, mediaCopied: copied, dir };
  ctx?.log(JSON.stringify(res));
  return res;
}

export async function applySeed(ctx?: JobContext) {
  const dir = env.seedDir;
  if (!(await exists(dir))) return { skipped: 'no seed dir' };
  const systems = new Map((await prisma.system.findMany()).map((s) => [s.slug, s]));
  const res = { datsImported: 0, datsSkipped: 0, raGames: 0, games: 0, media: 0 };

  // 1. DATs (los de hacks al final para enlazarlos con las roms base)
  const manifest = await readJson<ManifestEntry[]>(path.join(dir, 'dats', 'manifest.json'), []);
  manifest.sort((a, b) => Number(a.type === 'HACKS') - Number(b.type === 'HACKS'));
  for (const [i, m] of manifest.entries()) {
    const system = systems.get(m.system);
    const file = path.join(dir, 'dats', m.file);
    if (!system || !(await exists(file))) continue;
    const r = await importDat(await fs.promises.readFile(file, 'utf8'), { systemId: system.id, type: m.type, fileName: m.file });
    if (r.skipped) res.datsSkipped++;
    else {
      res.datsImported++;
      ctx?.log(`Imported ${m.file}`);
      // Copia de trabajo para futuras exportaciones
      await copyIfMissing(file, path.join(env.datsDir, m.file));
    }
    await ctx?.progress(i + 1, manifest.length, m.file);
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

  // 3. Metadatos y multimedia: solo se rellena lo que falta
  const seedGames = await readJson<SeedGame[]>(path.join(dir, 'games.json'), []);
  for (const sg of seedGames) {
    const s = systems.get(sg.system);
    if (!s) continue;
    const game = await prisma.game.findUnique({ where: { systemId_titleNormalized: { systemId: s.id, titleNormalized: sg.key } }, include: { media: true } });
    if (!game) continue;
    const data: Record<string, unknown> = {};
    for (const k of ['releaseYear', 'developer', 'publisher', 'genre', 'players', 'description', 'ssGameId'] as const)
      if (game[k] == null && sg[k] != null) data[k] = sg[k];
    if (Object.keys(data).length) {
      await prisma.game.update({ where: { id: game.id }, data: { ...data, scrapedAt: game.scrapedAt ?? new Date() } });
      res.games++;
    }
    for (const m of sg.media) {
      if (game.media.some((x) => x.type === m.type && x.source === m.source)) continue;
      const src = path.join(dir, 'media', m.file);
      if (!(await exists(src))) continue;
      // La ruta incluye el id del juego de la instancia original: se recoloca con el id local
      const rel = path.join(s.slug, String(game.id), path.basename(m.file));
      await copyIfMissing(src, path.join(env.mediaDir, rel));
      await prisma.media.create({ data: { gameId: game.id, type: m.type, source: m.source, path: rel, region: m.region } });
      res.media++;
    }
  }

  if (res.datsImported || res.raGames) await rematchAll();
  ctx?.log(JSON.stringify(res));
  return res;
}

/** Mantiene la semilla al dia tras importar DATs, sincronizar RA o scrapear. */
export async function scheduleSeedExport() {
  if (!env.seedAutoExport) return;
  const pending = await prisma.job.findFirst({ where: { type: 'seed-export', status: 'PENDING' } });
  if (!pending) await enqueue('seed-export', {});
}
