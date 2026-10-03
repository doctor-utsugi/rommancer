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

export function createApp() {
  const app = express();
  app.set('json replacer', jsonReplacer);
  app.set('trust proxy', 'loopback');
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  const api = express.Router();
  api.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  api.use('/auth', authRouter);
  api.use(requireAuth);
  api.use('/users', usersRouter);
  api.use('/invitations', invitationsRouter);
  api.use('/admin', adminRouter);
  api.use('/jobs', jobsRouter);
  api.use('/lists', listsRouter);
  api.use('/devices', devicesRouter);
  api.use('/uploads', uploadsRouter);
  api.use('/media', mediaRouter);
  api.use('/scrape', scrapeRouter);
  api.use('/ra', raRouter);
  api.use('/saves', savesRouter);
  api.use('/', collectionRouter);

  app.use('/api/v1', api);
  app.use(errorHandler);
  return app;
}
