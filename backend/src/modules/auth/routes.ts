import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { sha256 } from '../../lib/crypto.js';
import { HttpError, badRequest } from '../../lib/http.js';
import { signAccess } from './middleware.js';

export const authRouter = Router();

const REFRESH_DAYS = 30;

async function issueTokens(user: { id: number; username: string; role: 'ADMIN' | 'USER' }) {
  const refresh = crypto.randomBytes(32).toString('hex');
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: sha256(refresh),
      expiresAt: new Date(Date.now() + REFRESH_DAYS * 86400_000),
    },
  });
  return {
    accessToken: signAccess(user),
    refreshToken: refresh,
    user: { id: user.id, username: user.username, role: user.role },
  };
}

authRouter.post('/login', async (req, res) => {
  const { username, password } = z.object({ username: z.string(), password: z.string() }).parse(req.body);
  const user = await prisma.user.findFirst({ where: { OR: [{ username }, { email: username }] } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) throw new HttpError(401, 'Invalid credentials');
  res.json(await issueTokens(user));
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
      password: z.string().min(8),
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
      },
    });
    await tx.invitation.update({ where: { id: inv.id }, data: { usedAt: new Date(), usedById: u.id } });
    return u;
  });
  res.status(201).json(await issueTokens(user));
});
