/**
 * Save conflicts only for real differences: an empty save, or the same save padded to another size, never is one,
 * and a conflict closes once the device holds the server's version.
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
const DATA = path.join(ROOT, 'data-test-conflicts');
let server: Server;
let base = '';
let token = '';
let name = '';

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
  name = `cf${Date.now()}`;
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

test('saves: empty and padded copies are no conflict; a conflict settles once the device holds the server version', async () => {
  const { prisma } = await import('../src/lib/prisma.js');
  const { receiveFromDevice, decide, findLogicalSave } = await import('../src/modules/saves/core.js');
  const claim = async (n: string) => {
    const r = await fetch(`${base}/api/v1/link/claim`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: n, firmware: 'android-esde', root: '/storage/emulated/0' }),
    });
    assert.equal(r.status, 201);
    return prisma.device.findFirstOrThrow({ where: { name: n }, orderBy: { id: 'desc' } });
  };
  const a = await claim(`${name}-a`);
  const b = await claim(`${name}-b`);
  const emu = await prisma.emulator.findFirstOrThrow({ where: { saveFormat: 'raw', core: { not: null } } });
  const data = Buffer.alloc(8192, 0xff);
  data.write('real progress', 100);
  const open = () => prisma.saveConflict.count({ where: { deviceId: b.id, resolvedAt: null, save: { userId: a.userId } } });

  // A save never written to on B gives way to A's: the next sync downloads it
  await receiveFromDevice(a, null, emu, 'SAVE', 0, `${name} Empty`, data);
  const r1 = await receiveFromDevice(b, null, emu, 'SAVE', 0, `${name} Empty`, Buffer.alloc(8192, 0));
  assert.equal(r1.action, 'server-newer');
  assert.equal(await open(), 0);
  const empty = await findLogicalSave(a.userId, emu, 'SAVE', 0, `${name} Empty`, null, false, b.id);
  assert.equal((await decide(empty, b, emu, { sha1: '0'.repeat(40) })).action, 'conflict', 'by hash alone it differs');

  // The same 8 KiB in a 128 KiB file
  await receiveFromDevice(a, null, emu, 'SAVE', 0, `${name} Padded`, data);
  const padded = Buffer.concat([data, Buffer.alloc(131072 - 8192, 0xff)]);
  assert.equal((await receiveFromDevice(b, null, emu, 'SAVE', 0, `${name} Padded`, padded)).action, 'unchanged');
  assert.equal(await open(), 0);

  // Different progress is a conflict, closed when B later holds A's version
  await receiveFromDevice(a, null, emu, 'SAVE', 0, `${name} Real`, data);
  const other = Buffer.from(data);
  other.write('other progress', 100);
  assert.equal((await receiveFromDevice(b, null, emu, 'SAVE', 0, `${name} Real`, other)).action, 'conflict');
  assert.equal(await open(), 1);
  const real = await findLogicalSave(a.userId, emu, 'SAVE', 0, `${name} Real`, null, false, b.id);
  const { sha1 } = await import('../src/modules/saves/core.js');
  assert.equal((await decide(real, b, emu, { sha1: sha1(data) })).action, 'adopt');
  assert.equal(await open(), 0);
});
