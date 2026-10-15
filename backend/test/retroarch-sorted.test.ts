/**
 * An Android device whose RetroArch sorts saves by core: the app says so on /agent/roots and the flat layout follows.
 * Requires: compose MySQL up. Uses the e2e test database without resetting it (each run makes its own user).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DATA = path.join(ROOT, 'data-test-rasorted');
let server: Server;
let base = '';
let token = '';

before(async () => {
  const dbUrl = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?.*)?$/, '/rommancer_test$1');
  Object.assign(process.env, { DATABASE_URL: dbUrl, DATA_DIR: DATA, SEED_DIR: path.join(DATA, 'seed'), SEED_AUTO_EXPORT: 'false', EXTERNAL_SYNC_CRON: '', ROMMANCER_NO_NOTIFY: '1' });
  execSync('npx prisma migrate deploy', { cwd: path.join(ROOT, 'backend'), env: process.env, stdio: 'ignore' });
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  const { seed } = await import('../src/seed/seed.js');
  const { createApp } = await import('../src/app.js');
  const { prisma } = await import('../src/lib/prisma.js');
  const { signAccess } = await import('../src/modules/auth/middleware.js');
  await seed();
  const name = `ras${Date.now()}`;
  const user = await prisma.user.create({ data: { username: name, email: `${name}@test.invalid`, passwordHash: 'x', role: 'ADMIN' } });
  token = signAccess(user);
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  const { prisma } = await import('../src/lib/prisma.js');
  server?.close();
  await prisma.$disconnect();
  fs.rmSync(DATA, { recursive: true, force: true });
});

test('android: saves sorted by core in RetroArch turn a flat layout into core, forgetting the synced bases', async () => {
  const r = await fetch(`${base}/api/v1/link/claim`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'ras-android', firmware: 'android-esde', root: '/storage/emulated/0' }),
  });
  assert.equal(r.status, 201);
  const agent = (await r.json()).token as string;
  const { prisma } = await import('../src/lib/prisma.js');
  const device = await prisma.device.findFirstOrThrow({ where: { name: 'ras-android' }, orderBy: { id: 'desc' } });
  const roots = async (sorted?: string) =>
    (await fetch(`${base}/api/v1/agent/roots`, { headers: { 'X-Device-Token': agent, ...(sorted ? { 'X-RetroArch-Sorted': sorted } : {}) } })).text();

  await roots();
  assert.equal((await prisma.device.findUniqueOrThrow({ where: { id: device.id } })).overrides, null, 'nothing told, nothing changed');

  const save = await prisma.save.findFirst({ select: { id: true } });
  if (save) await prisma.saveDeviceState.create({ data: { saveId: save.id, deviceId: device.id, versionId: null, deviceSha1: 'x'.repeat(40) } });
  await roots('states');
  let o = (await prisma.device.findUniqueOrThrow({ where: { id: device.id } })).overrides as Record<string, string>;
  assert.deepEqual(o, { statesLayout: 'core' });
  assert.equal(await prisma.saveDeviceState.count({ where: { deviceId: device.id } }), 0, 'bases forgotten on a change');

  await roots('saves,states');
  o = (await prisma.device.findUniqueOrThrow({ where: { id: device.id } })).overrides as Record<string, string>;
  assert.deepEqual(o, { statesLayout: 'core', savesLayout: 'core' });
  if (save) await prisma.saveDeviceState.create({ data: { saveId: save.id, deviceId: device.id, versionId: null, deviceSha1: 'x'.repeat(40) } });
  await roots('saves,states');
  assert.equal(await prisma.saveDeviceState.count({ where: { deviceId: device.id } }), save ? 1 : 0, 'no change, bases kept');
});
