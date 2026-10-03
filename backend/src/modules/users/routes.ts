import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { encrypt } from '../../lib/crypto.js';
import { HttpError, intParam } from '../../lib/http.js';
import { me, requireAdmin } from '../auth/middleware.js';

export const usersRouter = Router();

const publicUser = {
  id: true,
  username: true,
  email: true,
  role: true,
  locale: true,
  createdAt: true,
} as const;

usersRouter.get('/me', async (req, res) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: me(req).id } });
  res.json({
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    locale: u.locale,
    hasScreenScraper: !!u.ssUser,
    hasRetroAchievements: !!u.raApiKey,
  });
});

usersRouter.patch('/me', async (req, res) => {
  const body = z
    .object({
      email: z.email().optional(),
      locale: z.enum(['es', 'en']).optional(),
      currentPassword: z.string().optional(),
      newPassword: z.string().min(8).optional(),
      ssUser: z.string().nullable().optional(),
      ssPassword: z.string().nullable().optional(),
      raUser: z.string().nullable().optional(),
      raApiKey: z.string().nullable().optional(),
    })
    .parse(req.body);
  const u = await prisma.user.findUniqueOrThrow({ where: { id: me(req).id } });
  const data: Record<string, unknown> = {};
  if (body.email) data.email = body.email;
  if (body.locale) data.locale = body.locale;
  if (body.newPassword) {
    if (!body.currentPassword || !(await bcrypt.compare(body.currentPassword, u.passwordHash)))
      throw new HttpError(400, 'Current password is wrong');
    data.passwordHash = await bcrypt.hash(body.newPassword, 10);
  }
  for (const k of ['ssUser', 'ssPassword', 'raUser', 'raApiKey'] as const) {
    if (body[k] !== undefined) data[k] = encrypt(body[k]);
  }
  await prisma.user.update({ where: { id: u.id }, data });
  res.status(204).end();
});

// Listado minimo para compartir listas
usersRouter.get('/directory', async (_req, res) => {
  res.json(await prisma.user.findMany({ select: { id: true, username: true }, orderBy: { username: 'asc' } }));
});

usersRouter.get('/', requireAdmin, async (_req, res) => {
  res.json(await prisma.user.findMany({ select: publicUser, orderBy: { id: 'asc' } }));
});

usersRouter.post('/', requireAdmin, async (req, res) => {
  const body = z
    .object({
      username: z.string().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/),
      email: z.email(),
      password: z.string().min(8),
      role: z.enum(['ADMIN', 'USER']).default('USER'),
    })
    .parse(req.body);
  const u = await prisma.user.create({
    data: { username: body.username, email: body.email, role: body.role, passwordHash: await bcrypt.hash(body.password, 10) },
    select: publicUser,
  });
  res.status(201).json(u);
});

usersRouter.patch('/:id', requireAdmin, async (req, res) => {
  const body = z
    .object({ role: z.enum(['ADMIN', 'USER']).optional(), password: z.string().min(8).optional() })
    .parse(req.body);
  const data: Record<string, unknown> = {};
  if (body.role) data.role = body.role;
  if (body.password) data.passwordHash = await bcrypt.hash(body.password, 10);
  res.json(await prisma.user.update({ where: { id: intParam(req) }, data, select: publicUser }));
});

usersRouter.delete('/:id', requireAdmin, async (req, res) => {
  const id = intParam(req);
  if (id === me(req).id) throw new HttpError(400, 'Cannot delete yourself');
  await prisma.user.delete({ where: { id } });
  res.status(204).end();
});

export const invitationsRouter = Router();
invitationsRouter.use(requireAdmin);

invitationsRouter.get('/', async (_req, res) => {
  res.json(await prisma.invitation.findMany({ orderBy: { id: 'desc' } }));
});

invitationsRouter.post('/', async (req, res) => {
  const body = z.object({ role: z.enum(['ADMIN', 'USER']).default('USER'), days: z.number().int().min(1).max(90).default(7) }).parse(req.body ?? {});
  const inv = await prisma.invitation.create({
    data: {
      token: crypto.randomBytes(24).toString('hex'),
      role: body.role,
      createdBy: me(req).id,
      expiresAt: new Date(Date.now() + body.days * 86400_000),
    },
  });
  res.status(201).json(inv);
});

invitationsRouter.delete('/:id', async (req, res) => {
  await prisma.invitation.delete({ where: { id: intParam(req) } });
  res.status(204).end();
});
