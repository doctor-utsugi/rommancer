/**
 * The installer's second step, once the database is there: the first account, an administrator, and the web address
 * when Rommancer is reached from the internet (the other settings keep their defaults until Administration > Server).
 * Open only while no user exists; it starts logged in. Installed from the browser, a third step follows, for that
 * administrator: the folder with the roms (roms.ts).
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../lib/http.js';
import { PERMISSIONS } from '../../lib/permissions.js';
import { localeSchema, setDefaultLocale } from '../../lib/locales.js';
import { bundledDatabase } from '../../config/bootstrap.js';
import { setServerSettings } from '../../lib/settings.js';
import { issueTokens } from '../auth/routes.js';
import { requireAdmin, requireAuth } from '../auth/middleware.js';
import { badRequest } from '../../lib/http.js';
import { browseRoots, canChangeRoms, finishRoms, hostPath, isDir, listFolders, requestRoms, romsOnHost, romsPending } from './roms.js';

export const setupRouter = Router();

setupRouter.get('/', async (_req, res) => {
  res.json({ needsDatabase: false, bundledDatabase: !!bundledDatabase, needsAdmin: (await prisma.user.count()) === 0, needsRoms: romsPending() });
});

setupRouter.post('/database', () => {
  throw new HttpError(409, 'The database is already set up');
});

// The console installer (deploy/install.sh) sends the same fields: test/installer-parity.test.ts
export const adminBody = z.object({
  username: z.string().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(1).max(512),
  locale: localeSchema.catch('en').default('en'),
  // Empty: each request's own address (a home network)
  publicUrl: z.string().trim().max(255).regex(/^(https?:\/\/\S+)?$/).default(''),
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
  if (body.publicUrl) await setServerSettings({ publicUrl: body.publicUrl.replace(/\/+$/, '') });
  const user = await prisma.user.create({
    data: {
      username: body.username,
      role: 'ADMIN',
      passwordHash: await bcrypt.hash(body.password, 10),
      permissions: [...PERMISSIONS],
      locale,
    },
  });
  return issueTokens(user);
}

// The console installer (deploy/install.sh) sends the same field: test/installer-parity.test.ts
export const romsBody = z.object({ path: z.string().min(1).max(1024) });

/** Where the roms are now, and whether the computer can mount another folder */
setupRouter.get('/roms', requireAuth, requireAdmin, (_req, res) => {
  res.json({ pending: romsPending(), current: romsOnHost(), canChange: canChangeRoms(), roots: browseRoots() });
});

/** The folders inside one of the computer, to pick the roms' one */
setupRouter.get('/roms/folders', requireAuth, requireAdmin, (req, res) => {
  const p = hostPath(String(req.query.path ?? ''));
  if (!p || !isDir(p)) throw badRequest('Not a folder Rommancer can see');
  res.json({ path: p, folders: listFolders(p) });
});

/** The roms' folder: the current one ends the step; another one is mounted by the computer, which restarts Rommancer */
setupRouter.post('/roms', requireAuth, requireAdmin, (req, res) => {
  const body = romsBody.parse(req.body);
  const current = romsOnHost();
  if (body.path.replace(/\/+$/, '') === current) {
    finishRoms();
    return res.json({ restarting: false, path: current });
  }
  if (!canChangeRoms()) throw badRequest('This computer cannot change the roms folder from the browser');
  const p = hostPath(body.path);
  if (!p || !isDir(p)) throw badRequest('Not a folder Rommancer can see');
  requestRoms(p);
  res.json({ restarting: true, path: p });
});
