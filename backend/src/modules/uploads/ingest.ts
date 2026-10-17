import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { badRequest, HttpError } from '../../lib/http.js';
import { hashFile, type FileHashes } from '../../lib/hash.js';
import { raHashFile, raHashFromHashes } from '../../lib/rahash.js';
import { normalizeTitle, parseRomName } from '../../lib/romname.js';
import { matchByDiscId, matchHashes, processFile } from '../scanner/service.js';
import { guessSystem, systemIndex } from '../scanner/systems.js';
import { ownedRomIds } from '../roms/service.js';
import { placeFile, userDatSource } from '../roms/destination.js';
import { identifyUploadedGames } from '../hacks/identify.js';

/** Who brings a file in: a user uploading from the web, or the owner of a device sending it. */
export type IngestUser = { id: number; username: string };

const CONTAINERS = new Set(['.rvz', '.wia', '.wbfs', '.ciso', '.cso', '.zso']);

/** The temporary file has no extension; container readers need one. */
export async function withExtension(tmpPath: string, originalName: string) {
  const tmp = tmpPath + path.extname(originalName).toLowerCase();
  await fs.promises.rename(tmpPath, tmp);
  return tmp;
}

export async function analyse(tmp: string, originalName: string, systemId?: number) {
  const idx = await systemIndex();
  const guessed = systemId ? idx.byId.get(systemId) ?? null : guessSystem(idx, originalName, null);
  const ext = path.extname(tmp);
  if (CONTAINERS.has(ext)) {
    // RVZ/WIA/CSO/ZSO: hashes of the rebuilt ISO; WBFS/CISO: by disc id
    const [row] = await processFile(tmp, originalName, idx, guessed, '');
    const h = row.hashes as FileHashes;
    let m = await matchHashes(h);
    if (m.status === 'UNKNOWN' && row.byDiscId) {
      const d = await matchByDiscId(row.systemId, row.byDiscId.id, row.byDiscId.revision);
      if (d) m = { status: 'UNVERIFIED', romPartId: d.romPartId, romHackId: null, systemId: d.systemId };
    }
    const system = (m.systemId ? idx.byId.get(m.systemId) : null) ?? (row.systemId ? idx.byId.get(row.systemId) : null) ?? guessed;
    return { idx, h, m, system, raHash: row.raHash, container: row.container ?? null };
  }
  const h = await hashFile(tmp, guessed?.headerType ?? 'none');
  const m = await matchHashes(h);
  const system = m.systemId ? idx.byId.get(m.systemId) ?? guessed : guessed;
  const raHash = system ? (raHashFromHashes(system.slug, h) ?? (await raHashFile(system.slug, tmp))) : null;
  return { idx, h, m, system, raHash, container: null as string | null };
}

/**
 * Verified ingest: accepted only when the hash matches a rom or romhack of the database, or a known
 * RetroAchievements hash; stored in its system's destination. Throws 422 NO_MATCH otherwise.
 */
export async function ingestVerified(tmp: string, originalName: string, u: IngestUser) {
  const original = path.basename(originalName);
  const { idx, h, m, raHash, system: sys, container } = await analyse(tmp, original);
  let system = sys;
  let raGameId: number | null = null;
  // WBFS/CISO identified by disc id: accepted, left as unverified
  const byDisc = m.status === 'UNVERIFIED' && !!container && !!m.romPartId;
  if (!byDisc && (m.status === 'UNKNOWN' || m.status === 'UNVERIFIED')) {
    const candidates = [raHash, h.md5, h.headerless?.md5].filter(Boolean) as string[];
    const ra = await prisma.raHash.findFirst({ where: { hash: { in: candidates } }, include: { raGame: true } });
    if (!ra) throw new HttpError(422, 'NO_MATCH');
    raGameId = ra.raGameId;
    system = idx.byId.get(ra.raGame.systemId) ?? system;
  }
  if (!system) throw new HttpError(422, 'Cannot determine system');

  let destName = original;
  let romId: number | null = null;
  if (m.romPartId && (m.status === 'MATCHED' || byDisc)) {
    const part = await prisma.romPart.findUniqueOrThrow({ where: { id: m.romPartId } });
    // Containers keep their extension (.rvz, .cso...)
    destName = container ? part.name.replace(/\.[^.]+$/, '') + path.extname(original) : part.name;
    romId = part.romId;
    if (await prisma.romFile.findFirst({ where: { romPartId: part.id, status: 'MATCHED' } })) {
      return ({ status: 'already-owned', romId, gameId: (await prisma.rom.findUnique({ where: { id: romId }, select: { gameId: true } }))?.gameId });
    }
  } else if (m.romHackId) {
    const hack = await prisma.romHack.findUniqueOrThrow({ where: { id: m.romHackId } });
    if (await prisma.romFile.findFirst({ where: { romHackId: hack.id } })) {
      return ({ status: 'already-owned', hackId: hack.id });
    }
    destName = hack.title + path.extname(original);
  } else {
    // Known only to RetroAchievements: the same content may be stored already, unverified
    const same = await prisma.romFile.findFirst({ where: { sha1: h.sha1 }, select: { id: true } });
    if (same) return { status: 'already-owned', file: { id: same.id } };
  }
  const { file, rel } = await placeFile(tmp, {
    system,
    fileName: destName,
    hashes: h,
    status: m.status === 'HACK' ? 'HACK' : m.status === 'MATCHED' ? 'MATCHED' : 'UNVERIFIED',
    romPartId: m.status === 'MATCHED' || byDisc ? m.romPartId : null,
    romHackId: m.romHackId,
    raHash,
    uploadedById: u.id,
    container,
  });
  return ({
    status: 'stored',
    match: m.status === 'UNKNOWN' ? 'RETROACHIEVEMENTS' : m.status,
    romId,
    gameId: romId ? (await prisma.rom.findUnique({ where: { id: romId }, select: { gameId: true } }))?.gameId : undefined,
    hackId: m.romHackId ?? undefined,
    raGameId,
    file: { id: file.id, path: rel },
    owned: romId ? (await ownedRomIds({ romIds: [romId] })).has(romId) : undefined,
  });
}

export const unverifiedBody = z.object({
  systemId: z.coerce.number().int(),
  gameId: z.coerce.number().int().optional(),
  newGameTitle: z.string().min(1).max(255).optional(),
  kind: z.enum(['rom', 'hack', 'translation']).default('rom'),
  name: z.string().max(255).optional(),
  regions: z.string().optional(),
  languages: z.string().optional(),
  revision: z.string().max(32).optional(),
  // Hack/translation data
  hackName: z.string().max(255).optional(),
  hackVersion: z.string().max(64).optional(),
  hackLanguage: z.string().max(32).optional(),
  author: z.string().max(255).optional(),
  baseRomId: z.coerce.number().int().optional(),
  sourceUrl: z.string().max(512).optional(),
});

const csv = (v?: string) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/** Unverified ingest: a rom no database knows, recorded with the data the user gives. */
export async function ingestUnverified(tmp: string, originalName: string, u: IngestUser, raw: unknown) {
  const body = unverifiedBody.parse(raw);
  const original = path.basename(originalName);
  const { h, m, raHash, system } = await analyse(tmp, original, body.systemId);
  if (!system) throw badRequest('Unknown system');
  if (m.status === 'MATCHED' || m.status === 'HACK') throw new HttpError(409, 'Already known: use the verified upload');
  if (await prisma.romFile.findFirst({ where: { sha1: h.sha1, status: 'UNVERIFIED' } })) throw new HttpError(409, 'Already uploaded');

  let gameId = body.gameId;
  if (gameId) {
    const g = await prisma.game.findUniqueOrThrow({ where: { id: gameId } });
    if (g.systemId !== system.id) throw badRequest('Game belongs to another system');
  } else {
    if (!body.newGameTitle) throw badRequest('gameId or newGameTitle required');
    const g = await prisma.game.create({
      data: { systemId: system.id, title: body.newGameTitle, titleNormalized: normalizeTitle(body.newGameTitle).slice(0, 255), createdById: u.id },
    });
    gameId = g.id;
  }
  const baseName = (body.name || original.replace(/\.[^.]+$/, '')).slice(0, 200);
  const ext = path.extname(original);

  if (body.kind !== 'rom') {
    const hack = await prisma.romHack.create({
      data: {
        gameId,
        type: body.kind === 'translation' ? 'TRANSLATION' : 'HACK',
        title: baseName,
        hackName: body.hackName ?? null,
        version: body.hackVersion ?? null,
        language: body.hackLanguage ?? null,
        author: body.author ?? null,
        baseRomId: body.baseRomId ?? null,
        baseEvidence: 'manual',
        sourceUrl: body.sourceUrl ?? null,
        size: BigInt(h.size),
        crc32: h.crc32,
        md5: h.md5,
        sha1: h.sha1,
      },
    });
    const { file, rel } = await placeFile(tmp, { system, fileName: baseName + ext, hashes: h, status: 'HACK', romHackId: hack.id, raHash, uploadedById: u.id });
    return ({ status: 'stored', match: 'HACK', hackId: hack.id, file: { id: file.id, path: rel } });
  }

  const ds = await userDatSource(system.id);
  const parsed = parseRomName(baseName);
  // Another file of the same name (a .zip and a .smd of one game): told apart by its hash
  let romName = `${baseName} [${u.username}]`.slice(0, 255);
  if (await prisma.rom.findFirst({ where: { datSourceId: ds.id, name: romName }, select: { id: true } })) romName = `${baseName} (${h.sha1.slice(0, 8)}) [${u.username}]`.slice(0, 255);
  const rom = await prisma.rom.create({
    data: {
      gameId,
      datSourceId: ds.id,
      name: romName,
      regions: body.regions ? csv(body.regions) : parsed.regions,
      languages: body.languages ? csv(body.languages) : parsed.languages,
      revision: body.revision ?? parsed.revision,
      flags: ['unverified'],
      raHash,
      createdById: u.id,
      parts: { create: [{ name: baseName + ext, size: BigInt(h.size), crc32: h.crc32, md5: h.md5, sha1: h.sha1, headerlessSize: h.headerless ? BigInt(h.headerless.size) : null, headerlessCrc: h.headerless?.crc32 ?? null, headerlessMd5: h.headerless?.md5 ?? null, headerlessSha1: h.headerless?.sha1 ?? null }] },
    },
    include: { parts: true },
  });
  const { file, rel } = await placeFile(tmp, { system, fileName: baseName + ext, hashes: h, status: 'UNVERIFIED', romPartId: rom.parts[0].id, raHash, uploadedById: u.id });
  if (!body.gameId) await identifyUploadedGames({ fileIds: [file.id] }).catch(() => 0);
  return ({ status: 'stored', match: 'UNVERIFIED', romId: rom.id, gameId, file: { id: file.id, path: rel } });
}

/**
 * A file of no system (an app shortcut, a launcher file) kept as a file nobody identified, under the folder its
 * device kept it in. The same content under the same name is stored once; another content under a taken name gets
 * its hash in the name
 */
export async function ingestUnknown(tmp: string, originalName: string, folder: string, u: IngestUser) {
  const name = path.basename(originalName);
  const h = await hashFile(tmp, 'none');
  const named = unknownStoredNames(name, h.sha1);
  const same = await prisma.romFile.findMany({ where: { sha1: h.sha1, systemId: null }, select: { id: true, relativePath: true } });
  const had = same.find((f) => named.includes(path.basename(f.relativePath)));
  if (had) return { status: 'already-owned' as const, file: { id: had.id } };
  for (const fileName of named) {
    try {
      const { file, rel } = await placeFile(tmp, { system: null, subdir: folder, fileName, hashes: h, status: 'UNKNOWN', uploadedById: u.id });
      return { status: 'stored' as const, file: { id: file.id, path: rel } };
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 409) throw e;
    }
  }
  throw new HttpError(409, `File exists: ${name}`);
}

/** The names a file of no system is stored under: its own, or with its hash when that is taken */
export function unknownStoredNames(name: string, sha1: string) {
  const ext = path.extname(name);
  return [name, `${name.slice(0, name.length - ext.length)} (${sha1.slice(0, 8)})${ext}`];
}
