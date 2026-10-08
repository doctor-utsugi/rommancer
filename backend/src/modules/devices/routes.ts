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
import { copiesSystem, folderFor, layoutOf, openSink, systemFilterOf } from './sink.js';
import { ownedGameIds, ownedRomIds } from '../roms/service.js';
import { installClient, serverKey, syncOverSsh } from './ssh.js';
import { OPEN_PULL, pullTransfers } from '../saves/agent.js';

/** Requests not finished yet, including paused ones (the console is only offered the open ones) */
const QUEUED_PULL = [...OPEN_PULL, 'paused'];
import { createAgentDevice, publicBase } from '../link/routes.js';

export const devicesRouter = Router();
// Dispositivos: para copiar roms (descargar) o para sincronizar saves
devicesRouter.use(requirePerm('roms.download', 'saves'));

const publicDevice = { sshPassword: true, sshKey: true, tokenHash: true } as const;

/** Where each firmware's card or data lives, for consoles added over SSH */
const DEFAULT_ROOTS: Record<string, string> = { onion: '/mnt/SDCARD', knulli: '/userdata', batocera: '/userdata', rocknix: '/storage', muos: '/mnt/mmc' };

// --- Catalogo de consolas y firmwares ---
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
  savesLayout: z.enum(['flat', 'system', 'core', 'rom', 'rom-core', 'rom-saves', 'beside']),
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

// --- Dispositivos del usuario ---
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
      savesLayout: z.enum(['flat', 'system', 'core', 'rom', 'rom-core', 'rom-saves', 'beside']).optional(),
      systemMap: z.record(z.string(), z.object({ folder: z.string(), emulator: z.string() })).optional(),
    })
    .nullable()
    .optional(),
  syncSaves: z.boolean().optional(),
});

function deviceData(body: Partial<z.infer<typeof deviceBody>>) {
  const data: Record<string, unknown> = { ...body };
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
devicesRouter.get('/activity', async (req, res) => {
  const u = me(req);
  const queued = await prisma.devicePull.findMany({ where: { status: { in: QUEUED_PULL }, device: { userId: u.id } }, select: { deviceId: true }, distinct: ['deviceId'] });
  const devices = await prisma.device.findMany({ where: { id: { in: queued.map((q) => q.deviceId) } } });
  res.json(await Promise.all(devices.map(async (d) => ({ deviceId: d.id, name: d.name, ...(await pullProgress(d)) }))));
});

devicesRouter.get('/:id', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const { sshPassword, sshKey, tokenHash: _token, ...rest } = d;
  res.json({ ...rest, hasPassword: !!sshPassword, hasKey: !!sshKey, layout: layoutOf(d), games: await prisma.deviceRom.count({ where: { deviceId: d.id } }) });
});

devicesRouter.patch('/:id', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const body = deviceBody.partial().parse(req.body);
  res.json(await prisma.device.update({ where: { id: d.id }, data: deviceData(body) as Prisma.DeviceUncheckedUpdateInput, omit: publicDevice }));
});

// ---------- what a sync client has, and what the server asks of it ----------

const pathKey = (p: string) => crypto.createHash('sha1').update(p).digest('hex');

/** Share of a list already on a device: items whose files are at their destination or whose game it has. */
export async function listProgress(listId: number, device: Awaited<ReturnType<typeof ownDevice>>) {
  const layout = layoutOf(device);
  const root = device.rootPath.replace(/\/+$/, '');
  const { items } = await resolveListFiles(listId);
  const inv = await prisma.deviceRom.findMany({ where: { deviceId: device.id }, select: { pathHash: true, gameId: true } });
  const paths = new Set(inv.map((r) => r.pathHash));
  const games = new Set(inv.map((r) => r.gameId).filter(Boolean));
  const roms = items.length ? await prisma.rom.findMany({ where: { id: { in: items.flatMap((i) => (i.romId ? [i.romId] : [])) } }, select: { id: true, gameId: true } }) : [];
  const gameOf = new Map(roms.map((r) => [r.id, r.gameId]));
  let have = 0;
  let total = 0;
  const filter = systemFilterOf(device);
  for (const it of items) {
    if (!copiesSystem(filter, it.systemSlug)) continue; // left out for this device
    const folder = folderFor(layout, it.systemSlug);
    total++;
    const there = it.files.some((f) => paths.has(pathKey(path.posix.join(root, layout.romsRoot, folder, f.destName))));
    if (there || (it.romId && games.has(gameOf.get(it.romId) ?? -1))) have++;
  }
  return { have, total };
}

devicesRouter.get('/:id/inventory', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const rows = await prisma.deviceRom.findMany({ where: { deviceId: d.id }, orderBy: [{ systemSlug: 'asc' }, { path: 'asc' }] });
  const ownedRoms = await ownedRomIds({ romIds: [...new Set(rows.flatMap((r) => (r.romId ? [r.romId] : [])))], include: 'any' });
  const ownedGames = await ownedGameIds();
  const games = await prisma.game.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => (r.gameId ? [r.gameId] : [])))] } }, select: { id: true, title: true, systemId: true } });
  const gameById = new Map(games.map((g) => [g.id, g]));
  const systems = await prisma.system.findMany({ select: { id: true, slug: true, name: true } });
  const sysName = new Map(systems.map((x) => [x.slug, x.name]));
  const sysById = new Map(systems.map((x) => [x.id, x]));
  const pending = new Set((await prisma.devicePull.findMany({ where: { deviceId: d.id, status: { in: QUEUED_PULL } }, select: { path: true } })).map((p) => p.path));
  const sizes = await catalogSizes(rows);
  const romsBase = path.posix.join(d.rootPath.replace(/\/+$/, ''), layoutOf(d).romsRoot) + '/';
  const items = rows.map((r) => {
    const game = r.gameId ? gameById.get(r.gameId) : undefined;
    // Identified games know their system even in folders the firmware map does not list
    const sys = r.systemSlug ?? (game ? sysById.get(game.systemId)?.slug : undefined) ?? null;
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
      onServer: !!((r.romId && ownedRoms.has(r.romId)) || (r.gameId && ownedGames.has(r.gameId))),
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
    summary: {
      newGames: newGames.size,
      newFiles: helpful.length,
      newBytes: helpful.reduce((n, i) => n + i.size, 0),
      waiting: helpful.filter((i) => i.pullPending).length,
      unidentified: items.filter((i) => !i.gameId && !i.onServer).length,
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

// Bring roms the server lacks from the device: given paths, a whole system, or everything missing
devicesRouter.post('/:id/pull', requirePerm('roms.upload'), async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  if (!d.allowPull) throw forbidden();
  // identified: only games a database knows (what the device page offers to copy); otherwise everything missing
  const body = z.object({ paths: z.array(z.string().max(1024)).max(5000).optional(), system: z.string().max(32).optional(), identified: z.boolean().optional() }).parse(req.body);
  const rows = await prisma.deviceRom.findMany({
    where: { deviceId: d.id, ...(body.paths ? { path: { in: body.paths } } : {}), ...(body.system ? { systemSlug: body.system } : {}), ...(body.identified ? { gameId: { not: null } } : {}) },
  });
  const ownedRoms = await ownedRomIds({ romIds: [...new Set(rows.flatMap((r) => (r.romId ? [r.romId] : [])))], include: 'any' });
  const ownedGames = await ownedGameIds();
  const pending = new Set((await prisma.devicePull.findMany({ where: { deviceId: d.id, status: { in: QUEUED_PULL } }, select: { path: true } })).map((p) => p.path));
  // Explicit paths are fetched even if the game is owned (another version); bulk requests only bring what is missing
  const wanted = rows.filter((r) => !pending.has(r.path) && (body.paths || !((r.romId && ownedRoms.has(r.romId)) || (r.gameId && ownedGames.has(r.gameId)))));
  if (wanted.length) await prisma.devicePull.createMany({ data: wanted.map((r) => ({ deviceId: d.id, path: r.path })) });
  res.status(202).json({ queued: wanted.length });
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
  await prisma.$transaction([
    prisma.deviceList.deleteMany({ where: { listId: list.id, deviceId: { in: [...allowed] } } }),
    prisma.deviceList.createMany({ data: [...new Set(deviceIds)].map((deviceId) => ({ deviceId, listId: list.id })) }),
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
devicesRouter.put('/:id/system-filter', requirePerm('roms.download'), async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const body = z.object({ newAuto: z.boolean(), excluded: z.array(z.string().max(32)).max(200), known: z.array(z.string().max(32)).max(200) }).parse(req.body);
  const filter = { newAuto: body.newAuto, excluded: [...new Set(body.excluded)], known: [...new Set([...body.known, ...body.excluded])] };
  await prisma.device.update({ where: { id: d.id }, data: { systemFilter: filter } });
  res.json(filter);
});

devicesRouter.get('/:id/lists', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const rows = await prisma.deviceList.findMany({ where: { deviceId: d.id }, include: { list: { select: { id: true, name: true } } } });
  res.json(rows.map((r) => r.list));
});

devicesRouter.put('/:id/lists', requirePerm('roms.download'), async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const { listIds } = z.object({ listIds: z.array(z.number().int()).max(100) }).parse(req.body);
  for (const id of listIds) await loadList(id, me(req));
  await prisma.$transaction([
    prisma.deviceList.deleteMany({ where: { deviceId: d.id } }),
    prisma.deviceList.createMany({ data: [...new Set(listIds)].map((listId) => ({ deviceId: d.id, listId })) }),
  ]);
  res.json({ listIds });
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

// Copia las roms de una lista al dispositivo
// Token y scripts de eventos para dispositivos que sincronizan solos (ES-DE, Batocera, Knulli)
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

// Zip con los scripts ya configurados; el token se genera nuevo (el anterior deja de valer)
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
  try {
    for (const it of items) {
      const folder = layout.systemMap[it.systemSlug]?.folder ?? it.systemSlug;
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
          plan.push({ dest, action: 'copy' });
          ctx.log(`Copied ${dest}`);
        }
        await ctx.progress(++done, total, dest);
      }
    }
  } finally {
    await sink?.close();
  }
  return { copied, skipped, missing, plan };
});
