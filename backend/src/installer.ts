/**
 * The installer's first step, while the server has no database: a small server that only asks where the database
 * is. The choice is tried by bringing the database's schema up to date; once that works it is kept in
 * DATA_DIR/config/database.json and the installer steps aside for the real server.
 */
import express from 'express';
import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import { z } from 'zod';
import { applyBootstrap, bundledDatabase, bundledPassword, databaseUrl, writeDatabaseConfig, type DatabaseConfig } from './config/bootstrap.js';

const body = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('bundled') }),
  z.object({
    mode: z.literal('external'),
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535).default(3306),
    database: z.string().min(1).max(64),
    user: z.string().min(1).max(64),
    password: z.string().max(256).default(''),
  }),
]);

/** Brings the schema of the database at URL up to date; rejects with prisma's last words */
export function migrate(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: url }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) return resolve();
      // The URL (and its password) never goes back to the browser
      const why = out.split('\n').map((l) => l.trim()).filter((l) => l && !l.includes('mysql://')).slice(-3).join(' ');
      reject(new Error(why || `prisma exited with ${code}`));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The bundled MySQL right after its first start: its password file and its port come a little later */
async function tryBundled(): Promise<string> {
  let last: unknown = new Error('The bundled database has not generated its password yet');
  for (let i = 0; i < 30; i++) {
    const url = bundledPassword() ? databaseUrl({ mode: 'bundled' }) : null;
    if (url) {
      try {
        await migrate(url);
        return url;
      } catch (e) {
        last = e;
      }
    }
    await sleep(2000);
  }
  throw last;
}

/** Serves the installer until a database works; resolves then, with the environment filled for the real server */
export function runInstaller(port: number): Promise<void> {
  return new Promise((resolve) => {
    const app = express();
    let server: Server;
    let busy = false;
    app.disable('x-powered-by');
    app.get('/api/v1/health', (_req, res) => res.json({ ok: true, installing: true }));
    app.get('/api/v1/setup', (_req, res) => res.json({ needsDatabase: true, bundledDatabase: !!bundledDatabase, needsAdmin: true }));
    app.post('/api/v1/setup/database', express.json(), async (req, res) => {
      const parsed = body.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid data' });
      if (busy) return res.status(409).json({ error: 'Already connecting' });
      const c: DatabaseConfig = parsed.data;
      if (c.mode === 'bundled' && !bundledDatabase) return res.status(400).json({ error: 'This installation has no database of its own' });
      busy = true;
      try {
        if (c.mode === 'bundled') await tryBundled();
        else await migrate(databaseUrl(c)!);
        writeDatabaseConfig(c);
        applyBootstrap();
        res.json({ ok: true });
        server.close();
        resolve();
      } catch (e) {
        res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
      } finally {
        busy = false;
      }
    });
    app.use('/api', (_req, res) => res.status(503).json({ error: 'Rommancer is being installed' }));
    server = app.listen(port, () => console.log(`Rommancer installer on :${port}: open the web app to choose the database`));
  });
}
