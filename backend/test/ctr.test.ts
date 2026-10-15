/**
 * 3DS saves (Azahar/Citra save folders) synced by the shell client between two Linux consoles through a real server.
 * Requires: compose MySQL up. Uses the e2e test database without resetting it (each run makes its own user).
 * With ROMMANCER_DESKTOP=1 the desktop app's engine (cargo) joins as a third device; with ROMMANCER_DESKTOP=wine it is
 * the Windows build, run by Wine, with Azahar in the Wine user's AppData.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const execFileP = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '../..');
const DATA = path.join(ROOT, 'data-test-ctr');
const CLIENT = path.join(ROOT, 'clients/linux/rommancer-sync.sh');
const NAND = '0123456789abcdef0123456789abcdef/fedcba9876543210fedcba9876543210';
let server: Server;
let base = '';
let token = '';
let userId = 0;

/** A .3ds (NCSD) whose media id is the title id */
function cart(titleId: bigint) {
  const b = crypto.randomBytes(0x4000);
  b.write('NCSD', 0x100, 'latin1');
  b.writeBigUInt64LE(titleId, 0x108);
  return b;
}

/** A .cia whose TMD (RSA-2048 signature) holds the title id */
function cia(titleId: bigint) {
  const b = crypto.randomBytes(0x4000);
  b.writeUInt32LE(0x2020, 0);
  b.writeUInt32LE(0, 4);
  b.writeUInt32LE(0xa00, 8);
  b.writeUInt32LE(0x350, 12);
  // TMD at align64(align64(align64(0x2020) + 0xa00) + 0x350)
  b.writeUInt32BE(0x10004, 0x2dc0);
  b.writeBigUInt64BE(titleId, 0x2dc0 + 4 + 0x13c + 0x4c);
  return b;
}

const saveDir = (sdmc: string, titleId: bigint) =>
  path.join(sdmc, 'Nintendo 3DS', NAND, 'title/00040000', (titleId & 0xffffffffn).toString(16).padStart(8, '0'), 'data');

function writeSave(dir: string, files: Record<string, string>) {
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), content);
  }
}

function readSave(dir: string) {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

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
  const name = `ctr${Date.now()}`;
  const user = await prisma.user.create({ data: { username: name, email: `${name}@test.invalid`, passwordHash: 'x', role: 'ADMIN' } });
  token = signAccess(user);
  userId = user.id;
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

async function enrol(name: string, root: string) {
  const r = await fetch(`${base}/api/v1/link/claim`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, firmware: 'knulli', root }),
  });
  assert.equal(r.status, 201);
  const state = path.join(DATA, `${name}-state`);
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'config'), `SERVER=${base}\nTOKEN=${(await r.json()).token}\n`);
  return { state };
}

test('3ds: Azahar save folders go between consoles whole, keyed by the rom title id', async () => {
  const titleId = 0x0004000000055d00n;
  const ciaId = 0x0004000000123400n;
  const rom = cart(titleId);
  // Console A: Knulli, Azahar under /userdata/saves
  const a = path.join(DATA, 'a');
  const aSys = path.join(DATA, 'a-sys');
  const aSdmc = path.join(aSys, 'userdata/saves/3ds/azahar-emu/sdmc');
  fs.mkdirSync(path.join(a, 'roms/3ds'), { recursive: true });
  fs.writeFileSync(path.join(a, 'roms/3ds', 'Some Game (USA).3ds'), rom);
  fs.writeFileSync(path.join(a, 'roms/3ds', 'Other Game (USA).cia'), cia(ciaId));
  writeSave(saveDir(aSdmc, titleId), { '00000001/main': 'A-MAIN-1', '00000001/system': 'A-SYS' });
  writeSave(saveDir(aSdmc, ciaId), { '00000001/main': 'CIA-SAVE' });
  // Console B: a Linux PC, Azahar in the user's home, the same rom
  const b = path.join(DATA, 'b');
  const bHome = path.join(DATA, 'b-home');
  const bSdmc = path.join(bHome, '.local/share/azahar-emu/sdmc');
  fs.mkdirSync(path.join(b, 'roms/3ds'), { recursive: true });
  fs.mkdirSync(path.join(bSdmc, 'Nintendo 3DS', NAND, 'title/00040000'), { recursive: true });
  fs.writeFileSync(path.join(b, 'roms/3ds', 'Some Game (USA).3ds'), rom);

  const A = await enrol('ctr-a', a);
  const B = await enrol('ctr-b', b);
  const empty = path.join(DATA, 'empty-home');
  fs.mkdirSync(empty, { recursive: true });
  const run = async (c: { state: string }, env: Record<string, string>) =>
    (await execFileP('sh', [CLIENT, 'sync'], { env: { ...process.env, ROMMANCER_STATE: c.state, ...env } })).stdout;
  const runA = () => run(A, { HOME: empty, ROMMANCER_SYSROOT: aSys });
  const runB = () => run(B, { HOME: bHome, ROMMANCER_SYSROOT: path.join(DATA, 'b-sys') });

  assert.match(await runA(), /2 up, 0 down, 0 errors/);
  assert.match(await runA(), /0 up, 0 down, 0 errors/, 'an unchanged folder is not sent again');
  const { prisma } = await import('../src/lib/prisma.js');
  const saves = await prisma.save.findMany({ where: { userId }, include: { emulator: true } });
  assert.equal(saves.length, 2);
  assert.ok(saves.every((s) => s.emulator.slug === 'azahar' && s.emulator.saveFormat === 'ctrdir'));

  assert.match(await runB(), /0 up, 1 down, 0 errors/);
  assert.deepEqual(readSave(saveDir(bSdmc, titleId)), { '00000001/main': 'A-MAIN-1', '00000001/system': 'A-SYS' });
  assert.match(await runB(), /0 up, 0 down, 0 errors/, 'the folder written by the download is not sent back');

  writeSave(saveDir(bSdmc, titleId), { '00000001/main': 'B-MAIN-2' });
  assert.match(await runB(), /1 up, 0 down, 0 errors/);
  assert.match(await runA(), /0 up, 1 down, 0 errors/);
  assert.deepEqual(readSave(saveDir(aSdmc, titleId)), { '00000001/main': 'B-MAIN-2', '00000001/system': 'A-SYS' });
  assert.deepEqual(readSave(saveDir(aSdmc, ciaId)), { '00000001/main': 'CIA-SAVE' }, 'the other game is untouched');

  const desktop = process.env.ROMMANCER_DESKTOP;
  if (desktop !== '1' && desktop !== 'wine') return;
  // The desktop app: same rom, Azahar in its home (or AppData under Wine), picks up B's version
  const c = path.join(DATA, 'c');
  const cHome = path.join(DATA, 'c-home');
  const prefix = path.join(DATA, 'wine');
  const wine = { WINEPREFIX: prefix, WINEDEBUG: '-all', CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUNNER: 'wine' };
  // Async: the test server runs in this process
  if (desktop === 'wine') await execFileP('wineboot', ['-i'], { env: { ...process.env, ...wine } });
  const cSdmc =
    desktop === 'wine'
      ? path.join(prefix, 'drive_c/users', os.userInfo().username, 'AppData/Roaming/Azahar/sdmc')
      : path.join(cHome, '.local/share/azahar-emu/sdmc');
  fs.mkdirSync(path.join(c, 'roms/n3ds'), { recursive: true });
  fs.mkdirSync(path.join(cSdmc, 'Nintendo 3DS', NAND, 'title/00040000'), { recursive: true });
  fs.writeFileSync(path.join(c, 'roms/n3ds', 'Some Game (USA).3ds'), rom);
  const r = await fetch(`${base}/api/v1/link/claim`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'ctr-c', firmware: 'retroarch-desktop', model: 'PC', root: c }),
  });
  assert.equal(r.status, 201);
  const cToken = (await r.json()).token;
  const runC = async () =>
    (
      await execFileP('cargo', ['test', '-q', ...(desktop === 'wine' ? ['--target', 'x86_64-pc-windows-gnu'] : []), 'engine_against_server', '--', '--ignored', '--nocapture'], {
        cwd: path.join(ROOT, 'clients/desktop/src-tauri'),
        env: { ...process.env, ...(desktop === 'wine' ? wine : {}), HOME: cHome, ROMMANCER_TEST_SERVER: base, ROMMANCER_TEST_TOKEN: cToken, ROMMANCER_TEST_ROOT: c, RUSTUP_HOME: process.env.RUSTUP_HOME ?? path.join(process.env.HOME!, '.rustup'), CARGO_HOME: process.env.CARGO_HOME ?? path.join(process.env.HOME!, '.cargo') },
        maxBuffer: 1 << 26,
      })
    ).stdout;
  assert.match(await runC(), /OUT up=0 down=1 errors=0/);
  assert.deepEqual(readSave(saveDir(cSdmc, titleId)), { '00000001/main': 'B-MAIN-2', '00000001/system': 'A-SYS' });
  assert.match(await runC(), /OUT up=0 down=0 errors=0/);
  writeSave(saveDir(cSdmc, titleId), { '00000001/system': 'C-SYS' });
  assert.match(await runC(), /OUT up=1 down=0 errors=0/);
  assert.match(await runA(), /0 up, 1 down, 0 errors/);
  assert.deepEqual(readSave(saveDir(aSdmc, titleId)), { '00000001/main': 'B-MAIN-2', '00000001/system': 'C-SYS' });
});
