/**
 * Aplica la semilla del repositorio (seed/) sobre una base de datos vacia y comprueba
 * que se cargan los DATs de todas las consolas y el scraping sin descargar nada.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DATA = path.join(ROOT, 'data-test-seed');
const SEED = path.join(ROOT, 'seed');

before(() => {
  const dbUrl = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?.*)?$/, '/rommancer_test$1');
  Object.assign(process.env, { DATABASE_URL: dbUrl, DATA_DIR: DATA, SEED_DIR: SEED, SEED_AUTO_EXPORT: 'false', EXTERNAL_SYNC_CRON: '' });
  execSync('npx prisma migrate reset --force --skip-seed --skip-generate', { cwd: path.join(ROOT, 'backend'), env: process.env, stdio: 'ignore' });
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
});

after(async () => {
  const { prisma } = await import('../src/lib/prisma.js');
  await prisma.$disconnect();
  fs.rmSync(DATA, { recursive: true, force: true });
});

test('semilla: DATs de todas las consolas, RA y scraping sin red', { skip: !fs.existsSync(path.join(SEED, 'dats', 'manifest.json')) }, async () => {
  const { seed } = await import('../src/seed/seed.js');
  const { applySeed } = await import('../src/modules/seed/service.js');
  const { prisma } = await import('../src/lib/prisma.js');
  await seed();
  // Sin red: cualquier fetch fallaria la prueba
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error('network disabled'))) as typeof fetch;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(SEED, 'dats', 'manifest.json'), 'utf8')) as { system: string }[];
    const r1 = await applySeed();
    assert.equal(r1.datsImported, manifest.length);
    const systems = await prisma.system.findMany({ include: { _count: { select: { games: true } } } });
    for (const slug of new Set(manifest.map((m) => m.system))) {
      assert.ok(systems.find((s) => s.slug === slug)!._count.games > 0, `${slug} sin juegos`);
    }
    const games = JSON.parse(fs.readFileSync(path.join(SEED, 'games.json'), 'utf8')) as unknown[];
    if (games.length) {
      const media = await prisma.media.count();
      assert.ok(media > 0);
      const m = await prisma.media.findFirstOrThrow();
      assert.ok(fs.existsSync(path.join(DATA, 'media', m.path)));
    }
    // Segunda aplicacion: no hay nada nuevo
    const r2 = await applySeed();
    assert.equal(r2.datsImported, 0);
    assert.equal(r2.media, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
