import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
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
import { layoutOf, openSink } from './sink.js';
import { ownedGameIds, ownedRomIds } from '../roms/service.js';
import { installClient, serverKey, syncOverSsh } from './ssh.js';
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
  savesLayout: z.enum(['flat', 'system', 'core', 'rom', 'rom-core', 'rom-saves']),
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
      savesLayout: z.enum(['flat', 'system', 'core', 'rom', 'rom-core', 'rom-saves']).optional(),
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
  for (const it of items) {
    const folder = layout.systemMap[it.systemSlug]?.folder;
    if (!folder) continue; // a system this console does not have
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
  const games = await prisma.game.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => (r.gameId ? [r.gameId] : [])))] } }, select: { id: true, title: true } });
  const title = new Map(games.map((g) => [g.id, g.title]));
  const systems = await prisma.system.findMany({ select: { slug: true, name: true } });
  const sysName = new Map(systems.map((x) => [x.slug, x.name]));
  const pending = new Set((await prisma.devicePull.findMany({ where: { deviceId: d.id, status: 'pending' }, select: { path: true } })).map((p) => p.path));
  res.json({
    allowPull: d.allowPull,
    inventoryAt: d.inventoryAt,
    items: rows.map((r) => ({
      id: r.id,
      path: r.path,
      name: path.posix.basename(r.path),
      system: r.systemSlug,
      systemName: r.systemSlug ? (sysName.get(r.systemSlug) ?? r.systemSlug) : null,
      gameId: r.gameId,
      gameTitle: r.gameId ? title.get(r.gameId) : null,
      onServer: !!((r.romId && ownedRoms.has(r.romId)) || (r.gameId && ownedGames.has(r.gameId))),
      pullPending: pending.has(r.path),
    })),
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
  const body = z.object({ paths: z.array(z.string().max(1024)).max(5000).optional(), system: z.string().max(32).optional() }).parse(req.body);
  const rows = await prisma.deviceRom.findMany({
    where: { deviceId: d.id, ...(body.paths ? { path: { in: body.paths } } : {}), ...(body.system ? { systemSlug: body.system } : {}) },
  });
  const ownedRoms = await ownedRomIds({ romIds: [...new Set(rows.flatMap((r) => (r.romId ? [r.romId] : [])))], include: 'any' });
  const ownedGames = await ownedGameIds();
  const pending = new Set((await prisma.devicePull.findMany({ where: { deviceId: d.id, status: 'pending' }, select: { path: true } })).map((p) => p.path));
  // Explicit paths are fetched even if the game is owned (another version); bulk requests only bring what is missing
  const wanted = rows.filter((r) => !pending.has(r.path) && (body.paths || !((r.romId && ownedRoms.has(r.romId)) || (r.gameId && ownedGames.has(r.gameId)))));
  if (wanted.length) await prisma.devicePull.createMany({ data: wanted.map((r) => ({ deviceId: d.id, path: r.path })) });
  res.status(202).json({ queued: wanted.length });
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
