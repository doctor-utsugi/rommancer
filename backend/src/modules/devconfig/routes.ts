/** Web app side of device configuration: the user's console settings, and per device its copies and restores. */
import { Router } from 'express';
import { z } from 'zod';
import { ZipArchive } from 'archiver';
import { prisma } from '../../lib/prisma.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { badRequest, forbidden, HttpError, intParam } from '../../lib/http.js';
import { me, requirePerm, type AuthUser } from '../auth/middleware.js';
import { adapterFor } from './adapters.js';
import { bandsOf, editVersion, queueOp, raLogin, readBlob, settingsPending, wifiLeftOut } from './service.js';

export const configRouter = Router();

/** Devices that keep the settings applied sync soon (and quiet ones are reached over SSH) */
const touchDevices = (userId: number) => prisma.device.updateMany({ where: { userId, keepSettings: true }, data: { wantSyncAt: new Date() } });

const wifiView = (w: { id: number; ssid: string; password: string | null; band: string; hidden: boolean; priority: number }) => ({
  id: w.id,
  ssid: w.ssid,
  hasPassword: !!w.password,
  band: w.band,
  hidden: w.hidden,
  priority: w.priority,
});

configRouter.get('/settings/consoles', async (req, res) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: me(req).id }, include: { wifiNetworks: { orderBy: [{ priority: 'asc' }, { id: 'asc' }] } } });
  res.json({
    ra: { username: decrypt(u.raUser), hasPassword: !!u.raPassword, hasToken: !!u.raToken },
    wifi: u.wifiNetworks.map(wifiView),
  });
});

/** Checks the login with RetroAchievements and keeps it (the password too: Knulli needs it) */
configRouter.put('/settings/consoles/ra', async (req, res) => {
  const body = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(256) }).parse(req.body);
  const token = await raLogin(body.username, body.password);
  await prisma.user.update({ where: { id: me(req).id }, data: { raUser: encrypt(body.username), raPassword: encrypt(body.password), raToken: encrypt(token) } });
  await touchDevices(me(req).id);
  res.json({ username: body.username, hasPassword: true, hasToken: true });
});

configRouter.delete('/settings/consoles/ra', async (req, res) => {
  await prisma.user.update({ where: { id: me(req).id }, data: { raPassword: null, raToken: null } });
  res.status(204).end();
});

const wifiBody = z.object({
  ssid: z.string().min(1).max(32),
  // undefined: keep the stored one; null or "": open network
  password: z.string().max(63).nullable().optional(),
  band: z.enum(['2.4', '5', 'dual']).default('dual'),
  hidden: z.boolean().default(false),
});

const checkPass = (p: string | null | undefined) => {
  if (p && p.length < 8) throw badRequest('A WPA password has between 8 and 63 characters');
};

configRouter.post('/settings/consoles/wifi', async (req, res) => {
  const body = wifiBody.parse(req.body);
  checkPass(body.password);
  const userId = me(req).id;
  const last = await prisma.wifiNetwork.findFirst({ where: { userId }, orderBy: { priority: 'desc' } });
  const w = await prisma.wifiNetwork.create({
    data: { userId, ssid: body.ssid, password: body.password ? encrypt(body.password) : null, band: body.band, hidden: body.hidden, priority: (last?.priority ?? -1) + 1 },
  });
  await touchDevices(me(req).id);
  res.status(201).json(wifiView(w));
});

async function ownWifi(id: number, u: AuthUser) {
  const w = await prisma.wifiNetwork.findUnique({ where: { id } });
  if (!w || w.userId !== u.id) throw new HttpError(404, 'Unknown network');
  return w;
}

configRouter.patch('/settings/consoles/wifi/:id', async (req, res) => {
  const w = await ownWifi(intParam(req), me(req));
  const body = wifiBody.partial().parse(req.body);
  checkPass(body.password);
  const updated = await prisma.wifiNetwork.update({
    where: { id: w.id },
    data: {
      ...(body.ssid !== undefined ? { ssid: body.ssid } : {}),
      ...(body.password !== undefined ? { password: body.password ? encrypt(body.password) : null } : {}),
      ...(body.band !== undefined ? { band: body.band } : {}),
      ...(body.hidden !== undefined ? { hidden: body.hidden } : {}),
    },
  });
  await touchDevices(me(req).id);
  res.json(wifiView(updated));
});

configRouter.delete('/settings/consoles/wifi/:id', async (req, res) => {
  const w = await ownWifi(intParam(req), me(req));
  await prisma.wifiNetwork.delete({ where: { id: w.id } });
  await touchDevices(me(req).id);
  res.status(204).end();
});

/** New order: ids from first to last */
configRouter.put('/settings/consoles/wifi-order', async (req, res) => {
  const { ids } = z.object({ ids: z.array(z.number().int()).max(50) }).parse(req.body);
  const u = me(req);
  for (const [i, id] of ids.entries()) await prisma.wifiNetwork.updateMany({ where: { id, userId: u.id }, data: { priority: i } });
  res.status(204).end();
});

async function ownDevice(id: number, u: AuthUser) {
  const d = await prisma.device.findUniqueOrThrow({ where: { id }, include: { firmware: true, console: true } });
  if (d.userId !== u.id && u.role !== 'ADMIN') throw forbidden();
  return d;
}

const dev = Router({ mergeParams: true });
configRouter.use('/devices/:id/config', requirePerm('roms.download', 'saves'), dev);

dev.get('/', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const [ops, versions] = await Promise.all([
    prisma.deviceConfigOp.findMany({ where: { deviceId: d.id }, orderBy: { id: 'desc' }, take: 10, select: { id: true, kind: true, status: true, channel: true, error: true, versionId: true, createdAt: true, doneAt: true } }),
    prisma.deviceConfigVersion.findMany({ where: { deviceId: d.id }, orderBy: { id: 'desc' }, take: 40, select: { id: true, source: true, note: true, bytes: true, files: true, createdAt: true } }),
  ]);
  res.json({
    supported: !!adapterFor(d.firmware.slug),
    firmware: d.firmware.slug,
    keepSettings: d.keepSettings,
    wifiBands: bandsOf(d),
    wifiBandsSource: d.wifiBandsManual ? 'manual' : d.wifiBands ? 'device' : d.console?.wifiBands ? 'model' : null,
    wifiLeftOut: await wifiLeftOut(d),
    settingsPending: await settingsPending(d),
    settingsAt: d.settingsAt,
    settingsError: d.settingsError,
    ops,
    versions: versions.map((v) => ({ ...v, files: (v.files as unknown[]).length })),
  });
});

dev.patch('/', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const body = z.object({ keepSettings: z.boolean().optional(), wifiBands: z.enum(['none', '2.4', 'dual']).nullable().optional() }).parse(req.body);
  await prisma.device.update({
    where: { id: d.id },
    data: {
      ...(body.keepSettings !== undefined ? { keepSettings: body.keepSettings } : {}),
      // null: back to what the device reports (or its model)
      ...(body.wifiBands !== undefined ? { wifiBands: body.wifiBands, wifiBandsManual: body.wifiBands !== null } : {}),
    },
  });
  res.status(204).end();
});

/** Copy the device's configuration now (at its next sync, or over SSH if it is quiet) */
dev.post('/backup', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  if (!adapterFor(d.firmware.slug)) throw badRequest(`Rommancer does not know where ${d.firmware.name} keeps its configuration yet`);
  res.status(201).json(await queueOp(d.id, 'backup'));
});

/** Apply the user's settings again, even if they look applied */
dev.post('/apply', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  if (!adapterFor(d.firmware.slug)) throw badRequest(`Rommancer does not know where ${d.firmware.name} keeps its configuration yet`);
  await prisma.device.update({ where: { id: d.id }, data: { settingsHash: null } });
  res.status(201).json(await queueOp(d.id, 'settings'));
});

dev.delete('/ops/:op', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  await prisma.deviceConfigOp.deleteMany({ where: { id: intParam(req, 'op'), deviceId: d.id, status: 'pending' } });
  res.status(204).end();
});

async function ownVersion(req: Parameters<typeof intParam>[0]) {
  const d = await ownDevice(intParam(req), me(req));
  const v = await prisma.deviceConfigVersion.findUnique({ where: { id: intParam(req, 'v') } });
  if (!v || v.deviceId !== d.id) throw new HttpError(404, 'Unknown copy');
  return { d, v, files: v.files as { path: string; sha1: string; size: number }[] };
}

dev.get('/versions/:v', async (req, res) => {
  const { v, files } = await ownVersion(req);
  res.json({ ...v, files });
});

/** One file of a copy, as text (configuration files are) */
dev.get('/versions/:v/file', async (req, res) => {
  const { files } = await ownVersion(req);
  const f = files.find((x) => x.path === String(req.query.path ?? ''));
  if (!f) throw new HttpError(404, 'No such file in this copy');
  res.type('text/plain; charset=utf-8').send(await readBlob(f.sha1));
});

dev.get('/versions/:v/zip', async (req, res) => {
  const { d, v, files } = await ownVersion(req);
  res.attachment(`${d.name.replace(/[^\w.-]+/g, '_')}-config-${v.createdAt.toISOString().slice(0, 10)}-${v.id}.zip`);
  const zip = new ZipArchive({ zlib: { level: 6 } });
  zip.on('error', (e: Error) => res.destroy(e));
  zip.pipe(res);
  // Files outside the device root keep their place under "_root/"
  for (const f of files) zip.append(await readBlob(f.sha1), { name: f.path.startsWith('/') ? `_root${f.path}` : f.path });
  await zip.finalize();
});

/** Puts a copy (or some of its files) back on the device */
dev.post('/versions/:v/restore', async (req, res) => {
  const { d, v, files } = await ownVersion(req);
  const { paths } = z.object({ paths: z.array(z.string().max(512)).max(400).optional() }).parse(req.body ?? {});
  if (paths?.some((p) => !files.some((f) => f.path === p))) throw badRequest('Some files are not in this copy');
  res.status(201).json(await queueOp(d.id, 'restore', { versionId: v.id, paths }));
});

/** Changes one file of a copy and puts it on the device */
dev.put('/versions/:v/file', async (req, res) => {
  const { d, v } = await ownVersion(req);
  const body = z.object({ path: z.string().min(1).max(512), content: z.string().max(4 * 1024 * 1024) }).parse(req.body);
  const r = await editVersion(d, v.id, body.path, body.content);
  res.status(201).json({ versionId: r.version.id, opId: r.op.id });
});
