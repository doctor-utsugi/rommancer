import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import express, { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { me, requirePerm } from '../auth/middleware.js';
import { HttpError, badRequest } from '../../lib/http.js';
import { deviceFromToken, journeyLayout } from '../saves/agent.js';
import { blobPath, commit, createJourney, listJourneys, owned, slotOf, putBlob, revision, select } from './service.js';
import { HASH, UUID, identityKey, manifestText, parseManifest } from './manifest.js';

export const journeysRouter = Router();
export const journeysAgentRouter = Router();
journeysRouter.use(requirePerm('saves'));
const enc = (s: string) => Buffer.from(s).toString('base64');
const dec = (s: string = '') => Buffer.from(s, 'base64').toString('utf8');
const fields = (body: unknown) => String(body ?? '').trimEnd().split('\t');
const idSchema = z.string().regex(UUID);

async function validateAdapter(device: Awaited<ReturnType<typeof deviceFromToken>>, identityId: string) {
  const b = await prisma.journeyBinding.findUnique({ where: { deviceId_identityId: { deviceId: device.id, identityId } } });
  if (!b) throw badRequest('ROM not enrolled on this console');
  const current = await journeyLayout(device, b.romPath);
  const old = b.layout as Record<string, string>;
  if (['savePath', 'statePath', 'saveAdapter', 'stateAdapter'].some((key) => old[key] !== current[key as keyof typeof current]))
    throw new HttpError(409, 'Emulator paths or core version changed; preserve local progress and reconcile the adapter before switching');
}

journeysRouter.get('/migration-report', async (req, res) => {
  const legacy = await prisma.save.findMany({ where: { userId: me(req).id, supersededAt: null }, select: {
    id: true, baseName: true, romId: true, kind: true, currentVersionId: true, emulator: { select: { slug: true, saveFormat: true } },
  } });
  res.json({ mode: 'preserve-and-enroll', legacy: legacy.map((save) => ({ ...save, requiresReview: true,
    reason: save.kind === 'ENTRY' || save.emulator.saveFormat !== 'raw' ? 'adapter-required' : 'legacy-history-has-no-exact-ROM-checkpoint-binding',
  })) });
});
journeysRouter.get('/', async (req, res) => {
  let list = await listJourneys(me(req).id, z.string().regex(HASH).optional().parse(req.query.romIdentityId));
  if (req.query.gameId !== undefined) {
    const gameId = z.coerce.number().int().positive().parse(req.query.gameId);
    const game = await prisma.game.findUnique({ where: { id: gameId }, select: { system: { select: { slug: true } } } });
    const parts = await prisma.romPart.findMany({ where: { rom: { gameId } }, select: { sha1: true, headerlessSha1: true } });
    const hashes = new Set(parts.flatMap((p) => [p.sha1, p.headerlessSha1]).filter(Boolean));
    list = list.filter((j) => hashes.has(j.identity.digest) && j.identity.platform === game?.system.slug);
  }
  res.json(list);
});
journeysRouter.post('/', async (req, res) => {
  const body = z.object({ id: idSchema, identityId: z.string().regex(HASH), name: z.string().trim().min(1).max(80), sourceId: idSchema.optional(), sourceRevision: z.number().int().nonnegative().optional() }).parse(req.body);
  if (!(await prisma.journey.count({ where: { userId: me(req).id, identityId: body.identityId } }))) throw new HttpError(404, 'ROM not found');
  res.status(201).json(await createJourney(me(req).id, body));
});
journeysRouter.patch('/:id', async (req, res) => {
  const j = await owned(me(req).id, String(req.params.id));
  const body = z.object({ name: z.string().trim().min(1).max(80).optional(), archived: z.boolean().optional(), metadata: z.number().int().nonnegative() }).parse(req.body);
  if (body.archived && ((await prisma.journeyBinding.count({ where: { journeyId: j.id } })) || (await prisma.journeyCommand.count({ where: { journeyId: j.id, status: { in: ['pending', 'waiting', 'downloading', 'error'] } } }))))
    throw new HttpError(409, 'Journey is selected or has pending requests');
  const changed = await prisma.journey.updateMany({ where: { id: j.id, metadata: body.metadata }, data: { ...(body.name ? { name: body.name } : {}), ...(body.archived !== undefined ? { archived: body.archived } : {}), metadata: { increment: 1 } } });
  if (!changed.count) throw new HttpError(409, 'Journey changed; refresh first');
  res.json(await owned(j.userId, j.id));
});
journeysRouter.get('/:id/revisions', async (req, res) => {
  const j = await owned(me(req).id, String(req.params.id));
  res.json(await prisma.journeyRevision.findMany({ where: { journeyId: j.id }, include: { sourceDevice: { select: { name: true } } }, orderBy: { createdAt: 'desc' } }));
});
journeysRouter.get('/:id/blob/:sha1', async (req, res) => {
  const j = await owned(me(req).id, String(req.params.id));
  const sha1 = z.string().regex(HASH).parse(req.params.sha1);
  const revisions = await prisma.journeyRevision.findMany({ where: { journeyId: j.id }, select: { manifest: true } });
  if (!revisions.some((r) => (r.manifest as unknown as { sha1: string }[]).some((e) => e.sha1 === sha1))) throw new HttpError(404, 'File not found');
  res.type('application/octet-stream').attachment(`${sha1}.bin`).send(await fs.readFile(blobPath(j.userId, sha1)));
});
journeysRouter.post('/:id/restore', async (req, res) => {
  const j = await owned(me(req).id, String(req.params.id));
  const body = z.object({ checkpoint: idSchema, base: z.number().int().nonnegative(), operation: idSchema }).parse(req.body);
  const source = await prisma.journeyRevision.findFirst({ where: { id: body.checkpoint, journeyId: j.id } });
  if (!source) throw new HttpError(404, 'Checkpoint not found');
  const result = await commit(j.userId, j.id, body.base, body.operation, parseManifest(manifestText(source.manifest as unknown as import('./manifest.js').Entry[])));
  res.json(result);
});
journeysRouter.post('/:id/switch-requests', async (req, res) => {
  const j = await owned(me(req).id, String(req.params.id));
  if (j.archived) throw badRequest('Journey archived');
  const body = z.object({ bindings: z.array(z.object({ id: idSchema, generation: z.number().int().nonnegative() })).min(1).max(100) }).parse(req.body);
  const results = await prisma.$transaction(async (tx) => {
    const commands = [];
    for (const target of body.bindings) {
      const b = await tx.journeyBinding.findFirst({ where: { id: target.id, identityId: j.identityId, device: { userId: j.userId }, generation: target.generation } });
      if (!b) throw new HttpError(409, 'Console selection changed; refresh first');
      await tx.journeyCommand.updateMany({ where: { bindingId: b.id, status: { in: ['pending', 'waiting', 'downloading', 'error'] } }, data: { status: 'superseded' } });
      commands.push(await tx.journeyCommand.create({ data: { id: crypto.randomUUID(), bindingId: b.id, journeyId: j.id, generation: b.generation, status: b.journeyId === j.id ? 'applied' : 'pending' } }));
      await tx.device.update({ where: { id: b.deviceId }, data: { wantSyncAt: new Date() } });
    }
    return commands;
  });
  res.status(201).json(results);
});
journeysRouter.post('/commands/:id/cancel', async (req, res) => {
  const result = await prisma.journeyCommand.updateMany({ where: { id: String(req.params.id), binding: { device: { userId: me(req).id } }, status: { in: ['pending', 'waiting', 'downloading', 'error'] } }, data: { status: 'cancelled' } });
  if (!result.count) throw new HttpError(409, 'Request no longer pending');
  res.json({ ok: true });
});

journeysAgentRouter.post('/blob/:sha1', express.raw({ limit: '128mb', type: '*/*' }), async (req, res) => {
  const device = await deviceFromToken(req);
  await putBlob(device.userId, String(req.params.sha1), Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
  res.type('text/plain').send('ok\n');
});
journeysAgentRouter.get('/blob/:sha1', async (req, res) => {
  const d = await deviceFromToken(req);
  const sha1 = String(req.params.sha1);
  if (!HASH.test(sha1) || !(await prisma.journeyBlob.findUnique({ where: { userId_sha1: { userId: d.userId, sha1 } } }))) throw new HttpError(404, 'File not found');
  res.type('application/octet-stream').send(await fs.readFile(blobPath(d.userId, sha1)));
});
journeysAgentRouter.use(express.text({ limit: '4mb', type: '*/*' }));
journeysAgentRouter.get('/games', async (req, res) => {
  const d = await deviceFromToken(req);
  const games = await prisma.deviceRom.findMany({ where: { deviceId: d.id }, orderBy: { path: 'asc' } });
  const rows: string[] = [];
  // The consoles' names, so clients need not keep their own list of every system slug
  const names = new Map((await prisma.system.findMany({ select: { slug: true, name: true } })).map((s) => [s.slug, s.name]));
  for (const g of games) {
    try {
      const layout = await journeyLayout(d, g.path);
      rows.push(`game\t${enc(g.path)}\t${enc(g.path.split('/').pop() ?? '')}\t${layout.platform}\t${enc(names.get(layout.platform) ?? layout.platform)}`);
    } catch { /* Unsupported adapters are excluded from enrollment. */ }
  }
  res.type('text/plain').send(rows.join('\n') + '\n');
});
journeysAgentRouter.post('/register', async (req, res) => {
  let d = await deviceFromToken(req);
  const versionsHeader = req.header('x-core-versions-b64');
  if (versionsHeader) {
    if (versionsHeader.length > 16000) throw badRequest('Core version report too large');
    let report: unknown;
    try { report = JSON.parse(dec(versionsHeader)); } catch { throw badRequest('Invalid core version report'); }
    const versions = z.record(z.string().max(128), z.string().max(64)).parse(report);
    if (Object.keys(versions).length) {
      await prisma.device.update({ where: { id: d.id }, data: { coreVersions: versions } });
      d = { ...d, coreVersions: versions };
    }
  }
  const [rom64, digest, operation] = fields(req.body);
  if (!HASH.test(digest ?? '') || !UUID.test(operation ?? '')) throw badRequest('Exact ROM digest and operation required');
  const romPath = dec(rom64);
  const layout = await journeyLayout(d, romPath);
  const identityId = identityKey(layout.platform, digest);
  await prisma.romIdentity.upsert({ where: { id: identityId }, create: { id: identityId, platform: layout.platform, digest, title: `${layout.platform} ROM ${digest.slice(0, 12)}` }, update: {} });
  const old = await prisma.journeyBinding.findUnique({ where: { deviceId_identityId: { deviceId: d.id, identityId } } });
  if (old) {
    if (old.romPath !== romPath) throw new HttpError(409, 'This exact ROM is already managed at another path; relocate it explicitly');
    return res.type('text/plain').send(`binding\t${old.id}\t${identityId}\t${old.journeyId}\t${old.generation}\n` + Object.entries(old.layout as Record<string, string>).map(([k, v]) => `layout\t${k}\t${enc(v)}\n`).join(''));
  }
  const existingBindings = await prisma.journeyBinding.findMany({ where: { deviceId: d.id } });
  if (existingBindings.some((b) => {
    const other = b.layout as Record<string, string>;
    return other.savePath === layout.savePath || other.statePath === layout.statePath;
  })) throw new HttpError(409, 'Another exact ROM uses these emulator save paths; give the ROMs distinct save filenames first');
  // Each enrollment begins with an empty branch, so a new console cannot overwrite shared progress.
  const hasJourney = await prisma.journey.count({ where: { userId: d.userId, identityId } });
  const journey = await createJourney(d.userId, { id: operation, identityId, name: hasJourney ? `From ${d.name}`.slice(0, 80) : 'Main' });
  const b = await prisma.journeyBinding.create({ data: { id: crypto.randomUUID(), deviceId: d.id, identityId, journeyId: journey.id, romPath, layout, operation } });
  res.type('text/plain').send(`binding\t${b.id}\t${identityId}\t${journey.id}\t0\n` + Object.entries(layout).map(([k, v]) => `layout\t${k}\t${enc(v)}\n`).join(''));
});
journeysAgentRouter.get('/list/:identity', async (req, res) => {
  const d = await deviceFromToken(req);
  await validateAdapter(d, String(req.params.identity));
  const list = await listJourneys(d.userId, String(req.params.identity));
  res.type('text/plain').send(list.filter((j) => !j.archived).map((j) => `journey\t${j.id}\t${j.head}\t${enc(j.name)}\t${j.updatedAt.toISOString()}\t${j.slot}\n`).join(''));
});
journeysAgentRouter.post('/create', async (req, res) => {
  const d = await deviceFromToken(req);
  const [id, identityId, name, sourceId, sourceRevision] = fields(req.body);
  if (!(await prisma.journeyBinding.count({ where: { deviceId: d.id, identityId } }))) throw badRequest('ROM not enrolled');
  const j = await createJourney(d.userId, { id, identityId, name: dec(name), ...(sourceId && sourceId !== '-' ? { sourceId, sourceRevision: Number(sourceRevision) } : {}) });
  res.type('text/plain').send(`journey\t${j.id}\t${j.head}\t${enc(j.name)}\t${j.updatedAt.toISOString()}\t${await slotOf(d.userId, j)}\n`);
});
journeysAgentRouter.post('/rename/:id', async (req, res) => {
  const d = await deviceFromToken(req);
  const j = await owned(d.userId, String(req.params.id));
  const name = dec(fields(req.body)[0]).trim();
  if (!name || name.length > 80) throw badRequest('Invalid journey name');
  await prisma.journey.update({ where: { id: j.id }, data: { name, metadata: { increment: 1 } } });
  res.type('text/plain').send('ok\n');
});
journeysAgentRouter.get('/manifest/:id/:number', async (req, res) => {
  const d = await deviceFromToken(req);
  const number = z.coerce.number().int().nonnegative().parse(req.params.number);
  const r = await revision(d.userId, String(req.params.id), number);
  if (number > 0 && !r.revision) throw new HttpError(404, 'Checkpoint not found');
  res.type('text/plain').send(manifestText(r.entries));
});
journeysAgentRouter.post('/commit/:id', async (req, res) => {
  const d = await deviceFromToken(req);
  await validateAdapter(d, (await owned(d.userId, String(req.params.id))).identityId);
  const r = await commit(d.userId, String(req.params.id), Number(req.header('x-journey-base')), req.header('x-journey-operation') ?? '', parseManifest(String(req.body ?? '')), d.id);
  res.type('text/plain').send(`${r.conflict ? 'conflict' : 'committed'}\t${r.number}\t${r.id}\n`);
});
journeysAgentRouter.post('/select/:id', async (req, res) => {
  const d = await deviceFromToken(req);
  const [journey, generation, operation, commandId] = fields(req.body);
  await validateAdapter(d, (await owned(d.userId, journey)).identityId);
  const b = await select(d.userId, d.id, String(req.params.id), journey, Number(generation), operation, commandId && UUID.test(commandId) ? commandId : undefined);
  res.type('text/plain').send(`selected\t${b.journeyId}\t${b.generation}\n`);
});
journeysAgentRouter.get('/commands', async (req, res) => {
  const d = await deviceFromToken(req);
  const commands = await prisma.journeyCommand.findMany({ where: { binding: { deviceId: d.id }, status: { in: ['pending', 'waiting', 'error'] } }, orderBy: { createdAt: 'asc' } });
  res.type('text/plain').send(commands.map((c) => `command\t${c.id}\t${c.bindingId}\t${c.journeyId}\t${c.generation}\n`).join(''));
});
journeysAgentRouter.post('/commands/:id', async (req, res) => {
  const d = await deviceFromToken(req);
  const [status, message = ''] = fields(req.body);
  if (!['waiting', 'error', 'applied', 'superseded'].includes(status)) throw badRequest('Invalid request status');
  const c = await prisma.journeyCommand.findFirst({ where: { id: String(req.params.id), binding: { deviceId: d.id } }, include: { binding: true } });
  if (!c) throw new HttpError(404, 'Request not found');
  if (status === 'applied' && (c.binding.journeyId !== c.journeyId || c.binding.generation !== c.generation + 1)) throw new HttpError(409, 'Selection not applied');
  if (!['cancelled', 'applied'].includes(c.status)) await prisma.journeyCommand.update({ where: { id: c.id }, data: { status, error: dec(message).slice(0, 255) || null } });
  res.type('text/plain').send('ok\n');
});
