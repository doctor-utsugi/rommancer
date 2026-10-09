import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { forceSync } from '../sync/service.js';
import { checkKey, refreshProgress } from '../ra/progress.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { HttpError, intParam } from '../../lib/http.js';
import { DEFAULT_PERMISSIONS, PERMISSIONS, normalizePermissions } from '../../lib/permissions.js';
import { me, requireAdmin } from '../auth/middleware.js';
import { issueTokens } from '../auth/routes.js';

export const usersRouter = Router();

const publicUser = {
  id: true,
  username: true,
  email: true,
  role: true,
  locale: true,
  permissions: true,
  mustChangePassword: true,
  createdAt: true,
} as const;

const permissionsSchema = z.array(z.enum(PERMISSIONS));

// Contrasena robusta: 10+ caracteres y distinta de la inicial de .env
export function weakPassword(pw: string) {
  return pw.length < 10 || (!!env.admin.password && pw === env.admin.password);
}

usersRouter.get('/me', async (req, res) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: me(req).id } });
  res.json({
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    locale: u.locale,
    permissions: u.role === 'ADMIN' ? [...PERMISSIONS] : normalizePermissions(u.permissions),
    mustChangePassword: u.mustChangePassword,
    hasScreenScraper: !!u.ssUser,
    hasRetroAchievements: !!u.raApiKey,
    // What is set, so the profile can say so: user names are shown, secrets only as present or not
    ssUser: decrypt(u.ssUser),
    raUser: decrypt(u.raUser),
    raConsoles: !!(u.raPassword || u.raToken),
    hasTheGamesDb: !!u.tgdbApiKey,
  });
});

usersRouter.patch('/me', async (req, res) => {
  const body = z
    .object({
      email: z.email().optional(),
      locale: z.enum(['es', 'en']).optional(),
      currentPassword: z.string().optional(),
      newPassword: z.string().min(8).max(512).optional(),
      ssUser: z.string().nullable().optional(),
      ssPassword: z.string().nullable().optional(),
      raUser: z.string().nullable().optional(),
      raApiKey: z.string().nullable().optional(),
      tgdbApiKey: z.string().nullable().optional(),
    })
    .parse(req.body);
  const u = await prisma.user.findUniqueOrThrow({ where: { id: me(req).id } });
  if (u.mustChangePassword && !body.newPassword) throw new HttpError(403, 'PASSWORD_CHANGE_REQUIRED');
  const data: Record<string, unknown> = {};
  if (body.email) data.email = body.email;
  if (body.locale) data.locale = body.locale;
  if (body.newPassword) {
    if (!body.currentPassword || !(await bcrypt.compare(body.currentPassword, u.passwordHash))) throw new HttpError(400, 'Current password is wrong');
    if (weakPassword(body.newPassword) || body.newPassword === body.currentPassword) throw new HttpError(400, 'WEAK_PASSWORD');
    data.passwordHash = await bcrypt.hash(body.newPassword, 10);
    data.mustChangePassword = false;
  }
  // A Web API key is checked with RetroAchievements before it is kept
  if (body.raApiKey) {
    const raUser = body.raUser ?? decrypt(u.raUser);
    if (!raUser) throw new HttpError(400, 'Set your RetroAchievements user first');
    await checkKey(raUser, body.raApiKey);
  }
  for (const k of ['ssUser', 'ssPassword', 'raUser', 'raApiKey', 'tgdbApiKey'] as const) {
    if (body[k] !== undefined) data[k] = encrypt(body[k]);
  }
  const updated = await prisma.user.update({ where: { id: u.id }, data });
  if (body.raApiKey) {
    // A first key brings the RA catalogue (an admin's key serves the server) and the user's progress
    if (u.role === 'ADMIN' && (await prisma.raGame.count()) === 0) await forceSync(['retroachievements'], undefined, u.id).catch(() => {});
    void refreshProgress(u.id).catch(() => {});
  }
  // Al cambiar la contrasena se invalidan las sesiones anteriores y se entregan tokens nuevos
  if (body.newPassword) {
    await prisma.refreshToken.deleteMany({ where: { userId: u.id } });
    res.json(await issueTokens(updated));
    return;
  }
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
      permissions: permissionsSchema.optional(),
    })
    .parse(req.body);
  const u = await prisma.user.create({
    data: {
      username: body.username,
      email: body.email,
      role: body.role,
      passwordHash: await bcrypt.hash(body.password, 10),
      permissions: body.permissions ?? DEFAULT_PERMISSIONS,
    },
    select: publicUser,
  });
  res.status(201).json(u);
});

usersRouter.patch('/:id', requireAdmin, async (req, res) => {
  const body = z
    .object({ role: z.enum(['ADMIN', 'USER']).optional(), password: z.string().min(8).optional(), permissions: permissionsSchema.optional() })
    .parse(req.body);
  const data: Record<string, unknown> = {};
  if (body.role) data.role = body.role;
  if (body.password) data.passwordHash = await bcrypt.hash(body.password, 10);
  if (body.permissions) data.permissions = body.permissions;
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
  const body = z
    .object({ role: z.enum(['ADMIN', 'USER']).default('USER'), days: z.number().int().min(1).max(90).default(7), permissions: permissionsSchema.optional() })
    .parse(req.body ?? {});
  const inv = await prisma.invitation.create({
    data: {
      token: crypto.randomBytes(24).toString('hex'),
      role: body.role,
      createdBy: me(req).id,
      expiresAt: new Date(Date.now() + body.days * 86400_000),
      permissions: body.permissions ?? DEFAULT_PERMISSIONS,
    },
  });
  res.status(201).json(inv);
});

invitationsRouter.delete('/:id', async (req, res) => {
  await prisma.invitation.delete({ where: { id: intParam(req) } });
  res.status(204).end();
});
