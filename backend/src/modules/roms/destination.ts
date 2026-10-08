import fs from 'node:fs';
import path from 'node:path';
import type { RomPath, System } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { safeFileName } from '../../lib/romname.js';
import { HttpError } from '../../lib/http.js';
import { pathKey } from '../scanner/service.js';
import type { FileHashes } from '../../lib/hash.js';
import crypto from 'node:crypto';
import { checkPath, registerIdentity, TMP_DIR, volumeKey } from '../storage/health.js';

/** Bytes being written right now per disk, so concurrent uploads do not all pass the same free-space check */
const inFlight = new Map<string, number>();

/** Holds SIZE bytes on a disk while a file is written; returns the release */
export function holdSpace(key: string, size: number) {
  inFlight.set(key, (inFlight.get(key) ?? 0) + size);
  return () => inFlight.set(key, Math.max(0, (inFlight.get(key) ?? 0) - size));
}

/** Folder inside a destination for a system, by its scheme (per system, flat, or a firmware's folders) */
async function schemeDir(rp: RomPath, system: System) {
  if (rp.targetScheme === 'flat') return '';
  if (rp.targetScheme === 'system') return system.slug;
  const fw = await prisma.firmware.findUnique({ where: { slug: rp.targetScheme } });
  return (fw?.systemMap as Record<string, { folder: string }> | undefined)?.[system.slug]?.folder ?? system.slug;
}

/**
 * Where a new rom of SYSTEM (SIZE bytes) goes: the system's destinations by priority, then the general ones,
 * the first that is reachable and keeps its free-space reserve after the write. Each file goes whole to one
 * destination. When destinations exist and none can take it, the upload fails (507) instead of landing on a
 * disk nobody chose.
 */
export async function resolveDestination(system: System, size = 0): Promise<{ romPath: RomPath; dir: string; volume: string }> {
  const writable = await prisma.romPath.findMany({ where: { readOnly: false }, orderBy: [{ priority: 'asc' }, { id: 'asc' }] });
  const forSystem = writable.filter((p) => ((p.targetSystems as string[] | null) ?? []).includes(system.slug));
  const general = writable.filter((p) => p.isDefaultTarget && !forSystem.includes(p));
  const candidates = [...forSystem, ...general];
  if (!candidates.length && !writable.length) {
    // A new server with no folders yet: the library inside the data folder
    await fs.promises.mkdir(env.libraryDir, { recursive: true });
    const rp =
      (await prisma.romPath.findUnique({ where: { path: env.libraryDir } })) ??
      (await registerIdentity(await prisma.romPath.create({ data: { label: 'Biblioteca', path: env.libraryDir, isDefaultTarget: true } })));
    return { romPath: rp, dir: await schemeDir(rp, system), volume: await volumeKey(rp.path) };
  }
  const reasons: string[] = [];
  let full = false;
  for (const rp of candidates) {
    const health = await checkPath(rp);
    if (!health.online) {
      reasons.push(`${rp.label}: offline (${health.reason}), check that its disk is connected`);
      continue;
    }
    const volume = await volumeKey(rp.path);
    const keep = ((health.total ?? 0) * rp.reservePercent) / 100;
    const free = (health.free ?? 0) - (inFlight.get(volume) ?? 0);
    if (free - size < keep) {
      reasons.push(`${rp.label}: ${fmt(Math.max(0, free - keep))} free above its ${rp.reservePercent}% reserve`);
      full = true;
      continue;
    }
    return { romPath: rp, dir: await schemeDir(rp, system), volume };
  }
  throw new HttpError(
    507,
    candidates.length
      ? `No destination can take ${fmt(size)} for ${system.name}: ${reasons.join('; ')}.${full ? ' Free some space, lower a reserve or add another destination folder.' : ''}`
      : `No destination folder takes ${system.name}. Mark a folder as destination for it, or as general destination.`,
  );
}

const fmt = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);

export interface PlaceOptions {
  system: System;
  fileName: string;
  hashes: FileHashes;
  status: 'MATCHED' | 'HACK' | 'UNVERIFIED';
  romPartId?: number | null;
  romHackId?: number | null;
  raHash?: string | null;
  uploadedById?: number | null;
  container?: string | null;
}

/** Copia (o escribe) un fichero en su destino final y lo registra como fichero escaneado. */
export async function placeFile(src: string | Buffer, opts: PlaceOptions) {
  const size = typeof src === 'string' ? (await fs.promises.stat(src)).size : src.length;
  const { romPath, dir, volume } = await resolveDestination(opts.system, size);
  const rel = path.join(dir, safeFileName(opts.fileName));
  const dest = path.join(romPath.path, rel);
  if (fs.existsSync(dest)) throw new HttpError(409, `File exists: ${rel}`);
  // Written beside the destination (same disk) and renamed when complete: a crash or a full disk never
  // leaves a half file under its final name
  const tmpDirOnDisk = path.join(romPath.path, TMP_DIR);
  const tmp = path.join(tmpDirOnDisk, `${crypto.randomUUID()}${path.extname(dest)}`);
  const release = holdSpace(volume, size);
  try {
    await fs.promises.mkdir(tmpDirOnDisk, { recursive: true });
    if (typeof src === 'string') await fs.promises.copyFile(src, tmp);
    else await fs.promises.writeFile(tmp, src);
    const fh = await fs.promises.open(tmp, 'r+');
    await fh.sync();
    await fh.close();
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.rename(tmp, dest);
  } catch (e) {
    await fs.promises.rm(tmp, { force: true });
    if ((e as NodeJS.ErrnoException).code === 'ENOSPC') throw new HttpError(507, `The disk of ${romPath.label} is full`);
    throw e;
  } finally {
    release();
  }
  const st = await fs.promises.stat(dest);
  const h = opts.hashes;
  const file = await prisma.romFile.create({
    data: {
      romPathId: romPath.id,
      pathKey: pathKey(rel),
      relativePath: rel,
      size: BigInt(h.size),
      fileSize: BigInt(st.size),
      mtimeMs: BigInt(Math.floor(st.mtimeMs)),
      crc32: h.crc32,
      md5: h.md5,
      sha1: h.sha1,
      headerlessCrc: h.headerless?.crc32 ?? null,
      headerlessMd5: h.headerless?.md5 ?? null,
      headerlessSha1: h.headerless?.sha1 ?? null,
      raHash: opts.raHash ?? null,
      systemId: opts.system.id,
      status: opts.status,
      romPartId: opts.romPartId ?? null,
      romHackId: opts.romHackId ?? null,
      uploadedById: opts.uploadedById ?? null,
      container: opts.container ?? null,
    },
  });
  return { file, rel, romPath };
}

/** DAT interno para roms subidas sin verificar en un sistema. */
export async function userDatSource(systemId: number) {
  const name = 'Rommancer (no verificado)';
  return (
    (await prisma.datSource.findUnique({ where: { systemId_type_name: { systemId, type: 'USER', name } } })) ??
    (await prisma.datSource.create({ data: { systemId, type: 'USER', name, fileSha1: '', priority: -1 } }))
  );
}
