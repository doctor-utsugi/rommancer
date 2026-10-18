import express from 'express';
import { z } from 'zod';
import { badRequest } from '../../lib/http.js';
import { setServerSettings } from '../../lib/settings.js';
import { compareVersions, VERSION } from '../../lib/version.js';
import { me, requireAdmin } from '../auth/middleware.js';
import { checkReleases, readLog, requestUpdate, updateState } from './service.js';

/** Administration > Update: this version, the newer ones with what they change, and the button that updates */
export const updateRouter = express.Router();
updateRouter.use(requireAdmin);

updateRouter.get('/', async (_req, res) => {
  res.json(await updateState());
});

updateRouter.post('/check', async (_req, res) => {
  await checkReleases();
  res.json(await updateState());
});

updateRouter.put('/settings', async (req, res) => {
  const body = z.object({ checks: z.boolean() }).parse(req.body);
  await setServerSettings({ updateCheck: String(body.checks) });
  res.json(await updateState());
});

updateRouter.post('/', async (req, res) => {
  const { to } = z.object({ to: z.string().regex(/^\d+\.\d+\.\d+$/) }).parse(req.body);
  const state = await updateState();
  if (VERSION === 'dev') throw badRequest('A development build is updated with git');
  if (compareVersions(to, VERSION) <= 0) throw badRequest(`${to} is not newer than ${VERSION}`);
  if (state.status?.state === 'running') throw badRequest('An update is already running');
  try {
    requestUpdate(to, me(req).username);
  } catch (e) {
    throw badRequest(e instanceof Error ? e.message : String(e));
  }
  res.status(202).json(await updateState());
});

updateRouter.get('/log', (_req, res) => {
  res.type('text/plain').send(readLog());
});
