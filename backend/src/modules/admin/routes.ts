import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { badRequest, intParam } from '../../lib/http.js';
import { enqueue, registerJob } from '../../lib/jobs.js';
import { me, requireAdmin } from '../auth/middleware.js';
import { importDat } from '../dats/importer.js';
import { DAT_PRESETS } from '../dats/presets.js';
import { applySeed, exportSeed, scheduleSeedExport } from '../seed/service.js';
import { rematchAll, scanPath } from '../scanner/service.js';
import { applyOrganize, planOrganize } from '../roms/organize.js';

registerJob('scan', async (ctx) => scanPath(ctx.params.romPathId, ctx, !!ctx.params.force));
registerJob('rematch', async () => rematchAll());
registerJob('seed-export', async (ctx) => exportSeed(ctx));
registerJob('seed-apply', async (ctx) => applySeed(ctx));
registerJob('dat-import', async (ctx) => {
  const { file, systemId, type, fileName, url } = ctx.params;
  let text: string;
  if (url) {
    ctx.log(`Downloading ${url}`);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Download failed: ${r.status}`);
    text = await r.text();
    const name = fileName ?? decodeURIComponent(url.split('/').pop() ?? 'download.dat');
    await fs.promises.mkdir(env.datsDir, { recursive: true });
    await fs.promises.writeFile(path.join(env.datsDir, path.basename(name)), text);
  } else {
    text = await fs.promises.readFile(file, 'utf8');
  }
  const result = await importDat(text, { systemId, type, fileName: fileName ?? (file ? path.basename(file) : undefined), force: !!ctx.params.force });
  ctx.log(`Imported: ${JSON.stringify(result)}`);
  if ((!result.skipped || ctx.params.forceRematch) && !ctx.params.skipRematch) {
    ctx.log('Rematching files');
    await rematchAll();
  }
  if (!ctx.params.skipRematch && (!result.skipped || ctx.params.forceRematch)) await scheduleSeedExport();
  return result;
});

export const adminRouter = Router();
adminRouter.use(requireAdmin);

// --- Rutas de roms ---
const pathBody = z.object({
  label: z.string().min(1).max(128),
  path: z.string().min(1).max(700),
  systemId: z.number().int().nullable().optional(),
  isUploadTarget: z.boolean().optional(),
  readOnly: z.boolean().optional(),
});

adminRouter.get('/paths', async (_req, res) => {
  const paths = await prisma.romPath.findMany({ orderBy: { id: 'asc' } });
  const counts = await prisma.romFile.groupBy({ by: ['romPathId', 'status'], _count: true });
  res.json(
    paths.map((p) => ({
      ...p,
      files: Object.fromEntries(counts.filter((c) => c.romPathId === p.id).map((c) => [c.status, c._count])),
    })),
  );
});

async function checkDir(p: string) {
  const st = await fs.promises.stat(p).catch(() => null);
  if (!st?.isDirectory()) throw badRequest(`Not a directory: ${p}`);
}

adminRouter.post('/paths', async (req, res) => {
  const body = pathBody.parse(req.body);
  const abs = path.resolve(body.path);
  await checkDir(abs);
  if (body.isUploadTarget) await prisma.romPath.updateMany({ data: { isUploadTarget: false } });
  res.status(201).json(await prisma.romPath.create({ data: { ...body, path: abs } }));
});

adminRouter.patch('/paths/:id', async (req, res) => {
  const body = pathBody.partial().parse(req.body);
  if (body.path) {
    body.path = path.resolve(body.path);
    await checkDir(body.path);
  }
  if (body.isUploadTarget) await prisma.romPath.updateMany({ data: { isUploadTarget: false } });
  res.json(await prisma.romPath.update({ where: { id: intParam(req) }, data: body }));
});

adminRouter.delete('/paths/:id', async (req, res) => {
  await prisma.romPath.delete({ where: { id: intParam(req) } });
  res.status(204).end();
});

adminRouter.post('/paths/:id/scan', async (req, res) => {
  const { force } = z.object({ force: z.boolean().default(false) }).parse(req.body ?? {});
  const romPathId = intParam(req);
  await prisma.romPath.findUniqueOrThrow({ where: { id: romPathId } });
  res.status(202).json(await enqueue('scan', { romPathId, force }, me(req).id));
});

adminRouter.get('/paths/:id/organize', async (req, res) => {
  const scheme = z.string().default('rename').parse(req.query.scheme);
  res.json(await planOrganize(intParam(req), scheme));
});

adminRouter.post('/paths/:id/organize', async (req, res) => {
  const { scheme } = z.object({ scheme: z.string() }).parse(req.body);
  res.json(await applyOrganize(intParam(req), scheme));
});

// --- DATs ---
const upload = multer({ dest: path.join(env.tmpDir, 'uploads'), limits: { fileSize: 512 * 1024 * 1024 } });

adminRouter.get('/dats', async (_req, res) => {
  res.json(await prisma.datSource.findMany({ include: { system: { select: { slug: true, name: true } } }, orderBy: [{ systemId: 'asc' }, { type: 'asc' }] }));
});

adminRouter.get('/dats/files', async (_req, res) => {
  await fs.promises.mkdir(env.datsDir, { recursive: true });
  res.json((await fs.promises.readdir(env.datsDir)).filter((f) => /\.(dat|xml)$/i.test(f)));
});

const datOpts = z.object({
  systemId: z.coerce.number().int().optional(),
  type: z.enum(['NOINTRO', 'REDUMP', 'FBNEO', 'MAME', 'HACKS', 'OTHER']).optional(),
});

adminRouter.post('/dats/upload', upload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('Missing file');
  const opts = datOpts.parse(req.body);
  await fs.promises.mkdir(env.datsDir, { recursive: true });
  const dest = path.join(env.datsDir, path.basename(req.file.originalname));
  await fs.promises.rename(req.file.path, dest);
  res.status(202).json(await enqueue('dat-import', { file: dest, fileName: req.file.originalname, ...opts }, me(req).id));
});

adminRouter.post('/dats/import-file', async (req, res) => {
  const body = datOpts.extend({ file: z.string() }).parse(req.body);
  const file = path.join(env.datsDir, path.basename(body.file));
  if (!fs.existsSync(file)) throw badRequest('File not found');
  res.status(202).json(await enqueue('dat-import', { ...body, file }, me(req).id));
});

const ALLOWED_DAT_HOSTS = ['raw.githubusercontent.com', 'github.com'];

adminRouter.post('/dats/fetch', async (req, res) => {
  const body = datOpts.extend({ url: z.url() }).parse(req.body);
  if (!ALLOWED_DAT_HOSTS.includes(new URL(body.url).hostname)) throw badRequest('Host not allowed');
  res.status(202).json(await enqueue('dat-import', body, me(req).id));
});

adminRouter.get('/dats/presets', async (_req, res) => {
  const imported = await prisma.datSource.findMany({ include: { system: { select: { slug: true } } } });
  res.json(DAT_PRESETS.map((p) => ({ ...p, imported: imported.some((d) => d.system.slug === p.system && d.type === p.type) })));
});

// Descarga e importa varios DATs de libretro-database (todos si no se indican ids)
adminRouter.post('/dats/fetch-presets', async (req, res) => {
  const { ids, force } = z.object({ ids: z.array(z.string()).optional(), force: z.boolean().default(false) }).parse(req.body ?? {});
  const presets = DAT_PRESETS.filter((p) => !ids || ids.includes(p.id));
  const systems = await prisma.system.findMany();
  const jobs = [];
  for (const [i, p] of presets.entries()) {
    const systemId = systems.find((s) => s.slug === p.system)?.id;
    jobs.push(
      await enqueue(
        'dat-import',
        { url: p.url, systemId, type: p.type, fileName: `${p.type.toLowerCase()} - ${decodeURIComponent(p.url.split('/').pop()!)}`, skipRematch: i < presets.length - 1, forceRematch: i === presets.length - 1, force },
        me(req).id,
      ),
    );
  }
  res.status(202).json(jobs);
});

adminRouter.delete('/dats/:id', async (req, res) => {
  await prisma.datSource.delete({ where: { id: intParam(req) } });
  await prisma.game.deleteMany({ where: { roms: { none: {} }, hacks: { none: {} }, listItems: { none: {} } } });
  res.status(202).json(await enqueue('rematch', {}, me(req).id));
});

adminRouter.post('/rematch', async (req, res) => {
  res.status(202).json(await enqueue('rematch', {}, me(req).id));
});

// --- Semilla ---
adminRouter.post('/seed/export', async (req, res) => {
  res.status(202).json(await enqueue('seed-export', {}, me(req).id));
});

adminRouter.post('/seed/apply', async (req, res) => {
  res.status(202).json(await enqueue('seed-apply', {}, me(req).id));
});

// --- Ajustes globales ---
adminRouter.get('/tools', async (_req, res) => {
  const { hasTool } = await import('../../lib/tools.js');
  res.json({
    chdman: await hasTool(env.bins.chdman),
    sevenZip: await hasTool(env.bins.sevenZip),
    screenscraper: !!(env.screenscraper.devId && env.screenscraper.user),
    retroachievements: !!env.ra.apiKey,
    seed: fs.existsSync(env.seedDir),
  });
});
