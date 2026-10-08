import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { env } from '../../config/env.js';
import { badRequest } from '../../lib/http.js';
import { me, requirePerm } from '../auth/middleware.js';
import { ingestUnverified, ingestVerified } from './ingest.js';

export const uploadsRouter = Router();

const upload = multer({ dest: path.join(env.uploadsDir, 'incoming'), limits: { fileSize: 8 * 1024 * 1024 * 1024 } });

async function withExt(file: Express.Multer.File) {
  const tmp = file.path + path.extname(file.originalname).toLowerCase();
  await fs.promises.rename(file.path, tmp);
  return tmp;
}

uploadsRouter.post('/', requirePerm('roms.upload'), upload.single('file'), async (req, res) => {
  const u = me(req);
  if (!req.file) throw badRequest('Missing file');
  const tmp = await withExt(req.file);
  try {
    const r = await ingestVerified(tmp, req.file.originalname, u);
    res.status(r.status === 'already-owned' ? 200 : 201).json(r);
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
});

uploadsRouter.post('/unverified', requirePerm('roms.uploadUnverified'), upload.single('file'), async (req, res) => {
  const u = me(req);
  if (!req.file) throw badRequest('Missing file');
  const tmp = await withExt(req.file);
  try {
    res.status(201).json(await ingestUnverified(tmp, req.file.originalname, u, req.body));
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
});
