import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';

const data = path.resolve(import.meta.dirname, '../../data-test-journeys');
before(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?.*)?$/, '/rommancer_test$1');
  Object.assign(process.env, { DATA_DIR: data, EXTERNAL_SYNC_CRON: '', ROMMANCER_NO_NOTIFY: '1' });
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: path.resolve(import.meta.dirname, '..'), stdio: 'pipe' });
});

test('Journey API enrolls exact ROMs, protects legacy writes and keeps console selections independent', async () => {
  const { prisma } = await import('../src/lib/prisma.js');
  const { seed } = await import('../src/seed/seed.js');
  const { createApp } = await import('../src/app.js');
  const { signAccess } = await import('../src/modules/auth/middleware.js');
  const { sha256 } = await import('../src/lib/crypto.js');
  await seed();
  const name = `ja-${crypto.randomUUID()}`;
  const user = await prisma.user.create({ data: { username: name, email: `${name}@test.invalid`, passwordHash: 'x' } });
  const firmware = await prisma.firmware.findUniqueOrThrow({ where: { slug: 'android-esde' } });
  const consoleRow = await prisma.console.findFirstOrThrow();
  const aToken = crypto.randomUUID(), bToken = crypto.randomUUID();
  const device = async (token: string) => prisma.device.create({ data: { userId: user.id, name: token, consoleId: consoleRow.id, firmwareId: firmware.id, connType: 'AGENT', rootPath: '/storage/emulated/0', tokenHash: sha256(token) } });
  const a = await device(aToken), b = await device(bToken);
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const bearer = signAccess(user);
  const api = (token: string, route: string, body?: string, headers: Record<string, string> = {}) => fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Device-Token': token, 'Content-Type': 'text/plain', ...headers }, body });
  const rom = '/storage/emulated/0/ROMs/gba/Test.gba';
  const rom64 = Buffer.from(rom).toString('base64');
  const digest = 'c'.repeat(40);
  try {
    const enroll = async (token: string) => {
      const r = await api(token, '/agent/journeys/register', `${rom64}\t${digest}\t${crypto.randomUUID()}\n`);
      assert.equal(r.status, 200, await r.clone().text());
      return (await r.text()).split('\n')[0].split('\t');
    };
    const ar = await enroll(aToken), br = await enroll(bToken);
    assert.equal(ar[2], br[2]); assert.notEqual(ar[3], br[3], 'each console imports into its own preserved branch');
    assert.equal((await api(aToken, '/agent/upload', 'old client write', { 'X-Rom-B64': rom64 })).status, 409);
    assert.equal((await api(aToken, '/agent/file?v=1', undefined, { 'X-Rom-B64': rom64 })).status, 409);
    const switchResponse = await fetch(base + `/journeys/${ar[3]}/switch-requests`, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ bindings: [{ id: br[1], generation: 0 }] }) });
    assert.equal(switchResponse.status, 201);
    const commands = await switchResponse.json() as { id: string }[];
    assert.match(await (await api(bToken, '/agent/journeys/commands')).text(), new RegExp(commands[0].id));
    const operation = crypto.randomUUID();
    assert.equal((await api(bToken, `/agent/journeys/select/${br[1]}`, `${ar[3]}\t1\t${operation}\t${commands[0].id}\n`)).status, 200);
    assert.equal((await prisma.journeyCommand.findUniqueOrThrow({ where: { id: commands[0].id } })).status, 'applied', 'selection and request acknowledgement commit together');
    assert.equal((await prisma.journeyBinding.findUniqueOrThrow({ where: { id: ar[1] } })).generation, 0, 'other console never switches');
    assert.equal((await api(bToken, `/agent/journeys/commands/${commands[0].id}`, 'applied\n')).status, 200);
    assert.equal((await prisma.journeyCommand.findUniqueOrThrow({ where: { id: commands[0].id } })).status, 'applied');
    assert.equal((await api(bToken, `/agent/journeys/select/${br[1]}`, `${br[3]}\t1\t${crypto.randomUUID()}\n`)).status, 409, 'stale generations cannot undo a switch');
    assert.equal((await api(aToken, `/agent/journeys/select/${br[1]}`, `${ar[3]}\t2\t${crypto.randomUUID()}\n`)).status, 400, 'a token cannot operate on another device');
    const list = await fetch(base + '/journeys', { headers: { Authorization: `Bearer ${bearer}` } });
    assert.equal(list.status, 200);
    assert.equal((await list.json() as unknown[]).length, 2);
    assert.equal((await prisma.journeyBinding.count({ where: { deviceId: { in: [a.id, b.id] } } })), 2);
    const pendingBefore = await prisma.journeyCommand.count({ where: { bindingId: ar[1], status: 'pending' } });
    const staleBulk = await fetch(base + `/journeys/${br[3]}/switch-requests`, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ bindings: [{ id: ar[1], generation: 0 }, { id: br[1], generation: 0 }] }) });
    assert.equal(staleBulk.status, 409);
    assert.equal(await prisma.journeyCommand.count({ where: { bindingId: ar[1], status: 'pending' } }), pendingBefore, 'a failed bulk review cannot partially enqueue commands');
    const archive = await fetch(base + `/journeys/${ar[3]}`, { method: 'PATCH', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: true, metadata: 0 }) });
    assert.equal(archive.status, 409, 'selected journeys cannot be archived');
    assert.equal((await api(aToken, '/agent/manifest', undefined, { 'X-Rom-B64': rom64, 'X-Device-Root-B64': Buffer.from('/another/mount').toString('base64') })).status, 409);
    await prisma.device.update({ where: { id: a.id }, data: { coreVersions: { mGBA: 'changed-version' } } });
    assert.equal((await api(aToken, `/agent/journeys/list/${ar[2]}`)).status, 409, 'reported core changes require reconciliation, not state reinterpretation');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test('Linux client enrolls, duplicates offline, switches and synchronizes complete blocks through the real API', async () => {
  const { prisma } = await import('../src/lib/prisma.js');
  const { createApp } = await import('../src/app.js');
  const { sha256 } = await import('../src/lib/crypto.js');
  const fixture = path.join(data, 'linux');
  const name = `jl-${crypto.randomUUID()}`;
  const user = await prisma.user.create({ data: { username: name, email: `${name}@test.invalid`, passwordHash: 'x' } });
  const token = crypto.randomUUID();
  const firmware = await prisma.firmware.findUniqueOrThrow({ where: { slug: 'android-esde' } });
  const consoleRow = await prisma.console.findFirstOrThrow();
  await prisma.device.create({ data: { userId: user.id, name, consoleId: consoleRow.id, firmwareId: firmware.id, connType: 'AGENT', rootPath: fixture, tokenHash: sha256(token),
    overrides: { romsRoot: 'ROMs', savesRoot: 'saves', statesRoot: 'states', savesLayout: 'flat', statesLayout: 'flat', systemMap: { gba: { folder: 'gba', emulator: 'ra-mgba' } } } } });
  const server = createApp().listen(0); await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = path.join(fixture, '.rommancer');
  await fs.mkdir(config, { recursive: true });
  for (const sub of ['ROMs/gba', 'saves', 'states']) await fs.mkdir(path.join(fixture, sub), { recursive: true });
  const rom = path.join(fixture, 'ROMs/gba/Adventure.gba'), save = path.join(fixture, 'saves/Adventure.srm'), auto = path.join(fixture, 'states/Adventure.state.auto');
  await fs.writeFile(rom, 'exact ROM fixture'); await fs.writeFile(save, 'first progress'); await fs.writeFile(auto, 'first auto state');
  await fs.writeFile(path.join(config, 'config'), `SERVER='${base}'\nTOKEN='${token}'\nUSER='${name}'\n`);
  const run = async (...args: string[]) => (await promisify(execFile)('sh', [path.resolve(import.meta.dirname, '../../clients/linux/rommancer-sync.sh'), 'journeys', ...args], {
    env: { ...process.env, ROMMANCER_STATE: config, ROMMANCER_JOURNEY_SETTLE: '0', TMPDIR: fixture, HTTP_MAX: '5' }, timeout: 30000,
  })).stdout;
  try {
    const enrolled = await run('enroll', Buffer.from(rom).toString('base64'));
    const identity = /enrolled\t([a-f0-9]{40})/.exec(enrolled)![1];
    const initial = await run('list', identity);
    const main = /active\t([a-f0-9-]{36})/.exec(initial)![1];
    assert.match(initial, /cached\t/);
    assert.match(initial, new RegExp(`slot\\t${main}\\t1`));
    await run('duplicate', identity, 'Offline copy', '1');
    const slots = await run('list', identity);
    const copy = /active\t([a-f0-9-]{36})/.exec(slots)![1];
    assert.notEqual(copy, main);
    assert.match(slots, new RegExp(`slot\\t${copy}\\t2`));
    assert.equal(await fs.readFile(save, 'utf8'), 'first progress');
    await fs.writeFile(save, 'copy progress'); await fs.writeFile(auto, 'copy auto state');
    await run('sync', identity, '1');
    await run('switch', identity, main, '1');
    const returned = await run('list', identity);
    assert.match(returned, new RegExp(`slot\\t${main}\\t1`), 'slot numbers stay fixed after changing the active journey');
    assert.match(returned, new RegExp(`slot\\t${copy}\\t2`));
    assert.equal(await fs.readFile(save, 'utf8'), 'first progress');
    assert.equal(await fs.readFile(auto, 'utf8'), 'first auto state');
    await run('switch', identity, copy, '1');
    assert.equal(await fs.readFile(save, 'utf8'), 'copy progress');
    assert.equal(await fs.readFile(auto, 'utf8'), 'copy auto state');
    assert.equal(await prisma.journey.count({ where: { userId: user.id } }), 2);
    const latest = await prisma.journey.findUniqueOrThrow({ where: { id: copy } });
    assert.equal(latest.head, 1);
  } finally {
    await new Promise<void>((r, reject) => server.close((e) => e ? reject(e) : r()));
    await prisma.user.delete({ where: { id: user.id } });
  }
});
after(async () => {
  const { prisma } = await import('../src/lib/prisma.js');
  await prisma.$disconnect();
  await fs.rm(data, { recursive: true, force: true });
});

test('journeys: coherent CAS checkpoints, isolation, duplicate, idempotency and exact identity', async () => {
  const { prisma } = await import('../src/lib/prisma.js');
  const { commit, createJourney, putBlob, revision, listJourneys } = await import('../src/modules/journeys/service.js');
  const { hash, identityKey, parseManifest } = await import('../src/modules/journeys/manifest.js');
  const name = `journey-${crypto.randomUUID()}`;
  const user = await prisma.user.create({ data: { username: name, email: `${name}@test.invalid`, passwordHash: 'x' } });
  const other = await prisma.user.create({ data: { username: name + '-2', email: `${name}-2@test.invalid`, passwordHash: 'x' } });
  try {
    const identityId = identityKey('gba', hash('exact rom'));
    assert.notEqual(identityId, identityKey('gb', hash('exact rom')));
    assert.notEqual(identityId, identityKey('gba', hash('patched rom')));
    await prisma.romIdentity.upsert({ where: { id: identityId }, create: { id: identityId, platform: 'gba', digest: hash('exact rom'), title: 'Same title' }, update: {} });
    const j = await createJourney(user.id, { id: crypto.randomUUID(), identityId, name: 'Main' });
    const bytes = Buffer.from('progress 1');
    await putBlob(user.id, hash(bytes), bytes);
    const entries = parseManifest(`ra-mgba/save/0\t${hash(bytes)}\t${bytes.length}\n`);
    const operation = crypto.randomUUID();
    const r = await commit(user.id, j.id, 0, operation, entries);
    assert.equal(r.conflict, false);
    assert.equal((await commit(user.id, j.id, 0, operation, entries)).id, r.id);
    await assert.rejects(commit(user.id, j.id, 0, operation, []), /already used/);
    const divergence = await commit(user.id, j.id, 0, crypto.randomUUID(), []);
    assert.equal(divergence.conflict, true);
    assert.deepEqual((await revision(user.id, j.id)).entries, entries);
    const copy = await createJourney(user.id, { id: crypto.randomUUID(), identityId, name: 'Copy', sourceId: j.id, sourceRevision: 1 });
    assert.deepEqual((await revision(user.id, copy.id)).entries, entries);
    await commit(user.id, copy.id, 1, crypto.randomUUID(), []);
    assert.deepEqual((await revision(user.id, copy.id)).entries, []);
    assert.deepEqual((await revision(user.id, j.id)).entries, entries);
    await assert.rejects(revision(other.id, j.id), /not found/);
    await createJourney(other.id, { id: crypto.randomUUID(), identityId, name: 'Other account' });
    const otherList = await listJourneys(other.id);
    assert.equal(otherList.length, 1);
    assert.equal(otherList[0].entries.length, 0);
    assert.equal(otherList[0].devices.length, 0);
    assert.notEqual(otherList[0].identity.title, 'Same title', 'another owner does not inherit private ROM filenames through a shared content identity');
    await assert.rejects(putBlob(user.id, '0'.repeat(40), bytes), /checksum/);
    assert.throws(() => parseManifest(`../save/0\t${hash(bytes)}\t1\n`));
    assert.throws(() => parseManifest(`ra-mgba/save/0\t${hash(bytes)}\t1\nra-mgba/save/0\t${hash(bytes)}\t1\n`));
    assert.throws(() => parseManifest(`raw/save/1\t${hash(bytes)}\t1\n`));
    assert.throws(() => parseManifest(`ra-mgba/state/01\t${hash(bytes)}\t1\n`));
    const newId = crypto.randomUUID();
    const same = await Promise.allSettled([commit(user.id, j.id, 1, newId, []), commit(user.id, j.id, 1, crypto.randomUUID(), entries)]);
    assert.equal(same.filter((v) => v.status === 'fulfilled' && !v.value.conflict).length, 1);
    assert.equal((await ownedHead(j.id)), 2);
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: [user.id, other.id] } } });
  }
  async function ownedHead(id: string) { return (await prisma.journey.findUniqueOrThrow({ where: { id } })).head; }
});
