/**
 * Prueba de extremo a extremo de todos los flujos sobre una base de datos de test.
 * Requiere: MySQL de compose levantado, 7zz y chdman, ../roms/{nes,snes} y ../data/dats/*.dat.
 * Opcional: contenedor rommancer-sshd en 127.0.0.1:2222 (usuario device/device) para probar SFTP.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DATA = path.join(ROOT, 'data-test');
const ROMS = path.join(ROOT, 'roms');
const SMB3 = 'Super Mario Bros. 3 (USA) (Rev 1)';

// --- Mock de ScreenScraper ---
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
let ssRequests = 0;
const ssMock = http.createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  if (url.pathname.endsWith('/jeuInfos.php')) {
    ssRequests++;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        response: {
          jeu: {
            id: '1234',
            noms: [{ region: 'us', text: 'Mock Game' }],
            synopsis: [{ langue: 'es', text: 'Descripcion de prueba' }],
            dates: [{ region: 'us', text: '1990-02-12' }],
            developpeur: { text: 'Nintendo EAD' },
            editeur: { text: 'Nintendo' },
            joueurs: { text: '1-2' },
            genres: [{ noms: [{ langue: 'es', text: 'Plataformas' }] }],
            medias: [
              { type: 'box-2D', region: 'us', format: 'png', url: `http://127.0.0.1:${(ssMock.address() as AddressInfo).port}/media/box.png` },
              { type: 'manuel', region: 'us', format: 'pdf', url: `http://127.0.0.1:${(ssMock.address() as AddressInfo).port}/media/manual.pdf` },
            ],
          },
        },
      }),
    );
    return;
  }
  if (url.pathname.startsWith('/media/')) {
    res.end(url.pathname.endsWith('.pdf') ? Buffer.from('%PDF-1.4 mock') : PNG);
    return;
  }
  res.statusCode = 404;
  res.end();
});

let base = '';
let server: http.Server;
let adminToken = '';
let userToken = '';
let userId = 0;
const ctx: Record<string, any> = {};

async function api(method: string, p: string, body?: unknown, token = adminToken) {
  const isForm = body instanceof FormData;
  const r = await fetch(`${base}/api/v1${p}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: r.status, json, headers: r.headers };
}

async function waitJob(id: number, token = adminToken) {
  for (let i = 0; i < 1200; i++) {
    const r = await api('GET', `/jobs/${id}`, undefined, token);
    if (r.json.status === 'DONE') return r.json;
    if (r.json.status === 'FAILED') throw new Error(`Job ${id} failed: ${r.json.message}\n${r.json.log}`);
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error('timeout');
}

const sshAvailable = () =>
  new Promise<boolean>((resolve) => {
    const s = net.connect(2222, '127.0.0.1');
    s.on('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
  });

before(async () => {
  await new Promise<void>((r) => ssMock.listen(0, '127.0.0.1', r));
  const dbUrl = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?.*)?$/, '/rommancer_test$1');
  Object.assign(process.env, {
    DATABASE_URL: dbUrl,
    DATA_DIR: DATA,
    SEED_DIR: path.join(DATA, 'seed'),
    SEED_AUTO_EXPORT: 'false',
    SAVE_SYNC_CRON: '',
    SCREENSCRAPER_URL: `http://127.0.0.1:${(ssMock.address() as AddressInfo).port}`,
    SCREENSCRAPER_DEV_ID: 'dev',
    SCREENSCRAPER_DEV_PASSWORD: 'devpass',
    SCREENSCRAPER_USER: '',
    SCREENSCRAPER_PASSWORD: '',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'admin1234',
  });
  execSync('npx prisma db push --force-reset --skip-generate', { cwd: path.join(ROOT, 'backend'), env: process.env, stdio: 'ignore' });
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'dats'), { recursive: true });
  for (const f of ['nointro - Nintendo - Nintendo Entertainment System.dat', 'nointro - Nintendo - Super Nintendo Entertainment System.dat', 'hacks - Nintendo - Nintendo Entertainment System.dat', 'hacks - Nintendo - Super Nintendo Entertainment System.dat']) fs.copyFileSync(path.join(ROOT, 'data/dats', f), path.join(DATA, 'dats', f));

  const { seed } = await import('../src/seed/seed.js');
  const { startJobRunner } = await import('../src/lib/jobs.js');
  const { createApp } = await import('../src/app.js');
  await seed();
  await startJobRunner();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  const { stopJobRunner } = await import('../src/lib/jobs.js');
  const { prisma } = await import('../src/lib/prisma.js');
  stopJobRunner();
  server?.close();
  ssMock.close();
  await prisma.$disconnect();
});

test('auth: login admin, invitacion y registro de usuario', async () => {
  const bad = await api('POST', '/auth/login', { username: 'admin', password: 'nope' });
  assert.equal(bad.status, 401);
  const r = await api('POST', '/auth/login', { username: 'admin', password: 'admin1234' });
  assert.equal(r.status, 200);
  adminToken = r.json.accessToken;
  const refreshed = await api('POST', '/auth/refresh', { refreshToken: r.json.refreshToken });
  assert.equal(refreshed.status, 200);
  adminToken = refreshed.json.accessToken;

  const inv = await api('POST', '/invitations', { role: 'USER' });
  assert.equal(inv.status, 201);
  const check = await api('GET', `/auth/invitations/${inv.json.token}`);
  assert.equal(check.status, 200);
  const reg = await api('POST', '/auth/register', { token: inv.json.token, username: 'player2', email: 'p2@example.com', password: 'player2pass' });
  assert.equal(reg.status, 201);
  userToken = reg.json.accessToken;
  userId = reg.json.user.id;
  const reuse = await api('POST', '/auth/register', { token: inv.json.token, username: 'player3', email: 'p3@example.com', password: 'player3pass' });
  assert.equal(reuse.status, 400);
  const forbidden = await api('GET', '/admin/paths', undefined, userToken);
  assert.equal(forbidden.status, 403);
  const meR = await api('PATCH', '/users/me', { locale: 'en', raUser: 'someone', raApiKey: 'secret' }, userToken);
  assert.equal(meR.status, 204);
  const me = await api('GET', '/users/me', undefined, userToken);
  assert.equal(me.json.locale, 'en');
  assert.equal(me.json.hasRetroAchievements, true);
});

test('dats: importacion No-Intro y hacks', async () => {
  for (const file of ['nointro - Nintendo - Nintendo Entertainment System.dat', 'nointro - Nintendo - Super Nintendo Entertainment System.dat', 'hacks - Nintendo - Nintendo Entertainment System.dat', 'hacks - Nintendo - Super Nintendo Entertainment System.dat']) {
    const j = await api('POST', '/admin/dats/import-file', { file });
    assert.equal(j.status, 202);
    const done = await waitJob(j.json.id);
    assert.equal(done.result.skipped, false);
  }
  const again = await api('POST', '/admin/dats/import-file', { file: 'nointro - Nintendo - Nintendo Entertainment System.dat' });
  assert.equal((await waitJob(again.json.id)).result.skipped, true);
  const dats = await api('GET', '/admin/dats');
  assert.equal(dats.json.length, 4);
  const nes = dats.json.find((d: any) => d.system.slug === 'nes' && d.type === 'NOINTRO');
  assert.ok(nes.romCount > 7000);
});

test('escaneo: rutas, checksums con y sin cabecera, hacks y hash RA', async () => {
  const nes = await api('POST', '/admin/paths', { label: 'NES', path: path.join(ROMS, 'nes') });
  const snes = await api('POST', '/admin/paths', { label: 'SNES', path: path.join(ROMS, 'snes') });
  assert.equal(nes.status, 201);
  ctx.nesPath = nes.json.id;
  ctx.snesPath = snes.json.id;
  const r1 = await waitJob((await api('POST', `/admin/paths/${nes.json.id}/scan`)).json.id);
  const r2 = await waitJob((await api('POST', `/admin/paths/${snes.json.id}/scan`)).json.id);
  assert.ok(r1.result.matched >= 150, `nes matched ${r1.result.matched}`);
  assert.ok(r2.result.matched >= 140, `snes matched ${r2.result.matched}`);
  assert.ok(r2.result.hacksLinked >= 25);
  // Re-escaneo incremental: nada que hashear
  const r3 = await waitJob((await api('POST', `/admin/paths/${nes.json.id}/scan`)).json.id);
  assert.equal(r3.result.hashed, 0);
  assert.equal(r3.result.skipped, 161);

  const smb3 = await api('GET', `/files?q=${encodeURIComponent(SMB3)}`);
  const f = smb3.json.items[0];
  assert.equal(f.status, 'MATCHED');
  assert.equal(f.raHash, '55b7111567c1709e849c574078699577');
  assert.equal(f.headerlessCrc, '2e6301ed');

  const translation = await api('GET', `/files?q=${encodeURIComponent('Chrono Trigger (USA) [T+Spa')}`);
  assert.equal(translation.json.items[0].status, 'HACK');
  const unknown = await api('GET', '/files?status=UNKNOWN&pageSize=100');
  assert.ok(unknown.json.items.some((x: any) => x.relativePath.startsWith('Pooyan')));

  const systems = await api('GET', '/systems');
  const s = systems.json.find((x: any) => x.slug === 'nes');
  assert.ok(s.owned >= 150);
  ctx.nesSystemId = s.id;
  ctx.snesSystemId = systems.json.find((x: any) => x.slug === 'snes').id;
});

test('coleccion: juegos, filtros, faltantes, ficha y fusion', async () => {
  const owned = await api('GET', `/games?systemId=${ctx.nesSystemId}&status=owned&pageSize=500`);
  assert.ok(owned.json.total >= 140);
  const missing = await api('GET', `/games?systemId=${ctx.nesSystemId}&status=missing&pageSize=10`);
  assert.ok(missing.json.total > 3000);
  const search = await api('GET', `/games?q=${encodeURIComponent('Super Mario Bros. 3')}&systemId=${ctx.nesSystemId}`);
  const game = search.json.items.find((g: any) => g.title === 'Super Mario Bros. 3');
  assert.ok(game.ownedCount >= 1);
  ctx.smb3GameId = game.id;
  const detail = await api('GET', `/games/${game.id}`);
  assert.ok(detail.json.roms.length >= 3, 'varias roms por juego');
  const ownedRom = detail.json.roms.find((r: any) => r.name === SMB3);
  assert.equal(ownedRom.owned, true);
  ctx.smb3RomId = ownedRom.id;
  ctx.smb3EuropeRomId = detail.json.roms.find((r: any) => r.name === 'Super Mario Bros. 3 (Europe) (Rev 1)')?.id ?? detail.json.roms.find((r: any) => (r.regions as string[]).includes('Europe'))?.id;
  assert.ok(ctx.smb3EuropeRomId);

  const miss = await api('GET', `/missing?systemId=${ctx.nesSystemId}&region=USA&pageSize=5`);
  assert.ok(miss.json.total > 100);
  assert.ok(miss.json.items.every((r: any) => r.regions.includes('USA')));

  const hacks = await api('GET', `/hacks?systemId=${ctx.snesSystemId}`);
  assert.ok(hacks.json.total >= 60);

  // Fusion: "Rockman" (Japon) dentro de "Mega Man"
  const rock = (await api('GET', `/games?q=Rockman&systemId=${ctx.nesSystemId}`)).json.items.find((g: any) => g.title === 'Rockman');
  const mega = (await api('GET', `/games?q=${encodeURIComponent('Mega Man')}&systemId=${ctx.nesSystemId}`)).json.items.find((g: any) => g.title === 'Mega Man');
  assert.ok(rock && mega);
  const before = (await api('GET', `/games/${mega.id}`)).json.roms.length;
  assert.equal((await api('POST', `/games/${rock.id}/merge`, { intoGameId: mega.id })).status, 204);
  const afterMerge = (await api('GET', `/games/${mega.id}`)).json.roms.length;
  assert.ok(afterMerge > before);
});

test('retroachievements: importacion de hashes y enlace a roms', async () => {
  const detail = (await api('GET', `/games/${ctx.smb3GameId}`)).json;
  const europe = detail.roms.find((r: any) => r.id === ctx.smb3EuropeRomId);
  assert.ok(europe.raHash, 'hash RA precalculado desde el DAT');
  const r = await api('POST', '/ra/import', {
    system: 'nes',
    games: [{ ID: 1446, Title: 'Super Mario Bros. 3', NumAchievements: 60, Hashes: ['55b7111567c1709e849c574078699577', europe.raHash] }],
  });
  assert.equal(r.status, 200);
  const d2 = (await api('GET', `/games/${ctx.smb3GameId}`)).json;
  assert.equal(d2.roms.find((x: any) => x.id === ctx.smb3RomId).raGameId, 1446);
  assert.equal(d2.roms.find((x: any) => x.id === ctx.smb3EuropeRomId).raGameId, 1446);
  const status = await api('GET', '/ra/status');
  assert.ok(status.json.find((s: any) => s.slug === 'nes').roms >= 2);
  const filtered = await api('GET', `/games?systemId=${ctx.nesSystemId}&ra=1`);
  assert.equal(filtered.json.total, 1);
});

test('listas: crear, compartir, colaborar, clonar, sublistas, exportar e importar', async () => {
  const fav = await api('POST', '/lists', { name: 'Favoritos', visibility: 'PRIVATE' });
  assert.equal(fav.status, 201);
  ctx.favId = fav.json.id;
  const titles = ['Super Mario Bros. 3', 'Mega Man 2', 'Contra', 'The Legend of Zelda', 'Metroid', 'Kirby\'s Adventure'];
  const ids: number[] = [];
  for (const t of titles) {
    const g = (await api('GET', `/games?q=${encodeURIComponent(t.replace(/^The /, ''))}&systemId=${ctx.nesSystemId}`)).json.items.find((x: any) => x.title.replace(/, The$/, '') === t.replace(/^The /, '') || x.title === t);
    assert.ok(g, t);
    ids.push(g.id);
  }
  const chrono = (await api('GET', `/games?q=${encodeURIComponent('Chrono Trigger')}&systemId=${ctx.snesSystemId}`)).json.items[0];
  const add = await api('POST', `/lists/${ctx.favId}/items`, { items: [...ids.map((gameId) => ({ gameId })), { gameId: chrono.id }] });
  assert.equal(add.json.added, 7, JSON.stringify(add.json));
  const dup = await api('POST', `/lists/${ctx.favId}/items`, { gameId: ids[0] });
  assert.equal(dup.json.added, 0);
  const hack = (await api('GET', `/hacks?q=${encodeURIComponent('Chrono Trigger (USA) [T+Spa')}`)).json.items[0];
  await api('POST', `/lists/${ctx.favId}/items`, { hackId: hack.id });
  await api('POST', `/lists/${ctx.favId}/items`, { romId: ctx.smb3RomId });

  // Privada: otro usuario no la ve
  assert.equal((await api('GET', `/lists/${ctx.favId}`, undefined, userToken)).status, 403);
  await api('PUT', `/lists/${ctx.favId}/shares`, [{ userId, canEdit: true }]);
  const shared = await api('GET', '/lists?scope=shared', undefined, userToken);
  assert.equal(shared.json.length, 1);
  const kirby = ids[5];
  const del = (await api('GET', `/lists/${ctx.favId}`, undefined, userToken)).json.items.find((i: any) => i.gameId === kirby);
  assert.equal((await api('DELETE', `/lists/${ctx.favId}/items/${del.id}`, undefined, userToken)).status, 204);

  // Publica y clonada por el otro usuario
  await api('PATCH', `/lists/${ctx.favId}`, { visibility: 'PUBLIC' });
  const pub = await api('GET', '/lists?scope=public', undefined, userToken);
  assert.ok(pub.json.some((l: any) => l.id === ctx.favId));
  const clone = await api('POST', `/lists/${ctx.favId}/clone`, { name: 'Mi copia' }, userToken);
  assert.equal(clone.status, 201);
  assert.equal((await api('GET', `/lists/${clone.json.id}`, undefined, userToken)).json.items.length, 8);

  // Lista colaborativa publica: cualquiera puede editar
  const collab = await api('POST', '/lists', { name: 'Colaborativa', visibility: 'PUBLIC', isCollaborative: true });
  assert.equal((await api('POST', `/lists/${collab.json.id}/items`, { gameId: ids[1] }, userToken)).status, 201);

  // Sublista: alternativas Europa > USA
  const eu = await api('POST', `/lists/${ctx.favId}/derive`, { name: 'Favoritos EU', regions: ['Europe', 'USA'], strictRegions: true });
  assert.equal(eu.status, 201);
  ctx.euListId = eu.json.id;
  const euList = (await api('GET', `/lists/${eu.json.id}`)).json;
  const smbEu = euList.items.find((i: any) => i.gameId === ctx.smb3GameId);
  assert.equal(smbEu.romId, ctx.smb3EuropeRomId);
  // Sublista: compatibles con RetroAchievements
  const ra = await api('POST', `/lists/${ctx.favId}/derive`, { name: 'Favoritos RA', raOnly: true });
  const raList = (await api('GET', `/lists/${ra.json.id}`)).json;
  assert.equal(raList.items.filter((i: any) => i.kind === 'rom').length, 1);
  assert.ok(ra.json.skipped.length >= 4);
  // Sublista: solo lo que tengo, preferencia USA
  const usa = await api('POST', `/lists/${ctx.favId}/derive`, { name: 'Favoritos USA (tengo)', regions: ['USA'], ownedOnly: true });
  ctx.usaListId = usa.json.id;
  await api('PATCH', `/lists/${usa.json.id}`, { visibility: 'PUBLIC' });
  const usaList = (await api('GET', `/lists/${usa.json.id}`)).json;
  assert.ok(usaList.items.every((i: any) => i.owned));
  const refresh = await api('POST', `/lists/${usa.json.id}/refresh`);
  assert.equal(refresh.json.added, usaList.items.length);

  // Exportar e importar
  const exp = await api('GET', `/lists/${ctx.favId}/export`);
  assert.equal(exp.json.format, 'rommancer-list');
  const txt = await api('GET', `/lists/${ctx.favId}/export?format=txt`);
  assert.ok(String(txt.json).includes('nes\t'));
  const imp = await api('POST', '/lists/import', { ...exp.json, name: 'Importada' }, userToken);
  assert.equal(imp.status, 201);
  assert.equal(imp.json.unresolved.length, 0);
  assert.equal(imp.json.added, exp.json.items.length);
});

test('listas: descarga zip con estructura de firmware', async () => {
  const files = await api('GET', `/lists/${ctx.usaListId}/files`);
  assert.ok(files.json.items.length >= 5);
  const r = await fetch(`${base}/api/v1/lists/${ctx.usaListId}/download?firmware=knulli&token=${adminToken}`);
  assert.equal(r.status, 200);
  const zipPath = path.join(DATA, 'tmp', 'list.zip');
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.writeFileSync(zipPath, Buffer.from(await r.arrayBuffer()));
  const listing = execSync(`7zz l -ba "${zipPath}"`).toString();
  assert.ok(listing.includes(`roms/nes/${SMB3}.nes`), listing);
  assert.ok(listing.includes('roms/snes/'), listing);
});

test('dispositivos: catalogo, alta local, prueba y copia de lista', async () => {
  const consoles = (await api('GET', '/devices/consoles')).json;
  const firmwares = (await api('GET', '/devices/firmwares')).json;
  const thor = consoles.find((c: any) => c.name === 'AYN Thor');
  const knulli = firmwares.find((f: any) => f.slug === 'knulli');
  const rocknix = firmwares.find((f: any) => f.slug === 'rocknix');
  ctx.firmwares = firmwares;
  const root = path.join(DATA, 'device-sd');
  fs.mkdirSync(root, { recursive: true });
  const d = await api('POST', '/devices', { name: 'Thor Knulli', consoleId: thor.id, firmwareId: knulli.id, connType: 'LOCAL', rootPath: root, syncSaves: true }, userToken);
  assert.equal(d.status, 201);
  ctx.localDevice = d.json.id;
  const asAdmin = await api('GET', `/devices/${d.json.id}`);
  assert.equal(asAdmin.json.sshPassword, undefined);
  assert.equal(asAdmin.json.layout.romsRoot, 'roms');
  const t = await api('POST', `/devices/${d.json.id}/test`, undefined, userToken);
  assert.equal(t.json.ok, true);

  // El usuario copia una lista publica del admin
  const dry = await waitJob((await api('POST', `/devices/${d.json.id}/transfer`, { listId: ctx.usaListId, dryRun: true }, userToken)).json.id, userToken);
  assert.ok(dry.result.plan.length >= 5);
  assert.ok(!fs.existsSync(path.join(root, 'roms/nes')));
  const job = await waitJob((await api('POST', `/devices/${d.json.id}/transfer`, { listId: ctx.usaListId }, userToken)).json.id, userToken);
  assert.ok(job.result.copied >= 5);
  assert.ok(fs.existsSync(path.join(root, 'roms/nes', `${SMB3}.nes`)));
  const again = await waitJob((await api('POST', `/devices/${d.json.id}/transfer`, { listId: ctx.usaListId }, userToken)).json.id, userToken);
  assert.equal(again.result.copied, 0);

  // Otro firmware con overrides de carpetas
  fs.mkdirSync(path.join(DATA, 'device-rocknix'), { recursive: true });
  const d3 = await api('POST', '/devices', { name: 'Thor Rocknix', consoleId: thor.id, firmwareId: rocknix.id, connType: 'LOCAL', rootPath: path.join(DATA, 'device-rocknix'), overrides: { systemMap: { nes: { folder: 'famicom', emulator: 'ra-nestopia' } } } }, userToken);
  ctx.rocknixDevice = d3.json.id;
  await waitJob((await api('POST', `/devices/${d3.json.id}/transfer`, { listId: ctx.usaListId }, userToken)).json.id, userToken);
  assert.ok(fs.existsSync(path.join(DATA, 'device-rocknix/roms/famicom', `${SMB3}.nes`)));
});

test('dispositivos: SSH/SFTP', async (t) => {
  if (!(await sshAvailable())) {
    t.skip('rommancer-sshd no disponible');
    return;
  }
  const consoles = (await api('GET', '/devices/consoles')).json;
  const fw = ctx.firmwares.find((f: any) => f.slug === 'muos');
  const d = await api(
    'POST',
    '/devices',
    { name: 'RG35XX SSH', consoleId: consoles.find((c: any) => c.name === 'Anbernic RG35XX').id, firmwareId: fw.id, connType: 'SSH', rootPath: `/home/device/sd-${Date.now()}`, sshHost: '127.0.0.1', sshPort: 2222, sshUser: 'device', sshPassword: 'device' },
    userToken,
  );
  assert.equal(d.status, 201);
  ctx.sshDevice = d.json.id;
  assert.equal(d.json.sshPassword, undefined, 'no se devuelven credenciales');
  const job = await waitJob((await api('POST', `/devices/${d.json.id}/transfer`, { listId: ctx.usaListId }, userToken)).json.id, userToken);
  assert.ok(job.result.copied >= 5);
  const tst = await api('POST', `/devices/${d.json.id}/test`, undefined, userToken);
  assert.equal(tst.json.ok, true);
  assert.ok(tst.json.romsFolders.includes('Nintendo NES-Famicom'));
});

test('subidas: validacion por hash (DAT, romhack, RetroAchievements)', async () => {
  const target = path.join(DATA, 'uploads-target');
  fs.mkdirSync(target, { recursive: true });
  const p = await api('POST', '/admin/paths', { label: 'Subidas', path: target, isUploadTarget: true });
  assert.equal(p.status, 201);

  const send = async (name: string, buf: Buffer) => {
    const fd = new FormData();
    fd.append('file', new Blob([buf]), name);
    return api('POST', '/uploads', fd, userToken);
  };
  // Fichero basura: rechazado
  const junk = await send('junk.nes', crypto.randomBytes(40000));
  assert.equal(junk.status, 422);
  // Rom que ya existe en la coleccion
  const smb = fs.readFileSync(path.join(ROMS, 'nes', `${SMB3}.nes`));
  const h = (b: Buffer, a: string) => crypto.createHash(a).update(b).digest('hex');
  const pre = await api('POST', '/roms/match', { sha1: h(smb, 'sha1'), md5: h(smb, 'md5'), size: smb.length, headerless: { sha1: h(smb.subarray(16), 'sha1'), md5: h(smb.subarray(16), 'md5') } }, userToken);
  assert.equal(pre.json.status, 'MATCHED');
  assert.equal((await send('cualquier nombre.nes', smb)).json.status, 'already-owned');
  // Romhack registrado por el admin con su hash
  const hackBuf = Buffer.concat([Buffer.from('NES\x1a\x02\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00', 'latin1'), crypto.randomBytes(32768)]);
  await api('POST', '/hacks', { gameId: ctx.smb3GameId, title: 'SMB3 Test Hack', sha1: crypto.createHash('sha1').update(hackBuf).digest('hex'), size: hackBuf.length });
  const up = await send('hack.nes', hackBuf);
  assert.equal(up.status, 201);
  assert.equal(up.json.match, 'HACK');
  assert.ok(fs.existsSync(path.join(target, 'nes', 'SMB3 Test Hack.nes')));
  // Hash conocido solo por RetroAchievements
  const raBuf = Buffer.concat([Buffer.from('NES\x1a\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00', 'latin1'), crypto.randomBytes(24576)]);
  const raHash = crypto.createHash('md5').update(raBuf.subarray(16)).digest('hex');
  await api('POST', '/ra/import', { system: 'nes', games: [{ ID: 99999, Title: 'Homebrew RA', Hashes: [raHash] }] });
  const up2 = await send('Homebrew RA.nes', raBuf);
  assert.equal(up2.status, 201, JSON.stringify(up2.json));
  assert.equal(up2.json.raGameId, 99999);
});

test('scraping: ScreenScraper (mock) y libretro-thumbnails (real)', async (t) => {
  // Sin credenciales de usuario ScreenScraper se omite; el admin pone las suyas
  await api('PATCH', '/users/me', { ssUser: 'user', ssPassword: 'pass' });
  const job = await waitJob((await api('POST', '/scrape', { gameIds: [ctx.smb3GameId], sources: ['screenscraper'], types: ['COVER', 'MANUAL'] })).json.id);
  assert.equal(job.result.media, 2);
  assert.ok(ssRequests >= 1);
  const g = (await api('GET', `/games/${ctx.smb3GameId}`)).json;
  assert.equal(g.developer, 'Nintendo EAD');
  assert.equal(g.releaseYear, 1990);
  const cover = g.media.find((m: any) => m.type === 'COVER');
  const img = await fetch(`${base}${cover.url}?token=${adminToken}`);
  assert.equal(img.status, 200);
  assert.ok(g.media.some((m: any) => m.type === 'MANUAL'));

  try {
    const head = await fetch('https://raw.githubusercontent.com', { method: 'HEAD' });
    if (!head) throw new Error();
  } catch {
    t.skip('sin red');
    return;
  }
  const mm2 = (await api('GET', `/games?q=${encodeURIComponent('Mega Man 2')}&systemId=${ctx.nesSystemId}`)).json.items.find((x: any) => x.title === 'Mega Man 2');
  const lj = await waitJob((await api('POST', '/scrape', { gameIds: [mm2.id], sources: ['libretro'], types: ['COVER', 'SCREENSHOT', 'TITLE'] }, userToken)).json.id, userToken);
  assert.ok(lj.result.media >= 1, JSON.stringify(lj));
});

test('saves: subida, historial, restauracion, conversion y backups', async () => {
  const emus = (await api('GET', '/devices/emulators')).json;
  ctx.emus = Object.fromEntries(emus.map((e: any) => [e.slug, e]));
  const send = async (name: string, buf: Buffer, emulator: string, mtime: number, token = userToken) => {
    const fd = new FormData();
    fd.append('file', new Blob([buf]), name);
    fd.append('emulatorId', String(ctx.emus[emulator].id));
    fd.append('mtime', String(mtime));
    return api('POST', '/saves/upload', fd, token);
  };
  const v1 = crypto.randomBytes(8192);
  const v2 = crypto.randomBytes(8192);
  const now = Date.now();
  const a = await send(`${SMB3}.srm`, v1, 'ra-fceumm', now - 60_000);
  assert.equal(a.status, 201);
  const b = await send(`${SMB3}.srm`, v2, 'ra-fceumm', now);
  const same = await send(`${SMB3}.srm`, v2, 'ra-fceumm', now);
  assert.equal(same.status, 200);
  const save = (await api('GET', `/saves/${a.json.saveId}`, undefined, userToken)).json;
  assert.equal(save.gameId, ctx.smb3GameId, 'save identificado por nombre de rom');
  assert.equal(save.versions.length, 2);
  assert.equal(save.currentVersionId, b.json.versionId);
  // Una version antigua no desplaza a la actual
  const old = await send(`${SMB3}.srm`, crypto.randomBytes(8192), 'ra-fceumm', now - 3600_000);
  assert.notEqual((await api('GET', `/saves/${a.json.saveId}`, undefined, userToken)).json.currentVersionId, old.json.versionId);
  // Restaurar v1
  const rest = await api('POST', `/saves/${a.json.saveId}/restore`, { versionId: a.json.versionId }, userToken);
  const cur = (await api('GET', `/saves/${a.json.saveId}`, undefined, userToken)).json;
  assert.equal(cur.currentVersionId, rest.json.versionId);
  const dl = await fetch(`${base}/api/v1/saves/${a.json.saveId}/versions/${rest.json.versionId}/download?token=${userToken}`);
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(v1));
  ctx.smbSaveId = a.json.saveId;
  // Otro usuario no puede verlo
  assert.equal((await api('GET', `/saves/${a.json.saveId}`)).status, 403);

  // .srm (mGBA RetroArch) -> .sav standalone
  const gba = await send('Some GBA Game (USA).srm', crypto.randomBytes(32768), 'ra-mgba', now);
  const conv = await api('POST', `/saves/${gba.json.saveId}/convert`, { emulatorId: ctx.emus.mgba.id }, userToken);
  assert.equal(conv.status, 201);
  const convDl = await fetch(`${base}/api/v1/saves/${conv.json.saveId}/versions/${conv.json.versionId}/download?token=${userToken}`);
  assert.match(convDl.headers.get('content-disposition')!, /\.sav/);

  // Memory card PS1: srm -> mcd, gme, vmp
  const card = Buffer.alloc(0x20000);
  card.write('MC', 0, 'latin1');
  card[127] = 0x0e;
  crypto.randomBytes(8192).copy(card, 8192);
  const ps1 = await send('Final Fantasy VII (USA) (Disc 1).srm', card, 'ra-pcsx-rearmed', now);
  for (const [slug, size] of [['duckstation', 0x20000], ['dexdrive', 0x20000 + 3904], ['ps3-psp-vmp', 0x20080]] as const) {
    const r = await fetch(`${base}/api/v1/saves/${ps1.json.saveId}/versions/${ps1.json.versionId}/download?emulator=${slug}&token=${userToken}`);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.length, size, slug);
    if (slug === 'ps3-psp-vmp') {
      const { verifyVmp, ps1ToRaw } = await import('../src/modules/saves/convert.js');
      assert.ok(verifyVmp(buf));
      assert.ok(ps1ToRaw(buf, 'ps1vmp').equals(card));
    }
  }
  // Formatos incompatibles
  const bad = await api('POST', `/saves/${ps1.json.saveId}/convert`, { emulatorId: ctx.emus['ra-snes9x'].id }, userToken);
  assert.equal(bad.status, 400);
});

test('saves: sincronizacion con dispositivos (pull, push, conflictos, reubicacion)', async () => {
  const root = path.join(DATA, 'device-sd');
  // Save creado en la consola: Knulli guarda en saves/<sistema>/
  const contra = 'Contra (USA)';
  const devSave = crypto.randomBytes(8192);
  fs.mkdirSync(path.join(root, 'saves/nes'), { recursive: true });
  fs.writeFileSync(path.join(root, 'saves/nes', `${contra}.srm`), devSave);
  fs.writeFileSync(path.join(root, 'saves/nes', `${contra}.state1`), crypto.randomBytes(1000));
  const sync = await waitJob((await api('POST', `/saves/sync/${ctx.localDevice}`, { direction: 'both' }, userToken)).json.id, userToken);
  assert.equal(sync.result.pulled, 2);
  assert.ok(sync.result.pushed >= 1);
  // El save de SMB3 subido por web aparece en la consola
  assert.ok(fs.existsSync(path.join(root, 'saves/nes', `${SMB3}.srm`)));
  const saves = (await api('GET', '/saves', undefined, userToken)).json;
  const state = saves.find((s: any) => s.kind === 'STATE' && s.baseName === contra);
  assert.equal(state.slot, 1);

  // Conflicto: la consola modifica el save despues -> gana el mas reciente, el anterior queda en historial
  const newer = crypto.randomBytes(8192);
  const f = path.join(root, 'saves/nes', `${SMB3}.srm`);
  fs.writeFileSync(f, newer);
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(f, future, future);
  const sync2 = await waitJob((await api('POST', `/saves/sync/${ctx.localDevice}`, { direction: 'pull' }, userToken)).json.id, userToken);
  assert.equal(sync2.result.pulled, 1);
  const smb = (await api('GET', `/saves/${ctx.smbSaveId}`, undefined, userToken)).json;
  const current = smb.versions.find((v: any) => v.id === smb.currentVersionId);
  assert.equal(current.sourceDevice.id, ctx.localDevice);
  assert.ok(smb.versions.length >= 4);

  // Push a otro dispositivo (Rocknix: saves junto a la rom, carpeta 'famicom', otro core)
  await api('PATCH', `/devices/${ctx.rocknixDevice}`, { overrides: { systemMap: { nes: { folder: 'famicom', emulator: 'ra-fceumm' } } } }, userToken);
  const push = await waitJob((await api('POST', `/saves/sync/${ctx.rocknixDevice}`, { direction: 'push' }, userToken)).json.id, userToken);
  assert.ok(push.result.pushed >= 2);
  const pushed = path.join(DATA, 'device-rocknix/roms/famicom', `${SMB3}.srm`);
  assert.ok(fs.readFileSync(pushed).equals(newer));

  // Reubicacion: en el dispositivo la rom tiene otro nombre
  const relocRoot = path.join(DATA, 'device-reloc');
  fs.mkdirSync(path.join(relocRoot, 'roms/nes'), { recursive: true });
  fs.writeFileSync(path.join(relocRoot, 'roms/nes', 'Super Mario Bros. 3 (U) (PRG1) [!].nes'), 'x');
  const thor = (await api('GET', '/devices/consoles')).json.find((c: any) => c.name === 'AYN Thor');
  const fw = ctx.firmwares.find((x: any) => x.slug === 'rocknix');
  const d = await api('POST', '/devices', { name: 'Reloc', consoleId: thor.id, firmwareId: fw.id, connType: 'LOCAL', rootPath: relocRoot }, userToken);
  await waitJob((await api('POST', `/saves/sync/${d.json.id}`, { direction: 'push' }, userToken)).json.id, userToken);
  assert.ok(fs.existsSync(path.join(relocRoot, 'roms/nes', 'Super Mario Bros. 3 (U) (PRG1) [!].srm')));

  // Push por SSH
  if (ctx.sshDevice) {
    const s = await waitJob((await api('POST', `/saves/sync/${ctx.sshDevice}`, { direction: 'both' }, userToken)).json.id, userToken);
    assert.ok(s.result.pushed >= 2, JSON.stringify(s.result));
  }
});

test('organizacion: renombrado y ordenacion por carpetas (dry-run y aplicar)', async () => {
  const dir = path.join(DATA, 'messy');
  fs.mkdirSync(path.join(dir, 'varios'), { recursive: true });
  fs.copyFileSync(path.join(ROMS, 'nes', `${SMB3}.nes`), path.join(dir, 'varios', 'smb3.nes'));
  fs.copyFileSync(path.join(ROMS, 'snes', 'Chrono Trigger (USA).smc'), path.join(dir, 'varios', 'ct.smc'));
  fs.copyFileSync(path.join(ROMS, 'snes', 'Chrono Trigger (USA) [T+Spa1.07_Merida].smc'), path.join(dir, 'ct-es.smc'));
  const p = await api('POST', '/admin/paths', { label: 'Messy', path: dir });
  await waitJob((await api('POST', `/admin/paths/${p.json.id}/scan`)).json.id);
  const plan = (await api('GET', `/admin/paths/${p.json.id}/organize?scheme=knulli`)).json;
  assert.ok(plan.find((x: any) => x.to === path.join('nes', `${SMB3}.nes`)), JSON.stringify(plan));
  assert.ok(plan.find((x: any) => x.to === path.join('snes', 'Chrono Trigger (USA).sfc') || x.to === path.join('snes', 'Chrono Trigger (USA).smc')));
  assert.ok(fs.existsSync(path.join(dir, 'varios', 'smb3.nes')), 'dry-run no mueve nada');
  const applied = (await api('POST', `/admin/paths/${p.json.id}/organize`, { scheme: 'knulli' })).json;
  assert.equal(applied.errors.length, 0);
  assert.ok(fs.existsSync(path.join(dir, 'nes', `${SMB3}.nes`)));
  const rescan = await waitJob((await api('POST', `/admin/paths/${p.json.id}/scan`)).json.id);
  assert.equal(rescan.result.hashed, 0, 'la base de datos sigue sincronizada tras mover');
});

test('discos: CHD de PS1 con hash Redump y RetroAchievements', async (t) => {
  // Disco sintetico: SYSTEM.CNF + ejecutable PS-X EXE en ISO9660, convertido a CHD
  const work = path.join(DATA, 'ps1');
  const src = path.join(work, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'SYSTEM.CNF'), 'BOOT = cdrom:\\SLUS_999.99;1\r\nTCB = 4\r\n');
  const exe = Buffer.alloc(2048 + 8192);
  exe.write('PS-X EXE', 0, 'latin1');
  exe.writeUInt32LE(8192, 28);
  crypto.randomBytes(8192).copy(exe, 2048);
  fs.writeFileSync(path.join(src, 'SLUS_999.99'), exe);
  const iso = path.join(work, 'game.iso');
  try {
    execSync(`hdiutil makehybrid -iso -default-volume-name TEST -o "${iso}" "${src}"`, { stdio: 'ignore' });
  } catch {
    try {
      execSync(`xorriso -as mkisofs -o "${iso}" "${src}"`, { stdio: 'ignore' });
    } catch {
      t.skip('sin herramienta para crear ISO');
      return;
    }
  }
  const romsDir = path.join(work, 'psx');
  fs.mkdirSync(romsDir, { recursive: true });
  execSync(`chdman createcd -i "${iso}" -o "${path.join(romsDir, 'Test Game (USA).chd')}" -f`, { stdio: 'ignore' });
  const expectedRa = crypto.createHash('md5').update('SLUS_999.99').update(exe).digest('hex');

  // DAT Redump minimo con el hash de la pista (2352 bytes/sector tras extraer)
  const tmp = path.join(work, 'x');
  fs.mkdirSync(tmp, { recursive: true });
  execSync(`chdman extractcd -i "${path.join(romsDir, 'Test Game (USA).chd')}" -o "${tmp}/t.cue" -ob "${tmp}/t (Track %t).bin" -sb -f`, { stdio: 'ignore' });
  const bin = fs.readdirSync(tmp).find((f) => f.endsWith('.bin'))!;
  const binBuf = fs.readFileSync(path.join(tmp, bin));
  const sha1 = crypto.createHash('sha1').update(binBuf).digest('hex');
  const dat = `<?xml version="1.0"?><datafile><header><name>Sony - PlayStation</name><version>test</version></header>
    <game name="Test Game (USA)"><description>Test Game (USA)</description>
    <rom name="Test Game (USA).cue" size="80" crc="00000000" md5="00000000000000000000000000000000" sha1="0000000000000000000000000000000000000000"/>
    <rom name="Test Game (USA).bin" size="${binBuf.length}" crc="00000000" sha1="${sha1}"/></game></datafile>`;
  fs.writeFileSync(path.join(DATA, 'dats', 'psx-test.dat'), dat);
  await waitJob((await api('POST', '/admin/dats/import-file', { file: 'psx-test.dat' })).json.id);
  const p = await api('POST', '/admin/paths', { label: 'PS1', path: romsDir });
  const scan = await waitJob((await api('POST', `/admin/paths/${p.json.id}/scan`)).json.id);
  assert.equal(scan.result.matched, 1, JSON.stringify(scan));
  const files = (await api('GET', `/files?romPathId=${p.json.id}`)).json.items;
  assert.equal(files[0].raHash, expectedRa);
  const psx = (await api('GET', '/systems')).json.find((s: any) => s.slug === 'psx');
  assert.equal(psx.owned, 1);
});

test('comprimidos: zip/7z de cartuchos y sets arcade FBNeo', async () => {
  const dir = path.join(DATA, 'archives');
  fs.mkdirSync(path.join(dir, 'fbneo'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'mix'), { recursive: true });
  execSync(`7zz a -tzip "${path.join(dir, 'mix', 'smb3.zip')}" "${path.join(ROMS, 'nes', `${SMB3}.nes`)}"`, { stdio: 'ignore' });
  execSync(`7zz a -t7z "${path.join(dir, 'mix', 'ct.7z')}" "${path.join(ROMS, 'snes', 'Chrono Trigger (USA).smc')}"`, { stdio: 'ignore' });
  // Set arcade sintetico con dos roms internas
  const a = crypto.randomBytes(4096);
  const b = crypto.randomBytes(2048);
  const work = path.join(DATA, 'arcade-src');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'prg.bin'), a);
  fs.writeFileSync(path.join(work, 'gfx.bin'), b);
  execSync(`7zz a -tzip "${path.join(dir, 'fbneo', 'testgame.zip')}" prg.bin gfx.bin`, { cwd: work, stdio: 'ignore' });
  const crc = (x: Buffer) => (zlib.crc32(x) >>> 0).toString(16).padStart(8, '0');
  const dat = `<?xml version="1.0"?><datafile><header><name>FinalBurn Neo - Arcade Games</name><version>1.0</version></header>
    <game name="testgame"><description>Test Game (World)</description>
    <rom name="prg.bin" size="4096" crc="${crc(a)}"/><rom name="gfx.bin" size="2048" crc="${crc(b)}"/></game>
    <game name="testgamej" cloneof="testgame"><description>Test Game (Japan)</description>
    <rom name="prg.bin" size="4096" crc="ffffffff"/></game></datafile>`;
  fs.writeFileSync(path.join(DATA, 'dats', 'fbneo-test.dat'), dat);
  const imp = await waitJob((await api('POST', '/admin/dats/import-file', { file: 'fbneo-test.dat' })).json.id);
  assert.equal(imp.result.system, 'fbneo');
  assert.equal(imp.result.games, 1, 'el clon comparte juego con el padre');
  const p = await api('POST', '/admin/paths', { label: 'Archives', path: dir });
  const scan = await waitJob((await api('POST', `/admin/paths/${p.json.id}/scan`)).json.id);
  assert.equal(scan.result.matched, 4, JSON.stringify(scan.result));
  const files = (await api('GET', `/files?romPathId=${p.json.id}&pageSize=10`)).json.items;
  const arcade = files.find((f: any) => f.archiveEntry === 'prg.bin');
  assert.equal(arcade.raHash, crypto.createHash('md5').update('testgame').digest('hex'));
  const smb = files.find((f: any) => f.relativePath.endsWith('smb3.zip'));
  assert.equal(smb.raHash, '55b7111567c1709e849c574078699577');
  const fb = (await api('GET', '/systems')).json.find((s: any) => s.slug === 'fbneo');
  assert.equal(fb.owned, 1);
  const g = (await api('GET', `/games?systemId=${fb.id}`)).json.items[0];
  assert.equal(g.title, 'Test Game');
  assert.equal(g.romCount, 2);
});

test('discos: RVZ de GameCube verificado contra Redump sin dolphin-tool', async () => {
  const { makeGcRvz } = await import('./helpers/rvz-encoder.js');
  const { raHashGamecubeFrom } = await import('../src/lib/rahash.js');
  const { iso, rvz } = makeGcRvz();
  const dir = path.join(DATA, 'gcroms', 'gc');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Test GC Game (USA).rvz'), rvz);
  const h = (a: string) => crypto.createHash(a).update(iso).digest('hex');
  const dat = `<?xml version="1.0"?><datafile><header><name>Nintendo - GameCube</name><version>test</version></header>
    <game name="Test GC Game (USA)"><description>Test GC Game (USA)</description>
    <rom name="Test GC Game (USA).iso" size="${iso.length}" crc="${(zlib.crc32(iso) >>> 0).toString(16).padStart(8, '0')}" md5="${h('md5')}" sha1="${h('sha1')}"/></game></datafile>`;
  fs.writeFileSync(path.join(DATA, 'dats', 'gc-test.dat'), dat);
  await waitJob((await api('POST', '/admin/dats/import-file', { file: 'gc-test.dat' })).json.id);
  const p = await api('POST', '/admin/paths', { label: 'GC', path: dir });
  const scan = await waitJob((await api('POST', `/admin/paths/${p.json.id}/scan`)).json.id);
  assert.equal(scan.result.matched, 1, JSON.stringify(scan));
  const f = (await api('GET', `/files?romPathId=${p.json.id}`)).json.items[0];
  assert.equal(f.sha1, h('sha1'));
  assert.equal(f.raHash, await raHashGamecubeFrom(async (pos, len) => iso.subarray(pos, pos + len)));
});
