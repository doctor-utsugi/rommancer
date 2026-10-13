import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import type { Device, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { encrypt } from '../../lib/crypto.js';
import { badRequest, forbidden, intParam } from '../../lib/http.js';
import { enqueue, registerJob } from '../../lib/jobs.js';
import { extractEntryStream } from '../../lib/tools.js';
import { me, requireAdmin, requirePerm, type AuthUser } from '../auth/middleware.js';
import crypto from 'node:crypto';
import { ZipArchive } from 'archiver';
import { sha256 } from '../../lib/crypto.js';
import { scriptFiles } from '../saves/script.js';
import { loadList, resolveListFiles } from '../lists/service.js';
import { clearListCaches, copiesSystem, folderFor, layoutOf, openSink, systemFilterOf } from './sink.js';
import { ownedGameIds, ownedRomIds } from '../roms/service.js';
import { installClient, serverKey, syncOverSsh } from './ssh.js';
import { OPEN_PULL, pullTransfers, romDownloads } from '../saves/agent.js';
import { devicePlan } from './plan.js';
import { prunePlan } from './prune.js';
import { listsPreview, setDeviceLists } from './lists.js';
import { previewPlacement } from '../roms/destination.js';

/** Requests not finished yet, including paused ones (the console is only offered the open ones) */
const QUEUED_PULL = [...OPEN_PULL, 'paused'];
import { createAgentDevice, publicBase } from '../link/routes.js';

export const devicesRouter = Router();
// Devices: for copying roms (download) or syncing saves
devicesRouter.use(requirePerm('roms.download', 'saves'));

const publicDevice = { sshPassword: true, sshKey: true, tokenHash: true } as const;

/** Where each firmware's card or data lives, for consoles added over SSH */
const DEFAULT_ROOTS: Record<string, string> = { onion: '/mnt/SDCARD', knulli: '/userdata', batocera: '/userdata', rocknix: '/storage', muos: '/mnt/mmc', arkos: '/roms', nextui: '/mnt/SDCARD' };

// --- Console and firmware catalogue ---
devicesRouter.get('/consoles', async (_req, res) => {
  res.json(await prisma.console.findMany({ orderBy: [{ manufacturer: 'asc' }, { name: 'asc' }] }));
});

devicesRouter.post('/consoles', async (req, res) => {
  const body = z.object({ name: z.string().min(1).max(128), manufacturer: z.string().min(1).max(64), formFactor: z.string().max(32).default('handheld') }).parse(req.body);
  res.status(201).json(await prisma.console.create({ data: body }));
});

devicesRouter.get('/firmwares', async (_req, res) => {
  res.json(await prisma.firmware.findMany({ orderBy: { name: 'asc' } }));
});

const firmwareBody = z.object({
  slug: z.string().min(1).max(32).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(128),
  romsRoot: z.string().max(255),
  savesRoot: z.string().max(255),
  statesRoot: z.string().max(255),
  biosRoot: z.string().max(255),
  savesLayout: z.enum(['flat', 'system', 'core', 'content', 'content-core', 'rom', 'rom-core', 'rom-saves', 'beside', 'minui']),
  systemMap: z.record(z.string(), z.object({ folder: z.string(), emulator: z.string() })),
});

devicesRouter.post('/firmwares', requireAdmin, async (req, res) => {
  res.status(201).json(await prisma.firmware.create({ data: firmwareBody.parse(req.body) }));
});

devicesRouter.patch('/firmwares/:id', requireAdmin, async (req, res) => {
  res.json(await prisma.firmware.update({ where: { id: intParam(req) }, data: firmwareBody.partial().parse(req.body) }));
});

devicesRouter.get('/emulators', async (_req, res) => {
  res.json(await prisma.emulator.findMany({ orderBy: { name: 'asc' } }));
});

// --- User devices ---
async function ownDevice(id: number, u: AuthUser) {
  const d = await prisma.device.findUniqueOrThrow({ where: { id }, include: { firmware: true, console: true } });
  if (d.userId !== u.id && u.role !== 'ADMIN') throw forbidden();
  return d;
}

const deviceBody = z.object({
  name: z.string().min(1).max(128),
  consoleId: z.number().int(),
  firmwareId: z.number().int(),
  connType: z.enum(['LOCAL', 'SSH', 'AGENT']),
  rootPath: z.string().min(1).max(512),
  sshHost: z.string().max(255).nullable().optional(),
  sshPort: z.number().int().nullable().optional(),
  sshUser: z.string().max(64).nullable().optional(),
  sshPassword: z.string().nullable().optional(),
  sshKey: z.string().nullable().optional(),
  overrides: z
    .object({
      romsRoot: z.string().optional(),
      savesRoot: z.string().optional(),
      statesRoot: z.string().optional(),
      biosRoot: z.string().optional(),
      savesLayout: z.enum(['flat', 'system', 'core', 'content', 'content-core', 'rom', 'rom-core', 'rom-saves', 'beside', 'minui']).optional(),
      statesLayout: z.enum(['flat', 'system', 'core', 'content', 'content-core', 'rom', 'rom-core', 'rom-saves', 'beside']).optional(),
      systemMap: z.record(z.string(), z.object({ folder: z.string(), emulator: z.string() })).optional(),
    })
    .nullable()
    .optional(),
  syncSaves: z.boolean().optional(),
});

/** ROOT: the device's root, for a roms folder given as a full path (an SD card): kept relative to the root */
function deviceData(body: Partial<z.infer<typeof deviceBody>>, root = body.rootPath) {
  const data: Record<string, unknown> = { ...body };
  const roms = body.overrides?.romsRoot;
  if (roms?.startsWith('/') && root) data.overrides = { ...body.overrides, romsRoot: path.posix.relative(root, roms) };
  if (body.sshPassword !== undefined) data.sshPassword = encrypt(body.sshPassword);
  if (body.sshKey !== undefined) data.sshKey = encrypt(body.sshKey);
  if (body.overrides === null) data.overrides = undefined;
  return data;
}

devicesRouter.get('/', async (req, res) => {
  const u = me(req);
  const devices = await prisma.device.findMany({
    where: { userId: u.id },
    include: { console: true, firmware: true, _count: { select: { inventory: true } } },
    omit: { ...publicDevice, lastLog: true },
    orderBy: { name: 'asc' },
  });
  res.json(devices);
});

devicesRouter.post('/', async (req, res) => {
  const body = deviceBody.parse(req.body);
  if (body.connType === 'SSH' && (!body.sshHost || !body.sshUser)) throw badRequest('SSH host and user required');
  if (body.connType === 'LOCAL') body.rootPath = path.resolve(body.rootPath);
  const d = await prisma.device.create({ data: { ...(deviceData(body) as Prisma.DeviceUncheckedCreateInput), userId: me(req).id }, omit: publicDevice });
  res.status(201).json(d);
});

// --- The server's SSH access to consoles ---
// Public key to add by hand to a console's authorized_keys (consoles with the app add it themselves)
devicesRouter.get('/ssh-key', async (_req, res) => {
  res.json({ publicKey: (await serverKey()).publicKey });
});

// A console that only offers SSH: the server installs the client on it and from then on syncs it.
// Admins only: the server opens connections inside its own network
devicesRouter.post('/ssh-install', requireAdmin, async (req, res) => {
  const body = z
    .object({
      name: z.string().trim().min(1).max(128),
      consoleId: z.number().int(),
      firmwareId: z.number().int(),
      host: z.string().trim().min(1).max(255),
      port: z.number().int().min(1).max(65535).default(22),
      user: z.string().trim().min(1).max(64).default('root'),
      // Only to get in the first time; dropped once the server's key works
      password: z.string().max(256).optional(),
      rootPath: z.string().trim().max(512).optional(),
      // Address the console uses to reach this server (a LAN one, say); the public one by default
      server: z.string().trim().url().max(255).optional(),
    })
    .parse(req.body);
  const firmware = await prisma.firmware.findUniqueOrThrow({ where: { id: body.firmwareId } });
  const rootPath = body.rootPath || DEFAULT_ROOTS[firmware.slug];
  if (!rootPath?.startsWith('/')) throw badRequest('Root folder required for this firmware');
  const { device, token } = await createAgentDevice(me(req).id, { name: body.name, consoleId: body.consoleId, firmwareId: body.firmwareId, rootPath });
  const withSsh = await prisma.device.update({
    where: { id: device.id },
    data: { sshManual: true, sshHost: body.host, sshPort: body.port, sshUser: body.user, sshPassword: body.password ? encrypt(body.password) : null },
    include: { firmware: true },
  });
  try {
    await installClient(withSsh, (body.server ?? publicBase(req)).replace(/\/+$/, ''), token);
  } catch (e) {
    await prisma.device.delete({ where: { id: device.id } });
    throw badRequest(`Could not install over SSH: ${e instanceof Error ? e.message : e}`);
  }
  res.status(201).json({ id: device.id });
});

// Sync a quiet console now over SSH (the sweep does it by itself every few minutes)
devicesRouter.post('/:id/ssh-sync', requireAdmin, async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  if (!d.sshHost || !d.clientPath) throw badRequest('This console has no SSH access');
  void syncOverSsh(d.id).catch(() => {});
  res.status(202).json({ ok: true });
});

// Copies under way on any of the user's consoles, for the activity panel shown on every page
/**
 * Everything under way for the user, for the activity panel on every page (one entry per thing, by kind):
 * - copy: roms a console is sending to the server
 * - download: roms a console is taking from the server (seen in the last two minutes)
 * - config: a configuration change waiting for or being applied by a console
 * - sync: a sync asked from here that the console has not picked up yet
 * - prune: a deletion of roms held until the user confirms it
 * - job: the server's own work (scans, imports, copies to a card...): the user's, every one for an admin
 */
devicesRouter.get('/activity', async (req, res) => {
  const u = me(req);
  const items: Record<string, unknown>[] = [];
  const queued = await prisma.devicePull.findMany({ where: { status: { in: QUEUED_PULL }, device: { userId: u.id } }, select: { deviceId: true }, distinct: ['deviceId'] });
  const copying = await prisma.device.findMany({ where: { id: { in: queued.map((q) => q.deviceId) } } });
  for (const d of copying) items.push({ kind: 'copy', key: `copy-${d.id}`, deviceId: d.id, name: d.name, ...(await pullProgress(d)) });

  const devices = await prisma.device.findMany({
    where: { userId: u.id },
    select: { id: true, name: true, lastSeenAt: true, wantSyncAt: true, pruneRoms: true, pruneHeld: true, pruneAllow: true },
  });
  const online = (d: { lastSeenAt: Date | null }) => !!d.lastSeenAt && Date.now() - d.lastSeenAt.getTime() < 60_000;
  const ops = await prisma.deviceConfigOp.findMany({
    where: { deviceId: { in: devices.map((d) => d.id) }, status: { in: ['pending', 'collecting', 'applying'] } },
    select: { id: true, deviceId: true, kind: true, status: true, createdAt: true },
  });
  for (const d of devices) {
    const dl = romDownloads.get(d.id);
    if (dl && dl.at && (dl.current || Date.now() - dl.at < 120_000)) {
      const sent = dl.current?.sent() ?? 0;
      items.push({
        kind: 'download',
        key: `download-${d.id}`,
        deviceId: d.id,
        name: d.name,
        done: dl.done,
        total: Math.max(dl.expected, dl.done + (dl.current ? 1 : 0)),
        bytesDone: dl.bytesDone + sent,
        bytesTotal: Math.max(dl.bytesExpected, dl.bytesDone + sent),
        current: dl.current && { name: dl.current.name, received: sent, size: dl.current.size },
        active: !!dl.current,
        online: online(d),
      });
    }
    for (const op of ops.filter((o) => o.deviceId === d.id))
      items.push({ kind: 'config', key: `config-${op.id}`, opId: op.id, deviceId: d.id, name: d.name, op: op.kind, status: op.status, since: op.createdAt, online: online(d) });
    if (d.wantSyncAt) items.push({ kind: 'sync', key: `sync-${d.id}`, deviceId: d.id, name: d.name, since: d.wantSyncAt, online: online(d) });
    if (d.pruneRoms && d.pruneHeld !== null && d.pruneAllow === null) items.push({ kind: 'prune', key: `prune-${d.id}`, deviceId: d.id, name: d.name, held: d.pruneHeld });
  }

  const jobs = await prisma.job.findMany({
    where: { status: { in: ['PENDING', 'RUNNING'] }, ...(u.role === 'ADMIN' ? {} : { userId: u.id }), OR: [{ runAfter: null }, { runAfter: { lte: new Date() } }] },
    orderBy: { id: 'asc' },
    take: 20,
    select: { id: true, type: true, status: true, processed: true, total: true, message: true },
  });
  for (const j of jobs) items.push({ kind: 'job', key: `job-${j.id}`, ...j });
  res.json(items);
});

// Withdraws a sync asked from here that the console has not picked up (it still syncs on its own schedule)
devicesRouter.delete('/:id/sync-request', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  await prisma.device.update({ where: { id: d.id }, data: { wantSyncAt: null } });
  res.status(204).end();
});

devicesRouter.get('/:id', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const { sshPassword, sshKey, tokenHash: _token, ...rest } = d;
  res.json({ ...rest, hasPassword: !!sshPassword, hasKey: !!sshKey, layout: layoutOf(d), games: await prisma.deviceRom.count({ where: { deviceId: d.id } }) });
});

/**
 * Where a device's sync stands, for its page: in touch or not (the daemon polls every 15 s), its last sync, the last
 * failure its client reported (the newest "failed:" line of its log with no successful sync after it) and the saves
 * waiting for the user's choice
 */
devicesRouter.get('/:id/sync-state', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const lines = (d.lastLog ?? '').split('\n');
  const lastFail = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^\S+ \S+ failed: /.test(l)).pop();
  const okAfter = lastFail ? lines.slice(lastFail.i + 1).some((l) => /^\S+ \S+ sync: /.test(l)) : true;
  const seenAgo = d.lastSeenAt ? Date.now() - d.lastSeenAt.getTime() : null;
  res.json({
    agent: d.connType === 'AGENT',
    online: seenAgo !== null && seenAgo < 60_000,
    // Quiet for a while: switched off, asleep, or on but unable to reach the server
    quiet: seenAgo === null || seenAgo > 15 * 60_000,
    lastSeenAt: d.lastSeenAt,
    lastSyncAt: d.lastSyncAt,
    lastError: lastFail && !okAfter ? lastFail.l.replace(/^\S+ \S+ failed: /, '') : null,
    conflicts: await prisma.saveConflict.count({ where: { deviceId: d.id, resolvedAt: null } }),
    clockSync: d.clockSync,
    pending: await listsPending(d),
  });
});

/**
 * How far the console is from what its lists ask, by its last inventory: games still to copy to it (they go when
 * the user downloads them on the console), roms to delete (at its next sync, when it deletes roms in no list) and
 * a download under way. Null before it ever synced.
 */
async function listsPending(d: Awaited<ReturnType<typeof ownDevice>>) {
  // A console that synced but never listed a rom has none
  if (d.connType !== 'AGENT' || !(d.inventoryAt ?? d.lastSyncAt)) return null;
  const plan = await devicePlan(d);
  const missing = plan.files.filter((f) => !f.excluded && !f.present);
  const prune = d.pruneRoms ? await prunePlan(d) : null;
  const dl = romDownloads.get(d.id);
  const live = dl && dl.at && (dl.current || Date.now() - dl.at < 120_000) ? dl : null;
  return {
    copy: missing.length,
    copyBytes: missing.reduce((n, f) => n + f.size, 0),
    delete: prune ? prune.del.length + prune.upload.length : 0,
    inventoryAt: d.inventoryAt,
    downloading: live?.current ? { done: live.done, total: Math.max(live.expected, live.done + 1) } : null,
  };
}

devicesRouter.patch('/:id', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const body = deviceBody.partial().parse(req.body);
  res.json(await prisma.device.update({ where: { id: d.id }, data: deviceData(body, body.rootPath ?? d.rootPath) as Prisma.DeviceUncheckedUpdateInput, omit: publicDevice }));
});

// ---------- what a sync client has, and what the server asks of it ----------

const pathKey = (p: string) => crypto.createHash('sha1').update(p).digest('hex');

/** Share of a list already on a device: items whose files are at their destination or whose game it has. */
export async function listProgress(listId: number, device: Awaited<ReturnType<typeof ownDevice>>) {
  const layout = layoutOf(device);
  const root = device.rootPath;
  const { items } = await resolveListFiles(listId);
  const inv = await prisma.deviceRom.findMany({ where: { deviceId: device.id }, select: { pathHash: true, gameId: true, sha1: true } });
  const paths = new Set(inv.map((r) => r.pathHash));
  const contents = new Set(inv.flatMap((r) => (r.sha1 ? [r.sha1] : [])));
  const games = new Set(inv.map((r) => r.gameId).filter(Boolean));
  const roms = items.length ? await prisma.rom.findMany({ where: { id: { in: items.flatMap((i) => (i.romId ? [i.romId] : [])) } }, select: { id: true, gameId: true } }) : [];
  const gameOf = new Map(roms.map((r) => [r.id, r.gameId]));
  let have = 0;
  let total = 0;
  const filter = systemFilterOf(device);
  for (const it of items) {
    if (!it.folder && !copiesSystem(filter, it.systemSlug)) continue; // left out for this device
    const folder = it.folder ?? folderFor(layout, it.systemSlug);
    total++;
    const there = it.files.some((f) => paths.has(pathKey(path.posix.join(root, layout.romsRoot, folder, f.destName))));
    if (there || (it.romId && games.has(gameOf.get(it.romId) ?? -1)) || (it.sha1 && contents.has(it.sha1))) have++;
  }
  return { have, total };
}

devicesRouter.get('/:id/inventory', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const rows = await prisma.deviceRom.findMany({ where: { deviceId: d.id }, orderBy: [{ systemSlug: 'asc' }, { path: 'asc' }] });
  const ownedRoms = await ownedRomIds({ romIds: [...new Set(rows.flatMap((r) => (r.romId ? [r.romId] : [])))], include: 'any' });
  const ownedGames = await ownedGameIds();
  const games = await prisma.game.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.gameId, r.baseGameId].filter((x): x is number => !!x)))] } }, select: { id: true, title: true, systemId: true } });
  const gameById = new Map(games.map((g) => [g.id, g]));
  const systems = await prisma.system.findMany({ select: { id: true, slug: true, name: true } });
  const sysName = new Map(systems.map((x) => [x.slug, x.name]));
  const sysById = new Map(systems.map((x) => [x.id, x]));
  const pending = new Set((await prisma.devicePull.findMany({ where: { deviceId: d.id, status: { in: QUEUED_PULL } }, select: { path: true } })).map((p) => p.path));
  const sizes = await catalogSizes(rows);
  const romsBase = path.posix.join(d.rootPath, layoutOf(d).romsRoot) + '/';
  // Hacks and other unidentified files already stored on the server, by their content
  const loose = rows.flatMap((r) => (!r.gameId && r.sha1 ? [r.sha1] : []));
  const stored = new Set(loose.length ? (await prisma.romFile.findMany({ where: { sha1: { in: loose } }, select: { sha1: true } })).map((f) => f.sha1) : []);
  const items = rows.map((r) => {
    const game = r.gameId ? gameById.get(r.gameId) : undefined;
    const base = r.baseGameId ? gameById.get(r.baseGameId) : undefined;
    // Identified games (and hacks, by their game) know their system even in folders the firmware map does not list
    const sys = r.systemSlug ?? ((game ?? base) ? sysById.get((game ?? base)!.systemId)?.slug : undefined) ?? null;
    const folder = r.path.startsWith(romsBase) ? r.path.slice(romsBase.length).split('/')[0] : null;
    return {
      id: r.id,
      path: r.path,
      name: path.posix.basename(r.path),
      size: sizes.get(r.path) ?? 0,
      system: sys,
      systemName: sys ? (sysName.get(sys) ?? sys) : null,
      folder,
      gameId: r.gameId,
      gameTitle: game?.title ?? null,
      // A hack or translation: the game it was made from, by the product code in its header
      baseGameId: r.baseGameId,
      baseTitle: r.baseGameId ? (gameById.get(r.baseGameId)?.title ?? null) : null,
      serial: r.serial,
      onServer: !!((r.romId && ownedRoms.has(r.romId)) || (r.gameId && ownedGames.has(r.gameId)) || (!r.gameId && r.sha1 && stored.has(r.sha1))),
      pullPending: pending.has(r.path),
    };
  });
  // What the console would add: games a database knows and the collection lacks
  const helpful = items.filter((i) => i.gameId && !i.onServer);
  const newGames = new Set(helpful.map((i) => i.gameId!));
  const consoleSystems = [...new Set(items.flatMap((i) => (i.system ? [i.system] : [])))].map((slug) => systems.find((x) => x.slug === slug)?.id).filter((x): x is number => !!x);
  const catalogTotal = await prisma.game.count();
  const systemsTotal = consoleSystems.length ? await prisma.game.count({ where: { systemId: { in: consoleSystems } } }) : 0;
  const ownedInSystems = consoleSystems.length ? await prisma.game.count({ where: { id: { in: [...ownedGames] }, systemId: { in: consoleSystems } } }) : 0;
  res.json({
    allowPull: d.allowPull,
    inventoryAt: d.inventoryAt,
    // Where its client looks for roms, to tell when it found none
    romsDir: path.posix.join(d.rootPath, layoutOf(d).romsRoot),
    summary: {
      newGames: newGames.size,
      newFiles: helpful.length,
      newBytes: helpful.reduce((n, i) => n + i.size, 0),
      waiting: helpful.filter((i) => i.pullPending).length,
      unidentified: items.filter((i) => !i.gameId && !i.baseGameId && !i.onServer && i.system).length,
      hacks: items.filter((i) => i.baseGameId && !i.onServer).length,
      collection: { total: catalogTotal, before: ownedGames.size, after: ownedGames.size + newGames.size },
      consoleSystems: { total: systemsTotal, before: ownedInSystems, after: ownedInSystems + newGames.size },
    },
    items,
  });
});

// Ask the client to sync (and send its inventory) at its next poll, within seconds
devicesRouter.post('/:id/refresh', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  await prisma.device.update({ where: { id: d.id }, data: { wantSyncAt: new Date() } });
  res.status(202).json({ ok: true });
});

const pullBody = z.object({
  paths: z.array(z.string().max(1024)).max(5000).optional(),
  system: z.string().max(32).optional(),
  identified: z.boolean().optional(),
  // The copy window's choice: identified games of these systems, and unidentified files of these other ones
  // ("" for files in no system's folder); unidentified: all unidentified files
  systems: z.array(z.string().max(32)).max(500).optional(),
  unidentifiedSystems: z.array(z.string().max(32)).max(500).optional(),
  // Hacks and translations (files whose header names the game they were made from) of these systems
  hackSystems: z.array(z.string().max(32)).max(500).optional(),
  unidentified: z.boolean().optional(),
});

/** The device's roms a copy request covers that the server lacks and has not queued yet, with their system */
async function pullRows(d: Device, body: z.infer<typeof pullBody>) {
  const rows = await prisma.deviceRom.findMany({
    where: { deviceId: d.id, ...(body.paths ? { path: { in: body.paths } } : {}), ...(body.system ? { systemSlug: body.system } : {}), ...(body.identified ? { gameId: { not: null } } : {}) },
  });
  // A game's system when its folder named none (the same rule as the inventory)
  const games = await prisma.game.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.gameId, r.baseGameId].filter((x): x is number => !!x)))] } }, select: { id: true, system: { select: { slug: true } } } });
  const slugOf = new Map(games.map((g) => [g.id, g.system.slug]));
  const withSystem = rows.map((r) => ({ ...r, system: r.systemSlug ?? slugOf.get(r.gameId ?? r.baseGameId ?? 0) ?? null }));
  const systems = body.systems ? new Set(body.systems) : null;
  const unidentified = new Set(body.unidentifiedSystems ?? []);
  const hacks = new Set(body.hackSystems ?? []);
  // Files of no system (ports, apps) have nowhere to go on the server
  const chosen = systems
    ? withSystem.filter((r) => !!r.system).filter((r) => (r.gameId ? systems.has(r.system ?? '') : r.baseGameId ? hacks.has(r.system ?? '') : !!body.unidentified || unidentified.has(r.system ?? '')))
    : withSystem;
  // Hacks and other unidentified files the server already holds, by their content
  const sha1s = chosen.flatMap((r) => (!r.gameId && r.sha1 ? [r.sha1] : []));
  const stored = new Set(sha1s.length ? (await prisma.romFile.findMany({ where: { sha1: { in: sha1s } }, select: { sha1: true } })).map((f) => f.sha1) : []);
  const ownedRoms = await ownedRomIds({ romIds: [...new Set(chosen.flatMap((r) => (r.romId ? [r.romId] : [])))], include: 'any' });
  const ownedGames = await ownedGameIds();
  const pending = new Set((await prisma.devicePull.findMany({ where: { deviceId: d.id, status: { in: QUEUED_PULL } }, select: { path: true } })).map((p) => p.path));
  // Explicit paths are fetched even if the game is owned (another version); bulk requests only bring what is missing
  return chosen.filter((r) => !pending.has(r.path) && (body.paths || !((r.romId && ownedRoms.has(r.romId)) || (r.gameId && ownedGames.has(r.gameId)) || (r.sha1 && stored.has(r.sha1)))));
}

// Bring roms the server lacks from the device: given paths, a whole system, chosen systems or everything missing
devicesRouter.post('/:id/pull', requirePerm('roms.upload'), async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  if (!d.allowPull) throw forbidden();
  const wanted = await pullRows(d, pullBody.parse(req.body));
  if (wanted.length) await prisma.devicePull.createMany({ data: wanted.map((r) => ({ deviceId: d.id, path: r.path })) });
  res.status(202).json({ queued: wanted.length });
});

// Where a copy would land: every destination folder of the server, what each would get and what would not fit
devicesRouter.post('/:id/pull-preview', requirePerm('roms.upload'), async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const rows = await pullRows(d, pullBody.parse(req.body));
  const sizes = await catalogSizes(rows);
  res.json(await previewPlacement(rows.map((r) => ({ system: r.system, size: sizes.get(r.path) ?? 0 }))));
});

/** File sizes by DeviceRom path: what the device reported, else the catalog's (older clients send none) */
async function catalogSizes(rows: { path: string; romId: number | null; size?: bigint }[]) {
  const romIds = [...new Set(rows.flatMap((r) => (r.romId ? [r.romId] : [])))];
  const parts = romIds.length ? await prisma.romPart.groupBy({ by: ['romId'], where: { romId: { in: romIds } }, _sum: { size: true } }) : [];
  const byRom = new Map(parts.map((p) => [p.romId, Number(p._sum.size ?? 0)]));
  return new Map(rows.map((r) => [r.path, Number(r.size ?? 0) || (r.romId ? (byRom.get(r.romId) ?? 0) : 0)]));
}

/** The copy in progress for one device (see GET /:id/pull-progress) */
async function pullProgress(d: Device) {
  const oldestOpen = await prisma.devicePull.findFirst({ where: { deviceId: d.id, status: { in: QUEUED_PULL } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
  // Nothing open: what finished in the last half hour (the last copy's outcome)
  const pulls = await prisma.devicePull.findMany({
    where: { deviceId: d.id, ...(oldestOpen ? { createdAt: { gte: oldestOpen.createdAt } } : { doneAt: { gte: new Date(Date.now() - 30 * 60_000) } }) },
    orderBy: { id: 'asc' },
  });
  const sizes = await catalogSizes(await prisma.deviceRom.findMany({ where: { deviceId: d.id, path: { in: pulls.map((p) => p.path) } }, select: { path: true, romId: true, size: true } }));
  const count = (st: string) => pulls.filter((p) => p.status === st).length;
  const bytes = (st: string[]) => pulls.filter((p) => st.includes(p.status)).reduce((n, p) => n + (sizes.get(p.path) ?? 0), 0);
  const sending = pulls.find((p) => pullTransfers.has(p.id));
  const live = sending ? pullTransfers.get(sending.id)! : null;
  return {
    active: !!oldestOpen,
    finishedAt: oldestOpen ? null : pulls.reduce<Date | null>((m, p) => (p.doneAt && (!m || p.doneAt > m) ? p.doneAt : m), null),
    total: pulls.length,
    done: count('done'),
    failed: count('failed'),
    open: pulls.length - count('done') - count('failed'),
    paused: count('paused'),
    bytesTotal: bytes(['pending', 'sending', 'paused', 'done', 'failed']),
    bytesDone: bytes(['done', 'failed']) + (live?.received ?? 0),
    current: sending && live ? { path: sending.path, name: path.posix.basename(sending.path), received: live.received, size: live.size || (sizes.get(sending.path) ?? 0), startedAt: live.startedAt } : null,
    // The daemon polls every 15 s; SSH lets the server resume by itself when the daemon is not running
    online: !!d.lastSeenAt && Date.now() - d.lastSeenAt.getTime() < 60_000,
    lastSeenAt: d.lastSeenAt,
    viaSsh: !!(d.sshHost && d.clientPath),
    failures: pulls.filter((p) => p.status === 'failed').slice(-5).map((p) => ({ name: path.posix.basename(p.path), result: p.result })),
  }
}

/**
 * The copy in progress: every request since the oldest one still open (or the last hour's when all are
 * finished), with bytes, the file being received right now and whether the console can be reached.
 */
devicesRouter.get('/:id/pull-progress', async (req, res) => {
  res.json(await pullProgress(await ownDevice(intParam(req), me(req))));
});

// Cancels what has not been sent yet (a transfer already under way finishes)
devicesRouter.delete('/:id/pulls', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const r = await prisma.devicePull.deleteMany({ where: { deviceId: d.id, status: { in: ['pending', 'paused'] } } });
  res.json({ cancelled: r.count });
});

// Pause: the console stops being offered what is left (the file under way finishes); resume hands it back
devicesRouter.post('/:id/pulls/pause', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const r = await prisma.devicePull.updateMany({ where: { deviceId: d.id, status: 'pending' }, data: { status: 'paused' } });
  res.json({ paused: r.count });
});

devicesRouter.post('/:id/pulls/resume', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const r = await prisma.devicePull.updateMany({ where: { deviceId: d.id, status: 'paused' }, data: { status: 'pending' } });
  res.json({ resumed: r.count });
});

devicesRouter.get('/:id/pulls', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  res.json(await prisma.devicePull.findMany({ where: { deviceId: d.id }, orderBy: { id: 'desc' }, take: 100 }));
});

// Send games straight to a device: they go to its own list, which the device keeps
devicesRouter.post('/:id/send', requirePerm('roms.download'), async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const { gameIds } = z.object({ gameIds: z.array(z.number().int()).min(1).max(1000) }).parse(req.body);
  const name = `→ ${d.name}`;
  let list = await prisma.list.findFirst({ where: { ownerId: me(req).id, name, devices: { some: { deviceId: d.id } } } });
  if (!list) {
    list = await prisma.list.create({ data: { ownerId: me(req).id, name, description: `Roms sent directly to ${d.name}` } });
    await prisma.deviceList.create({ data: { deviceId: d.id, listId: list.id } });
  }
  const r = await prisma.listItem.createMany({ data: gameIds.map((gameId) => ({ listId: list.id, gameId, itemKey: `g${gameId}` })), skipDuplicates: true });
  res.status(201).json({ listId: list.id, added: r.count });
});

devicesRouter.get('/:id/lists-progress', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const rows = await prisma.deviceList.findMany({ where: { deviceId: d.id }, include: { list: { select: { id: true, name: true } } } });
  res.json(await Promise.all(rows.map(async (r) => ({ ...r.list, ...(await listProgress(r.list.id, d)) }))));
});

devicesRouter.get('/by-list/:listId/progress', async (req, res) => {
  const list = await loadList(intParam(req, 'listId'), me(req));
  const rows = await prisma.deviceList.findMany({ where: { listId: list.id, device: { userId: me(req).id } }, select: { deviceId: true } });
  const out = [];
  for (const r of rows) {
    const d = await ownDevice(r.deviceId, me(req));
    out.push({ deviceId: d.id, name: d.name, inventoryAt: d.inventoryAt, ...(await listProgress(list.id, d)) });
  }
  res.json(out);
});

// The same assignment seen from a list: which of my sync clients keep it
devicesRouter.get('/by-list/:listId', async (req, res) => {
  const list = await loadList(intParam(req, 'listId'), me(req));
  const rows = await prisma.deviceList.findMany({ where: { listId: list.id, device: { userId: me(req).id } }, select: { deviceId: true } });
  res.json(rows.map((r) => r.deviceId));
});

devicesRouter.put('/by-list/:listId', requirePerm('roms.download'), async (req, res) => {
  const list = await loadList(intParam(req, 'listId'), me(req));
  const { deviceIds } = z.object({ deviceIds: z.array(z.number().int()).max(100) }).parse(req.body);
  const mine = await prisma.device.findMany({ where: { userId: me(req).id, connType: 'AGENT' }, select: { id: true } });
  const allowed = new Set(mine.map((d) => d.id));
  if (deviceIds.some((id) => !allowed.has(id))) throw forbidden();
  const before = await prisma.deviceList.findMany({ where: { listId: list.id, deviceId: { in: [...allowed] } }, select: { deviceId: true } });
  const had = new Set(before.map((r) => r.deviceId));
  const changed = [...allowed].filter((id) => had.has(id) !== deviceIds.includes(id));
  await prisma.$transaction([
    prisma.deviceList.deleteMany({ where: { listId: list.id, deviceId: { in: [...allowed] } } }),
    prisma.deviceList.createMany({ data: [...new Set(deviceIds)].map((deviceId) => ({ deviceId, listId: list.id })) }),
    // The consoles look at their lists again on their next poll
    prisma.device.updateMany({ where: { id: { in: changed } }, data: { wantSyncAt: new Date() } }),
  ]);
  res.json({ deviceIds });
});

// Lists whose roms a sync client keeps on the device
// Systems found in the device's lists, with how many games each brings, where they go and whether they are
// copied; "fresh" ones appeared after the filter was last saved
devicesRouter.get('/:id/list-systems', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const layout = layoutOf(d);
  const filter = systemFilterOf(d);
  const counts = new Map<string, number>();
  for (const { listId } of await prisma.deviceList.findMany({ where: { deviceId: d.id }, select: { listId: true } })) {
    for (const it of (await resolveListFiles(listId)).items) counts.set(it.systemSlug, (counts.get(it.systemSlug) ?? 0) + 1);
  }
  const systems = await prisma.system.findMany({ where: { slug: { in: [...counts.keys()] } }, select: { slug: true, name: true } });
  const saved = d.systemFilter != null;
  res.json({
    newAuto: filter.newAuto,
    systems: systems
      .map((s) => ({
        slug: s.slug,
        name: s.name,
        games: counts.get(s.slug) ?? 0,
        folder: path.posix.join(layout.romsRoot, folderFor(layout, s.slug)),
        copied: copiesSystem(filter, s.slug),
        fresh: saved && !filter.known.includes(s.slug) && !filter.excluded.includes(s.slug),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
});

// Saves the filter: the systems unticked, and whether systems that appear later are copied by themselves
// (games left out one by one are kept unless given)
devicesRouter.put('/:id/system-filter', requirePerm('roms.download'), async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const body = z
    .object({ newAuto: z.boolean(), excluded: z.array(z.string().max(32)).max(200), known: z.array(z.string().max(32)).max(200), excludedGames: z.array(z.number().int()).max(20000).optional() })
    .parse(req.body);
  const filter = {
    newAuto: body.newAuto,
    excluded: [...new Set(body.excluded)],
    known: [...new Set([...body.known, ...body.excluded])],
    excludedGames: body.excludedGames ? [...new Set(body.excludedGames)] : systemFilterOf(d).excludedGames,
  };
  await prisma.device.update({ where: { id: d.id }, data: { systemFilter: filter } });
  res.json(filter);
});

/**
 * Space on the device against what its lists would copy: a tree of systems and games by size, with what is
 * already there and what is left out, so the user can choose what not to copy when it does not fit
 */
devicesRouter.get('/:id/plan', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const plan = await devicePlan(d);
  const names = new Map((await prisma.system.findMany({ select: { slug: true, name: true } })).map((s) => [s.slug, s.name]));
  const filter = systemFilterOf(d);
  const bySystem = new Map<string, { games: Map<string, { gameId: number | null; title: string; bytes: number; present: boolean; excluded: boolean }> }>();
  for (const f of plan.files) {
    const s = bySystem.get(f.system) ?? { games: new Map() };
    const key = f.gameId ? `g${f.gameId}` : f.dest;
    const g = s.games.get(key) ?? { gameId: f.gameId, title: f.title, bytes: 0, present: true, excluded: f.excluded };
    g.bytes += f.size;
    g.present = g.present && f.present;
    s.games.set(key, g);
    bySystem.set(f.system, s);
  }
  const systems = [...bySystem].map(([slug, s]) => {
    const games = [...s.games.values()].sort((a, b) => b.bytes - a.bytes);
    return {
      slug,
      name: names.get(slug) ?? slug,
      excluded: !copiesSystem(filter, slug),
      bytes: games.reduce((n, g) => n + g.bytes, 0),
      missingBytes: games.filter((g) => !g.present && !g.excluded).reduce((n, g) => n + g.bytes, 0),
      games,
    };
  });
  res.json({
    reservePercent: d.reservePercent,
    free: plan.free,
    total: plan.total,
    reserveBytes: plan.reserveBytes,
    budget: plan.budget,
    missingBytes: plan.missingBytes,
    fits: plan.budget === null ? null : plan.missingBytes <= plan.budget,
    spaceAt: d.spaceAt,
    shortfall: d.spaceShortfall,
    systems: systems.sort((a, b) => b.bytes - a.bytes),
  });
});

// Free space kept on the device when copying list roms (5% by default)
devicesRouter.put('/:id/reserve', requirePerm('roms.download'), async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const { percent } = z.object({ percent: z.number().int().min(0).max(90) }).parse(req.body);
  res.json(await prisma.device.update({ where: { id: d.id }, data: { reservePercent: percent }, select: { id: true, reservePercent: true } }));
});

/**
 * Deleting the roms that are in none of the device's lists: the setting, whether the console has still to answer a
 * change made here, and what it would delete now (files the server has, files it would fetch first, files that
 * stay because the server cannot get them), with a held deletion waiting for confirmation.
 */
devicesRouter.get('/:id/prune', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const plan = d.inventoryAt ? await prunePlan(d) : null;
  const bytes = (files: { size: number }[]) => files.reduce((n, f) => n + f.size, 0);
  res.json({
    on: d.pruneRoms,
    remote: d.pruneRemote,
    held: d.pruneHeld,
    inventoryAt: d.inventoryAt,
    plan: plan && {
      del: plan.del.length,
      delBytes: bytes(plan.del),
      upload: plan.upload.length,
      uploadBytes: bytes(plan.upload),
      stuck: plan.stuck,
      total: plan.total,
      sample: [...plan.del, ...plan.upload].slice(0, 200).map((f) => path.posix.basename(f.path)),
    },
  });
});

// Changed here, the console asks its user at its next sync (and its answer is the final value)
devicesRouter.put('/:id/prune', requirePerm('roms.download'), async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const { on } = z.object({ on: z.boolean() }).parse(req.body);
  if (on !== d.pruneRoms || d.pruneRemote) await prisma.device.update({ where: { id: d.id }, data: { pruneRoms: on, pruneRemote: true, pruneAllow: null, pruneHeld: null } });
  res.json({ ok: true });
});

// A held deletion (more than half of the device's roms) goes ahead at the next pass
devicesRouter.post('/:id/prune/confirm', requirePerm('roms.download'), async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  if (d.pruneHeld === null) throw badRequest('Nothing held');
  await prisma.device.update({ where: { id: d.id }, data: { pruneAllow: d.pruneHeld } });
  res.json({ ok: true });
});

// What giving the device these lists would delete from it
devicesRouter.post('/:id/lists/preview', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const { listIds } = z.object({ listIds: z.array(z.number().int()).max(100) }).parse(req.body);
  res.json(await listsPreview(d, me(req), listIds));
});

devicesRouter.get('/:id/lists', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const rows = await prisma.deviceList.findMany({ where: { deviceId: d.id }, include: { list: { select: { id: true, name: true } } } });
  res.json(rows.map((r) => r.list));
});

devicesRouter.put('/:id/lists', requirePerm('roms.download'), async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const { listIds } = z.object({ listIds: z.array(z.number().int()).max(100) }).parse(req.body);
  res.json({ listIds: await setDeviceLists(d, me(req), listIds) });
});

devicesRouter.delete('/:id', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  await prisma.device.delete({ where: { id: d.id } });
  res.status(204).end();
});

devicesRouter.post('/:id/test', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  if (d.connType === 'AGENT') {
    res.json({ ok: !!d.lastSeenAt, lastSeenAt: d.lastSeenAt, romsFolders: [] });
    return;
  }
  try {
    const sink = await openSink(d);
    const layout = layoutOf(d);
    const roms = await sink.list(layout.romsRoot);
    await sink.close();
    res.json({ ok: true, romsFolders: roms.filter((e) => e.isDir).map((e) => e.name) });
  } catch (e) {
    res.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// Copies a list's roms to the device
// Token and event scripts for devices that sync on their own (ES-DE, Batocera, Knulli)
devicesRouter.post('/:id/token', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const token = crypto.randomBytes(24).toString('base64url');
  await prisma.device.update({ where: { id: d.id }, data: { tokenHash: sha256(token), tokenCreatedAt: new Date() } });
  res.status(201).json({ token });
});

// A key for one SD card of this device, for the desktop companion: the console keeps its own key
devicesRouter.post('/:id/card-token', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const { label } = z.object({ label: z.string().trim().min(1).max(128) }).parse(req.body);
  const token = crypto.randomBytes(24).toString('base64url');
  await prisma.deviceToken.create({ data: { deviceId: d.id, tokenHash: sha256(token), label } });
  res.status(201).json({ token, deviceId: d.id });
});

devicesRouter.delete('/:id/card-tokens', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const r = await prisma.deviceToken.deleteMany({ where: { deviceId: d.id } });
  res.json({ revoked: r.count });
});

devicesRouter.delete('/:id/token', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  await prisma.device.update({ where: { id: d.id }, data: { tokenHash: null, tokenCreatedAt: null } });
  res.status(204).end();
});

// Zip of the configured scripts; a new token is generated (the old one stops working)
devicesRouter.post('/:id/agent-script', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const { flavor, server } = z.object({ flavor: z.enum(['esde', 'batocera']), server: z.url() }).parse(req.body);
  const token = crypto.randomBytes(24).toString('base64url');
  await prisma.device.update({ where: { id: d.id }, data: { tokenHash: sha256(token), tokenCreatedAt: new Date() } });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="rommancer-${flavor}.zip"`);
  const zip = new ZipArchive({ zlib: { level: 6 } });
  zip.on('error', (e: Error) => res.destroy(e));
  zip.pipe(res);
  for (const f of scriptFiles(flavor, server, token, d.name)) zip.append(f.content, { name: f.path, mode: f.mode });
  await zip.finalize();
});

devicesRouter.post('/:id/transfer', requirePerm('roms.download'), async (req, res) => {
  const u = me(req);
  const d = await ownDevice(intParam(req), u);
  const body = z.object({ listId: z.number().int(), overwrite: z.boolean().default(false), dryRun: z.boolean().default(false) }).parse(req.body);
  await loadList(body.listId, u);
  res.status(202).json(await enqueue('transfer', { deviceId: d.id, ...body }, u.id));
});

registerJob('transfer', async (ctx) => {
  const { deviceId, listId, overwrite, dryRun } = ctx.params;
  const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId }, include: { firmware: true } });
  const layout = layoutOf(device);
  const { items, missing } = await resolveListFiles(listId);
  const total = items.reduce((n, i) => n + i.files.length, 0);
  ctx.log(`${items.length} items, ${total} files, ${missing.length} missing`);
  const plan: { dest: string; action: 'copy' | 'skip' }[] = [];
  const sink = dryRun ? null : await openSink(device);
  let done = 0;
  let copied = 0;
  let skipped = 0;
  const touched = new Set<string>();
  try {
    for (const it of items) {
      const folder = it.folder ?? layout.systemMap[it.systemSlug]?.folder ?? it.systemSlug;
      for (const f of it.files) {
        const dest = path.posix.join(layout.romsRoot, folder, f.destName);
        if (dryRun) {
          plan.push({ dest, action: 'copy' });
          continue;
        }
        const existing = await sink!.stat(dest);
        if (existing && !overwrite) {
          skipped++;
          plan.push({ dest, action: 'skip' });
        } else {
          if (f.archiveEntry) await sink!.putStream(extractEntryStream(f.absPath, f.archiveEntry), dest);
          else await sink!.putFile(f.absPath, dest);
          copied++;
          touched.add(path.posix.join(layout.romsRoot, folder));
          plan.push({ dest, action: 'copy' });
          ctx.log(`Copied ${dest}`);
        }
        await ctx.progress(++done, total, dest);
      }
    }
    if (sink) await clearListCaches(sink, touched);
  } finally {
    await sink?.close();
  }
  return { copied, skipped, missing, plan };
});
