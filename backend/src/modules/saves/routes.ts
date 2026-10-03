import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { badRequest, forbidden, intParam } from '../../lib/http.js';
import { enqueue } from '../../lib/jobs.js';
import { me, requirePerm, type AuthUser } from '../auth/middleware.js';
import { resolveConflict } from './core.js';
import { convertSave, type SaveFormat } from './convert.js';
import { identifyRom, parseSaveFile, readVersion, storeVersion } from './service.js';
import './sync.js';

export const savesRouter = Router();
savesRouter.use(requirePerm('saves'));

savesRouter.get('/conflicts', async (req, res) => {
  const u = me(req);
  res.json(
    await prisma.saveConflict.findMany({
      where: { resolvedAt: null, save: { userId: u.id } },
      include: { device: { select: { id: true, name: true } }, save: { include: { emulator: true, game: { select: { id: true, title: true } } } } },
      orderBy: { createdAt: 'desc' },
    }),
  );
});

savesRouter.post('/conflicts/:id/resolve', async (req, res) => {
  const { keep } = z.object({ keep: z.enum(['device', 'server']) }).parse(req.body);
  try {
    await resolveConflict(intParam(req), keep, me(req).id);
  } catch (e) {
    if (e instanceof Error && e.message === 'Forbidden') throw forbidden();
    throw e;
  }
  res.status(204).end();
});

async function ownSave(id: number, u: AuthUser) {
  const s = await prisma.save.findUniqueOrThrow({ where: { id }, include: { emulator: true } });
  if (s.userId !== u.id) throw forbidden();
  return s;
}

savesRouter.get('/', async (req, res) => {
  const u = me(req);
  const q = z.object({ gameId: z.coerce.number().int().optional(), kind: z.enum(['SAVE', 'STATE']).optional() }).parse(req.query);
  const saves = await prisma.save.findMany({
    where: { userId: u.id, ...(q.gameId ? { gameId: q.gameId } : {}), ...(q.kind ? { kind: q.kind } : {}) },
    orderBy: { updatedAt: 'desc' },
    include: {
      emulator: true,
      game: { select: { id: true, title: true, system: { select: { slug: true, name: true } } } },
      versions: { orderBy: { fileMtime: 'desc' }, include: { sourceDevice: { select: { id: true, name: true } } } },
    },
  });
  res.json(saves);
});

savesRouter.get('/:id', async (req, res) => {
  const s = await ownSave(intParam(req), me(req));
  res.json(
    await prisma.save.findUniqueOrThrow({
      where: { id: s.id },
      include: { emulator: true, game: true, rom: true, versions: { orderBy: { fileMtime: 'desc' }, include: { sourceDevice: { select: { id: true, name: true } } } } },
    }),
  );
});

const upload = multer({ dest: path.join(env.tmpDir, 'saves'), limits: { fileSize: 64 * 1024 * 1024 } });

savesRouter.post('/upload', upload.single('file'), async (req, res) => {
  const u = me(req);
  if (!req.file) throw badRequest('Missing file');
  try {
    const body = z
      .object({
        emulatorId: z.coerce.number().int(),
        gameId: z.coerce.number().int().optional(),
        romId: z.coerce.number().int().optional(),
        mtime: z.coerce.number().optional(),
      })
      .parse(req.body);
    const emu = await prisma.emulator.findUniqueOrThrow({ where: { id: body.emulatorId } });
    const parsed = parseSaveFile(req.file.originalname, emu);
    if (!parsed) throw badRequest(`Extension does not match emulator (${emu.saveExt}${emu.stateExt ? ` / ${emu.stateExt}` : ''})`);
    let gameId = body.gameId ?? null;
    let romId = body.romId ?? null;
    if (romId && !gameId) gameId = (await prisma.rom.findUniqueOrThrow({ where: { id: romId } })).gameId;
    if (!gameId) {
      const ident = await identifyRom(parsed.baseName);
      gameId = ident?.gameId ?? null;
      romId = ident?.romId ?? null;
    }
    const buf = await fs.promises.readFile(req.file.path);
    const r = await storeVersion({ userId: u.id, emulatorId: emu.id, ...parsed }, buf, body.mtime ? new Date(body.mtime) : new Date(), { gameId, romId, note: 'upload' });
    res.status(r.created ? 201 : 200).json({ saveId: r.save.id, versionId: r.version.id, created: r.created });
  } finally {
    await fs.promises.rm(req.file.path, { force: true });
  }
});

// Descarga una version, opcionalmente convertida al formato de otro emulador
savesRouter.get('/:id/versions/:versionId/download', async (req, res) => {
  const s = await ownSave(intParam(req), me(req));
  const v = await prisma.saveVersion.findFirstOrThrow({ where: { id: intParam(req, 'versionId'), saveId: s.id } });
  const toEmu = typeof req.query.emulator === 'string' ? await prisma.emulator.findUniqueOrThrow({ where: { slug: req.query.emulator } }) : s.emulator;
  let buf = await readVersion(v.id);
  if (toEmu.saveFormat !== s.emulator.saveFormat) buf = convertSave(buf, s.emulator.saveFormat as SaveFormat, toEmu.saveFormat as SaveFormat);
  const ext = s.kind === 'SAVE' ? toEmu.saveExt : (toEmu.stateExt ?? '.state');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(s.baseName + ext)}"`);
  res.type('application/octet-stream').send(buf);
});

savesRouter.post('/:id/restore', async (req, res) => {
  const s = await ownSave(intParam(req), me(req));
  const { versionId } = z.object({ versionId: z.number().int() }).parse(req.body);
  const v = await prisma.saveVersion.findFirstOrThrow({ where: { id: versionId, saveId: s.id } });
  // Se crea una nueva version con fecha actual para que gane en la siguiente sincronizacion
  const r = await storeVersion({ userId: s.userId, emulatorId: s.emulatorId, kind: s.kind, slot: s.slot, baseName: s.baseName }, await readVersion(v.id), new Date(), {
    note: `restore of version ${v.id}`,
    force: true,
  });
  res.json({ versionId: r.version.id });
});

// Crea una copia del save para otro emulador (p.ej. de RetroArch .srm a DuckStation .mcd)
savesRouter.post('/:id/convert', async (req, res) => {
  const u = me(req);
  const s = await ownSave(intParam(req), u);
  const { emulatorId, size } = z.object({ emulatorId: z.number().int(), size: z.number().int().positive().optional() }).parse(req.body);
  if (s.kind !== 'SAVE') throw badRequest('Savestates cannot be converted');
  const target = await prisma.emulator.findUniqueOrThrow({ where: { id: emulatorId } });
  if (!s.currentVersionId) throw badRequest('Empty save');
  const buf = convertSave(await readVersion(s.currentVersionId), s.emulator.saveFormat as SaveFormat, target.saveFormat as SaveFormat, size);
  const r = await storeVersion({ userId: u.id, emulatorId: target.id, kind: 'SAVE', slot: 0, baseName: s.baseName }, buf, new Date(), {
    gameId: s.gameId,
    romId: s.romId,
    note: `converted from ${s.emulator.slug}`,
  });
  res.status(201).json({ saveId: r.save.id, versionId: r.version.id });
});

// Cambia el nombre base (reubicacion: el emulador busca el save por el nombre de la rom)
savesRouter.patch('/:id', async (req, res) => {
  const s = await ownSave(intParam(req), me(req));
  const body = z.object({ baseName: z.string().min(1).max(255).optional(), gameId: z.number().int().nullable().optional(), romId: z.number().int().nullable().optional() }).parse(req.body);
  const data: typeof body = { ...body };
  if (body.baseName && body.gameId === undefined) {
    const ident = await identifyRom(body.baseName);
    if (ident) Object.assign(data, { gameId: ident.gameId, romId: ident.romId });
  }
  res.json(await prisma.save.update({ where: { id: s.id }, data }));
});

savesRouter.delete('/:id/versions/:versionId', async (req, res) => {
  const s = await ownSave(intParam(req), me(req));
  const v = await prisma.saveVersion.findFirstOrThrow({ where: { id: intParam(req, 'versionId'), saveId: s.id } });
  if (v.id === s.currentVersionId) throw badRequest('Cannot delete current version');
  await fs.promises.rm(path.join(env.savesDir, v.path), { force: true });
  await prisma.saveVersion.delete({ where: { id: v.id } });
  res.status(204).end();
});

savesRouter.delete('/:id', async (req, res) => {
  const s = await ownSave(intParam(req), me(req));
  await fs.promises.rm(path.join(env.savesDir, String(s.userId), String(s.id)), { recursive: true, force: true });
  await prisma.save.delete({ where: { id: s.id } });
  res.status(204).end();
});

savesRouter.post('/sync/:deviceId', async (req, res) => {
  const u = me(req);
  const device = await prisma.device.findUniqueOrThrow({ where: { id: intParam(req, 'deviceId') } });
  if (device.userId !== u.id) throw forbidden();
  const { direction } = z.object({ direction: z.enum(['pull', 'push', 'both']).default('both') }).parse(req.body ?? {});
  res.status(202).json(await enqueue('save-sync', { deviceId: device.id, direction }, u.id));
});
