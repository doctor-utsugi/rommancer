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

export const devicesRouter = Router();
// Dispositivos: para copiar roms (descargar) o para sincronizar saves
devicesRouter.use(requirePerm('roms.download', 'saves'));

const publicDevice = { sshPassword: true, sshKey: true } as const;

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
  savesLayout: z.enum(['flat', 'system', 'core', 'rom']),
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
      savesLayout: z.enum(['flat', 'system', 'core', 'rom']).optional(),
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
  const devices = await prisma.device.findMany({ where: { userId: u.id }, include: { console: true, firmware: true }, omit: publicDevice, orderBy: { name: 'asc' } });
  res.json(devices);
});

devicesRouter.post('/', async (req, res) => {
  const body = deviceBody.parse(req.body);
  if (body.connType === 'SSH' && (!body.sshHost || !body.sshUser)) throw badRequest('SSH host and user required');
  if (body.connType === 'LOCAL') body.rootPath = path.resolve(body.rootPath);
  const d = await prisma.device.create({ data: { ...(deviceData(body) as Prisma.DeviceUncheckedCreateInput), userId: me(req).id }, omit: publicDevice });
  res.status(201).json(d);
});

devicesRouter.get('/:id', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const { sshPassword, sshKey, ...rest } = d;
  res.json({ ...rest, hasPassword: !!sshPassword, hasKey: !!sshKey, layout: layoutOf(d) });
});

devicesRouter.patch('/:id', async (req, res) => {
  const d = await ownDevice(intParam(req), me(req));
  const body = deviceBody.partial().parse(req.body);
  res.json(await prisma.device.update({ where: { id: d.id }, data: deviceData(body) as Prisma.DeviceUncheckedUpdateInput, omit: publicDevice }));
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
