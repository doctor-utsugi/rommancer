import fs from 'node:fs';
import path from 'node:path';
import type { MatchStatus, RomPath, System } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { sha1 } from '../../lib/crypto.js';
import { hashFile, hashStream, type FileHashes } from '../../lib/hash.js';
import { parseCue } from '../../lib/cdreader.js';
import { raHashArcade, raHashFile, raHashFromHashes, raHashGamecubeFrom, raHashWiiFrom } from '../../lib/rahash.js';
import { RvzReader } from '../../lib/rvz.js';
import { normalizeTitle, parseRomName } from '../../lib/romname.js';
import { chdInfo, extractChd, extractEntryStream, extractEntryToFile, listArchive, tmpDir } from '../../lib/tools.js';
import type { JobContext } from '../../lib/jobs.js';
import { env } from '../../config/env.js';
import { ARCHIVE_EXTS, guessSystem, systemIndex, type SystemIndex } from './systems.js';

const SKIP_DIRS = new Set(['.git', 'media', 'images', 'videos', 'manuals', 'saves', 'states', '@eaDir', '#recycle']);

export async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  async function rec(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name.toLowerCase())) await rec(full);
      } else if (e.isFile()) out.push(full);
    }
  }
  await rec(root);
  return out.sort();
}

const REUSE_MIN_SIZE = 64 * 1024 * 1024;

/** Huella rapida: sha1 de tamano + primer y ultimo MiB. Identifica el fichero sin leerlo entero. */
export async function quickHash(file: string, size: number): Promise<string> {
  const fd = await fs.promises.open(file, 'r');
  try {
    const n = Math.min(size, 1 << 20);
    const head = Buffer.alloc(n);
    const tail = Buffer.alloc(n);
    await fd.read(head, 0, n, 0);
    await fd.read(tail, 0, n, size - n);
    return sha1(Buffer.concat([Buffer.from(String(size)), head, tail]));
  } finally {
    await fd.close();
  }
}

export const pathKey = (rel: string, entry?: string | null) => sha1(`${rel}\0${entry ?? ''}`);

interface MatchResult {
  status: MatchStatus;
  romPartId: number | null;
  romHackId: number | null;
  systemId: number | null;
}

export async function matchHashes(h: { sha1?: string | null; md5?: string | null; crc32: string; size: number; headerless?: { sha1: string; md5: string } }): Promise<MatchResult> {
  const sha1s = [h.sha1, h.headerless?.sha1].filter(Boolean) as string[];
  let part = null;
  if (sha1s.length) {
    part = await prisma.romPart.findFirst({
      where: { OR: [{ sha1: { in: sha1s } }, { headerlessSha1: { in: sha1s } }] },
      include: { rom: { include: { game: { select: { systemId: true } } } } },
      orderBy: { id: 'asc' },
    });
  }
  if (!part && h.md5) {
    part = await prisma.romPart.findFirst({
      where: { OR: [{ md5: h.md5 }, { headerlessMd5: h.md5 }], sha1: null },
      include: { rom: { include: { game: { select: { systemId: true } } } } },
    });
  }
  if (!part && !h.sha1) {
    part = await prisma.romPart.findFirst({
      where: { crc32: h.crc32, size: BigInt(h.size) },
      include: { rom: { include: { game: { select: { systemId: true } } } } },
    });
  }
  if (part) return { status: 'MATCHED', romPartId: part.id, romHackId: null, systemId: part.rom.game.systemId };
  if (sha1s.length || h.md5) {
    const hack = await prisma.romHack.findFirst({
      where: { OR: [...(sha1s.length ? [{ sha1: { in: sha1s } }] : []), ...(h.md5 ? [{ md5: h.md5 }] : [])] },
      include: { game: { select: { systemId: true } } },
    });
    if (hack) return { status: 'HACK', romPartId: null, romHackId: hack.id, systemId: hack.game.systemId };
  }
  return { status: 'UNKNOWN', romPartId: null, romHackId: null, systemId: null };
}

interface FileRow {
  archiveEntry: string | null;
  hashes: FileHashes | { size: number; crc32: string; md5: null; sha1: null; headerless?: undefined };
  raHash: string | null;
  systemId: number | null;
}

async function raForFile(system: System | null, h: FileHashes | null, file: string): Promise<string | null> {
  if (!system) return null;
  if (h) {
    const fromHashes = raHashFromHashes(system.slug, h);
    if (fromHashes) return fromHashes;
  }
  return raHashFile(system.slug, file);
}

/** Procesa un fichero en disco y devuelve una o varias filas (archivos comprimidos y CHD multi-pista). */
async function processFile(full: string, rel: string, idx: SystemIndex, forced: System | null, rootName: string, ctx?: JobContext): Promise<FileRow[]> {
  const ext = path.extname(full).toLowerCase();
  const guessRel = path.join(rootName, rel);
  const sys = guessSystem(idx, guessRel, forced);

  if (ARCHIVE_EXTS.has(ext)) {
    const entries = await listArchive(full);
    const arcade = sys?.mediaType === 'arcade' || (!sys && entries.length > 1 && entries.every((e) => !idx.byExt.has(path.extname(e.path).toLowerCase())));
    if (arcade) {
      const ra = raHashArcade(full);
      return entries.map((e) => ({
        archiveEntry: e.path,
        hashes: { size: e.size, crc32: e.crc32 ?? '00000000', md5: null, sha1: null },
        raHash: ra,
        systemId: sys?.id ?? null,
      }));
    }
    const rows: FileRow[] = [];
    for (const e of entries) {
      const esys = guessSystem(idx, guessRel, forced, e.path);
      const h = await hashStream(extractEntryStream(full, e.path), esys?.headerType ?? 'none', e.size);
      let ra = esys ? raHashFromHashes(esys.slug, h) : null;
      if (!ra && esys && ['n64', 'nds', 'gc', 'wii', 'psx', 'ps2', 'psp'].includes(esys.slug)) {
        const dir = await tmpDir('ra');
        try {
          const out = path.join(dir, path.basename(e.path));
          await extractEntryToFile(full, e.path, out);
          ra = await raHashFile(esys.slug, out);
        } finally {
          await fs.promises.rm(dir, { recursive: true, force: true });
        }
      }
      rows.push({ archiveEntry: e.path, hashes: h, raHash: ra, systemId: esys?.id ?? null });
    }
    return rows;
  }

  if (ext === '.chd') {
    const info = await chdInfo(full);
    const dir = await tmpDir('chd');
    try {
      ctx?.log(`Extracting CHD ${rel}`);
      const out = await extractChd(full, dir, info);
      const rows: FileRow[] = [];
      let ra: string | null = null;
      if (sys) ra = await raHashFile(sys.slug, out);
      if (out.endsWith('.cue')) {
        const cue = await parseCue(out);
        for (const f of cue.files) rows.push({ archiveEntry: path.basename(f), hashes: await hashFile(f), raHash: null, systemId: sys?.id ?? null });
      } else {
        rows.push({ archiveEntry: path.basename(out), hashes: await hashFile(out), raHash: null, systemId: sys?.id ?? null });
      }
      if (!ra && !sys) {
        // Sistema desconocido: se prueban los algoritmos de disco tras el emparejado
        rows[0].raHash = null;
      } else rows[0].raHash = ra;
      return rows;
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  }

  if (ext === '.rvz' || ext === '.wia') {
    // Se reconstruye la ISO original en memoria por bloques para obtener los hashes de Redump
    const r = await RvzReader.open(full);
    try {
      ctx?.log(`Rebuilding ${rel} (${r.discType === 2 ? 'Wii' : 'GameCube'}, ${r.isoSize} bytes)`);
      const h = await r.hashIso();
      const discSys = sys ?? idx.bySlug.get(r.discType === 2 ? 'wii' : 'gc') ?? null;
      const readAt = (pos: number, len: number) => r.read(pos, len);
      const ra = discSys?.slug === 'gc' ? await raHashGamecubeFrom(readAt) : discSys?.slug === 'wii' ? await raHashWiiFrom(readAt) : null;
      return [{ archiveEntry: null, hashes: h, raHash: ra, systemId: discSys?.id ?? null }];
    } finally {
      await r.close();
    }
  }

  const h = await hashFile(full, sys?.headerType ?? 'none');
  let ra: string | null = null;
  if (ext !== '.bin' || !sys || sys.mediaType !== 'disc') ra = await raForFile(sys, h, full);
  return [{ archiveEntry: null, hashes: h, raHash: ra, systemId: sys?.id ?? null }];
}

export async function scanPath(romPathId: number, ctx?: JobContext, force = false) {
  const rp = await prisma.romPath.findUniqueOrThrow({ where: { id: romPathId } });
  const idx = await systemIndex();
  const forced = rp.systemId ? idx.byId.get(rp.systemId) ?? null : null;
  await fs.promises.mkdir(env.tmpDir, { recursive: true });
  const files = (await walk(rp.path)).filter((f) => idx.allExts.has(path.extname(f).toLowerCase()));
  ctx?.log(`${files.length} candidate files in ${rp.path}`);

  const existing = await prisma.romFile.findMany({ where: { romPathId }, select: { id: true, relativePath: true, fileSize: true, mtimeMs: true } });
  const byRel = new Map<string, typeof existing>();
  for (const e of existing) {
    const list = byRel.get(e.relativePath) ?? [];
    list.push(e);
    byRel.set(e.relativePath, list);
  }
  const seen = new Set<string>();
  const stats = { files: files.length, hashed: 0, skipped: 0, reused: 0, matched: 0, hacks: 0, unknown: 0, errors: 0 };
  const rootName = path.basename(rp.path);

  for (const [i, full] of files.entries()) {
    const rel = path.relative(rp.path, full);
    seen.add(rel);
    const st = await fs.promises.stat(full);
    const prev = byRel.get(rel);
    if (!force && prev?.length && prev.every((p) => Number(p.mtimeMs) === Math.floor(st.mtimeMs) && Number(p.fileSize) === st.size)) {
      stats.skipped++;
      await ctx?.progress(i + 1, files.length, rel);
      continue;
    }
    try {
      const qh = await quickHash(full, st.size);
      // Fichero grande ya hasheado en otra ruta o con otro nombre (movido o renombrado conserva la fecha):
      // se reutilizan sus hashes. Los pequenos se hashean siempre, es mas barato que arriesgarse.
      const known =
        st.size > REUSE_MIN_SIZE && !force
          ? await prisma.romFile.findFirst({
              where: { quickHash: qh, fileSize: BigInt(st.size), mtimeMs: BigInt(Math.floor(st.mtimeMs)) },
              select: { romPathId: true, relativePath: true },
            })
          : null;
      if (known) {
        const rows = await prisma.romFile.findMany({ where: { romPathId: known.romPathId, relativePath: known.relativePath } });
        if (prev?.length) await prisma.romFile.deleteMany({ where: { id: { in: prev.map((p) => p.id) } } });
        for (const { id: _id, romPathId: _rp, pathKey: _pk, relativePath: _rel, scannedAt: _s, ...data } of rows) {
          await prisma.romFile.create({ data: { ...data, romPathId, relativePath: rel, pathKey: pathKey(rel, data.archiveEntry) } });
          if (data.status === 'MATCHED') stats.matched++;
          else if (data.status === 'HACK') stats.hacks++;
          else stats.unknown++;
        }
        stats.reused++;
        await ctx?.progress(i + 1, files.length, rel);
        continue;
      }
      const rows = await processFile(full, rel, idx, forced, rootName, ctx);
      if (prev?.length) await prisma.romFile.deleteMany({ where: { id: { in: prev.map((p) => p.id) } } });
      for (const r of rows) {
        const m = await matchHashes(r.hashes as FileHashes);
        let raHash = r.raHash;
        const systemId = m.systemId ?? r.systemId;
        // Si el sistema solo se conoce tras emparejar, se calcula el hash RA ahora
        if (!raHash && m.systemId && !r.systemId && !r.archiveEntry) {
          raHash = await raForFile(idx.byId.get(m.systemId) ?? null, r.hashes.md5 ? (r.hashes as FileHashes) : null, full);
        }
        await prisma.romFile.create({
          data: {
            romPathId,
            pathKey: pathKey(rel, r.archiveEntry),
            relativePath: rel,
            archiveEntry: r.archiveEntry,
            size: BigInt(r.hashes.size),
            fileSize: BigInt(st.size),
            quickHash: qh,
            mtimeMs: BigInt(Math.floor(st.mtimeMs)),
            crc32: r.hashes.crc32,
            md5: r.hashes.md5,
            sha1: r.hashes.sha1,
            headerlessCrc: r.hashes.headerless?.crc32 ?? null,
            headerlessMd5: r.hashes.headerless?.md5 ?? null,
            headerlessSha1: r.hashes.headerless?.sha1 ?? null,
            raHash,
            systemId,
            status: m.status,
            romPartId: m.romPartId,
            romHackId: m.romHackId,
          },
        });
        if (m.status === 'MATCHED') stats.matched++;
        else if (m.status === 'HACK') stats.hacks++;
        else stats.unknown++;
      }
      stats.hashed++;
    } catch (e) {
      stats.errors++;
      ctx?.log(`Error in ${rel}: ${e instanceof Error ? e.message : e}`);
    }
    await ctx?.progress(i + 1, files.length, rel);
  }

  const gone = existing.filter((e) => !seen.has(e.relativePath)).map((e) => e.id);
  if (gone.length) await prisma.romFile.deleteMany({ where: { id: { in: gone } } });
  const linked = await autoLinkHacks(romPathId);
  await linkRaGames();
  await prisma.romPath.update({ where: { id: romPathId }, data: { lastScanAt: new Date() } });
  const res = { ...stats, removed: gone.length, hacksLinked: linked };
  ctx?.log(JSON.stringify(res));
  return res;
}

/**
 * Ficheros desconocidos con marcas de hack o traduccion ([T+Spa], (Hack), [h1]) se registran como romhacks
 * del juego cuyo titulo coincide, usando el hash del propio fichero.
 */
export async function autoLinkHacks(romPathId?: number): Promise<number> {
  const unknown = await prisma.romFile.findMany({ where: { status: 'UNKNOWN', ...(romPathId ? { romPathId } : {}), sha1: { not: null } } });
  let linked = 0;
  for (const f of unknown) {
    const name = path.basename(f.archiveEntry ?? f.relativePath);
    const p = parseRomName(name);
    if (!p.hack) continue;
    // "Super Mario Bros. 3 - Mario Adventure (Hack)" -> se prueba tambien "Super Mario Bros. 3"
    const titles = [p.title];
    const segs = p.title.split(' - ');
    for (let i = segs.length - 1; i > 0; i--) titles.push(segs.slice(0, i).join(' - '));
    let game = null;
    for (const t of titles) {
      game = await prisma.game.findFirst({ where: { titleNormalized: normalizeTitle(t), ...(f.systemId ? { systemId: f.systemId } : {}) } });
      if (game) break;
    }
    if (!game) continue;
    const hack =
      (await prisma.romHack.findFirst({ where: { sha1: f.sha1 } })) ??
      (await prisma.romHack.create({
        data: {
          gameId: game.id,
          type: p.hack.type,
          title: name.replace(/\.[^.]+$/, '').slice(0, 255),
          author: p.hack.author?.slice(0, 255) ?? null,
          version: p.hack.version ?? null,
          language: p.hack.language ?? null,
          size: f.size,
          crc32: f.crc32,
          md5: f.md5,
          sha1: f.sha1,
        },
      }));
    await prisma.romFile.update({ where: { id: f.id }, data: { status: 'HACK', romHackId: hack.id, systemId: game.systemId } });
    linked++;
  }
  return linked;
}

/** Re-empareja todos los ficheros contra la base de datos (tras importar un DAT). */
export async function rematchAll(): Promise<{ matched: number; hacks: number }> {
  const before = await prisma.romFile.count({ where: { status: { in: ['MATCHED', 'HACK'] } } });
  await prisma.$executeRaw`UPDATE RomFile f LEFT JOIN RomPart p ON p.id = f.romPartId SET f.status = 'UNKNOWN', f.romPartId = NULL WHERE f.status = 'MATCHED' AND p.id IS NULL`;
  await prisma.$executeRaw`UPDATE RomFile f LEFT JOIN RomHack h ON h.id = f.romHackId SET f.status = 'UNKNOWN', f.romHackId = NULL WHERE f.status = 'HACK' AND h.id IS NULL`;
  for (const [fcol, pcol] of [
    ['sha1', 'sha1'],
    ['sha1', 'headerlessSha1'],
    ['headerlessSha1', 'sha1'],
    ['headerlessSha1', 'headerlessSha1'],
  ] as const) {
    await prisma.$executeRawUnsafe(
      `UPDATE RomFile f JOIN RomPart p ON p.${pcol} = f.${fcol} JOIN Rom r ON r.id = p.romId JOIN Game g ON g.id = r.gameId
       SET f.status = 'MATCHED', f.romPartId = p.id, f.romHackId = NULL, f.systemId = g.systemId
       WHERE f.status <> 'MATCHED' AND f.${fcol} IS NOT NULL`,
    );
  }
  await prisma.$executeRawUnsafe(
    `UPDATE RomFile f JOIN RomPart p ON p.crc32 = f.crc32 AND p.size = f.size JOIN Rom r ON r.id = p.romId JOIN Game g ON g.id = r.gameId
     SET f.status = 'MATCHED', f.romPartId = p.id, f.systemId = g.systemId
     WHERE f.status <> 'MATCHED' AND f.sha1 IS NULL`,
  );
  for (const col of ['sha1', 'headerlessSha1'] as const) {
    await prisma.$executeRawUnsafe(
      `UPDATE RomFile f JOIN RomHack h ON h.sha1 = f.${col} JOIN Game g ON g.id = h.gameId
       SET f.status = 'HACK', f.romHackId = h.id, f.systemId = g.systemId
       WHERE f.status = 'UNKNOWN' AND f.${col} IS NOT NULL`,
    );
  }
  await autoLinkHacks();
  await linkRaGames();
  const after = await prisma.romFile.count({ where: { status: { in: ['MATCHED', 'HACK'] } } });
  return { matched: after, hacks: after - before };
}

/** Enlaza Rom.raGameId usando los hashes RA conocidos (del DAT o de ficheros escaneados). */
export async function linkRaGames() {
  await prisma.$executeRaw`UPDATE Rom r JOIN RaHash h ON h.hash = r.raHash SET r.raGameId = h.raGameId WHERE r.raGameId IS NULL OR r.raGameId <> h.raGameId`;
  await prisma.$executeRaw`UPDATE Rom r JOIN RomPart p ON p.romId = r.id JOIN RomFile f ON f.romPartId = p.id JOIN RaHash h ON h.hash = f.raHash SET r.raGameId = h.raGameId WHERE r.raGameId IS NULL`;
}

export type { RomPath };
