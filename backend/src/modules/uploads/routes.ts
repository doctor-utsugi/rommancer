import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { badRequest, HttpError } from '../../lib/http.js';
import { hashFile, type FileHashes } from '../../lib/hash.js';
import { raHashFile, raHashFromHashes } from '../../lib/rahash.js';
import { normalizeTitle, parseRomName } from '../../lib/romname.js';
import { me, requirePerm } from '../auth/middleware.js';
import { matchByDiscId, matchHashes, processFile } from '../scanner/service.js';
import { guessSystem, systemIndex } from '../scanner/systems.js';
import { ownedRomIds } from '../roms/service.js';
import { placeFile, userDatSource } from '../roms/destination.js';

export const uploadsRouter = Router();

const upload = multer({ dest: path.join(env.uploadsDir, 'incoming'), limits: { fileSize: 8 * 1024 * 1024 * 1024 } });

const CONTAINERS = new Set(['.rvz', '.wia', '.wbfs', '.ciso', '.cso', '.zso']);

/** El fichero temporal de multer no tiene extension; los lectores de contenedores la necesitan. */
async function withExt(file: Express.Multer.File) {
  const tmp = file.path + path.extname(file.originalname).toLowerCase();
  await fs.promises.rename(file.path, tmp);
  return tmp;
}

async function analyse(tmp: string, originalName: string, systemId?: number) {
  const idx = await systemIndex();
  const guessed = systemId ? idx.byId.get(systemId) ?? null : guessSystem(idx, originalName, null);
  const ext = path.extname(tmp);
  if (CONTAINERS.has(ext)) {
    // RVZ/WIA/CSO/ZSO: hashes de la ISO reconstruida; WBFS/CISO: por id de disco
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
 * Subida verificada: solo se acepta si el hash coincide con una rom o romhack de la base de datos,
 * o con un hash conocido de RetroAchievements. Va a la ruta destino de su sistema.
 */
uploadsRouter.post('/', requirePerm('roms.upload'), upload.single('file'), async (req, res) => {
  const u = me(req);
  if (!req.file) throw badRequest('Missing file');
  const tmp = await withExt(req.file);
  try {
    const original = path.basename(req.file.originalname);
    const { idx, h, m, raHash, system: sys, container } = await analyse(tmp, original);
    let system = sys;
    let raGameId: number | null = null;
    // WBFS/CISO identificados por id de disco: se aceptan, quedan como no verificados
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
      // Los contenedores conservan su extension (.rvz, .cso...)
      destName = container ? part.name.replace(/\.[^.]+$/, '') + path.extname(original) : part.name;
      romId = part.romId;
      if (await prisma.romFile.findFirst({ where: { romPartId: part.id, status: 'MATCHED' } })) {
        res.status(200).json({ status: 'already-owned', romId });
        return;
      }
    } else if (m.romHackId) {
      const hack = await prisma.romHack.findUniqueOrThrow({ where: { id: m.romHackId } });
      if (await prisma.romFile.findFirst({ where: { romHackId: hack.id } })) {
        res.status(200).json({ status: 'already-owned', hackId: hack.id });
        return;
      }
      destName = hack.title + path.extname(original);
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
    res.status(201).json({
      status: 'stored',
      match: m.status === 'UNKNOWN' ? 'RETROACHIEVEMENTS' : m.status,
      romId,
      hackId: m.romHackId ?? undefined,
      raGameId,
      file: { id: file.id, path: rel },
      owned: romId ? (await ownedRomIds({ romIds: [romId] })).has(romId) : undefined,
    });
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
});

const unverifiedBody = z.object({
  systemId: z.coerce.number().int(),
  gameId: z.coerce.number().int().optional(),
  newGameTitle: z.string().min(1).max(255).optional(),
  kind: z.enum(['rom', 'hack', 'translation']).default('rom'),
  name: z.string().max(255).optional(),
  regions: z.string().optional(),
  languages: z.string().optional(),
  revision: z.string().max(32).optional(),
  // Datos de hack/traduccion
  hackName: z.string().max(255).optional(),
  hackVersion: z.string().max(64).optional(),
  hackLanguage: z.string().max(32).optional(),
  author: z.string().max(255).optional(),
  baseRomId: z.coerce.number().int().optional(),
  sourceUrl: z.string().max(512).optional(),
});

const csv = (v?: string) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/**
 * Subida sin verificar: la rom no coincide con ninguna base de datos. Se registra con los datos que
 * aporta el usuario y queda marcada como no verificada; si un DAT posterior la incluye, pasa a verificada.
 */
uploadsRouter.post('/unverified', requirePerm('roms.uploadUnverified'), upload.single('file'), async (req, res) => {
  const u = me(req);
  if (!req.file) throw badRequest('Missing file');
  const tmp = await withExt(req.file);
  try {
    const body = unverifiedBody.parse(req.body);
    const original = path.basename(req.file.originalname);
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
      res.status(201).json({ status: 'stored', match: 'HACK', hackId: hack.id, file: { id: file.id, path: rel } });
      return;
    }

    const ds = await userDatSource(system.id);
    const parsed = parseRomName(baseName);
    const rom = await prisma.rom.create({
      data: {
        gameId,
        datSourceId: ds.id,
        name: `${baseName} [${u.username}]`.slice(0, 255),
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
    res.status(201).json({ status: 'stored', match: 'UNVERIFIED', romId: rom.id, gameId, file: { id: file.id, path: rel } });
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
});
