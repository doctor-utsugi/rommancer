/**
 * Browsing the server's games from a console (docs/browse.md): the fuzzy ranking on its own, then the agent endpoints
 * against a real server: systems and games, the space check, adding a selection and its download plan.
 * Requires: compose MySQL up. Uses the e2e test database without resetting it (each run makes its own user and games).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { query, score, searchable } from '../src/modules/browse/fuzzy.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DATA = path.join(ROOT, 'data-test-browse');
const RUN = `zq${Date.now().toString(36)}`;
let server: Server;
let base = '';
let token = '';
const games: Record<string, number> = {};

test('fuzzy: typos, roman numerals, acronyms and words together or apart', () => {
  const titles = ['Final Fantasy VII', 'Final Fantasy VI', 'Final Fight', 'Super Mario Bros. 3', 'Mega Man X', 'Megaman Battle Network', 'Castlevania: Symphony of the Night', 'Street Fighter II Turbo', 'Pokémon Red Version'];
  const top = (q: string) => titles.map((t) => ({ t, n: score(query(q), searchable(t)) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).map((x) => x.t);
  assert.equal(top('final fantasy 7')[0], 'Final Fantasy VII');
  assert.equal(top('fianl fantasy vii')[0], 'Final Fantasy VII');
  assert.equal(top('ff7')[0], 'Final Fantasy VII');
  assert.equal(top('smb3')[0], 'Super Mario Bros. 3');
  assert.equal(top('sotn')[0], 'Castlevania: Symphony of the Night');
  assert.equal(top('castelvania')[0], 'Castlevania: Symphony of the Night');
  assert.equal(top('street figter 2')[0], 'Street Fighter II Turbo');
  assert.equal(top('pokemon')[0], 'Pokémon Red Version');
  assert.deepEqual(top('megaman').slice(0, 2).sort(), ['Mega Man X', 'Megaman Battle Network']);
  assert.deepEqual(top('zzzz qqqq'), []);
});

before(async () => {
  const dbUrl = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?.*)?$/, '/rommancer_test$1');
  Object.assign(process.env, { DATABASE_URL: dbUrl, DATA_DIR: DATA, SEED_DIR: path.join(DATA, 'seed'), SEED_AUTO_EXPORT: 'false', EXTERNAL_SYNC_CRON: '', ROMMANCER_NO_NOTIFY: '1' });
  execSync('npx prisma migrate deploy', { cwd: path.join(ROOT, 'backend'), env: process.env, stdio: 'ignore' });
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'roms'), { recursive: true });
  const { seed } = await import('../src/seed/seed.js');
  const { createApp } = await import('../src/app.js');
  const { prisma } = await import('../src/lib/prisma.js');
  const { signAccess } = await import('../src/modules/auth/middleware.js');
  await seed();
  const user = await prisma.user.create({ data: { username: RUN, email: `${RUN}@test.invalid`, passwordHash: 'x', role: 'ADMIN' } });
  token = signAccess(user);
  // The server's own roms: three SNES games (one with two versions) and two Game Boy games, stored as files
  const romPath = await prisma.romPath.upsert({ where: { path: path.join(DATA, 'roms') }, create: { label: 'browse test', path: path.join(DATA, 'roms') }, update: {} });
  const add = async (slug: string, title: string, versions: { name: string; regions: string[]; size: number }[]) => {
    const system = await prisma.system.findUniqueOrThrow({ where: { slug } });
    const dat = await prisma.datSource.upsert({ where: { systemId_type_name: { systemId: system.id, type: 'NOINTRO', name: RUN } }, create: { type: 'NOINTRO', systemId: system.id, name: RUN, fileSha1: RUN }, update: {} });
    const game = await prisma.game.create({ data: { systemId: system.id, title, titleNormalized: title.toLowerCase() } });
    for (const v of versions) {
      const content = crypto.randomBytes(v.size);
      const rel = `${slug}/${v.name}`;
      fs.mkdirSync(path.join(DATA, 'roms', slug), { recursive: true });
      fs.writeFileSync(path.join(DATA, 'roms', rel), content);
      const sha1 = crypto.createHash('sha1').update(content).digest('hex');
      const rom = await prisma.rom.create({ data: { gameId: game.id, datSourceId: dat.id, name: v.name.replace(/\.[^.]+$/, ''), regions: v.regions, languages: [], flags: [] } });
      const part = await prisma.romPart.create({ data: { romId: rom.id, name: v.name, size: v.size, sha1, crc32: '00000000' } });
      await prisma.romFile.create({ data: { romPathId: romPath.id, pathKey: crypto.createHash('sha1').update(rel).digest('hex'), relativePath: rel, size: v.size, mtimeMs: 0, crc32: '00000000', sha1, romPartId: part.id, status: 'MATCHED' } });
    }
    games[title] = game.id;
  };
  await add('snes', `${RUN} Quest VII`, [{ name: `${RUN} Quest VII (USA).sfc`, regions: ['USA'], size: 3000 }, { name: `${RUN} Quest VII (Japan).sfc`, regions: ['Japan'], size: 2900 }]);
  await add('snes', `${RUN} Quest VI`, [{ name: `${RUN} Quest VI (USA).sfc`, regions: ['USA'], size: 2000 }]);
  await add('snes', `${RUN} Mega Hero`, [{ name: `${RUN} Mega Hero (USA).sfc`, regions: ['USA'], size: 1000 }]);
  await add('gb', `${RUN} Pocket One`, [{ name: `${RUN} Pocket One (World).gb`, regions: ['World'], size: 500 }]);
  await add('gb', `${RUN} Pocket Two`, [{ name: `${RUN} Pocket Two (World).gb`, regions: ['World'], size: 700 }]);
  // A cheat list a console sent as if it were the game's rom: in the library, but no game to offer
  await add('gb', `${RUN} Cheat List`, [{ name: `${RUN} Cheat List`, regions: [], size: 853 }]);
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

async function enrol(name: string, bearer = token) {
  const r = await fetch(`${base}/api/v1/link/claim`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, firmware: 'knulli', root: path.join(DATA, name) }),
  });
  assert.equal(r.status, 201);
  return (await r.json()).token as string;
}

const GB = 1024 ** 3;
async function agent(dev: string, p: string, opts: { body?: string; space?: [number, number] } = {}) {
  const headers: Record<string, string> = { 'X-Device-Token': dev };
  if (opts.space) headers['X-Space'] = opts.space.join(' ');
  const r = await fetch(`${base}/api/v1/agent${p}`, { method: opts.body === undefined ? 'GET' : 'POST', headers, body: opts.body });
  assert.equal(r.status, 200, `${p}: ${r.status}`);
  return (await r.text()).split('\n').filter(Boolean).map((l) => l.split('\t'));
}
const line = (rows: string[][], key: string) => rows.find((r) => r[0] === key);

test('browse: systems, search, the space check and adding a selection', async () => {
  const dev = await enrol(`${RUN}-con`);
  const systems = await agent(dev, '/browse/systems');
  const snes = systems.find((r) => r[1] === 'snes');
  assert.ok(snes && Number(snes[2]) >= 3, 'SNES is offered with its games');
  const cheat = await agent(dev, `/browse/games?q=${encodeURIComponent(`${RUN} cheat list`)}`);
  assert.ok(!cheat.some((r) => r[0] === 'game' && Number(r[1]) === games[`${RUN} Cheat List`]), 'a file without a rom extension is not offered');

  // One version per game (the USA one), sized by its file
  const all = await agent(dev, `/browse/games?system=snes&q=${encodeURIComponent(RUN)}&limit=200`);
  const quest7 = all.find((r) => r[0] === 'game' && Number(r[1]) === games[`${RUN} Quest VII`]);
  assert.ok(quest7);
  assert.deepEqual([quest7[2], quest7[3], quest7[4]], ['3000', 'new', 'snes']);
  // A typo and a roman numeral written as a number: the right game first
  const typo = await agent(dev, `/browse/games?q=${encodeURIComponent(`${RUN} qeust 7`)}`);
  assert.equal(Number(typo[1][1]), games[`${RUN} Quest VII`]);
  assert.equal(line(typo, 'total')?.[1], String(typo.length - 1));

  // Too little room: refused, and nothing is added
  const pick = `game\t${games[`${RUN} Quest VII`]}\ngame\t${games[`${RUN} Mega Hero`]}\n`;
  const tight = await agent(dev, '/browse/check', { body: pick, space: [50 * 1024 * 1024 + 1000, 100 * 1024 * 1024] });
  assert.deepEqual(line(tight, 'need'), ['need', '4000', '2']);
  assert.deepEqual(line(tight, 'fits'), ['fits', '0']);
  const refused = await agent(dev, '/browse/add', { body: pick, space: [50 * 1024 * 1024 + 1000, 100 * 1024 * 1024] });
  assert.ok(line(refused, 'nospace'));
  assert.equal((await agent(dev, '/roms')).length, 0);
  // Unknown space: never accepted blindly
  assert.equal(line(await agent(dev, '/browse/check', { body: pick }), 'fits')?.[1], '0');

  // Room enough: added, planned for download, then marked queued
  const added = await agent(dev, '/browse/add', { body: pick, space: [10 * GB, 32 * GB] });
  assert.deepEqual(line(added, 'added'), ['added', '2', '4000']);
  const plan = await agent(dev, '/roms', { space: [10 * GB, 32 * GB] });
  assert.equal(plan.length, 2);
  assert.ok(plan.some((r) => r[1].endsWith(`/roms/snes/${RUN} Quest VII (USA).sfc`) && r[2] === '3000'));
  const rom = await fetch(`${base}/api/v1/agent/rom?f=${plan[0][3]}`, { headers: { 'X-Device-Token': dev } });
  assert.equal(rom.status, 200);
  const after1 = await agent(dev, `/browse/games?system=snes&q=${encodeURIComponent(RUN)}`);
  assert.equal(after1.find((r) => Number(r[1]) === games[`${RUN} Quest VII`])?.[3], 'queued');
  // By default the consoles ask only for what is not here or on its way
  const fresh = await agent(dev, `/browse/games?system=snes&show=new&q=${encodeURIComponent(RUN)}`);
  assert.ok(!fresh.some((r) => Number(r[1]) === games[`${RUN} Quest VII`]));
  assert.ok(fresh.some((r) => Number(r[1]) === games[`${RUN} Quest VI`]));
  const snesNow = (await agent(dev, '/browse/systems')).find((r) => r[1] === 'snes')!;
  assert.equal(Number(snesNow[3]) - Number(snesNow[6]) >= 4000, true, 'newBytes leaves out the games picked');
  // Picked again: nothing new
  assert.deepEqual(line(await agent(dev, '/browse/add', { body: pick, space: [10 * GB, 32 * GB] }), 'added'), ['added', '0', '0']);
  // The space the check now counts: what the lists still have to bring
  assert.equal(line(await agent(dev, '/browse/check', { body: `game\t${games[`${RUN} Quest VI`]}\n`, space: [10 * GB, 32 * GB] }), 'pending')?.[1], '4000');

  // The picks are one list, given to the device, that the web app's "send" fills too
  const { prisma } = await import('../src/lib/prisma.js');
  const d = await prisma.device.findFirstOrThrow({ where: { name: `${RUN}-con` }, include: { picksList: { include: { items: true } } } });
  assert.equal(d.picksList?.kind, 'device');
  assert.equal(d.picksList?.items.length, 2);
  const sent = await fetch(`${base}/api/v1/devices/${d.id}/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ gameIds: [games[`${RUN} Quest VI`]] }),
  });
  assert.equal(sent.status, 201);
  assert.equal((await sent.json()).listId, d.picksListId);
});

test('browse: a whole system, a game unticked in it, and a system the device leaves out', async () => {
  const dev = await enrol(`${RUN}-sys`);
  const { prisma } = await import('../src/lib/prisma.js');
  await prisma.device.updateMany({ where: { name: `${RUN}-sys` }, data: { systemFilter: { newAuto: false, excluded: ['gb'], known: ['gb'], excludedGames: [] } } });
  const gb = (await agent(dev, '/browse/games?system=gb&limit=200')).filter((r) => r[0] === 'game');
  const ours = gb.filter((r) => r[5].startsWith(RUN));
  assert.equal(ours.length, 2);
  // Everything else on the test server's Game Boy shelf is left out too, to count only this run's games
  const skip = gb.filter((r) => !r[5].startsWith(RUN) || Number(r[1]) === games[`${RUN} Pocket Two`]).map((r) => `skip\t${r[1]}\n`).join('');
  const added = await agent(dev, '/browse/add', { body: `system\tgb\n${skip}`, space: [10 * GB, 32 * GB] });
  assert.deepEqual(line(added, 'added'), ['added', '1', '500']);
  const d = await prisma.device.findFirstOrThrow({ where: { name: `${RUN}-sys` } });
  const filter = d.systemFilter as { excluded: string[]; known: string[] };
  assert.ok(!filter.excluded.includes('gb') && filter.known.includes('gb'), 'picking turns the system back on');
  const plan = await agent(dev, '/roms', { space: [10 * GB, 32 * GB] });
  assert.ok(plan.some((r) => r[1].endsWith(`${RUN} Pocket One (World).gb`)));
  assert.ok(!plan.some((r) => r[1].endsWith(`${RUN} Pocket Two (World).gb`)));
});

test('browse: a selection saved as a new list, added to another, and given to the console', async () => {
  const dev = await enrol(`${RUN}-lst`);
  const { prisma } = await import('../src/lib/prisma.js');
  const pick = `game\t${games[`${RUN} Quest VII`]}\ngame\t${games[`${RUN} Quest VI`]}\n`;
  const named = line(await agent(dev, '/browse/check', { body: pick, space: [10 * GB, 32 * GB] }), 'listname');
  assert.match(named?.[1] ?? '', /^Super Nintendo · \d{1,2} [A-Z][a-z]{2}$/);

  // Not given to the console, so nothing downloads
  const saved = await agent(dev, '/browse/list', { body: `${pick}name\t${RUN} road trip\n`, space: [10 * GB, 32 * GB] });
  const row = line(saved, 'list')!;
  assert.deepEqual(row.slice(2), ['2', '2', '0', `${RUN} road trip`]);
  const listId = Number(row[1]);
  assert.equal((await agent(dev, '/roms', { space: [10 * GB, 32 * GB] })).length, 0);
  // The next name offered for the same games is numbered when taken
  await prisma.list.update({ where: { id: listId }, data: { name: named![1] } });
  assert.equal(line(await agent(dev, '/browse/check', { body: pick, space: [10 * GB, 32 * GB] }), 'listname')?.[1], `${named![1]} (2)`);

  const lists = await agent(dev, '/browse/lists');
  assert.equal(lists[0][0], 'list');
  assert.ok(lists.some((r) => Number(r[1]) === listId));
  const more = await agent(dev, '/browse/list', { body: `game\t${games[`${RUN} Mega Hero`]}\ngame\t${games[`${RUN} Quest VI`]}\nlist\t${listId}\nassign\t1\n`, space: [10 * GB, 32 * GB] });
  assert.deepEqual(line(more, 'list')?.slice(2, 5), ['1', '2', '1']);
  const plan = await agent(dev, '/roms', { space: [10 * GB, 32 * GB] });
  assert.ok(plan.some((r) => r[1].endsWith(`/roms/snes/${RUN} Mega Hero (USA).sfc`)));
  // The console has the list now, so an add needs room
  const full = await agent(dev, '/browse/list', { body: `game\t${games[`${RUN} Pocket One`]}\nlist\t${listId}\n`, space: [50 * 1024 * 1024 + 10, 100 * 1024 * 1024] });
  assert.ok(line(full, 'nospace'));
  assert.equal(await prisma.listItem.count({ where: { listId } }), 3);
  const other = await prisma.user.create({ data: { username: `${RUN}o`, email: `${RUN}o@test.invalid`, passwordHash: 'x', role: 'USER' } });
  const theirs = await prisma.list.create({ data: { ownerId: other.id, name: 'theirs', visibility: 'PUBLIC' } });
  assert.ok(line(await agent(dev, '/browse/list', { body: `${pick}list\t${theirs.id}\n`, space: [10 * GB, 32 * GB] }), 'nolist'));
});

test('browse: an account that may not download games is told so', async () => {
  const { prisma } = await import('../src/lib/prisma.js');
  const { signAccess } = await import('../src/modules/auth/middleware.js');
  const u = await prisma.user.create({ data: { username: `${RUN}u`, email: `${RUN}u@test.invalid`, passwordHash: 'x', role: 'USER' } });
  const dev = await enrol(`${RUN}-user`, signAccess(u));
  assert.deepEqual(await agent(dev, '/browse/systems'), [['denied']]);
  assert.deepEqual(await agent(dev, '/browse/add', { body: `game\t${games[`${RUN} Mega Hero`]}\n`, space: [10 * GB, 32 * GB] }), [['denied']]);
});

test('browse: the Linux client picks a game, downloads it and then counts it as here', async () => {
  const name = `${RUN}-sh`;
  const root = path.join(DATA, name);
  fs.mkdirSync(path.join(root, 'roms'), { recursive: true });
  const dev = await enrol(name);
  const state = path.join(DATA, `${name}-state`);
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'config'), `SERVER=${base}\nTOKEN=${dev}\n`);
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const env = { ...process.env, ROMMANCER_STATE: state, ROMMANCER_ROOT: root, ROMMANCER_FIRMWARE: 'knulli', ROMMANCER_SYSROOT: path.join(DATA, `${name}-sys`), ROMMANCER_ES_API: 'http://127.0.0.1:9' };
  const sh = async (...args: string[]) => (await promisify(execFile)('sh', [path.join(ROOT, 'clients/linux/rommancer-sync.sh'), ...args], { env })).stdout;
  assert.match(await sh('browse-systems'), /^system\tsnes\t/m);
  const found = await sh('browse-games', 'snes', '0', `${RUN} mega hero`);
  assert.match(found.split('\n')[1], new RegExp(`^game\t${games[`${RUN} Mega Hero`]}\t1000\tnew\tsnes\t`));
  const sel = path.join(DATA, `${name}-sel`);
  fs.writeFileSync(sel, `game\t${games[`${RUN} Mega Hero`]}\n`);
  assert.match(await sh('browse-check', sel), /^fits\t1$/m);
  assert.match(await sh('browse-add', sel), /^added\t1\t1000$/m);
  const out = await sh('browse-get');
  assert.match(out, /^sum\tgames-down\t1$/m);
  assert.match(out, /^sum\tgames-show\t1\tknulli$/m);
  assert.equal(fs.statSync(path.join(root, 'roms/snes', `${RUN} Mega Hero (USA).sfc`)).size, 1000);
  // EmulationStation knew nothing of it: it gets the game's name from the server, not its file name
  const gamelist = fs.readFileSync(path.join(root, 'roms/snes/gamelist.xml'), 'utf8');
  assert.match(gamelist, new RegExp(`<path>\\./${RUN} Mega Hero \\(USA\\)\\.sfc</path>\\n\t\t<name>${RUN} Mega Hero</name>`), gamelist);
  const after = await sh('browse-games', 'snes', '0', `${RUN} mega hero`, '50', 'all');
  assert.match(after.split('\n')[1], new RegExp(`^game\t${games[`${RUN} Mega Hero`]}\t1000\there\tsnes\t`), 'the inventory pass after the download marks it as here');
  // By default the client leaves out what the console has
  assert.doesNotMatch(await sh('browse-games', 'snes', '0', `${RUN} mega hero`), new RegExp(`^game\t${games[`${RUN} Mega Hero`]}\t`, 'm'));
});

test('browse: the Linux client saves a selection as a new list, then adds to it and takes it', async () => {
  const name = `${RUN}-shl`;
  const root = path.join(DATA, name);
  fs.mkdirSync(path.join(root, 'roms'), { recursive: true });
  const dev = await enrol(name);
  const state = path.join(DATA, `${name}-state`);
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'config'), `SERVER=${base}\nTOKEN=${dev}\n`);
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const env = { ...process.env, ROMMANCER_STATE: state, ROMMANCER_ROOT: root, ROMMANCER_FIRMWARE: 'knulli', ROMMANCER_SYSROOT: path.join(DATA, `${name}-sys`), ROMMANCER_ES_API: 'http://127.0.0.1:9' };
  const sh = async (...args: string[]) => (await promisify(execFile)('sh', [path.join(ROOT, 'clients/linux/rommancer-sync.sh'), ...args], { env })).stdout;
  const sel = path.join(DATA, `${name}-sel`);
  const pick = `game\t${games[`${RUN} Quest VII`]}\n`;
  fs.writeFileSync(sel, pick);
  assert.match(await sh('browse-check', sel), /^listname\tSuper Nintendo · /m);

  fs.writeFileSync(sel, `${pick}name\t${RUN} sh trip\n`);
  const saved = (await sh('browse-list', sel)).split('\n').find((l) => l.startsWith('list\t'))!.split('\t');
  assert.deepEqual(saved.slice(2), ['1', '1', '0', `${RUN} sh trip`]);
  const lists = await sh('browse-lists');
  assert.match(lists, new RegExp(`^list\t${saved[1]}\t1\t${RUN} sh trip$`, 'm'));

  // One of the two games is in the list already
  fs.writeFileSync(sel, `${pick}game\t${games[`${RUN} Mega Hero`]}\nlist\t${saved[1]}\nassign\t1\n`);
  const more = await sh('browse-list', sel);
  assert.match(more, new RegExp(`^list\t${saved[1]}\t1\t2\t1\t${RUN} sh trip$`, 'm'));
  const plan = await agent(dev, '/roms', { space: [10 * GB, 32 * GB] });
  assert.ok(plan.some((r) => r[1].endsWith(`/roms/snes/${RUN} Mega Hero (USA).sfc`)));
});

test('browse: the desktop app saves a pick as a list, picks a game, downloads it and then counts it as here', { skip: process.env.ROMMANCER_DESKTOP !== '1' && 'ROMMANCER_DESKTOP=1 runs it (cargo)' }, async () => {
  const name = `${RUN}-desk`;
  const root = path.join(DATA, name);
  fs.mkdirSync(path.join(root, 'roms'), { recursive: true });
  const dev = await enrol(name);
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const env = {
    ...process.env,
    ROMMANCER_TEST_SERVER: base,
    ROMMANCER_TEST_TOKEN: dev,
    ROMMANCER_TEST_ROOT: root,
    ROMMANCER_TEST_SYSTEM: 'snes',
    ROMMANCER_TEST_QUERY: `${RUN} mega hero`,
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? path.join(process.env.HOME!, '.rustup'),
    CARGO_HOME: process.env.CARGO_HOME ?? path.join(process.env.HOME!, '.cargo'),
  };
  const out = (
    await promisify(execFile)('cargo', ['test', '-q', '--lib', 'browse_against_server', '--', '--ignored', '--nocapture'], { cwd: path.join(ROOT, 'clients/desktop/src-tauri'), env, maxBuffer: 1 << 26 })
  ).stdout;
  assert.match(out, new RegExp(`^GAME ${games[`${RUN} Mega Hero`]} 1000 new `, 'm'));
  assert.match(out, /^CHECK need=1000 games=1 fits=true$/m);
  assert.match(out, /^LISTNAME Super Nintendo · /m);
  assert.match(out, /^SAVED 1 1 false Super Nintendo · /m, 'saved as a new list under the suggested name');
  assert.match(out, /^LISTED 1$/m);
  assert.match(out, /^AGAIN 0 1 false$/m, 'added again: nothing new in it');
  assert.match(out, /^ADDED 1$/m);
  assert.match(out, /^OUT games_down=1 failed=0$/m);
  assert.match(out, /^STATE here$/m, 'the inventory pass after the download marks it as here');
  assert.equal(fs.statSync(path.join(root, 'roms/snes', `${RUN} Mega Hero (USA).sfc`)).size, 1000);
});
