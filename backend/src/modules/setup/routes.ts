/**
 * The installer's second step, once the database is there: the first account, an administrator (the server's
 * settings keep their defaults until Administration > Server). Open only while no user exists; it starts logged in.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../lib/http.js';
import { PERMISSIONS } from '../../lib/permissions.js';
import { localeSchema, setDefaultLocale } from '../../lib/locales.js';
import { bundledDatabase } from '../../config/bootstrap.js';
import { issueTokens } from '../auth/routes.js';

export const setupRouter = Router();

setupRouter.get('/', async (_req, res) => {
  res.json({ needsDatabase: false, bundledDatabase: !!bundledDatabase, needsAdmin: (await prisma.user.count()) === 0 });
});

setupRouter.post('/database', () => {
  throw new HttpError(409, 'The database is already set up');
});

// The console installer (deploy/install.sh) sends the same fields: test/installer-parity.test.ts
export const adminBody = z.object({
  username: z.string().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/),
  email: z.email(),
  password: z.string().min(10).max(512),
  locale: localeSchema.catch('en').default('en'),
});

// Two submissions at once must not make two administrators
let creating = false;

setupRouter.post('/admin', async (req, res) => {
  const body = adminBody.parse(req.body);
  if (creating || (await prisma.user.count()) > 0) throw new HttpError(409, 'Rommancer is already installed');
  creating = true;
  try {
    res.status(201).json(await createAdmin(body));
  } finally {
    creating = false;
  }
});

async function createAdmin(body: z.infer<typeof adminBody>) {
  const locale = body.locale;
  await setDefaultLocale(locale);
  const user = await prisma.user.create({
    data: {
      username: body.username,
      email: body.email,
      role: 'ADMIN',
      passwordHash: await bcrypt.hash(body.password, 10),
      permissions: [...PERMISSIONS],
      locale,
    },
  });
  return issueTokens(user);
}
