import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { Prisma } from '@prisma/client';
import multer from 'multer';
import { z } from 'zod';
import { acceptsUnknownFiles, setAcceptsUnknownFiles } from '../roms/destination.js';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { badRequest, intParam, HttpError } from '../../lib/http.js';
import { enqueue, registerJob } from '../../lib/jobs.js';
import { me, requireAdmin } from '../auth/middleware.js';
import { importDat } from '../dats/importer.js';
import { DAT_PRESETS } from '../dats/presets.js';
import { applySeed, exportSeed, scheduleSeedExport } from '../seed/service.js';
import { rematchAll, scanPath } from '../scanner/service.js';
import { applyOrganize, planOrganize, undoOrganize } from '../roms/organize.js';
import { SOURCES, forceSync, raCatalogKey } from '../sync/service.js';
import { addRomRule, resolveRomGroups } from '../grouping/service.js';
import { resolveWorks } from '../sync/wikidata.js';
import { identifyHacks, linkFileAsHack } from '../hacks/identify.js';
import { SESSION_MIN_DAYS, sessionDays, setSessionDays, setSignupOpen, signupOpen } from '../auth/routes.js';
import { HISTORY_KEY, saveHistory } from '../saves/service.js';

registerJob('scan', async (ctx) => scanPath(ctx.params.romPathId, ctx, !!ctx.params.force, !!ctx.params.allowMassRemoval));
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

import { MARKER, refreshHealth, registerIdentity, volumeKey } from '../storage/health.js';
import { storageRouter } from '../storage/routes.js';
import { LOCALE_CODES, defaultLocale, localeSchema, setDefaultLocale } from '../../lib/locales.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);
adminRouter.use('/storage', storageRouter);

// --- Rom paths ---
const pathBody = z.object({
  label: z.string().min(1).max(128),
  path: z.string().min(1).max(700),
  systemId: z.number().int().nullable().optional(),
  // Destination of new roms: the systems it takes, the default for the rest and the folder scheme
  targetSystems: z.array(z.string()).nullable().optional(),
  isDefaultTarget: z.boolean().optional(),
  targetScheme: z.string().max(32).optional(),
  readOnly: z.boolean().optional(),
  reservePercent: z.number().int().min(0).max(90).optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  // Folder name -> system slug for folders whose name says nothing
  folderSystems: z.record(z.string().max(255), z.string().max(32)).nullable().optional(),
});

adminRouter.get('/paths', async (_req, res) => {
  const paths = await prisma.romPath.findMany({ orderBy: [{ priority: 'asc' }, { id: 'asc' }] });
  const counts = await prisma.romFile.groupBy({ by: ['romPathId', 'status'], _count: true });
  const sizes = await prisma.romFile.groupBy({ by: ['romPathId'], _sum: { fileSize: true } });
  res.json(
    await Promise.all(
      paths.map(async (p) => {
        const known = counts.filter((c) => c.romPathId === p.id).reduce((n, c) => n + c._count, 0);
        const health = await refreshHealth(p, known);
        return {
          ...p,
          ...(await prisma.romPath.findUnique({ where: { id: p.id }, select: { offlineAt: true, offlineReason: true, volumeId: true } })),
          files: Object.fromEntries(counts.filter((c) => c.romPathId === p.id).map((c) => [c.status, c._count])),
          bytes: Number(sizes.find((s) => s.romPathId === p.id)?._sum.fileSize ?? 0),
          disk: health.online ? { free: health.free ?? 0, total: health.total ?? 0, key: await volumeKey(p.path) } : null,
        };
      }),
    ),
  );
});

/** Another registered folder inside or around P (scanning both would index the same files twice) */
async function overlapping(p: string, exceptId?: number) {
  const inside = (a: string, b: string) => a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
  return (await prisma.romPath.findMany()).find((r) => r.id !== exceptId && (inside(p, r.path) || inside(r.path, p)));
}

async function checkDir(p: string) {
  const st = await fs.promises.stat(p).catch(() => null);
  if (!st?.isDirectory()) throw badRequest(`Not a directory: ${p}`);
}

adminRouter.post('/paths', async (req, res) => {
  // create: a destination that does not exist yet (the wizard's general folder) is created
  const body = pathBody.extend({ allowOverlap: z.boolean().optional(), create: z.boolean().optional() }).parse(req.body);
  const abs = path.resolve(body.path);
  if (body.create && body.readOnly === false) await fs.promises.mkdir(abs, { recursive: true }).catch(() => {});
  await checkDir(abs);
  // The same folder mounted somewhere else (its marker names a registered folder): update that one instead
  const marker = (await fs.promises.readFile(path.join(abs, MARKER), 'utf8').catch(() => ''))?.trim();
  const same = marker ? await prisma.romPath.findFirst({ where: { volumeId: marker } }) : null;
  if (same && same.path !== abs) throw new HttpError(409, `SAME_FOLDER:${same.id}:${same.path}`);
  const clash = await overlapping(abs);
  if (clash && !body.allowOverlap) throw new HttpError(409, `OVERLAP:${clash.id}:${clash.path}`);
  const { allowOverlap: _o, create: _c, folderSystems, ...data } = body;
  // New folders are sources Rommancer only reads; writing there is an explicit choice
  const rp = await prisma.romPath.create({
    data: { ...data, readOnly: body.readOnly ?? !(body.isDefaultTarget || body.targetSystems?.length), targetSystems: body.targetSystems ?? undefined, folderSystems: folderSystems ?? undefined, path: abs },
  });
  res.status(201).json(await registerIdentity(rp));
});

// The folder moved (disk mounted elsewhere, another drive letter): same index, new path
adminRouter.post('/paths/:id/relink', async (req, res) => {
  const { path: p } = z.object({ path: z.string().min(1).max(700) }).parse(req.body);
  const abs = path.resolve(p);
  await checkDir(abs);
  const rp = await prisma.romPath.update({ where: { id: intParam(req) }, data: { path: abs, offlineAt: null, offlineReason: null } });
  res.json(await refreshHealth(rp));
});

adminRouter.patch('/paths/:id', async (req, res) => {
  const body = pathBody.partial().parse(req.body);
  if (body.path) {
    body.path = path.resolve(body.path);
    await checkDir(body.path);
  }
  const { targetSystems, folderSystems, ...rest } = body;
  const rp = await prisma.romPath.update({
    where: { id: intParam(req) },
    data: {
      ...rest,
      ...(targetSystems !== undefined ? { targetSystems: targetSystems ?? Prisma.DbNull } : {}),
      ...(folderSystems !== undefined ? { folderSystems: folderSystems ?? Prisma.DbNull } : {}),
    },
  });
  // Made writable: it gets its marker now
  res.json(body.readOnly === false || body.path ? await registerIdentity(rp) : rp);
});

adminRouter.delete('/paths/:id', async (req, res) => {
  await prisma.romPath.delete({ where: { id: intParam(req) } });
  res.status(204).end();
});

adminRouter.post('/paths/:id/scan', async (req, res) => {
  // allowMassRemoval: the user confirms that the files a previous scan held back really are gone
  const { force, allowMassRemoval } = z.object({ force: z.boolean().default(false), allowMassRemoval: z.boolean().default(false) }).parse(req.body ?? {});
  const romPathId = intParam(req);
  await prisma.romPath.findUniqueOrThrow({ where: { id: romPathId } });
  res.status(202).json(await enqueue('scan', { romPathId, force, allowMassRemoval }, me(req).id));
});

adminRouter.get('/paths/:id/organize', async (req, res) => {
  const scheme = z.string().default('rename').parse(req.query.scheme);
  res.json(await planOrganize(intParam(req), scheme));
});

adminRouter.post('/paths/:id/organize/undo', async (req, res) => {
  res.json(await undoOrganize(intParam(req)));
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

// Downloads and imports several libretro-database DATs (all when no ids are given)
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

// External data is permanent: a DAT is never deleted (it is reimported or updated)
adminRouter.delete('/dats/:id', async () => {
  throw badRequest('DATs are permanent');
});

// Re-evaluates unknown files by content, and romhacks linked only by title
adminRouter.post('/hacks/identify', async (req, res) => {
  const { recheck } = z.object({ recheck: z.boolean().default(false) }).parse(req.body ?? {});
  res.status(202).json(await enqueue('hack-identify', { recheck }, me(req).id));
});

adminRouter.post('/rematch', async (req, res) => {
  res.status(202).json(await enqueue('rematch', {}, me(req).id));
});

// --- Seed ---
adminRouter.post('/seed/export', async (req, res) => {
  res.status(202).json(await enqueue('seed-export', {}, me(req).id));
});

adminRouter.post('/seed/apply', async (req, res) => {
  res.status(202).json(await enqueue('seed-apply', {}, me(req).id));
});

// --- Global settings ---
adminRouter.get('/tools', async (_req, res) => {
  const { hasTool } = await import('../../lib/tools.js');
  res.json({
    chdman: await hasTool(env.bins.chdman),
    sevenZip: await hasTool(env.bins.sevenZip),
    screenscraper: !!(env.screenscraper.devId && env.screenscraper.user),
    retroachievements: !!(await raCatalogKey()),
    thegamesdb: !!env.tgdb.apiKey,
    seed: fs.existsSync(env.seedDir),
  });
});

// --- External source sync ---
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

// --- Grouping review ---
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
      // hack: the chosen base rom (or just the game when the exact base is unknown)
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
      // Not a romhack of any known game: if it was linked only by title, it is unlinked
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

// Manual link of a game to a Wikidata item (or unlink)
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

adminRouter.get('/settings/saves', async (_req, res) => {
  res.json({ history: await saveHistory() });
});

adminRouter.put('/settings/saves', async (req, res) => {
  const { history } = z.object({ history: z.number().int().min(1).max(500) }).parse(req.body);
  await prisma.setting.upsert({ where: { key: HISTORY_KEY }, create: { key: HISTORY_KEY, value: String(history) }, update: { value: String(history) } });
  res.json({ history });
});

adminRouter.get('/settings/session', async (_req, res) => {
  res.json({ days: await sessionDays(), min: SESSION_MIN_DAYS });
});

adminRouter.put('/settings/session', async (req, res) => {
  const { days } = z
    .object({ days: z.number().int().refine((d) => d === 0 || (d >= SESSION_MIN_DAYS && d <= 3650)) })
    .parse(req.body);
  await setSessionDays(days);
  res.json({ days, min: SESSION_MIN_DAYS });
});

adminRouter.get('/settings/locale', async (_req, res) => {
  res.json({ locale: await defaultLocale(), locales: LOCALE_CODES });
});

adminRouter.put('/settings/locale', async (req, res) => {
  const { locale } = z.object({ locale: localeSchema }).parse(req.body);
  await setDefaultLocale(locale);
  res.json({ locale, locales: LOCALE_CODES });
});

// Files of no system fetched from devices (app shortcuts, launcher files), kept in the library as unknown files
adminRouter.get('/settings/unknown-files', async (_req, res) => {
  res.json({ accept: await acceptsUnknownFiles() });
});

adminRouter.put('/settings/unknown-files', async (req, res) => {
  const { accept } = z.object({ accept: z.boolean() }).parse(req.body);
  await setAcceptsUnknownFiles(accept);
  res.json({ accept });
});

adminRouter.put('/settings/signup', async (req, res) => {
  const { open } = z.object({ open: z.boolean() }).parse(req.body);
  await setSignupOpen(open);
  res.json({ open });
});
