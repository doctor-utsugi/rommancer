import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { HttpError, badRequest, forbidden, intParam } from '../../lib/http.js';
import { enqueue } from '../../lib/jobs.js';
import { me, requirePerm, type AuthUser } from '../auth/middleware.js';
import { Prisma, type Emulator, type Save, type SaveVersion } from '@prisma/client';
import { coreVersionOf, resolveConflict } from './core.js';
import { convertSave, type SaveFormat } from './convert.js';
import { identifyRom, parseSaveFile, readThumb, readVersion, removeVersion, storeThumb, storeVersion } from './service.js';
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

/**
 * The user's consoles whose core differs from the one a savestate was made with: the state may not load there.
 * Consoles that did not report their cores are left out (nothing to compare).
 */
async function coreChecker(userId: number) {
  const devices = await prisma.device.findMany({ where: { userId, coreVersions: { not: Prisma.DbNull } }, select: { id: true, name: true, coreVersions: true } });
  return (emu: Emulator, version: string | null | undefined) => {
    if (!version || !emu.core) return [];
    return devices.flatMap((d) => {
      const theirs = coreVersionOf(d as never, emu);
      return theirs && theirs !== version ? [{ deviceId: d.id, name: d.name, version: theirs }] : [];
    });
  };
}

type WithVersions = Save & { emulator: Emulator; versions: SaveVersion[] };
async function withCoreWarnings<T extends WithVersions>(userId: number, saves: T[]) {
  const check = await coreChecker(userId);
  return saves.map((s) => ({ ...s, coreWarnings: s.kind === 'STATE' ? check(s.emulator, s.versions.find((v) => v.id === s.currentVersionId)?.coreVersion) : [] }));
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
  res.json(await withCoreWarnings(u.id, saves));
});

// ---------- saves shared by any user of the server ----------

const sharedInclude = {
  save: {
    include: {
      emulator: true,
      user: { select: { id: true, username: true } },
      game: { select: { id: true, title: true, system: { select: { slug: true, name: true } } } },
    },
  },
} as const;

async function sharedVersion(id: number) {
  const v = await prisma.saveVersion.findUnique({ where: { id }, include: sharedInclude });
  if (!v?.sharedAt) throw new HttpError(404, 'Not shared');
  return v;
}

savesRouter.get('/shared', async (req, res) => {
  const u = me(req);
  const q = z.object({ gameId: z.coerce.number().int().optional(), q: z.string().max(100).optional(), kind: z.enum(['SAVE', 'STATE']).optional() }).parse(req.query);
  const rows = await prisma.saveVersion.findMany({
    where: {
      sharedAt: { not: null },
      save: {
        ...(q.gameId ? { gameId: q.gameId } : {}),
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.q ? { OR: [{ game: { title: { contains: q.q } } }, { baseName: { contains: q.q } }] } : {}),
      },
    },
    include: sharedInclude,
    orderBy: { sharedAt: 'desc' },
    take: 200,
  });
  const check = await coreChecker(u.id);
  res.json(
    rows.map(({ path: _p, thumbPath, save, ...v }) => ({
      ...v,
      hasThumb: !!thumbPath,
      mine: save.userId === u.id,
      save: { id: save.id, kind: save.kind, slot: save.slot, baseName: save.baseName, emulator: save.emulator, game: save.game, user: save.user },
      coreWarnings: save.kind === 'STATE' ? check(save.emulator, v.coreVersion) : [],
    })),
  );
});

savesRouter.get('/shared/:id/thumb', async (req, res) => {
  const v = await sharedVersion(intParam(req));
  if (!v.thumbPath) throw new HttpError(404, 'No screenshot');
  const t = await readThumb(v.thumbPath);
  res.type(t.type).send(t.buf);
});

savesRouter.get('/shared/:id/download', async (req, res) => {
  const v = await sharedVersion(intParam(req));
  const ext = v.save.kind === 'SAVE' ? v.save.emulator.saveExt : (v.save.emulator.stateExt ?? '.state');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(v.save.baseName + ext)}"`);
  res.type('application/octet-stream').send(await readVersion(v.id));
});

/**
 * Copies a shared version into the user's own saves, so it reaches their consoles at the next sync. It becomes a
 * new version of the save they already have for that game (history keeps theirs), or a new save.
 */
savesRouter.post('/shared/:id/import', async (req, res) => {
  const u = me(req);
  const v = await sharedVersion(intParam(req));
  const { slot } = z.object({ slot: z.number().int().min(-1).max(9).optional() }).parse(req.body ?? {});
  const src = v.save;
  let buf = await readVersion(v.id);
  let key = { userId: u.id, emulatorId: src.emulatorId, kind: src.kind, slot: src.kind === 'SAVE' ? 0 : (slot ?? src.slot), baseName: src.baseName };
  if (src.gameId) {
    const family = (f: string) => (f.startsWith('ps1') ? 'ps1' : f);
    // States only work in their own emulator; a game's save goes into the one the user already has, converted
    const mine = await prisma.save.findMany({
      where: { userId: u.id, gameId: src.gameId, kind: src.kind, slot: key.slot, ...(src.kind === 'STATE' ? { emulatorId: src.emulatorId } : {}) },
      include: { emulator: true },
      orderBy: { updatedAt: 'desc' },
    });
    const target = mine.find((s) => s.emulatorId === src.emulatorId) ?? mine.find((s) => family(s.emulator.saveFormat) === family(src.emulator.saveFormat));
    if (target) {
      if (target.emulator.saveFormat !== src.emulator.saveFormat) buf = convertSave(buf, src.emulator.saveFormat as SaveFormat, target.emulator.saveFormat as SaveFormat);
      key = { userId: u.id, emulatorId: target.emulatorId, kind: target.kind, slot: target.slot, baseName: target.baseName };
    }
  }
  const r = await storeVersion(key, buf, new Date(), {
    gameId: src.gameId,
    romId: src.romId,
    note: `shared by ${src.user.username}`.slice(0, 255),
    coreVersion: v.coreVersion,
    force: true,
  });
  if (v.thumbPath) await storeThumb(r.version.id, (await readThumb(v.thumbPath)).buf);
  res.status(201).json({ saveId: r.save.id, versionId: r.version.id });
});

savesRouter.get('/:id', async (req, res) => {
  const u = me(req);
  const s = await ownSave(intParam(req), u);
  const full = await prisma.save.findUniqueOrThrow({
    where: { id: s.id },
    include: { emulator: true, game: true, rom: true, versions: { orderBy: { fileMtime: 'desc' }, include: { sourceDevice: { select: { id: true, name: true } } } } },
  });
  res.json((await withCoreWarnings(u.id, [full]))[0]);
});

savesRouter.get('/:id/versions/:versionId/thumb', async (req, res) => {
  const s = await ownSave(intParam(req), me(req));
  const v = await prisma.saveVersion.findFirstOrThrow({ where: { id: intParam(req, 'versionId'), saveId: s.id } });
  if (!v.thumbPath) throw new HttpError(404, 'No screenshot');
  const t = await readThumb(v.thumbPath);
  res.type(t.type).send(t.buf);
});

// Shares one version with every user of the server (or stops sharing it)
savesRouter.put('/:id/versions/:versionId/share', async (req, res) => {
  const s = await ownSave(intParam(req), me(req));
  const { note } = z.object({ note: z.string().max(255).optional() }).parse(req.body ?? {});
  const v = await prisma.saveVersion.findFirstOrThrow({ where: { id: intParam(req, 'versionId'), saveId: s.id } });
  res.json(await prisma.saveVersion.update({ where: { id: v.id }, data: { sharedAt: v.sharedAt ?? new Date(), shareNote: note?.trim() || null } }));
});

savesRouter.delete('/:id/versions/:versionId/share', async (req, res) => {
  const s = await ownSave(intParam(req), me(req));
  const v = await prisma.saveVersion.findFirstOrThrow({ where: { id: intParam(req, 'versionId'), saveId: s.id } });
  await prisma.saveVersion.update({ where: { id: v.id }, data: { sharedAt: null, shareNote: null } });
  res.status(204).end();
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
  await removeVersion(v);
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
