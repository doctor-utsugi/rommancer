import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { Prisma } from '@prisma/client';
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
import { SOURCES, forceSync } from '../sync/service.js';
import { addRomRule, resolveRomGroups } from '../grouping/service.js';
import { resolveWorks } from '../sync/wikidata.js';
import { identifyHacks, linkFileAsHack } from '../hacks/identify.js';
import { setSignupOpen, signupOpen } from '../auth/routes.js';

registerJob('scan', async (ctx) => scanPath(ctx.params.romPathId, ctx, !!ctx.params.force));
registerJob('rematch', async () => rematchAll());
registerJob('hack-identify', async (ctx) => identifyHacks({ recheck: !!ctx.params.recheck }, ctx));
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
  const result = await importDat(text, { systemId, type, fileName: fileName ?? (file ? path.basename(file) : undefined), force: !!ctx.params.force, resolve: !ctx.params.skipRematch });
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
  // Destino de roms nuevas: sistemas que recibe, predeterminada para el resto y esquema de carpetas
  targetSystems: z.array(z.string()).nullable().optional(),
  isDefaultTarget: z.boolean().optional(),
  targetScheme: z.string().max(32).optional(),
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
  if (body.isDefaultTarget) await prisma.romPath.updateMany({ data: { isDefaultTarget: false } });
  res.status(201).json(await prisma.romPath.create({ data: { ...body, targetSystems: body.targetSystems ?? undefined, path: abs } }));
});

adminRouter.patch('/paths/:id', async (req, res) => {
  const body = pathBody.partial().parse(req.body);
  if (body.path) {
    body.path = path.resolve(body.path);
    await checkDir(body.path);
  }
  if (body.isDefaultTarget) await prisma.romPath.updateMany({ data: { isDefaultTarget: false } });
  const { targetSystems, ...rest } = body;
  res.json(await prisma.romPath.update({ where: { id: intParam(req) }, data: { ...rest, ...(targetSystems !== undefined ? { targetSystems: targetSystems ?? Prisma.DbNull } : {}) } }));
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

// Los datos externos son permanentes: un DAT no se borra (se reimporta o se actualiza)
adminRouter.delete('/dats/:id', async () => {
  throw badRequest('DATs are permanent');
});

// Vuelve a evaluar por contenido los ficheros desconocidos y los romhacks enlazados por titulo
adminRouter.post('/hacks/identify', async (req, res) => {
  const { recheck } = z.object({ recheck: z.boolean().default(false) }).parse(req.body ?? {});
  res.status(202).json(await enqueue('hack-identify', { recheck }, me(req).id));
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
    thegamesdb: !!env.tgdb.apiKey,
    seed: fs.existsSync(env.seedDir),
  });
});

// --- Sincronizacion de fuentes externas ---
adminRouter.get('/sync', async (_req, res) => {
  const [states, jobs] = await Promise.all([
    prisma.sourceState.findMany({ orderBy: { key: 'asc' } }),
    prisma.job.findMany({ where: { type: 'external-sync' }, orderBy: { id: 'desc' }, take: 20, omit: { log: true } }),
  ]);
  res.json({ cron: env.externalSyncCron, sources: SOURCES, states, history: jobs });
});

adminRouter.post('/sync', async (req, res) => {
  const body = z.object({ sources: z.array(z.enum(SOURCES)).min(1).default([...SOURCES]), system: z.string().optional() }).parse(req.body ?? {});
  res.status(202).json(await forceSync(body.sources, body.system, me(req).id));
});

// --- Revision de agrupaciones ---
adminRouter.get('/review', async (req, res) => {
  const q = z.object({ kind: z.string().optional(), status: z.string().default('open'), systemId: z.coerce.number().int().optional() }).parse(req.query);
  const items = await prisma.reviewItem.findMany({
    where: { status: q.status, ...(q.kind ? { kind: q.kind } : {}), ...(q.systemId ? { systemId: q.systemId } : {}) },
    orderBy: { id: 'asc' },
    take: 200,
  });
  const gameIds = items.map((i) => i.gameId).filter((x): x is number => !!x);
  const romIds = items.flatMap((i) => ((i.payload as { romIds?: number[] }).romIds ?? []));
  const [games, roms] = await Promise.all([
    prisma.game.findMany({ where: { id: { in: gameIds } }, select: { id: true, title: true, system: { select: { slug: true } } } }),
    prisma.rom.findMany({ where: { id: { in: romIds } }, select: { id: true, name: true, gameId: true } }),
  ]);
  const lowConfidence = await prisma.game.count({ where: { groupConfidence: 'low' } });
  res.json({ lowConfidence, items: items.map((i) => ({ ...i, game: games.find((g) => g.id === i.gameId) ?? null, roms: roms.filter((r) => ((i.payload as { romIds?: number[] }).romIds ?? []).includes(r.id)) })) });
});

adminRouter.post('/review/:id', async (req, res) => {
  const body = z
    .object({
      // conflict: same/different; wikidata: link (qid) / none
      action: z.enum(['same', 'different', 'link', 'none', 'dismiss']),
      wikidataId: z.string().regex(/^Q\d+$/).optional(),
      // hack: rom base elegida (o solo el juego si no se sabe la base exacta)
      romId: z.number().int().optional(),
      gameId: z.number().int().optional(),
    })
    .parse(req.body);
  const item = await prisma.reviewItem.findUniqueOrThrow({ where: { id: intParam(req) } });
  const u = me(req);
  const payload = item.payload as { romIds?: number[]; candidates?: { qid: string }[] };
  if (item.kind === 'conflict' && (body.action === 'same' || body.action === 'different') && payload.romIds?.length) {
    await addRomRule(body.action, payload.romIds, u.id);
    if (item.systemId) await resolveRomGroups(item.systemId);
  }
  if (item.kind === 'wikidata' && item.gameId) {
    if (body.action === 'link' && body.wikidataId) {
      await prisma.groupingRule.create({ data: { kind: 'game-work', rule: 'same', aGameId: item.gameId, wikidataId: body.wikidataId, userId: u.id } });
    } else if (body.action === 'none') {
      for (const c of payload.candidates ?? []) await prisma.groupingRule.create({ data: { kind: 'game-work', rule: 'different', aGameId: item.gameId, wikidataId: c.qid, userId: u.id } });
    }
    await resolveWorks(item.systemId ?? undefined);
  }
  if (item.kind === 'hack') {
    const p = item.payload as { fileId: number };
    if (body.action === 'link' && (body.romId || body.gameId)) {
      const rom = body.romId ? await prisma.rom.findUniqueOrThrow({ where: { id: body.romId } }) : null;
      await linkFileAsHack(p.fileId, { romId: rom?.id ?? null, gameId: rom?.gameId ?? body.gameId! }, 'manual');
    } else if (body.action === 'none') {
      // No es un romhack de ningun juego conocido: si estaba enlazado solo por titulo, se desenlaza
      const f = await prisma.romFile.findUnique({ where: { id: p.fileId }, include: { romHack: true } });
      if (f?.romHack && f.romHack.baseEvidence === 'title') {
        await prisma.romFile.update({ where: { id: f.id }, data: { status: 'UNKNOWN', romHackId: null } });
        const left = await prisma.romHack.findUnique({ where: { id: f.romHack.id }, include: { _count: { select: { files: true, patches: true, listItems: true } } } });
        if (left && !left._count.files && !left._count.patches && !left._count.listItems) await prisma.romHack.delete({ where: { id: left.id } });
      }
    }
  }
  await prisma.reviewItem.update({ where: { id: item.id }, data: { status: body.action === 'dismiss' ? 'dismissed' : 'resolved', resolvedAt: new Date(), resolvedBy: u.id } });
  await scheduleSeedExport();
  res.status(204).end();
});

// Enlace manual de un juego con un elemento de Wikidata (o desenlace)
adminRouter.post('/games/:id/work', async (req, res) => {
  const { wikidataId } = z.object({ wikidataId: z.string().regex(/^Q\d+$/).nullable() }).parse(req.body);
  const game = await prisma.game.findUniqueOrThrow({ where: { id: intParam(req) } });
  await prisma.groupingRule.deleteMany({ where: { kind: 'game-work', aGameId: game.id, rule: 'same' } });
  if (wikidataId) await prisma.groupingRule.create({ data: { kind: 'game-work', rule: 'same', aGameId: game.id, wikidataId, userId: me(req).id } });
  else {
    if (game.wikidataId) await prisma.groupingRule.create({ data: { kind: 'game-work', rule: 'different', aGameId: game.id, wikidataId: game.wikidataId, userId: me(req).id } });
    await prisma.game.update({ where: { id: game.id }, data: { workId: null, wikidataId: null } });
  }
  res.json(await resolveWorks(game.systemId));
});

adminRouter.get('/settings/signup', async (_req, res) => {
  res.json({ open: await signupOpen() });
});

adminRouter.put('/settings/signup', async (req, res) => {
  const { open } = z.object({ open: z.boolean() }).parse(req.body);
  await setSignupOpen(open);
  res.json({ open });
});
