import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { badRequest, HttpError } from '../../lib/http.js';
import { hashFile } from '../../lib/hash.js';
import { raHashFile, raHashFromHashes } from '../../lib/rahash.js';
import { safeFileName } from '../../lib/romname.js';
import { me } from '../auth/middleware.js';
import { matchHashes, pathKey } from '../scanner/service.js';
import { guessSystem, systemIndex } from '../scanner/systems.js';
import { ownedRomIds } from '../roms/service.js';

export const uploadsRouter = Router();

const upload = multer({ dest: path.join(env.uploadsDir, 'incoming'), limits: { fileSize: 8 * 1024 * 1024 * 1024 } });

/**
 * Subida de una rom por cualquier usuario. Solo se acepta si su hash coincide con una rom o romhack
 * de la base de datos, o con un hash conocido de RetroAchievements. Se guarda en la ruta marcada como destino.
 */
uploadsRouter.post('/', upload.single('file'), async (req, res) => {
  const u = me(req);
  if (!req.file) throw badRequest('Missing file');
  const tmp = req.file.path;
  try {
    const target = await prisma.romPath.findFirst({ where: { isUploadTarget: true } });
    if (!target || target.readOnly) throw new HttpError(409, 'No upload target path configured');
    const idx = await systemIndex();
    const original = path.basename(req.file.originalname);
    const guessed = guessSystem(idx, original, null);
    const h = await hashFile(tmp, guessed?.headerType ?? 'none');
    const m = await matchHashes(h);
    let system = m.systemId ? idx.byId.get(m.systemId) ?? null : guessed;
    let raHash = system ? (raHashFromHashes(system.slug, h) ?? (await raHashFile(system.slug, tmp))) : null;
    let raGameId: number | null = null;
    if (m.status === 'UNKNOWN') {
      const candidates = [raHash, h.md5, h.headerless?.md5].filter(Boolean) as string[];
      const ra = await prisma.raHash.findFirst({ where: { hash: { in: candidates } }, include: { raGame: true } });
      if (!ra) throw new HttpError(422, 'File does not match any known rom (No-Intro/Redump/hacks/RetroAchievements)');
      raGameId = ra.raGameId;
      raHash = ra.hash;
      system = idx.byId.get(ra.raGame.systemId) ?? system;
    }
    if (!system) throw new HttpError(422, 'Cannot determine system');

    // Nombre canonico
    let destName = original;
    let romId: number | null = null;
    if (m.romPartId) {
      const part = await prisma.romPart.findUniqueOrThrow({ where: { id: m.romPartId } });
      destName = part.name;
      romId = part.romId;
      const already = await prisma.romFile.findFirst({ where: { romPartId: part.id } });
      if (already) {
        res.status(200).json({ status: 'already-owned', romId, message: 'Rom already in collection' });
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
    const rel = path.join(system.slug, safeFileName(destName));
    const dest = path.join(target.path, rel);
    if (fs.existsSync(dest)) throw new HttpError(409, `File exists: ${rel}`);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(tmp, dest);
    const st = await fs.promises.stat(dest);
    const file = await prisma.romFile.create({
      data: {
        romPathId: target.id,
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
        raHash,
        systemId: system.id,
        status: m.status,
        romPartId: m.romPartId,
        romHackId: m.romHackId,
      },
    });
    console.log(`Upload by ${u.username}: ${rel}`);
    res.status(201).json({
      status: 'stored',
      match: m.status,
      romId,
      raGameId,
      file: { id: file.id, path: rel },
      owned: romId ? (await ownedRomIds({ romIds: [romId] })).has(romId) : undefined,
    });
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
});
