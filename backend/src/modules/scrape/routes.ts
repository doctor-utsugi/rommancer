import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import type { MediaType } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { badRequest, intParam, notFound } from '../../lib/http.js';
import { enqueue, registerJob } from '../../lib/jobs.js';
import { hasPermission } from '../../lib/permissions.js';
import { me, requireAdmin, requirePerm } from '../auth/middleware.js';
import { loadList } from '../lists/service.js';
import { ownedGameIds } from '../roms/service.js';
import { ALL_MEDIA, DEFAULT_MEDIA, credentialsFor, scrapeGames } from './service.js';
import { scheduleSeedExport } from '../seed/service.js';

export const mediaRouter = Router();

mediaRouter.get('/:id', async (req, res) => {
  const m = await prisma.media.findUnique({ where: { id: intParam(req) } });
  if (!m) throw notFound('Media');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  // PDF manuals are shown inside the game page
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.sendFile(path.join(env.mediaDir, m.path));
});

export const scrapeRouter = Router();

const mediaTypes = z.array(z.enum(ALL_MEDIA as [MediaType, ...MediaType[]]));

registerJob('scrape', async (ctx) => {
  const p = ctx.params;
  let ids: number[] = p.gameIds ?? [];
  if (p.listId) {
    const items = await prisma.listItem.findMany({ where: { listId: p.listId }, include: { rom: true, hack: true } });
    ids.push(...items.map((i) => i.gameId ?? i.rom?.gameId ?? i.hack?.gameId).filter((x): x is number => !!x));
  }
  if (p.systemId) {
    const games = p.ownedOnly ? [...(await ownedGameIds(p.systemId))] : (await prisma.game.findMany({ where: { systemId: p.systemId }, select: { id: true } })).map((g) => g.id);
    ids.push(...games);
  }
  ids = [...new Set(ids)];
  ctx.log(`Scraping ${ids.length} games`);
  const res = await scrapeGames(ids, { userId: p.userId, sources: p.sources, types: p.types, overwrite: p.overwrite }, ctx);
  // What did not fit in the quota resumes when the pause ends
  if (res.pending.length && res.pausedUntil) {
    await enqueue('scrape', { ...p, listId: undefined, systemId: undefined, gameIds: res.pending, sources: ['screenscraper'] }, p.userId, new Date(res.pausedUntil));
    ctx.log(`Quota reached: ${res.pending.length} games resume at ${res.pausedUntil}`);
  }
  if (res.media) await scheduleSeedExport();
  return res;
});

/** Queues media for games added to lists: one pending task per user that accumulates games. */
export async function queueListScrape(user: { id: number; role: string; permissions: string[] }, gameIds: number[]) {
  if (!gameIds.length || !hasPermission(user, 'scrape.lists')) return null;
  const pending = await prisma.job.findFirst({ where: { type: 'scrape', status: 'PENDING', userId: user.id, runAfter: null } });
  const params = pending?.params as Record<string, unknown> | undefined;
  if (pending && params?.mode === 'lists') {
    const ids = [...new Set([...((params.gameIds as number[]) ?? []), ...gameIds])];
    await prisma.job.update({ where: { id: pending.id }, data: { params: { ...params, gameIds: ids } } });
    return pending;
  }
  return enqueue('scrape', { mode: 'lists', userId: user.id, gameIds, types: DEFAULT_MEDIA }, user.id);
}

// Bulk scraping (systems, whole lists or large selections): only with a specific permission
scrapeRouter.post('/', requirePerm('scrape.bulk'), async (req, res) => {
  const u = me(req);
  const body = z
    .object({
      gameIds: z.array(z.number().int()).max(20000).optional(),
      systemId: z.number().int().optional(),
      listId: z.number().int().optional(),
      ownedOnly: z.boolean().default(true),
      sources: z.array(z.enum(['screenscraper', 'thegamesdb', 'libretro'])).default(['screenscraper', 'thegamesdb', 'libretro']),
      types: mediaTypes.default(DEFAULT_MEDIA),
      overwrite: z.boolean().default(false),
    })
    .parse(req.body);
  if (body.listId) await loadList(body.listId, u);
  res.status(202).json(await enqueue('scrape', { ...body, mode: 'bulk', userId: u.id }, u.id));
});

// Media for a single game (its page): with the user's own account
scrapeRouter.post('/game/:id', requirePerm('scrape.lists'), async (req, res) => {
  const u = me(req);
  const gameId = intParam(req);
  const { types, overwrite } = z.object({ types: mediaTypes.default(DEFAULT_MEDIA), overwrite: z.boolean().default(false) }).parse(req.body ?? {});
  await prisma.game.findUniqueOrThrow({ where: { id: gameId } });
  res.status(202).json(await enqueue('scrape', { mode: 'game', userId: u.id, gameIds: [gameId], types, overwrite }, u.id));
});

scrapeRouter.get('/status', async (req, res) => {
  const u = me(req);
  const creds = await credentialsFor(u.id);
  const quotas = await prisma.scrapeQuota.findMany();
  res.json({
    screenscraper: !!creds.ss,
    thegamesdb: !!creds.tgdb,
    quotas: quotas.filter((q) => u.role === 'ADMIN' || q.key === `ss:${creds.ss?.user}`),
    pendingJobs: await prisma.job.count({ where: { type: 'scrape', status: 'PENDING', userId: u.id } }),
  });
});

// --- Internet Archive: manual suggestions the admin confirms ---
scrapeRouter.get('/archive-manuals/:gameId', requireAdmin, async (req, res) => {
  const game = await prisma.game.findUniqueOrThrow({ where: { id: intParam(req, 'gameId') }, include: { system: true } });
  const q = `title:(${game.title.replace(/[^\p{L}\p{N} ]/gu, ' ')}) AND mediatype:texts AND (manual OR instruction)`;
  const r = await fetch(`https://archive.org/advancedsearch.php?${new URLSearchParams({ q, 'fl[]': 'identifier', rows: '10', output: 'json' })}&fl[]=title`, { headers: { 'User-Agent': env.userAgent } });
  if (!r.ok) throw badRequest(`archive.org: HTTP ${r.status}`);
  const j = (await r.json()) as { response?: { docs?: { identifier: string; title: string }[] } };
  res.json((j.response?.docs ?? []).map((d) => ({ identifier: d.identifier, title: d.title, url: `https://archive.org/details/${d.identifier}` })));
});

scrapeRouter.post('/archive-manuals/:gameId', requireAdmin, async (req, res) => {
  const game = await prisma.game.findUniqueOrThrow({ where: { id: intParam(req, 'gameId') }, include: { system: true } });
  const { identifier } = z.object({ identifier: z.string().regex(/^[\w.-]+$/) }).parse(req.body);
  const meta = (await (await fetch(`https://archive.org/metadata/${identifier}`, { headers: { 'User-Agent': env.userAgent } })).json()) as { files?: { name: string; format?: string }[] };
  const pdf = meta.files?.find((f) => f.name.toLowerCase().endsWith('.pdf'));
  if (!pdf) throw badRequest('No PDF in that item');
  const r = await fetch(`https://archive.org/download/${identifier}/${encodeURIComponent(pdf.name)}`, { headers: { 'User-Agent': env.userAgent } });
  if (!r.ok) throw badRequest(`archive.org: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const rel = path.join('large', game.system.slug, String(game.id), 'manual-archive.pdf');
  const fs = await import('node:fs');
  await fs.promises.mkdir(path.dirname(path.join(env.mediaDir, rel)), { recursive: true });
  await fs.promises.writeFile(path.join(env.mediaDir, rel), buf);
  await prisma.media.deleteMany({ where: { gameId: game.id, type: 'MANUAL', source: 'archive.org' } });
  const m = await prisma.media.create({ data: { gameId: game.id, type: 'MANUAL', source: 'archive.org', path: rel, size: buf.length } });
  await scheduleSeedExport();
  res.status(201).json(m);
});
