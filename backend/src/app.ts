import express from 'express';
import cors from 'cors';
import { errorHandler, jsonReplacer } from './lib/http.js';
import { authRouter } from './modules/auth/routes.js';
import { requireAuth } from './modules/auth/middleware.js';
import { invitationsRouter, usersRouter } from './modules/users/routes.js';
import { collectionRouter } from './modules/roms/routes.js';
import { adminRouter } from './modules/admin/routes.js';
import { jobsRouter } from './modules/jobs/routes.js';
import { listsRouter } from './modules/lists/routes.js';
import { devicesRouter } from './modules/devices/routes.js';
import { uploadsRouter } from './modules/uploads/routes.js';
import { mediaRouter, scrapeRouter } from './modules/scrape/routes.js';
import { raRouter } from './modules/ra/routes.js';
import { savesRouter } from './modules/saves/routes.js';
import { agentRouter } from './modules/saves/agent.js';
import { browseRouter } from './modules/browse/agent.js';
import { configAgentRouter } from './modules/devconfig/agent.js';
import { configRouter } from './modules/devconfig/routes.js';
import { linkPublicRouter, linkRouter } from './modules/link/routes.js';
import { env } from './config/env.js';
import { setupRouter } from './modules/setup/routes.js';
import './modules/sync/service.js';
import { journeysRouter, journeysAgentRouter } from './modules/journeys/routes.js';

export function createApp() {
  const app = express();
  app.set('json replacer', jsonReplacer);
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');
  // CORS closed except for configured origins
  app.use(cors({ origin: (origin, cb) => cb(null, !!origin && env.corsOrigins.includes(origin)) }));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
  });

  const api = express.Router();
  api.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  api.use('/auth', express.json({ limit: '1mb' }), authRouter);
  // The installer's second step (the first runs before the server has a database: installer.ts)
  api.use('/setup', express.json({ limit: '64kb' }), setupRouter);
  // Device scripts: authenticated with their own token
  api.use('/agent/config', configAgentRouter);
  api.use('/agent/journeys', journeysAgentRouter);
  api.use('/agent/browse', browseRouter);
  api.use('/agent', agentRouter);
  api.use('/link', linkPublicRouter);
  api.use(express.json({ limit: '10mb' }));
  api.use(requireAuth);
  api.use('/users', usersRouter);
  api.use('/invitations', invitationsRouter);
  api.use('/admin', adminRouter);
  api.use('/jobs', jobsRouter);
  api.use('/lists', listsRouter);
  api.use('/devices', devicesRouter);
  api.use('/', configRouter);
  api.use('/uploads', uploadsRouter);
  api.use('/media', mediaRouter);
  api.use('/scrape', scrapeRouter);
  api.use('/ra', raRouter);
  api.use('/saves', savesRouter);
  api.use('/journeys', journeysRouter);
  api.use('/link', linkRouter);
  api.use('/', collectionRouter);

  app.use('/api/v1', api);
  app.use(errorHandler);
  return app;
}
