import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import type { MediaType } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { intParam, notFound } from '../../lib/http.js';
import { enqueue, registerJob } from '../../lib/jobs.js';
import { me } from '../auth/middleware.js';
import { loadList } from '../lists/service.js';
import { ownedGameIds } from '../roms/service.js';
import { scrapeGames } from './service.js';
import { scheduleSeedExport } from '../seed/service.js';

export const mediaRouter = Router();

mediaRouter.get('/:id', async (req, res) => {
  const m = await prisma.media.findUnique({ where: { id: intParam(req) } });
  if (!m) throw notFound('Media');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(path.join(env.mediaDir, m.path));
});

export const scrapeRouter = Router();

const ALL_TYPES: MediaType[] = ['COVER', 'SCREENSHOT', 'TITLE', 'MANUAL', 'WHEEL', 'MARQUEE'];

scrapeRouter.post('/', async (req, res) => {
  const u = me(req);
  const body = z
    .object({
      gameIds: z.array(z.number().int()).max(20000).optional(),
      systemId: z.number().int().optional(),
      listId: z.number().int().optional(),
      ownedOnly: z.boolean().default(true),
      sources: z.array(z.enum(['screenscraper', 'libretro'])).default(['screenscraper', 'libretro']),
      types: z.array(z.enum(['COVER', 'SCREENSHOT', 'TITLE', 'MANUAL', 'VIDEO', 'WHEEL', 'MARQUEE'])).default(ALL_TYPES),
      overwrite: z.boolean().default(false),
    })
    .parse(req.body);
  if (body.listId) await loadList(body.listId, u);
  res.status(202).json(await enqueue('scrape', { ...body, userId: u.id }, u.id));
});

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
  if (res.media) await scheduleSeedExport();
  return res;
});
