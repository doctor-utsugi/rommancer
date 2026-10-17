import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';

const backend = path.resolve(import.meta.dirname, '..');
const testDbUrl = () => process.env.DATABASE_URL!.replace(/\/[^/?]+(\?.*)?$/, '/rommancer_test$1');
const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `rommancer-${name}-`));
// A server process as a fresh installation sees it: no secrets, no database, nothing from the developer's .env
const cleanEnv = (extra: Record<string, string>) => ({ PATH: process.env.PATH!, HOME: process.env.HOME ?? '/tmp', ...extra });

before(() => {
  Object.assign(process.env, { DATABASE_URL: testDbUrl(), DATA_DIR: tmp('setup-data'), EXTERNAL_SYNC_CRON: '', SEED_ON_START: 'false' });
  // Settings the developer's .env may fix: here they come from the panel
  for (const k of ['PUBLIC_URL', 'CORS_ORIGINS', 'FORCE_SYNC_MIN_MINUTES', 'SCREENSCRAPER_DEV_ID', 'SCREENSCRAPER_DEV_PASSWORD']) delete process.env[k];
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: backend, stdio: 'pipe' });
});

after(async () => {
  const { prisma } = await import('../src/lib/prisma.js');
  await prisma.$disconnect();
});

test('bootstrap: secrets made once into DATA_DIR/secrets, the database from the installer\'s choice', () => {
  const data = tmp('bootstrap');
  const read = (extra: Record<string, string> = {}) =>
    JSON.parse(
      execFileSync('npx', ['tsx', '-e', "import('./src/config/bootstrap.ts').then(() => console.log(JSON.stringify({ j: process.env.JWT_SECRET, e: process.env.ENCRYPTION_KEY, d: process.env.DATABASE_URL })))"], {
        cwd: backend,
        env: cleanEnv({ DATA_DIR: data, ...extra }),
      }).toString(),
    );
  const first = read();
  assert.match(first.e, /^[0-9a-f]{64}$/);
  assert.ok(first.j.length >= 40);
  assert.equal(first.d, '', 'no database chosen yet');
  assert.equal(fs.statSync(path.join(data, 'secrets', 'encryption-key')).mode & 0o777, 0o600);
  assert.deepEqual(read(), first, 'kept, never made again');
  assert.equal(read({ ENCRYPTION_KEY: 'f'.repeat(64) }).e, 'f'.repeat(64), 'the environment wins');

  fs.mkdirSync(path.join(data, 'config'));
  fs.writeFileSync(path.join(data, 'config', 'database.json'), JSON.stringify({ mode: 'external', host: 'db.lan', port: 3307, database: 'roms', user: 'me', password: 'p@ss/w' }));
  assert.equal(read().d, 'mysql://me:p%40ss%2Fw@db.lan:3307/roms');
  fs.writeFileSync(path.join(data, 'config', 'database.json'), JSON.stringify({ mode: 'bundled' }));
  assert.equal(read({ ROMMANCER_BUNDLED_DB: 'mysql:3306' }).d, '', 'the bundled MySQL has not made its password yet');
  fs.writeFileSync(path.join(data, 'secrets', 'mysql-password'), 'gen3rated\n');
  assert.equal(read({ ROMMANCER_BUNDLED_DB: 'mysql:3306' }).d, 'mysql://rommancer:gen3rated@mysql:3306/rommancer');
});

test('installer: without a database only the installer answers; a database that works starts the server', async () => {
  const data = tmp('installer');
  const port = await new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
  // Its own process group: npx, tsx and the server all go when the test ends
  const child = spawn('npx', ['tsx', 'src/main.ts'], { cwd: backend, env: cleanEnv({ DATA_DIR: data, API_PORT: String(port), EXTERNAL_SYNC_CRON: '', SEED_ON_START: 'false' }), stdio: 'pipe', detached: true });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}/api/v1`;
  const until = async (fn: () => Promise<boolean>) => {
    for (let i = 0; i < 120; i++) {
      if (await fn().catch(() => false)) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`timed out: ${log}`);
  };
  try {
    await until(async () => (await fetch(`${base}/setup`)).ok);
    assert.deepEqual(await (await fetch(`${base}/setup`)).json(), { needsDatabase: true, bundledDatabase: false, needsAdmin: true });
    assert.equal((await fetch(`${base}/users/me`)).status, 503);
    const send = (body: object) => fetch(`${base}/setup/database`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await send({ mode: 'bundled' })).status, 400, 'no database of its own here');
    const u = new URL(testDbUrl());
    const wrong = await send({ mode: 'external', host: u.hostname, port: Number(u.port), database: 'rommancer_test', user: u.username, password: 'not-the-password' });
    assert.equal(wrong.status, 400);
    assert.doesNotMatch(JSON.stringify(await wrong.json()), /not-the-password/, 'the password never comes back');
    const ok = await send({ mode: 'external', host: u.hostname, port: Number(u.port), database: 'rommancer_test', user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) });
    assert.equal(ok.status, 200, log);
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'config', 'database.json'), 'utf8')).host, u.hostname);
    // The real server takes over: users exist in the test database, so the installer is done
    await until(async () => (await (await fetch(`${base}/setup`)).json()).needsDatabase === false);
    assert.equal((await (await fetch(`${base}/setup`)).json()).needsAdmin, false);
  } finally {
    process.kill(-child.pid!, 'SIGKILL');
  }
});

test('installer: the administrator only while no user exists; server settings with the environment winning', async () => {
  const { prisma } = await import('../src/lib/prisma.js');
  const { loadServerSettings } = await import('../src/lib/settings.js');
  const { createApp } = await import('../src/app.js');
  const { signAccess } = await import('../src/modules/auth/middleware.js');
  const { env } = await import('../src/config/env.js');
  await loadServerSettings();
  const name = `adm-${crypto.randomUUID().slice(0, 8)}`;
  const admin = await prisma.user.create({ data: { username: name, email: `${name}@test.invalid`, passwordHash: 'x', role: 'ADMIN' } });
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = (method: string, route: string, body?: object) =>
    fetch(base + route, { method, headers: { Authorization: `Bearer ${signAccess(admin)}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${base}/setup/admin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'intruder', email: 'i@x.invalid', password: 'long-enough-pw' }) })).status, 409);
    assert.equal((await prisma.user.count({ where: { username: 'intruder' } })), 0);

    const before = await (await call('GET', '/admin/settings/server')).json();
    assert.ok(before.locked.includes('externalSyncCron'), 'EXTERNAL_SYNC_CRON is set in this process');
    assert.equal(before.values.screenscraperDevPassword, false);
    const put = await call('PUT', '/admin/settings/server', { publicUrl: 'http://roms.lan:8096/', externalSyncCron: '0 3 * * *', screenscraperDevPassword: 'dev-secret', forceSyncMinMinutes: 5 });
    assert.equal(put.status, 200);
    const after = await put.json();
    assert.equal(after.values.publicUrl, 'http://roms.lan:8096');
    assert.equal(after.values.externalSyncCron, '', 'the environment keeps it');
    assert.equal(after.values.forceSyncMinMinutes, 5);
    assert.equal(after.values.screenscraperDevPassword, true, 'kept, never sent back');
    assert.equal(env.publicUrl, 'http://roms.lan:8096', 'the server uses it right away');
    assert.equal(env.screenscraper.devPassword, 'dev-secret');
    assert.notEqual((await prisma.setting.findUniqueOrThrow({ where: { key: 'server.screenscraperDevPassword' } })).value, 'dev-secret', 'stored encrypted');
    assert.equal((await call('PUT', '/admin/settings/server', { externalSyncCron: 'every tuesday' })).status, 400);
  } finally {
    await new Promise((r) => server.close(r));
    await prisma.setting.deleteMany({ where: { key: { startsWith: 'server.' } } });
    await prisma.user.delete({ where: { id: admin.id } });
  }
});

test('console installer: the same two steps as the web one, in Spanish, against an empty database', async () => {
  // MySQL's shadow database for prisma migrate dev (the development grants allow it): thrown away and made again
  const shadow = 'rommancer_shadow';
  const { prisma } = await import('../src/lib/prisma.js');
  await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${shadow}`);
  await prisma.$executeRawUnsafe(`CREATE DATABASE ${shadow}`);
  const port = await new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
  const server = spawn('npx', ['tsx', 'src/main.ts'], { cwd: backend, env: cleanEnv({ DATA_DIR: tmp('console'), API_PORT: String(port), SEED_ON_START: 'false' }), stdio: 'ignore', detached: true });
  const base = `http://127.0.0.1:${port}`;
  try {
    const u = new URL(testDbUrl());
    const answers = [
      'es',
      u.hostname, u.port, shadow, decodeURIComponent(u.username), 'not-the-password',
      '', '', '', '', decodeURIComponent(u.password),
      'boss', 'boss@test.invalid', 'short', 'short', 'long-enough-1', 'long-enough-2', 'long-enough-ok', 'long-enough-ok',
    ];
    const cli = spawn('sh', [path.join(backend, '..', 'deploy', 'install.sh'), base, '--plain'], { env: cleanEnv({}), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    cli.stdout.on('data', (d) => (out += d));
    cli.stderr.on('data', (d) => (out += d));
    cli.stdin.end(answers.join('\n') + '\n');
    const code = await new Promise<number | null>((resolve) => cli.on('close', resolve));
    assert.equal(code, 0, out);
    assert.match(out, /MySQL rechaza el usuario o la contraseña\. Revisa ambos\.\n\nDetalles: .*P1000/, 'the wrong MySQL password is explained, with prisma\'s words as the detail');
    assert.match(out, /La contraseña necesita al menos 10 caracteres/);
    assert.match(out, /Al menos 3 caracteres: letras/, 'the username rule is said before asking');
    assert.match(out, /Las contraseñas no coinciden/);
    assert.match(out, /Rommancer está instalado\. Entra en http:\/\/127\.0\.0\.1:\d+ como «boss»/);
    assert.doesNotMatch(out, /long-enough-ok/, 'passwords are never shown');

    const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'boss', password: 'long-enough-ok' }) });
    assert.equal(login.status, 200);
    const auth = { Authorization: `Bearer ${(await login.json()).accessToken}` };
    const me = await (await fetch(`${base}/api/v1/users/me`, { headers: auth })).json();
    assert.equal(me.role, 'ADMIN');
    assert.equal(me.locale, 'es');
    const settings = await (await fetch(`${base}/api/v1/admin/settings/server`, { headers: auth })).json();
    // The installer asks only for the account: the server's settings keep their defaults
    assert.equal(settings.values.publicUrl, '');
    assert.equal(settings.values.externalSyncCron, '0 4 * * 0');
    // Run again, it only says so
    const again = spawn('sh', [path.join(backend, '..', 'deploy', 'install.sh'), base, '--plain'], { env: cleanEnv({}), stdio: ['ignore', 'pipe', 'pipe'] });
    let said = '';
    again.stdout.on('data', (d) => (said += d));
    again.stderr.on('data', (d) => (said += d));
    assert.equal(await new Promise((resolve) => again.on('close', resolve)), 0);
    assert.match(said, /already installed/);
  } finally {
    process.kill(-server.pid!, 'SIGKILL');
    await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${shadow}`);
    await prisma.$executeRawUnsafe(`CREATE DATABASE ${shadow}`);
  }
});

test('console installer, unattended: every answer as an option, nothing asked', async () => {
  const shadow = 'rommancer_shadow';
  const { prisma } = await import('../src/lib/prisma.js');
  await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${shadow}`);
  await prisma.$executeRawUnsafe(`CREATE DATABASE ${shadow}`);
  const port = await new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
  const server = spawn('npx', ['tsx', 'src/main.ts'], { cwd: backend, env: cleanEnv({ DATA_DIR: tmp('unattended'), API_PORT: String(port), SEED_ON_START: 'false' }), stdio: 'ignore', detached: true });
  const base = `http://127.0.0.1:${port}`;
  const run = (args: string[], env: Record<string, string>) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const p = spawn('sh', [path.join(backend, '..', 'deploy', 'install.sh'), base, ...args], { env: cleanEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      p.on('close', (code) => resolve({ code, out }));
    });
  try {
    const u = new URL(testDbUrl());
    const db = ['--db', 'external', '--db-host', u.hostname, `--db-port=${u.port}`, '--db-name', shadow, '--db-user', decodeURIComponent(u.username)];
    // A wrong answer given with the command ends the run: nobody is there to ask again
    const bad = await run(['--lang', 'en', ...db, '--admin', 'ops', '--email', 'ops@test.invalid'], { ROMMANCER_DB_PASSWORD: 'not-the-password', ROMMANCER_ADMIN_PASSWORD: 'long-enough-ok' });
    assert.equal(bad.code, 2, bad.out);
    assert.match(bad.out, /MySQL refused the user or the password/);

    const ok = await run(['--lang', 'en', ...db, '--admin', 'ops', '--email', 'ops@test.invalid'], {
      ROMMANCER_DB_PASSWORD: decodeURIComponent(u.password),
      ROMMANCER_ADMIN_PASSWORD: 'long-enough-ok',
    });
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /Rommancer is installed\. Log in at http:\/\/127\.0\.0\.1:\d+ as "ops"/);
    const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ops', password: 'long-enough-ok' }) });
    assert.equal(login.status, 200);
  } finally {
    process.kill(-server.pid!, 'SIGKILL');
    await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${shadow}`);
    await prisma.$executeRawUnsafe(`CREATE DATABASE ${shadow}`);
  }
});
