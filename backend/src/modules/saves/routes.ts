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
import { layoutOf } from '../devices/sink.js';
import { raDefaults } from '../../seed/data.js';
import { convertSave, type SaveFormat } from './convert.js';
import { identifyRom, parseSaveFile, readThumb, readVersion, looseRomFile, removeVersion, romForSave, storeThumb, storeVersion } from './service.js';
import { mainCard, readSnapshot, splitWholeCard } from './cards.js';
import { codecFor } from './cardcodec.js';
import { sendRomFile } from '../roms/routes.js';
import { WEB_SYSTEMS } from '../../lib/websystems.js';
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

type DeviceSaveStatus = 'synced' | 'pending' | 'conflict' | 'incompatible';

/**
 * Where each save is among the user's consoles: holding the current version, about to get it at their next sync,
 * waiting for a conflict to be settled, or unable to use it (a savestate of another emulator). Consoles without
 * the game (by their last inventory) and that never held the save are left out.
 */
async function deviceStatuses(userId: number, saves: (Save & { game?: { system?: { slug: string } | null } | null })[]) {
  const out = new Map<number, { deviceId: number; name: string; status: DeviceSaveStatus }[]>(saves.map((s) => [s.id, []]));
  if (!saves.length) return out;
  const devices = await prisma.device.findMany({ where: { userId }, include: { firmware: true }, orderBy: { name: 'asc' } });
  if (!devices.length) return out;
  const ids = saves.map((s) => s.id);
  const [bases, conflicts, emulators] = await Promise.all([
    prisma.saveDeviceState.findMany({ where: { saveId: { in: ids } } }),
    prisma.saveConflict.findMany({ where: { saveId: { in: ids }, resolvedAt: null }, select: { saveId: true, deviceId: true } }),
    prisma.emulator.findMany({ select: { id: true, slug: true } }),
  ]);
  const gameIds = [...new Set(saves.map((s) => s.gameId).filter((g): g is number => g !== null))];
  const unnamed = [...new Set(saves.filter((s) => s.gameId === null).map((s) => s.baseName))];
  const inventory = await prisma.deviceRom.findMany({
    where: { deviceId: { in: devices.map((d) => d.id) }, OR: [{ gameId: { in: gameIds } }, ...unnamed.slice(0, 200).map((b) => ({ path: { contains: `/${b}.` } }))] },
    select: { deviceId: true, gameId: true, path: true, systemSlug: true },
  });
  // The game on each console, with the system its folder says (unidentified roms have no other)
  const has = new Map(inventory.flatMap((r) => [`${r.deviceId}:g${r.gameId}`, `${r.deviceId}:n${path.posix.basename(r.path).replace(/\.[^.]+$/, '')}`].map((k) => [k, r.systemSlug] as const)));
  const base = new Map(bases.map((b) => [`${b.saveId}:${b.deviceId}`, b]));
  const open = new Set(conflicts.map((c) => `${c.saveId}:${c.deviceId}`));
  const emuId = new Map(emulators.map((e) => [e.slug, e.id]));
  for (const s of saves) {
    for (const d of devices) {
      const key = s.gameId !== null ? `${d.id}:g${s.gameId}` : `${d.id}:n${s.baseName}`;
      const slug = s.game?.system?.slug ?? has.get(key) ?? undefined;
      const b = base.get(`${s.id}:${d.id}`);
      let status: DeviceSaveStatus | null = null;
      if (open.has(`${s.id}:${d.id}`)) status = 'conflict';
      else if (b) status = b.versionId === s.currentVersionId ? 'synced' : 'pending';
      else if (has.has(key)) {
        // A savestate only loads in the emulator the console uses for that system
        const emu = slug ? (layoutOf(d).systemMap[slug]?.emulator ?? raDefaults[slug]) : undefined;
        status = s.kind === 'STATE' && emu && emuId.get(emu) !== s.emulatorId ? 'incompatible' : 'pending';
      }
      if (status) out.get(s.id)!.push({ deviceId: d.id, name: d.name, status });
    }
  }
  return out;
}

type WithVersions = Save & { emulator: Emulator; versions: SaveVersion[]; game?: { system?: { slug: string } | null } | null };
async function withCoreWarnings<T extends WithVersions>(userId: number, saves: T[]) {
  const check = await coreChecker(userId);
  const where = await deviceStatuses(userId, saves);
  return saves.map((s) => ({
    ...s,
    coreWarnings: s.kind === 'STATE' ? check(s.emulator, s.versions.find((v) => v.id === s.currentVersionId)?.coreVersion) : [],
    devices: where.get(s.id) ?? [],
  }));
}

savesRouter.get('/', async (req, res) => {
  const u = me(req);
  const q = z.object({ gameId: z.coerce.number().int().optional(), kind: z.enum(['SAVE', 'STATE', 'ENTRY']).optional() }).parse(req.query);
  const saves = await prisma.save.findMany({
    // Whole PS1 cards from before cards were read entry by entry are left out: their entries are listed
    where: { userId: u.id, supersededAt: null, ...(q.gameId ? { gameId: q.gameId } : {}), ...(q.kind ? { kind: q.kind } : {}) },
    orderBy: { updatedAt: 'desc' },
    include: {
      emulator: true,
      game: { select: { id: true, title: true, system: { select: { slug: true, name: true } } } },
      versions: { orderBy: { fileMtime: 'desc' }, include: { sourceDevice: { select: { id: true, name: true } } } },
    },
  });
  // Unplayed: a save unchanged since the game created it, or the emulator's own resume state (.state.auto)
  const out = await withCoreWarnings(u.id, saves);
  for (const s of out) (s as typeof s & { unplayed: boolean }).unplayed = s.kind === 'STATE' ? s.slot === -1 : s.kind === 'SAVE' && s.versions.length < 2;
  res.json(out);
});

/** A save's file name: memory card entries download as single saves (.mcs for PS1, .gci for GameCube, .psu for PS2) */
const fileExt = (s: { kind: string; emulator: Emulator }, emu: Emulator = s.emulator) =>
  s.kind === 'ENTRY' ? (codecFor(s.emulator)?.ext ?? '.mcs') : s.kind === 'SAVE' ? emu.saveExt : (emu.stateExt ?? '.state');

// ---------- memory card files on the user's devices ----------

savesRouter.get('/cards', async (req, res) => {
  const u = me(req);
  const cards = await prisma.deviceCard.findMany({
    where: { device: { userId: u.id } },
    include: {
      device: { select: { id: true, name: true } },
      card: { select: { id: true, name: true, family: true } },
      emulator: { select: { id: true, name: true } },
      snapshots: { select: { id: true, sha1: true, size: true, kind: true, createdAt: true }, orderBy: { id: 'desc' } },
      _count: { select: { bases: { where: { entrySha1: { not: null } } } } },
    },
    orderBy: [{ deviceId: 'asc' }, { path: 'asc' }],
  });
  const games = await prisma.game.findMany({ where: { id: { in: cards.map((c) => c.gameId).filter((g): g is number => g !== null) } }, select: { id: true, title: true } });
  const title = new Map(games.map((g) => [g.id, g.title]));
  res.json(cards.map(({ offer: _o, _count, ...c }) => ({ ...c, entries: _count.bases, game: c.gameId ? { id: c.gameId, title: title.get(c.gameId) ?? null } : null })));
});

// A whole image of a device's card as it was read or sent, to put the card back by hand
savesRouter.get('/cards/:id/snapshots/:snapshotId', async (req, res) => {
  const u = me(req);
  const dc = await prisma.deviceCard.findUniqueOrThrow({ where: { id: intParam(req) }, include: { device: true } });
  if (dc.device.userId !== u.id) throw forbidden();
  const snap = await prisma.cardSnapshot.findFirstOrThrow({ where: { id: intParam(req, 'snapshotId'), deviceCardId: dc.id } });
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.posix.basename(dc.path))}"`);
  res.type('application/octet-stream').send(await readSnapshot(snap.path));
});

// ---------- saves shared by any user of the server ----------

const sharedInclude = {
  save: {
    include: {
      emulator: true,
      user: { select: { id: true, username: true } },
      game: { select: { id: true, title: true, system: { select: { slug: true, name: true } } } },
      card: { select: { family: true } },
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
      save: { id: save.id, kind: save.kind, slot: save.slot, baseName: save.baseName, label: save.label, emulator: save.emulator, game: save.game, user: save.user },
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
  const ext = fileExt(v.save);
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
  let cardId: number | undefined;
  if (src.kind === 'ENTRY') {
    // A memory card entry goes into the user's own card, as a new version of the entry of that name if there is one
    const card = await mainCard(u.id, src.card?.family ?? 'ps1');
    const mine = await prisma.save.findFirst({ where: { cardId: card.id, baseName: src.baseName } });
    key = mine ? { userId: u.id, emulatorId: mine.emulatorId, kind: 'ENTRY', slot: mine.slot, baseName: mine.baseName } : { ...key, slot: card.id };
    cardId = card.id;
  } else if (src.gameId) {
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
    cardId,
    label: src.label,
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
    include: { emulator: true, game: { include: { system: true } }, rom: true, versions: { orderBy: { fileMtime: 'desc' }, include: { sourceDevice: { select: { id: true, name: true } } } } },
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
    // A PS1 memory card: its saves join the user's card one by one, the file stays as uploaded
    const entries = await splitWholeCard({ ...(await prisma.save.findUniqueOrThrow({ where: { id: r.save.id } })), emulator: emu }, true);
    res.status(r.created ? 201 : 200).json({ saveId: r.save.id, versionId: r.version.id, created: r.created, entries });
  } finally {
    await fs.promises.rm(req.file.path, { force: true });
  }
});

// Descarga una version, opcionalmente convertida al formato de otro emulador
// ---------- playing a save in the browser (EmulatorJS, nothing kept) ----------



// What the play page needs for a version: the EmulatorJS system, the rom and the save or state to load
savesRouter.get('/:id/versions/:versionId/play', requirePerm('roms.download'), async (req, res) => {
  const s = await ownSave(intParam(req), me(req));
  const v = await prisma.saveVersion.findFirstOrThrow({ where: { id: intParam(req, 'versionId'), saveId: s.id } });
  if (s.kind === 'ENTRY') throw badRequest('Memory card entries cannot be played in the browser');
  const rom = await romForSave(s);
  const loose = rom ? null : await looseRomFile(s.baseName);
  if (loose?.system) {
    const system = WEB_SYSTEMS[loose.system.slug];
    if (!system) throw badRequest(`${loose.system.name} cannot be played in the browser`);
    const asRa = s.kind === 'SAVE' && raDefaults[loose.system.slug] ? `?emulator=${raDefaults[loose.system.slug]}` : '';
    res.json({
      system,
      title: s.baseName,
      kind: s.kind,
      romName: path.posix.basename(loose.relativePath),
      romUrl: `/api/v1/saves/${s.id}/rom`,
      fileUrl: `/api/v1/saves/${s.id}/versions/${v.id}/download${asRa}`,
      core: s.emulator.name,
    });
    return;
  }
  if (!rom) {
    // Where it is: the consoles that sent this save, and whether the rom was asked from one of them
    const from = await prisma.saveVersion.findMany({ where: { saveId: s.id, sourceDeviceId: { not: null } }, distinct: ['sourceDeviceId'], select: { sourceDevice: { select: { id: true, name: true } } } });
    const devices = from.flatMap((v) => (v.sourceDevice ? [v.sourceDevice] : []));
    const pull = devices.length ? await prisma.devicePull.findFirst({ where: { deviceId: { in: devices.map((d) => d.id) }, path: { contains: `/${s.baseName}.` } }, orderBy: { id: 'desc' } }) : null;
    const where = devices.length ? ` It is only on ${devices.map((d) => d.name).join(', ')}` : '';
    const state = !pull
      ? devices.length
        ? ': it is asked from there at its next sync if the console lets the server fetch roms'
        : ''
      : pull.status === 'failed'
        ? `: fetching it failed (${pull.result ?? 'unknown'})`
        : pull.status === 'done'
          ? ''
          : ': it is on its way to the server (the console sends it when it syncs); try again once it arrives';
    throw new HttpError(404, `The rom "${s.baseName}" is not on the server.${where}${state}`);
  }
  const system = WEB_SYSTEMS[rom.game.system.slug];
  if (!system) throw badRequest(`${rom.game.system.name} cannot be played in the browser`);
  // Saves go as RetroArch writes them (the browser runs RetroArch cores); states as they are
  const asRa = s.kind === 'SAVE' && raDefaults[rom.game.system.slug] ? `?emulator=${raDefaults[rom.game.system.slug]}` : '';
  res.json({
    system,
    title: rom.game.title,
    kind: s.kind,
    // The file's own name: its extension tells some cores the system (a Game Gear rom in a Master System core)
    romName: (await prisma.romPart.findFirst({ where: { romId: rom.id }, select: { name: true } }))?.name ?? rom.name,
    romUrl: `/api/v1/roms/${rom.id}/download`,
    fileUrl: `/api/v1/saves/${s.id}/versions/${v.id}/download${asRa}`,
    core: s.emulator.name,
  });
});

// The save's rom when it is a file of no catalogue rom (see looseRomFile)
savesRouter.get('/:id/rom', requirePerm('roms.download'), async (req, res) => {
  const s = await ownSave(intParam(req), me(req));
  const f = await looseRomFile(s.baseName);
  if (!f) throw new HttpError(404, 'Rom file');
  await sendRomFile(res, f, path.posix.basename(f.relativePath));
});

savesRouter.get('/:id/versions/:versionId/download', async (req, res) => {
  const s = await ownSave(intParam(req), me(req));
  const v = await prisma.saveVersion.findFirstOrThrow({ where: { id: intParam(req, 'versionId'), saveId: s.id } });
  const toEmu = typeof req.query.emulator === 'string' ? await prisma.emulator.findUniqueOrThrow({ where: { slug: req.query.emulator } }) : s.emulator;
  let buf = await readVersion(v.id);
  if (s.kind === 'SAVE' && toEmu.saveFormat !== s.emulator.saveFormat) buf = convertSave(buf, s.emulator.saveFormat as SaveFormat, toEmu.saveFormat as SaveFormat);
  const ext = fileExt(s, toEmu);
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
