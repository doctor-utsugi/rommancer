import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { forbidden, intParam } from '../../lib/http.js';
import { me } from '../auth/middleware.js';

export const jobsRouter = Router();

jobsRouter.get('/', async (req, res) => {
  const u = me(req);
  const q = z.object({ type: z.string().optional(), limit: z.coerce.number().int().max(200).default(50) }).parse(req.query);
  res.json(
    await prisma.job.findMany({
      where: { ...(u.role === 'ADMIN' ? {} : { userId: u.id }), ...(q.type ? { type: q.type } : {}) },
      orderBy: { id: 'desc' },
      take: q.limit,
      omit: { log: true },
    }),
  );
});

async function getJob(id: number, userId: number, admin: boolean) {
  const j = await prisma.job.findUniqueOrThrow({ where: { id } });
  if (!admin && j.userId !== userId) throw forbidden();
  return j;
}

jobsRouter.get('/:id', async (req, res) => {
  const u = me(req);
  res.json(await getJob(intParam(req), u.id, u.role === 'ADMIN'));
});

// Server-Sent Events con el progreso del trabajo
jobsRouter.get('/:id/events', async (req, res) => {
  const u = me(req);
  const id = intParam(req);
  await getJob(id, u.id, u.role === 'ADMIN');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  let closed = false;
  req.on('close', () => (closed = true));
  while (!closed) {
    const j = await prisma.job.findUnique({ where: { id }, omit: { log: true } });
    if (!j) break;
    res.write(`data: ${JSON.stringify(j)}\n\n`);
    if (j.status === 'DONE' || j.status === 'FAILED') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  res.end();
});
