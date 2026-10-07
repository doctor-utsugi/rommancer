import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { User } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { sha256 } from '../../lib/crypto.js';
import { HttpError, badRequest } from '../../lib/http.js';
import { DEFAULT_PERMISSIONS, normalizePermissions } from '../../lib/permissions.js';
import { signAccess, signFiles } from './middleware.js';

export const authRouter = Router();

const REFRESH_DAYS = 30;
const MAX_FAILS = 5;
const WINDOW_MS = 15 * 60_000;

// Limite de intentos fallidos por IP y por usuario, en memoria
const fails = new Map<string, number[]>();

function recent(key: string) {
  const now = Date.now();
  const list = (fails.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  fails.set(key, list);
  return list;
}

function checkLimit(keys: string[]) {
  for (const k of keys) {
    const list = recent(k);
    if (list.length >= MAX_FAILS) {
      const retry = Math.ceil((WINDOW_MS - (Date.now() - list[0])) / 1000);
      throw new HttpError(429, `Too many attempts, retry in ${retry}s`);
    }
  }
}

export function resetLoginLimits() {
  fails.clear();
}

const clientIp = (req: Request) => req.ip ?? req.socket.remoteAddress ?? 'unknown';

export async function issueTokens(user: User) {
  const refresh = crypto.randomBytes(32).toString('hex');
  await prisma.refreshToken.create({
    data: { userId: user.id, tokenHash: sha256(refresh), expiresAt: new Date(Date.now() + REFRESH_DAYS * 86400_000) },
  });
  return {
    accessToken: signAccess(user),
    filesToken: signFiles(user),
    refreshToken: refresh,
    user: { id: user.id, username: user.username, role: user.role, mustChangePassword: user.mustChangePassword },
  };
}

/** Username or email + password, with the per-IP and per-user attempt limit. */
export async function verifyCredentials(req: Request, username: string, password: string) {
  const keys = [`ip:${clientIp(req)}`, `user:${username.toLowerCase()}`];
  checkLimit(keys);
  const user = await prisma.user.findFirst({ where: { OR: [{ username }, { email: username }] } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    for (const k of keys) recent(k).push(Date.now());
    throw new HttpError(401, 'Invalid credentials');
  }
  for (const k of keys) fails.delete(k);
  return user;
}

authRouter.post('/login', async (req, res) => {
  const { username, password } = z.object({ username: z.string().max(191), password: z.string().max(512) }).parse(req.body);
  res.json(await issueTokens(await verifyCredentials(req, username, password)));
});

authRouter.post('/refresh', async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refreshToken) }, include: { user: true } });
  if (!row || row.expiresAt < new Date()) throw new HttpError(401, 'Invalid refresh token');
  await prisma.refreshToken.delete({ where: { id: row.id } });
  res.json(await issueTokens(row.user));
});

authRouter.post('/logout', async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
  await prisma.refreshToken.deleteMany({ where: { tokenHash: sha256(refreshToken) } });
  res.status(204).end();
});

authRouter.get('/invitations/:token', async (req, res) => {
  const inv = await prisma.invitation.findUnique({ where: { token: req.params.token } });
  if (!inv || inv.usedAt || inv.expiresAt < new Date()) throw new HttpError(404, 'Invalid invitation');
  res.json({ valid: true, role: inv.role });
});

authRouter.post('/register', async (req, res) => {
  const body = z
    .object({
      token: z.string(),
      username: z.string().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/),
      email: z.email(),
      password: z.string().min(8).max(512),
      locale: z.enum(['es', 'en']).optional(),
    })
    .parse(req.body);
  const inv = await prisma.invitation.findUnique({ where: { token: body.token } });
  if (!inv || inv.usedAt || inv.expiresAt < new Date()) throw badRequest('Invalid invitation');
  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: {
        username: body.username,
        email: body.email,
        passwordHash: await bcrypt.hash(body.password, 10),
        role: inv.role,
        locale: body.locale ?? 'es',
        permissions: inv.permissions ? normalizePermissions(inv.permissions) : DEFAULT_PERMISSIONS,
      },
    });
    await tx.invitation.update({ where: { id: inv.id }, data: { usedAt: new Date(), usedById: u.id } });
    return u;
  });
  res.status(201).json(await issueTokens(user));
});

const SIGNUP_KEY = 'signup.open';

export async function signupOpen() {
  return (await prisma.setting.findUnique({ where: { key: SIGNUP_KEY } }))?.value === 'true';
}

export async function setSignupOpen(open: boolean) {
  await prisma.setting.upsert({ where: { key: SIGNUP_KEY }, create: { key: SIGNUP_KEY, value: String(open) }, update: { value: String(open) } });
}

authRouter.get('/config', async (_req, res) => {
  res.json({ signupOpen: await signupOpen() });
});

// Self-service sign-up, only when the admin opened it; default permissions, never admin
export const signupBody = z.object({
  username: z.string().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/),
  email: z.email(),
  password: z.string().min(10).max(512),
  locale: z.enum(['es', 'en']).optional(),
});

/** Self-service account (default permissions, never admin) when the admin opened sign-up. */
export async function selfSignup(req: Request, body: z.infer<typeof signupBody>) {
  if (!(await signupOpen())) throw new HttpError(403, 'Sign-up is closed');
  checkLimit([`signup:${clientIp(req)}`]);
  recent(`signup:${clientIp(req)}`).push(Date.now());
  if (await prisma.user.findFirst({ where: { OR: [{ username: body.username }, { email: body.email }] } })) throw new HttpError(409, 'User already exists');
  return prisma.user.create({
    data: { username: body.username, email: body.email, passwordHash: await bcrypt.hash(body.password, 10), role: 'USER', locale: body.locale ?? 'es', permissions: DEFAULT_PERMISSIONS },
  });
}

authRouter.post('/signup', async (req, res) => {
  res.status(201).json(await issueTokens(await selfSignup(req, signupBody.parse(req.body))));
});
