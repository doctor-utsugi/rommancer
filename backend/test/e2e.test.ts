/**
 * Prueba de extremo a extremo de todos los flujos sobre una base de datos de test.
 * Requiere: MySQL de compose levantado, 7zz y chdman, ../roms/{nes,snes} y ../data/dats/*.dat.
 * Opcional: contenedor rommancer-sshd en 127.0.0.1:2222 (usuario device/device) para probar SFTP.
 * Opcional: the same image on the host network, port 2224, to install and run the client over SSH:
 *   podman run -d --name rommancer-sshd-host --network host localhost/rommancer-test-sshd /usr/sbin/sshd -D -e -p 2224
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { execFile, execSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
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
const SEVENZIP = process.env.SEVENZIP_BIN ?? '7zz';
const SMB3 = 'Super Mario Bros. 3 (USA) (Rev 1)';

// --- Mock de ScreenScraper y del resto de servicios externos ---
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
let ssRequests = 0;
// normal | quota | notfound
let ssMode = 'normal';
const ssUsers: string[] = [];
const ssRomSha1s: Record<string, string[]> = {};
// Contadores de peticiones al resto de mocks
const hits: Record<string, number> = {};
const hit = (k: string) => (hits[k] = (hits[k] ?? 0) + 1);
// Contenido servido por el mock de GitHub (ruta -> { body, etag })
const ghFiles = new Map<string, { body: string | Buffer; etag: string }>();
const wdBindings: Record<string, { props: any[]; names: any[] }> = {};
const raLists: Record<string, any[]> = {};
const mockBase = () => `http://127.0.0.1:${(ssMock.address() as AddressInfo).port}`;

function json(res: http.ServerResponse, v: unknown, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(v));
}

function otherMocks(req: http.IncomingMessage, res: http.ServerResponse, url: URL, body: string): boolean {
  const p = decodeURIComponent(url.pathname);
  if (p.startsWith('/gh/')) {
    hit('gh');
    const f = ghFiles.get(p.slice(3));
    if (!f) {
      res.statusCode = 404;
      res.end();
      return true;
    }
    if (req.headers['if-none-match'] === f.etag) {
      hit('gh304');
      res.statusCode = 304;
      res.end();
      return true;
    }
    hit(`gh:${p.slice(3)}`);
    res.setHeader('ETag', f.etag);
    res.end(f.body);
    return true;
  }
  if (p.startsWith('/thumbs/')) {
    hit('thumbs');
    if (p.includes('Named_Boxarts/Mega Man 2')) res.end(PNG);
    else {
      res.statusCode = 404;
      res.end();
    }
    return true;
  }
  if (p === '/tgdb/v1.1/Games/ByGameName') {
    hit('tgdb');
    const name = url.searchParams.get('name') ?? '';
    return json(res, { data: { games: name === 'Contra' ? [{ id: 77, game_title: 'Contra' }, { id: 78, game_title: 'Contra III' }] : [] }, remaining_monthly_allowance: 1000 }), true;
  }
  if (p === '/tgdb/v1/Games/Images') {
    hit('tgdb');
    return json(res, { data: { images: { '77': [{ type: 'boxart', side: 'back', filename: 'back/77.jpg' }] } }, include: { boxart: { base_url: { original: `${mockBase()}/tgdb/img/` } } }, remaining_monthly_allowance: 999 }), true;
  }
  if (p.startsWith('/tgdb/img/')) {
    res.end(PNG);
    return true;
  }
  if (p === '/ra/API_GetUserProfile.php') {
    if (url.searchParams.get('y') !== 'user-web-key') return (res.statusCode = 401), res.end('{}'), true;
    return json(res, { User: 'raplayer', UserPic: '/UserPic/raplayer.png', TotalPoints: 1234, TotalSoftcorePoints: 10, TotalTruePoints: 3000, MemberSince: '2020-01-01 00:00:00' }), true;
  }
  if (p === '/ra/API_GetUserCompletionProgress.php') {
    const rows = raProgressGames.map((id) => ({ GameID: id, MaxPossible: 40, NumAwarded: 12, NumAwardedHardcore: 10, MostRecentAwardedDate: '2026-10-01T10:00:00+00:00' }));
    return json(res, { Count: rows.length, Total: rows.length, Results: url.searchParams.get('o') === '0' ? rows : [] }), true;
  }
  if (p === '/ra/dorequest.php') {
    const f = new URLSearchParams(body);
    if (f.get('r') === 'login2' && f.get('u') === 'raplayer' && f.get('p') === 'ra-secret-pass') return json(res, { Success: true, User: 'raplayer', Token: 'RATOKEN123' }), true;
    return json(res, { Success: false, Error: 'Invalid user/password combination. Please try again.' }), true;
  }
  if (p === '/ra/API_GetGameList.php') {
    hit(`ra:${url.searchParams.get('i')}`);
    return json(res, raLists[url.searchParams.get('i') ?? ''] ?? []), true;
  }
  if (p === '/sparql') {
    hit('sparql');
    const q = new URLSearchParams(body).get('query') ?? '';
    if (q.includes('VALUES ?x')) return json(res, { results: { bindings: [{ x: { value: 'http://www.wikidata.org/entity/Q500' }, l: { value: 'Super Mario' } }] } }), true;
    const platform = q.match(/wdt:P400 wd:(Q\d+)/)?.[1] ?? '';
    const b = wdBindings[platform] ?? { props: [], names: [] };
    return json(res, { results: { bindings: q.includes('?names') ? b.names : b.props } }), true;
  }
  return false;
}

/** RA games the mocked user has progress in */
const raProgressGames: number[] = [];
const ssMock = http.createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://x');
  let body = '';
  for await (const c of req) body += c;
  if (otherMocks(req, res, url, body)) return;
  if (url.pathname.endsWith('/jeuInfos.php')) {
    ssRequests++;
    ssUsers.push(url.searchParams.get('ssid') ?? '');
    const romnom = url.searchParams.get('romnom') ?? '';
    if (ssMode === 'notfound') {
      res.statusCode = 404;
      res.end('Erreur : Rom/Iso/Dossier non trouvee !');
      return;
    }
    const ssuser = ssMode === 'quota' ? { requeststoday: '95', requestskotoday: '0', maxrequestsperday: '100', maxrequestskoperday: '50', maxrequestspermin: '600' } : undefined;
    const romsKey = Object.keys(ssRomSha1s).find((k) => romnom.includes(k));
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        response: {
          ssuser,
          jeu: {
            roms: romsKey ? ssRomSha1s[romsKey].map((h) => ({ romsha1: h.toUpperCase() })) : [],
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
let adminFiles = '';
let userToken = '';
let userFiles = '';
let userRefresh = '';
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

const sshAvailable = (port = 2222) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect(port, '127.0.0.1');
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
    EXTERNAL_SYNC_CRON: '',
    SCREENSCRAPER_URL: mockBase(),
    THEGAMESDB_URL: `${mockBase()}/tgdb`,
    WIKIDATA_SPARQL_URL: `${mockBase()}/sparql`,
    GITHUB_RAW_URL: `${mockBase()}/gh`,
    LIBRETRO_THUMBS_URL: `${mockBase()}/thumbs`,
    RA_URL: `${mockBase()}/ra`,
    RA_API_KEY: 'test-ra-key',
    THEGAMESDB_API_KEY: '',
    SCREENSCRAPER_DEV_ID: 'dev',
    SCREENSCRAPER_DEV_PASSWORD: 'devpass',
    SCREENSCRAPER_USER: '',
    SCREENSCRAPER_PASSWORD: '',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'admin1234',
  });
  // The shell client would pop desktop notifications on the machine running the tests
  process.env.ROMMANCER_NO_NOTIFY = '1';
  execSync('npx prisma migrate reset --force --skip-seed --skip-generate', { cwd: path.join(ROOT, 'backend'), env: process.env, stdio: 'ignore' });
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
  // Tareas encoladas por las ultimas pruebas (multimedia de listas): se espera a que terminen
  for (let i = 0; i < 240; i++) {
    const busy = await prisma.job.count({ where: { status: { in: ['PENDING', 'RUNNING'] }, OR: [{ runAfter: null }, { runAfter: { lte: new Date() } }] } });
    if (!busy) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  stopJobRunner();
  server?.close();
  ssMock.close();
  await prisma.$disconnect();
});

test('auth: login admin, invitacion y registro de usuario', async () => {
  const bad = await api('POST', '/auth/login', { username: 'admin', password: 'nope' });
  assert.equal(bad.status, 401);
  const first = await api('POST', '/auth/login', { username: 'admin', password: 'admin1234' });
  assert.equal(first.status, 200);
  // Contrasena inicial de .env: hay que cambiarla antes de nada
  assert.equal(first.json.user.mustChangePassword, true);
  adminToken = first.json.accessToken;
  assert.equal((await api('GET', '/systems')).status, 403);
  assert.equal((await api('PATCH', '/users/me', { currentPassword: 'admin1234', newPassword: 'corta' })).status, 400);
  const changed = await api('PATCH', '/users/me', { currentPassword: 'admin1234', newPassword: 'admin-segura-2026' });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.user.mustChangePassword, false);
  const r = await api('POST', '/auth/login', { username: 'admin', password: 'admin-segura-2026' });
  adminToken = r.json.accessToken;
  const refreshed = await api('POST', '/auth/refresh', { refreshToken: r.json.refreshToken });
  assert.equal(refreshed.status, 200);
  adminToken = refreshed.json.accessToken;
  adminFiles = refreshed.json.filesToken;
  // El token de ficheros no sirve como token de API
  assert.equal((await api('GET', '/systems', undefined, adminFiles)).status, 401);

  const inv = await api('POST', '/invitations', { role: 'USER' });
  assert.equal(inv.status, 201);
  const check = await api('GET', `/auth/invitations/${inv.json.token}`);
  assert.equal(check.status, 200);
  const reg = await api('POST', '/auth/register', { token: inv.json.token, username: 'player2', email: 'p2@example.com', password: 'player2pass' });
  assert.equal(reg.status, 201);
  userToken = reg.json.accessToken;
  userRefresh = reg.json.refreshToken;
  userId = reg.json.user.id;
  const reuse = await api('POST', '/auth/register', { token: inv.json.token, username: 'player3', email: 'p3@example.com', password: 'player3pass' });
  assert.equal(reuse.status, 400);
  const forbidden = await api('GET', '/admin/paths', undefined, userToken);
  assert.equal(forbidden.status, 403);
  const badKey = await api('PATCH', '/users/me', { locale: 'en', raUser: 'someone', raApiKey: 'secret' }, userToken);
  assert.equal(badKey.status, 400, 'a Web API key RetroAchievements refuses is not kept');
  const meR = await api('PATCH', '/users/me', { locale: 'en', raUser: 'someone' }, userToken);
  assert.equal(meR.status, 204);
  const me = await api('GET', '/users/me', undefined, userToken);
  assert.equal(me.json.locale, 'en');
  assert.equal(me.json.hasRetroAchievements, false);
  assert.equal(me.json.raUser, 'someone');
  assert.equal(me.json.raConsoles, false);
  assert.deepEqual(me.json.permissions, ['collection.view', 'lists', 'saves', 'scrape.lists']);
});

test('permisos: por defecto, 403 y concesion por el admin', async () => {
  assert.equal((await api('GET', '/lists/1/files', undefined, userToken)).status, 403);
  assert.equal((await api('POST', '/scrape', { gameIds: [1] }, userToken)).status, 403);
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('x')]), 'x.nes');
  assert.equal((await api('POST', '/uploads', fd, userToken)).status, 403);
  // Lista sin permiso de listas
  const u = await api('POST', '/users', { username: 'viewer', email: 'v@example.com', password: 'viewerpass', permissions: ['collection.view'] });
  assert.equal(u.status, 201);
  const vt = (await api('POST', '/auth/login', { username: 'viewer', password: 'viewerpass' })).json.accessToken;
  assert.equal((await api('GET', '/lists', undefined, vt)).status, 403);
  assert.equal((await api('GET', '/systems', undefined, vt)).status, 200);
  // Se conceden todos al usuario de pruebas; los permisos van en el token y se renuevan con refresh
  const all = ['collection.view', 'lists', 'saves', 'roms.download', 'roms.upload', 'roms.uploadUnverified', 'scrape.lists', 'scrape.bulk'];
  assert.equal((await api('PATCH', `/users/${userId}`, { permissions: all })).status, 200);
  const rr = await api('POST', '/auth/refresh', { refreshToken: userRefresh });
  userToken = rr.json.accessToken;
  userFiles = rr.json.filesToken;
  userRefresh = rr.json.refreshToken;
  assert.deepEqual((await api('GET', '/users/me', undefined, userToken)).json.permissions, all);
});

test('seguridad: limite de login, CORS cerrado y cabeceras', async () => {
  const { resetLoginLimits } = await import('../src/modules/auth/routes.js');
  for (let i = 0; i < 5; i++) assert.equal((await api('POST', '/auth/login', { username: 'viewer', password: 'mal' })).status, 401);
  assert.equal((await api('POST', '/auth/login', { username: 'viewer', password: 'viewerpass' })).status, 429);
  resetLoginLimits();
  const r = await fetch(`${base}/api/v1/health`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
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
  // Romhacks enlazados por contenido (los que no tienen su base en roms/snes quedan en revision)
  assert.ok(r2.result.hacksLinked >= 5, JSON.stringify(r2.result));
  // Re-escaneo incremental: nada que hashear
  const r3 = await waitJob((await api('POST', `/admin/paths/${nes.json.id}/scan`)).json.id);
  assert.equal(r3.result.hashed, 0);
  assert.equal(r3.result.skipped, r3.result.files);

  const smb3 = await api('GET', `/files?q=${encodeURIComponent(SMB3)}`);
  const f = smb3.json.items[0];
  assert.equal(f.status, 'MATCHED');
  assert.equal(f.raHash, '55b7111567c1709e849c574078699577');
  assert.equal(f.headerlessCrc, '2e6301ed');

  const translation = await api('GET', `/files?q=${encodeURIComponent('Chrono Trigger (USA) [T+Spa')}`);
  assert.equal(translation.json.items[0].status, 'HACK');
  // Romhacks identificados por contenido: base exacta; los que no tienen base en la coleccion van a revision
  const { prisma } = await import('../src/lib/prisma.js');
  const ct = await prisma.romHack.findUniqueOrThrow({ where: { id: translation.json.items[0].romHackId }, include: { baseRom: true } });
  assert.ok(ct.baseEvidence === 'content' || ct.baseEvidence === 'dat', String(ct.baseEvidence));
  if (ct.baseEvidence === 'content') assert.equal(ct.baseRom?.name, 'Chrono Trigger (USA)');
  assert.equal(await prisma.romHack.count({ where: { baseEvidence: 'title' } }), 0);
  const review = (await api('GET', '/admin/review?kind=hack')).json.items;
  assert.ok(review.length >= 25);
  assert.ok(review.every((i: any) => i.payload.titleSuggestions), 'el titulo solo como sugerencia');
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
  assert.ok(hacks.json.total >= 40);

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
  // The SMB3 game and the SMB3 rom are the same rom now that lists hold roms
  assert.equal((await api('GET', `/lists/${clone.json.id}`, undefined, userToken)).json.items.length, (await api('GET', `/lists/${ctx.favId}`)).json.items.length);

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
  // El token de acceso no vale en la URL; el de ficheros si
  assert.equal((await fetch(`${base}/api/v1/lists/${ctx.usaListId}/download?token=${adminToken}`)).status, 401);
  const r = await fetch(`${base}/api/v1/lists/${ctx.usaListId}/download?firmware=knulli&token=${adminFiles}`);
  assert.equal(r.status, 200);
  const zipPath = path.join(DATA, 'tmp', 'list.zip');
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.writeFileSync(zipPath, Buffer.from(await r.arrayBuffer()));
  const listing = execSync(`${SEVENZIP} l -ba "${zipPath}"`).toString();
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

test('dispositivos: el servidor instala el cliente por SSH y sincroniza la consola', async (t) => {
  if (!(await sshAvailable(2224))) {
    t.skip('rommancer-sshd-host no disponible');
    return;
  }
  const consoles = (await api('GET', '/devices/consoles')).json;
  const fw = ctx.firmwares.find((f: any) => f.slug === 'rocknix');
  const body = { name: 'SSH only', consoleId: consoles.find((c: any) => c.name === 'Other').id, firmwareId: fw.id, host: '127.0.0.1', port: 2224, user: 'device', password: 'device', rootPath: `/home/device/sd-${Date.now()}`, server: base };
  // Admins only: the server opens connections inside its network
  assert.equal((await api('POST', '/devices/ssh-install', body, userToken)).status, 403);
  const r = await api('POST', '/devices/ssh-install', body);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const d = (await api('GET', `/devices/${r.json.id}`)).json;
  assert.equal(d.connType, 'AGENT');
  assert.ok(d.clientPath.endsWith('/rommancer/rommancer-sync.sh'));
  assert.ok(d.lastSeenAt, 'the client ran its first sync');
  assert.equal(d.hasPassword, false, 'the password is dropped once the server key works');
  assert.equal((await api('POST', `/devices/${d.id}/ssh-sync`, {})).status, 202);
  for (let i = 0; i < 40 && !(await api('GET', `/devices/${d.id}`)).json.sshAt; i++) await new Promise((res) => setTimeout(res, 500));
  const after = (await api('GET', `/devices/${d.id}`)).json;
  assert.ok(after.sshAt, 'synced over SSH');
  assert.equal(after.sshError, null);
  // A wrong address leaves nothing behind
  const bad = await api('POST', '/devices/ssh-install', { ...body, port: 1 });
  assert.equal(bad.status, 400);
  assert.equal((await api('GET', '/devices')).json.filter((x: any) => x.name === 'SSH only').length, 1);
});

test('subidas: validacion por hash (DAT, romhack, RetroAchievements)', async () => {
  const target = path.join(DATA, 'uploads-target');
  fs.mkdirSync(target, { recursive: true });
  const p = await api('POST', '/admin/paths', { label: 'Subidas', path: target, isDefaultTarget: true });
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
  const img = await fetch(`${base}${cover.url}?token=${adminFiles}`);
  assert.equal(img.status, 200);
  assert.ok(g.media.some((m: any) => m.type === 'MANUAL'));

  // libretro-thumbnails (mock): la portada de Mega Man 2 puede haberse bajado ya al anadirlo a una lista
  const mm2 = (await api('GET', `/games?q=${encodeURIComponent('Mega Man 2')}&systemId=${ctx.nesSystemId}`)).json.items.find((x: any) => x.title === 'Mega Man 2');
  await waitJob((await api('POST', '/scrape', { gameIds: [mm2.id], sources: ['libretro'], types: ['COVER', 'SCREENSHOT', 'TITLE'] }, userToken)).json.id, userToken);
  const mm2d = (await api('GET', `/games/${mm2.id}`)).json;
  assert.ok(mm2d.media.some((m: any) => m.type === 'COVER' && m.source === 'libretro'));
  void t;
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
  // Sin relojes: la ultima subida pasa a ser la actual aunque su fecha sea anterior
  const old = await send(`${SMB3}.srm`, crypto.randomBytes(8192), 'ra-fceumm', now - 3600_000);
  assert.equal((await api('GET', `/saves/${a.json.saveId}`, undefined, userToken)).json.currentVersionId, old.json.versionId);
  // Restaurar v1
  const rest = await api('POST', `/saves/${a.json.saveId}/restore`, { versionId: a.json.versionId }, userToken);
  const cur = (await api('GET', `/saves/${a.json.saveId}`, undefined, userToken)).json;
  assert.equal(cur.currentVersionId, rest.json.versionId);
  const dl = await fetch(`${base}/api/v1/saves/${a.json.saveId}/versions/${rest.json.versionId}/download?token=${userFiles}`);
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(v1));
  ctx.smbSaveId = a.json.saveId;
  // Otro usuario no puede verlo
  assert.equal((await api('GET', `/saves/${a.json.saveId}`)).status, 403);

  // .srm (mGBA RetroArch) -> .sav standalone
  const gba = await send('Some GBA Game (USA).srm', crypto.randomBytes(32768), 'ra-mgba', now);
  const conv = await api('POST', `/saves/${gba.json.saveId}/convert`, { emulatorId: ctx.emus.mgba.id }, userToken);
  assert.equal(conv.status, 201);
  const convDl = await fetch(`${base}/api/v1/saves/${conv.json.saveId}/versions/${conv.json.versionId}/download?token=${userFiles}`);
  assert.match(convDl.headers.get('content-disposition')!, /\.sav/);

  // Memory card PS1: srm -> mcd, gme, vmp
  const card = Buffer.alloc(0x20000);
  card.write('MC', 0, 'latin1');
  card[127] = 0x0e;
  crypto.randomBytes(8192).copy(card, 8192);
  const ps1 = await send('Final Fantasy VII (USA) (Disc 1).srm', card, 'ra-pcsx-rearmed', now);
  for (const [slug, size] of [['duckstation', 0x20000], ['dexdrive', 0x20000 + 3904], ['ps3-psp-vmp', 0x20080]] as const) {
    const r = await fetch(`${base}/api/v1/saves/${ps1.json.saveId}/versions/${ps1.json.versionId}/download?emulator=${slug}&token=${userFiles}`);
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

  // Solo cambia la consola: gana su version, la anterior queda en el historial (sin mirar fechas)
  const newer = crypto.randomBytes(8192);
  const f = path.join(root, 'saves/nes', `${SMB3}.srm`);
  fs.writeFileSync(f, newer);
  const past = new Date(Date.now() - 86400_000 * 365);
  fs.utimesSync(f, past, past);
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
  // A new folder is a read-only source: reorganizing it is refused until it is made writable
  const p = await api('POST', '/admin/paths', { label: 'Messy', path: dir });
  assert.equal(p.json.readOnly, true);
  await waitJob((await api('POST', `/admin/paths/${p.json.id}/scan`)).json.id);
  assert.equal((await api('POST', `/admin/paths/${p.json.id}/organize`, { scheme: 'knulli' })).status, 400);
  await api('PATCH', `/admin/paths/${p.json.id}`, { readOnly: false });
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
  execSync(`${SEVENZIP} a -tzip "${path.join(dir, 'mix', 'smb3.zip')}" "${path.join(ROMS, 'nes', `${SMB3}.nes`)}"`, { stdio: 'ignore' });
  execSync(`${SEVENZIP} a -t7z "${path.join(dir, 'mix', 'ct.7z')}" "${path.join(ROMS, 'snes', 'Chrono Trigger (USA).smc')}"`, { stdio: 'ignore' });
  // Set arcade sintetico con dos roms internas
  const a = crypto.randomBytes(4096);
  const b = crypto.randomBytes(2048);
  const work = path.join(DATA, 'arcade-src');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'prg.bin'), a);
  fs.writeFileSync(path.join(work, 'gfx.bin'), b);
  execSync(`${SEVENZIP} a -tzip "${path.join(dir, 'fbneo', 'testgame.zip')}" prg.bin gfx.bin`, { cwd: work, stdio: 'ignore' });
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
  // DAT de "un zip por set" (como el de libretro-database): describe los mismos juegos con otro nombre; no crea roms
  const zipDat = `clrmamepro (\n\tname "FBNeo - Arcade Games"\n)\n\ngame (\n\tname "Test Game (World)"\n\trom ( name testgame.zip size 100 crc 12345678 )\n)\n`;
  fs.writeFileSync(path.join(DATA, 'dats', 'fbneo-zip.dat'), zipDat);
  const zipImp = await waitJob((await api('POST', '/admin/dats/import-file', { file: 'fbneo-zip.dat' })).json.id);
  assert.equal(zipImp.result.skipped, true);
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

// ======================= Fase 2 =======================

const md = (b: Buffer, a: string) => crypto.createHash(a).update(b).digest('hex');
const crcHex = (b: Buffer) => (zlib.crc32(b) >>> 0).toString(16).padStart(8, '0');
const prismaClient = async () => (await import('../src/lib/prisma.js')).prisma;

async function lastJob(type: string, userId?: number) {
  const prisma = await prismaClient();
  return prisma.job.findFirst({ where: { type, ...(userId ? { userId } : {}) }, orderBy: { id: 'desc' } });
}

async function waitJobDone(id: number) {
  const prisma = await prismaClient();
  for (let i = 0; i < 1200; i++) {
    const j = await prisma.job.findUniqueOrThrow({ where: { id } });
    if (j.status === 'DONE') return j;
    if (j.status === 'FAILED') throw new Error(`Job ${id} failed: ${j.message}\n${j.log}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('timeout');
}

test('fase2: destino final, subidas no verificadas y verificacion posterior', async () => {
  const prisma = await prismaClient();
  const nesTarget = path.join(DATA, 'target-nes');
  fs.mkdirSync(nesTarget, { recursive: true });
  const t = await api('POST', '/admin/paths', { label: 'NES destino', path: nesTarget, targetSystems: ['nes'], targetScheme: 'flat' });
  assert.equal(t.status, 201);
  ctx.nesTargetPath = nesTarget;
  const before = (await api('GET', '/systems')).json.find((s: any) => s.slug === 'nes');

  const rom = Buffer.concat([Buffer.from('NES\x1a\x02\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00', 'latin1'), crypto.randomBytes(32768)]);
  const send = (extra: Record<string, string>, buf = rom, name = 'Mi Homebrew (World).nes', token = userToken) => {
    const fd = new FormData();
    fd.append('file', new Blob([buf]), name);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    return api('POST', '/uploads/unverified', fd, token);
  };
  const up = await send({ systemId: String(ctx.nesSystemId), newGameTitle: 'Mi Homebrew', regions: 'World', revision: 'v1.0' });
  assert.equal(up.status, 201, JSON.stringify(up.json));
  assert.equal(up.json.match, 'UNVERIFIED');
  assert.ok(fs.existsSync(path.join(nesTarget, 'Mi Homebrew (World).nes')), 'destino del sistema, esquema plano');
  assert.equal((await send({ systemId: String(ctx.nesSystemId), newGameTitle: 'Otra' })).status, 409);
  // No cuenta en el porcentaje; se muestra aparte
  const after = (await api('GET', '/systems')).json.find((s: any) => s.slug === 'nes');
  assert.equal(after.owned, before.owned);
  assert.equal(after.roms, before.roms);
  assert.equal(after.files.unverified, before.files.unverified + 1);
  const g = (await api('GET', `/games/${up.json.gameId}`)).json;
  assert.equal(g.roms[0].unverified, true);
  assert.equal(g.roms[0].uploadedBy, 'player2');
  // Hack no verificado de SNES: va a la ruta predeterminada (Subidas)
  const snesHack = await send({ systemId: String(ctx.snesSystemId), newGameTitle: 'Juego Snes', kind: 'translation', hackName: 'Traduccion', hackVersion: '0.9', hackLanguage: 'Es' }, crypto.randomBytes(65536), 'juego-es.sfc');
  assert.equal(snesHack.status, 201, JSON.stringify(snesHack.json));
  assert.ok(fs.existsSync(path.join(DATA, 'uploads-target', 'snes', 'juego-es.sfc')));
  // Destinations exist but none takes Game Boy: a clear error, never a disk nobody chose
  const def = (await api('GET', '/admin/paths')).json.find((p: any) => p.isDefaultTarget);
  await api('PATCH', `/admin/paths/${def.id}`, { isDefaultTarget: false });
  const gbs = (await api('GET', '/systems')).json.find((s: any) => s.slug === 'gb');
  const lib = await send({ systemId: String(gbs.id), newGameTitle: 'Homebrew GB' }, crypto.randomBytes(32768), 'hb.gb');
  assert.equal(lib.status, 507, JSON.stringify(lib.json));
  assert.match(lib.json.error, /No destination folder takes Game Boy/);
  assert.ok(!fs.existsSync(path.join(DATA, 'library', 'gb', 'hb.gb')));
  await api('PATCH', `/admin/paths/${def.id}`, { isDefaultTarget: true });

  // Un DAT posterior con su checksum la verifica
  const dat = `<?xml version="1.0"?><datafile><header><name>Nintendo - Nintendo Entertainment System</name><description>Homebrew test</description><version>1</version></header>
    <game name="Mi Homebrew (World)"><description>Mi Homebrew (World)</description><rom name="Mi Homebrew (World).nes" size="${rom.length}" crc="${crcHex(rom)}" md5="${md5h(rom)}" sha1="${md(rom, 'sha1')}"/></game></datafile>`;
  fs.writeFileSync(path.join(DATA, 'dats', 'homebrew-test.dat'), dat);
  await waitJob((await api('POST', '/admin/dats/import-file', { file: 'homebrew-test.dat', systemId: ctx.nesSystemId, type: 'OTHER' })).json.id);
  const f = await prisma.romFile.findUniqueOrThrow({ where: { id: up.json.file.id } });
  assert.equal(f.status, 'MATCHED');
  assert.equal((await api('GET', '/systems')).json.find((s: any) => s.slug === 'nes').owned, before.owned + 1);
});

function md5h(b: Buffer) {
  return md(b, 'md5');
}

function ipsPatch(records: { offset: number; data: Buffer }[]) {
  const parts = [Buffer.from('PATCH', 'latin1')];
  for (const r of records) {
    const h = Buffer.alloc(5);
    h.writeUIntBE(r.offset, 0, 3);
    h.writeUInt16BE(r.data.length, 3);
    parts.push(h, r.data);
  }
  parts.push(Buffer.from('EOF', 'latin1'));
  return Buffer.concat(parts);
}

function bpsVarint(n: number) {
  const out: number[] = [];
  for (;;) {
    const x = n & 0x7f;
    n = Math.floor(n / 128);
    if (n === 0) {
      out.push(0x80 | x);
      break;
    }
    out.push(x);
    n--;
  }
  return Buffer.from(out);
}

// BPS minimo: el destino entero como TargetRead
function bpsPatch(source: Buffer, target: Buffer) {
  const body = Buffer.concat([Buffer.from('BPS1', 'latin1'), bpsVarint(source.length), bpsVarint(target.length), bpsVarint(0), bpsVarint(((target.length - 1) << 2) | 1), target]);
  const foot = Buffer.alloc(8);
  foot.writeUInt32LE(zlib.crc32(source) >>> 0, 0);
  foot.writeUInt32LE(zlib.crc32(target) >>> 0, 4);
  const withFoot = Buffer.concat([body, foot]);
  const pc = Buffer.alloc(4);
  pc.writeUInt32LE(zlib.crc32(withFoot) >>> 0, 0);
  return Buffer.concat([withFoot, pc]);
}

test('fase2: parches IPS/BPS, generacion bajo demanda y etiquetas', async () => {
  const prisma = await prismaClient();
  const base = fs.readFileSync(path.join(ROMS, 'nes', `${SMB3}.nes`));
  const h = await api('POST', '/hacks', { gameId: ctx.smb3GameId, baseRomId: ctx.smb3RomId, title: 'Super Mario Bros. 3 Parcheado', hackName: 'Parcheado', version: '1.2' });
  assert.equal(h.status, 201);
  const ips = ipsPatch([{ offset: 0x20, data: Buffer.from('ROMMANCER', 'latin1') }]);
  const fd = new FormData();
  fd.append('file', new Blob([ips]), 'parche.ips');
  const p = await api('POST', `/hacks/${h.json.id}/patches`, fd);
  assert.equal(p.status, 201, JSON.stringify(p.json));
  assert.equal(p.json.format, 'ips');
  const expected = Buffer.from(base);
  expected.write('ROMMANCER', 0x20, 'latin1');
  // Con la base en la coleccion se conoce ya el checksum del resultado
  assert.equal((await prisma.romHack.findUniqueOrThrow({ where: { id: h.json.id } })).sha1, md(expected, 'sha1'));
  const g = (await api('GET', `/games/${ctx.smb3GameId}`)).json;
  const hk = g.hacks.find((x: any) => x.id === h.json.id);
  assert.equal(hk.canGenerate, true);
  assert.equal(hk.label, 'Super Mario Bros. 3 (USA) Rev 1 + Parcheado v1.2');
  // Descarga: se genera en el destino final del sistema y queda registrado
  const dl = await fetch(`${base_()}/api/v1/hacks/${h.json.id}/download?token=${userFiles}`);
  assert.equal(dl.status, 200);
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(expected));
  assert.ok(fs.existsSync(path.join(ctx.nesTargetPath, 'Super Mario Bros. 3 Parcheado.nes')));
  await fetch(`${base_()}/api/v1/hacks/${h.json.id}/download?token=${userFiles}`);
  assert.equal(await prisma.romFile.count({ where: { romHackId: h.json.id } }), 1);

  // Ficheros ya parcheados en disco antes de tener el parche: uno con cabecera y otro sin ella.
  // Se reconocen por contenido como romhacks de SMB3 (sin mirar el nombre).
  const target = Buffer.from(base);
  target.write('BPS!', 0x40, 'latin1');
  const pre = path.join(DATA, 'pre-hacks', 'nes');
  fs.mkdirSync(pre, { recursive: true });
  fs.writeFileSync(path.join(pre, 'nombre cualquiera.nes'), target);
  fs.writeFileSync(path.join(pre, 'sin cabecera.nes'), target.subarray(16));
  const pp = await api('POST', '/admin/paths', { label: 'Pre', path: path.dirname(pre) });
  await waitJob((await api('POST', `/admin/paths/${pp.json.id}/scan`)).json.id);
  const preFiles = await prisma.romFile.findMany({ where: { romPathId: pp.json.id }, include: { romHack: true } });
  assert.equal(preFiles.length, 2);
  for (const f of preFiles) {
    assert.equal(f.status, 'HACK', f.relativePath);
    assert.equal(f.romHack!.baseRomId, ctx.smb3RomId);
    assert.equal(f.romHack!.baseEvidence, 'content');
  }
  // BPS: la base se encuentra por el CRC del parche; los romhacks creados por contenido con el mismo
  // resultado se fusionan con este y sus ficheros quedan enlazados
  const h2 = await api('POST', '/hacks', { gameId: ctx.smb3GameId, title: 'SMB3 BPS', hackName: 'BPS', version: '2.0' });
  const fd2 = new FormData();
  fd2.append('file', new Blob([bpsPatch(base, target)]), 'p.bps');
  const p2 = await api('POST', `/hacks/${h2.json.id}/patches`, fd2);
  assert.equal(p2.json.baseRomId, ctx.smb3RomId);
  assert.equal(p2.json.baseCrc32, crcHex(base));
  const relinked = await prisma.romFile.findMany({ where: { romPathId: pp.json.id } });
  assert.ok(relinked.every((f) => f.romHackId === h2.json.id), JSON.stringify(relinked.map((f) => [f.relativePath, f.romHackId])));
  assert.equal(await prisma.romHack.count({ where: { id: { in: preFiles.map((f) => f.romHackId!) }, NOT: { id: h2.json.id } } }), 0);
  const fd3 = new FormData();
  fd3.append('file', new Blob([bpsPatch(crypto.randomBytes(100), Buffer.from('x'))]), 'bad.bps');
  const h3 = await api('POST', '/hacks', { gameId: ctx.smb3GameId, baseRomId: ctx.smb3RomId, title: 'SMB3 Malo' });
  await api('POST', `/hacks/${h3.json.id}/patches`, fd3);
  assert.equal((await fetch(`${base_()}/api/v1/hacks/${h3.json.id}/download?token=${userFiles}`)).status, 409);
  // En una lista: se usa el fichero que ya habia, no se genera otro
  const l = await api('POST', '/lists', { name: 'Hacks' }, userToken);
  await api('POST', `/lists/${l.json.id}/items`, { items: [{ hackId: h2.json.id }] }, userToken);
  const files = (await api('GET', `/lists/${l.json.id}/files`, undefined, userToken)).json;
  assert.equal(files.missing.length, 0);
  assert.ok(files.items[0].files[0].absPath.startsWith(path.dirname(pre)));
  assert.equal(await prisma.romFile.count({ where: { romHackId: h2.json.id } }), 2);

  // Parche generado desde un romhack que solo existe como fichero: se puede regenerar si se pierde
  const other = Buffer.from(base);
  other.write('OTRO HACK', 0x300, 'latin1');
  fs.writeFileSync(path.join(pre, 'otro hack.nes'), other);
  await waitJob((await api('POST', `/admin/paths/${pp.json.id}/scan`)).json.id);
  const of = await prisma.romFile.findFirstOrThrow({ where: { romPathId: pp.json.id, relativePath: { contains: 'otro hack' } } });
  assert.equal(of.status, 'HACK');
  const gd = (await api('GET', `/games/${ctx.smb3GameId}`)).json;
  assert.equal(gd.hacks.find((x: any) => x.id === of.romHackId).canMakePatch, true);
  const mp = await api('POST', `/hacks/${of.romHackId}/make-patch`);
  assert.equal(mp.status, 201, JSON.stringify(mp.json));
  assert.equal(mp.json.format, 'bps');
  fs.rmSync(path.join(pre, 'otro hack.nes'));
  await waitJob((await api('POST', `/admin/paths/${pp.json.id}/scan`)).json.id);
  const regen = await fetch(`${base_()}/api/v1/hacks/${of.romHackId}/download?token=${userFiles}`);
  assert.equal(regen.status, 200);
  assert.ok(Buffer.from(await regen.arrayBuffer()).equals(other));
});

function base_() {
  return base;
}

test('fase2: multimedia al anadir a listas con cuenta propia, cuotas y TheGamesDB', async () => {
  const prisma = await prismaClient();
  const { env } = await import('../src/config/env.js');
  // Credenciales globales presentes: un usuario normal nunca debe usarlas
  env.screenscraper.user = 'global';
  env.screenscraper.password = 'globalpass';
  try {
    const contra = (await api('GET', `/games?q=Contra&systemId=${ctx.nesSystemId}`)).json.items.find((x: any) => x.title === 'Contra');
    const zelda = (await api('GET', `/games?q=Zelda&systemId=${ctx.nesSystemId}`)).json.items[0];
    ctx.contraGameId = contra.id;
    const l = await api('POST', '/lists', { name: 'Para scrapear' }, userToken);
    const n = ssUsers.length;
    await api('POST', `/lists/${l.json.id}/items`, { items: [{ gameId: contra.id }] }, userToken);
    const j1 = await lastJob('scrape', userId);
    assert.equal((j1!.params as any).mode, 'lists');
    const r1 = await waitJobDone(j1!.id);
    assert.equal((r1.result as any).noCredentials, true);
    assert.equal(ssUsers.length, n, 'sin cuenta propia no se usa ScreenScraper');
    // Con cuenta propia: se usa la suya
    await api('PATCH', '/users/me', { ssUser: 'player2ss', ssPassword: 'x', tgdbApiKey: 'tgdb-user' }, userToken);
    await api('POST', `/lists/${l.json.id}/items`, { items: [{ gameId: zelda.id }] }, userToken);
    await waitJobDone((await lastJob('scrape', userId))!.id);
    assert.ok(ssUsers.slice(n).length >= 1);
    assert.ok(ssUsers.slice(n).every((u) => u === 'player2ss'), ssUsers.slice(n).join(','));
    // Lo descargado es comun: el admin lo ve y no se vuelve a pedir
    const zd = (await api('GET', `/games/${zelda.id}`)).json;
    assert.ok(zd.media.some((m: any) => m.type === 'COVER' && m.source === 'screenscraper'));
    const before = ssRequests;
    await waitJob((await api('POST', `/scrape/game/${zelda.id}`, { types: ['COVER'] }, userToken)).json.id, userToken);
    assert.equal(ssRequests, before);

    // TheGamesDB como respaldo de la contraportada (ScreenScraper no la tiene en el mock)
    const tj = await waitJob((await api('POST', `/scrape/game/${contra.id}`, { types: ['BOX_BACK'] }, userToken)).json.id, userToken);
    assert.equal(tj.result.media, 1, JSON.stringify(tj.result));
    const cd = (await api('GET', `/games/${contra.id}`)).json;
    assert.equal(cd.tgdbGameId, 77);
    assert.ok(cd.media.some((m: any) => m.type === 'BOX_BACK' && m.source === 'thegamesdb'));

    // "No encontrado": se recuerda y no se repite
    ssMode = 'notfound';
    const mm = (await api('GET', `/games?q=Metroid&systemId=${ctx.nesSystemId}`)).json.items[0];
    await waitJob((await api('POST', '/scrape', { gameIds: [mm.id], sources: ['screenscraper'], types: ['COVER'] })).json.id);
    const c1 = ssRequests;
    await waitJob((await api('POST', '/scrape', { gameIds: [mm.id], sources: ['screenscraper'], types: ['COVER'] })).json.id);
    assert.equal(ssRequests, c1);
    assert.ok(await prisma.scrapeMiss.findUnique({ where: { gameId_source: { gameId: mm.id, source: 'screenscraper' } } }));

    // Cuota: al acercarse al limite diario se para y lo pendiente se reanuda otro dia
    ssMode = 'quota';
    const ids = (await api('GET', `/games?systemId=${ctx.nesSystemId}&status=owned&pageSize=3`)).json.items.map((x: any) => x.id);
    const qj = await waitJob((await api('POST', '/scrape', { gameIds: ids, sources: ['screenscraper'], types: ['COVER'], overwrite: true })).json.id);
    assert.ok(qj.result.pausedUntil);
    assert.equal(qj.result.pending.length, ids.length - 1);
    const resumed = await prisma.job.findFirst({ where: { type: 'scrape', status: 'PENDING', runAfter: { gt: new Date() } } });
    assert.ok(resumed);
    const q = await prisma.scrapeQuota.findUnique({ where: { key: 'ss:user' } });
    assert.equal(q!.maxPerDay, 100);
    await prisma.job.delete({ where: { id: resumed!.id } });
    await prisma.scrapeQuota.deleteMany();
  } finally {
    ssMode = 'normal';
    env.screenscraper.user = '';
    env.screenscraper.password = '';
  }
});

test('fase2: sincronizacion global, ETag de GitHub, metadatos libretro y permanencia', async () => {
  const prisma = await prismaClient();
  const { env } = await import('../src/config/env.js');
  const nesDat = fs.readFileSync(path.join(DATA, 'dats', 'nointro - Nintendo - Nintendo Entertainment System.dat'), 'utf8');
  const nesName = 'Nintendo - Nintendo Entertainment System';
  const lr = '/libretro/libretro-database/master/metadat';
  ghFiles.set(`${lr}/no-intro/${nesName}.dat`, { body: nesDat, etag: '"v1"' });
  ghFiles.set(`${lr}/hacks/${nesName}.dat`, { body: fs.readFileSync(path.join(DATA, 'dats', 'hacks - Nintendo - Nintendo Entertainment System.dat')), etag: '"h1"' });
  const smbCrc = (await prisma.romPart.findFirstOrThrow({ where: { romId: ctx.smb3RomId } })).crc32;
  ghFiles.set(`${lr}/developer/${nesName}.dat`, { body: `game (\n\tcomment "${SMB3}"\n\tdeveloper "Nintendo R&D4"\n\trom ( crc ${smbCrc} )\n)\n`, etag: '"d1"' });
  ghFiles.set(`${lr}/genre/${nesName}.dat`, { body: `game (\n\tcomment "${SMB3}"\n\tgenre "Platform"\n)\ngame (\n\tcomment "Contra (USA)"\n\tgenre "Run and gun"\n)\n`, etag: '"g1"' });
  ghFiles.set(`${lr}/franchise/${nesName}.dat`, { body: `game (\n\tcomment "${SMB3}"\n\tfranchise "Super Mario"\n)\n`, etag: '"f1"' });
  // Edicion manual del genero de Contra: libretro no la pisa
  await api('PATCH', `/games/${ctx.contraGameId}`, { genre: 'Accion (manual)' });

  const r = await api('POST', '/admin/sync', { sources: ['libretro'], system: 'nes' });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  // Forzar lo mismo enseguida no se permite; si hay una en curso tampoco
  assert.equal((await api('POST', '/admin/sync', { sources: ['libretro'], system: 'nes' })).status, 409);
  const done = await waitJob(r.json.id);
  assert.equal(done.result.libretro.metaGames, 2, JSON.stringify(done.result));
  assert.equal((await api('POST', '/admin/sync', { sources: ['libretro'], system: 'nes' })).status, 429);
  const smb = (await api('GET', `/games/${ctx.smb3GameId}`)).json;
  assert.equal(smb.developer, 'Nintendo EAD', 'ScreenScraper tiene prioridad sobre libretro');
  assert.equal(smb.genre, 'Plataformas', 'tampoco pisa el genero de ScreenScraper');
  assert.equal(smb.franchiseName, 'Super Mario');
  assert.equal((await api('GET', `/games/${ctx.contraGameId}`)).json.genre, 'Accion (manual)');
  assert.equal(hits[`gh:${lr}/no-intro/${nesName}.dat`], 1);

  // Segunda pasada sin cambios: peticiones condicionales, nada se descarga
  env.forceSyncMinMinutes = 0;
  const r2 = await waitJob((await api('POST', '/admin/sync', { sources: ['libretro'], system: 'nes' })).json.id);
  assert.equal(r2.result.libretro.dats, 0);
  assert.equal(hits[`gh:${lr}/no-intro/${nesName}.dat`], 1);
  assert.ok(hits.gh304 >= 5);

  // El DAT cambia y ya no tiene Contra (USA): se conserva marcada como retirada
  const contraRom = await prisma.rom.findFirstOrThrow({ where: { name: 'Contra (USA)', game: { systemId: ctx.nesSystemId } } });
  const without = nesDat.replace(/game \(\r?\n\tname "Contra \(USA\)"[\s\S]*?\r?\n\)\r?\n/g, '');
  assert.notEqual(without.length, nesDat.length);
  ghFiles.set(`${lr}/no-intro/${nesName}.dat`, { body: without, etag: '"v2"' });
  const r3 = await waitJob((await api('POST', '/admin/sync', { sources: ['libretro'], system: 'nes' })).json.id);
  assert.equal(r3.result.libretro.dats, 1);
  const kept = await prisma.rom.findUniqueOrThrow({ where: { id: contraRom.id } });
  assert.equal(kept.removedFromSource, true);
  const contraFile = await prisma.romFile.findFirst({ where: { romPart: { romId: contraRom.id } } });
  assert.equal(contraFile?.status, 'MATCHED');
  // Vuelve a aparecer: deja de estar retirada
  ghFiles.set(`${lr}/no-intro/${nesName}.dat`, { body: nesDat, etag: '"v3"' });
  await waitJob((await api('POST', '/admin/sync', { sources: ['libretro'], system: 'nes' })).json.id);
  assert.equal((await prisma.rom.findUniqueOrThrow({ where: { id: contraRom.id } })).removedFromSource, false);

  assert.ok((await api('GET', '/admin/sync')).json.history.length >= 4);
});

test('fase2: agrupacion por evidencias (clones del DAT, Retool, RA, ScreenScraper) y revision', async () => {
  const prisma = await prismaClient();
  const { env } = await import('../src/config/env.js');
  env.forceSyncMinMinutes = 0;
  const gb = (await api('GET', '/systems')).json.find((s: any) => s.slug === 'gb');
  ctx.gbSystemId = gb.id;
  const names = ['Alpha (Japan)', 'Beta Quest (USA)', 'Gamma (USA)', 'Gamma (Europe)', 'Delta (USA)', 'Delta Kun (Japan)', 'Epsilon (USA)', 'Zeta (Japan)', 'Super Mario Bros. 3 (World)'];
  const bufs: Record<string, Buffer> = Object.fromEntries(names.map((n) => [n, crypto.randomBytes(32768)]));
  ctx.gbBufs = bufs;
  const games = names
    .map((n, i) => {
      const b = bufs[n];
      const clone = n === 'Beta Quest (USA)' ? ' cloneofid="0001"' : '';
      return `<game name="${n}" id="${String(i + 1).padStart(4, '0')}"${clone}><description>${n}</description><rom name="${n}.gb" size="${b.length}" crc="${crcHex(b)}" md5="${md5h(b)}" sha1="${md(b, 'sha1')}"/></game>`;
    })
    .join('\n');
  const xml = `<?xml version="1.0"?><datafile><header><name>Nintendo - Game Boy (Parent-Clone)</name><description>Nintendo - Game Boy (Parent-Clone)</description><version>20260901-000000</version><homepage>No-Intro</homepage><url>https://www.no-intro.org</url></header>\n${games}\n</datafile>`;
  fs.writeFileSync(path.join(DATA, 'dats', 'gb-test.dat'), xml);
  await waitJob((await api('POST', '/admin/dats/import-file', { file: 'gb-test.dat', systemId: gb.id, type: 'NOINTRO' })).json.id);

  const romOf = async (n: string) => prisma.rom.findFirstOrThrow({ where: { name: n, game: { systemId: gb.id } } });
  const sameGame = async (a: string, b: string) => (await romOf(a)).gameId === (await romOf(b)).gameId;
  // Los clones del DAT unen titulos distintos; padres con el mismo titulo quedan separados
  assert.ok(await sameGame('Alpha (Japan)', 'Beta Quest (USA)'));
  assert.ok(!(await sameGame('Gamma (USA)', 'Gamma (Europe)')));
  assert.ok(!(await sameGame('Delta (USA)', 'Delta Kun (Japan)')));

  // Retool (mock de GitHub): grupo curado
  const rt = '/unexpectedpanda/retool-clonelists-metadata/main';
  ghFiles.set(`${rt}/clonelists/Nintendo - Game Boy (No-Intro).json`, { body: JSON.stringify({ variants: [{ group: 'Delta', titles: [{ searchTerm: 'Delta' }, { searchTerm: 'Delta Kun' }] }] }), etag: '"r1"' });
  ghFiles.set(`${rt}/metadata/Nintendo - Game Boy (No-Intro).json`, { body: JSON.stringify({ 'Delta Kun (Japan)': { localName: 'Deruta-kun' } }), etag: '"m1"' });
  await waitJob((await api('POST', '/admin/sync', { sources: ['retool'], system: 'gb' })).json.id);
  assert.ok(await sameGame('Delta (USA)', 'Delta Kun (Japan)'));
  assert.equal((await romOf('Delta Kun (Japan)')).localTitle, 'Deruta-kun');

  // RetroAchievements: mismo juego RA por hash (sincronizacion forzada solo de ese sistema)
  raLists['4'] = [
    { ID: 555, Title: 'Alpha', NumAchievements: 5, Hashes: [md5h(bufs['Alpha (Japan)'])] },
    { ID: 556, Title: 'Epsilon', NumAchievements: 5, Hashes: [md5h(bufs['Epsilon (USA)']), md5h(bufs['Zeta (Japan)'])] },
  ];
  await waitJob((await api('POST', '/ra/sync', { systemId: gb.id })).json.id);
  assert.equal(hits['ra:4'], 1);
  assert.equal(Object.keys(hits).filter((k) => k.startsWith('ra:')).length, 1, 'una sola llamada, la del sistema pedido');
  assert.ok(await sameGame('Epsilon (USA)', 'Zeta (Japan)'));

  // ScreenScraper: la lista de roms del juego (por hash) une los dos Gamma
  ssRomSha1s['Gamma'] = [md(bufs['Gamma (USA)'], 'sha1'), md(bufs['Gamma (Europe)'], 'sha1')];
  await api('PATCH', '/users/me', { ssUser: 'user', ssPassword: 'pass' });
  await waitJob((await api('POST', '/scrape', { gameIds: [(await romOf('Gamma (USA)')).gameId], sources: ['screenscraper'], types: ['COVER'] })).json.id);
  const { resolveRomGroups } = await import('../src/modules/grouping/service.js');
  await resolveRomGroups(gb.id);
  assert.ok(await sameGame('Gamma (USA)', 'Gamma (Europe)'));

  // Agrupacion solo por titulo (NES, sin Parent/Clone): confianza baja salvo con RA
  const low = await api('GET', `/games?systemId=${ctx.nesSystemId}&lowConfidence=1&pageSize=1`);
  assert.ok(low.json.total > 100);
  assert.equal((await prisma.game.findUniqueOrThrow({ where: { id: ctx.smb3GameId } })).groupConfidence, 'high');

  // Separar a mano contra la evidencia P/C: conflicto en la cola de revision
  const alpha = await romOf('Alpha (Japan)');
  const beta = await romOf('Beta Quest (USA)');
  await api('POST', `/games/${alpha.gameId}/split`, { romIds: [beta.id] });
  assert.ok(!(await sameGame('Alpha (Japan)', 'Beta Quest (USA)')));
  const review = (await api('GET', '/admin/review?kind=conflict')).json;
  const item = review.items.find((i: any) => i.roms.some((r: any) => r.id === beta.id));
  assert.ok(item, JSON.stringify(review));
  assert.equal((await api('POST', `/admin/review/${item.id}`, { action: 'same' })).status, 204);
  assert.ok(await sameGame('Alpha (Japan)', 'Beta Quest (USA)'));
});

test('fase2: obras multiplataforma con Wikidata, sagas y listas por plataforma', async () => {
  const prisma = await prismaClient();
  const e = (q: string) => ({ value: `http://www.wikidata.org/entity/${q}` });
  const v = (x: string) => ({ value: x });
  wdBindings.Q186437 = {
    props: [
      { g: e('Q100'), label: v('Alpha Totally Different'), year: v('1990'), ras: v('555'), sss: v('') },
      { g: e('Q200'), label: v('Gamma'), year: v('1991') },
      { g: e('Q201'), label: v('Gamma'), year: v('1991') },
      { g: e('Q300'), label: v('Delta'), year: v('1992') },
      { g: e('Q400'), label: v('Super Mario Bros. 3'), year: v('1988'), series: e('Q500') },
    ],
    names: [
      { g: e('Q100'), names: v('Alpha Totally Different') },
      { g: e('Q200'), names: v('Gamma') },
      { g: e('Q201'), names: v('Gamma') },
      { g: e('Q300'), names: v('Delta|Deruta-kun') },
      { g: e('Q400'), names: v('Super Mario Bros. 3|Super Mario Bros 3') },
    ],
  };
  wdBindings.Q172742 = { props: [{ g: e('Q400'), label: v('Super Mario Bros. 3'), year: v('1988'), series: e('Q500') }], names: [{ g: e('Q400'), names: v('Super Mario Bros. 3') }] };
  await waitJob((await api('POST', '/admin/sync', { sources: ['wikidata'], system: 'gb' })).json.id);
  await waitJob((await api('POST', '/admin/sync', { sources: ['wikidata'], system: 'nes' })).json.id);
  const gameOf = async (n: string) => (await prisma.rom.findFirstOrThrow({ where: { name: n, game: { systemId: ctx.gbSystemId } }, include: { game: true } })).game;
  // Ancla exacta por id de RetroAchievements aunque el nombre no coincida
  assert.equal((await gameOf('Alpha (Japan)')).wikidataId, 'Q100');
  // Nombre unico en la plataforma (incluidos titulos locales de Retool)
  assert.equal((await gameOf('Delta (USA)')).wikidataId, 'Q300');
  // Ambiguo: a revision
  const gamma = await gameOf('Gamma (USA)');
  assert.equal(gamma.wikidataId, null);
  const rv = (await api('GET', '/admin/review?kind=wikidata')).json.items.find((i: any) => i.gameId === gamma.id);
  assert.equal(rv.payload.candidates.length, 2);
  await api('POST', `/admin/review/${rv.id}`, { action: 'link', wikidataId: 'Q200' });
  assert.equal((await gameOf('Gamma (USA)')).wikidataId, 'Q200');

  // Obra con dos plataformas y saga
  const smbGb = await gameOf('Super Mario Bros. 3 (World)');
  const smbNes = await prisma.game.findUniqueOrThrow({ where: { id: ctx.smb3GameId } });
  assert.ok(smbGb.workId && smbGb.workId === smbNes.workId);
  const work = (await api('GET', `/works/${smbGb.workId}`)).json;
  assert.deepEqual(work.games.map((g: any) => g.system.slug).sort(), ['gb', 'nes']);
  assert.equal(work.franchise.name, 'Super Mario');
  const fr = (await api('GET', `/franchises/${work.franchise.id}`)).json;
  assert.deepEqual(fr.works.find((w: any) => w.id === work.id).missingPlatforms, ['gb']);
  const detail = (await api('GET', `/games/${ctx.smb3GameId}`)).json;
  assert.equal(detail.work.games[0].system.slug, 'gb');

  // Lista con la obra y sublistas con preferencia de plataforma
  const l = await api('POST', '/lists', { name: 'Obras' }, userToken);
  await api('POST', `/lists/${l.json.id}/items`, { items: [{ workId: work.id }] }, userToken);
  const items = (await api('GET', `/lists/${l.json.id}`, undefined, userToken)).json.items;
  assert.equal(items[0].kind, 'rom', 'a work goes in as one of its roms');
  const gbFirst = await api('POST', `/lists/${l.json.id}/derive`, { name: 'GB primero', platforms: ['gb', 'nes'] }, userToken);
  const gbList = (await api('GET', `/lists/${gbFirst.json.id}`, undefined, userToken)).json;
  assert.equal(gbList.items[0].system.slug, 'gb');
  const owned = await api('POST', `/lists/${l.json.id}/derive`, { name: 'Lo que tengo', platforms: ['gb', 'nes'], ownedOnly: true }, userToken);
  const ownedList = (await api('GET', `/lists/${owned.json.id}`, undefined, userToken)).json;
  assert.equal(ownedList.items[0].romId, ctx.smb3RomId);
  // Exportar/importar conserva la obra
  const exp = (await api('GET', `/lists/${l.json.id}/export`, undefined, userToken)).json;
  assert.equal(exp.items[0].type, 'rom');
  assert.equal((await api('POST', '/lists/import', exp, userToken)).json.unresolved.length, 0);
});

test('fase2: saves por eventos con script (inicio, cierre, conflicto, sin red) y SD montada', async () => {
  const prisma = await prismaClient();
  const thor = (await api('GET', '/devices/consoles')).json.find((c: any) => c.name === 'AYN Thor');
  const knulli = ctx.firmwares.find((f: any) => f.slug === 'knulli');
  const root = path.join(DATA, 'agent-root');
  fs.mkdirSync(path.join(root, 'roms/nes'), { recursive: true });
  const romPath = path.join(root, 'roms/nes', `${SMB3}.nes`);
  fs.writeFileSync(romPath, 'x');
  const d = await api('POST', '/devices', { name: 'Thor ES', consoleId: thor.id, firmwareId: knulli.id, connType: 'AGENT', rootPath: root }, userToken);
  assert.equal(d.status, 201, JSON.stringify(d.json));
  const zr = await fetch(`${base}/api/v1/devices/${d.json.id}/agent-script`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ flavor: 'batocera', server: base }),
  });
  assert.equal(zr.status, 200);
  const scripts = path.join(DATA, 'agent-userdata');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, 's.zip'), Buffer.from(await zr.arrayBuffer()));
  execSync(`${SEVENZIP} x -y s.zip`, { cwd: scripts, stdio: 'ignore' });
  const hook = path.join(scripts, 'system/scripts/rommancer.sh');
  // Asincrono: el servidor de la API corre en este mismo proceso
  const run = async (event: string, rom = romPath) => {
    try {
      return (await execFileP('sh', [hook, event, 'a', 'b', 'c', rom], { timeout: 30_000, env: { ...process.env, SHELLOPTS: 'xtrace' } })).stdout;
    } catch (e: any) {
      throw new Error(`script ${event}: ${e.message}\n${String(e.stderr ?? '').slice(-4000)}`);
    }
  };
  const saveFile = path.join(root, 'saves/nes', `${SMB3}.srm`);

  // Inicio: el servidor entrega su version, ya en el formato del emulador del dispositivo
  await run('gameStart');
  const smb = (await api('GET', `/saves/${ctx.smbSaveId}`, undefined, userToken)).json;
  const serverCur = await fetch(`${base}/api/v1/saves/${ctx.smbSaveId}/versions/${smb.currentVersionId}/download?token=${userFiles}`);
  assert.ok(fs.readFileSync(saveFile).equals(Buffer.from(await serverCur.arrayBuffer())));
  // Cierre: sube lo que cambio en el dispositivo
  const played = crypto.randomBytes(8192);
  fs.writeFileSync(saveFile, played);
  await run('gameStop');
  const s2 = (await api('GET', `/saves/${ctx.smbSaveId}`, undefined, userToken)).json;
  const cur2 = s2.versions.find((v: any) => v.id === s2.currentVersionId);
  assert.equal(cur2.sourceDevice?.id, d.json.id);
  // Sin cambios: no crea versiones
  const nv = s2.versions.length;
  await run('gameStop');
  assert.equal((await api('GET', `/saves/${ctx.smbSaveId}`, undefined, userToken)).json.versions.length, nv);

  // Conflicto: cambian el servidor (web) y el dispositivo. No se pisa nada.
  const fdw = new FormData();
  fdw.append('file', new Blob([crypto.randomBytes(8192)]), `${SMB3}.srm`);
  fdw.append('emulatorId', String(ctx.emus['ra-fceumm'].id));
  await api('POST', '/saves/upload', fdw, userToken);
  const local = crypto.randomBytes(8192);
  fs.writeFileSync(saveFile, local);
  await run('gameStart');
  assert.ok(fs.readFileSync(saveFile).equals(local), 'el dispositivo conserva su version');
  const conflicts = (await api('GET', '/saves/conflicts', undefined, userToken)).json;
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].device.id, d.json.id);
  assert.equal((await api('POST', `/saves/conflicts/${conflicts[0].id}/resolve`, { keep: 'device' }, userToken)).status, 204);
  const s3 = (await api('GET', `/saves/${ctx.smbSaveId}`, undefined, userToken)).json;
  assert.equal(s3.currentVersionId, conflicts[0].deviceVersionId);
  assert.equal((await api('GET', '/saves/conflicts', undefined, userToken)).json.length, 0);

  // Sin red: no bloquea y se sube en el siguiente evento con red
  const syncSh = path.join(scripts, 'system/scripts/rommancer/rommancer-sync.sh');
  const original = fs.readFileSync(syncSh, 'utf8');
  fs.writeFileSync(syncSh, original.replace(/^SERVER=".*"$/m, 'SERVER="http://127.0.0.1:9"'));
  const offline = crypto.randomBytes(8192);
  fs.writeFileSync(saveFile, offline);
  const t0 = Date.now();
  await run('gameStop');
  assert.ok(Date.now() - t0 < 15_000);
  fs.writeFileSync(syncSh, original);
  const contraRom = path.join(root, 'roms/nes', 'Contra (USA).nes');
  fs.writeFileSync(contraRom, 'x');
  await run('gameStart', contraRom);
  const s4 = (await api('GET', `/saves/${ctx.smbSaveId}`, undefined, userToken)).json;
  const cur4 = s4.versions.find((v: any) => v.id === s4.currentVersionId);
  const dl4 = await fetch(`${base}/api/v1/saves/${ctx.smbSaveId}/versions/${cur4.id}/download?token=${userFiles}`);
  assert.ok(Buffer.from(await dl4.arrayBuffer()).equals(offline));

  // Token revocado: el script deja de tener acceso
  await api('DELETE', `/devices/${d.json.id}/token`, undefined, userToken);
  const tok = original.match(/^TOKEN="(.*)"$/m)![1];
  const m = await fetch(`${base}/api/v1/agent/manifest`, { headers: { 'X-Device-Token': tok, 'X-Rom-B64': Buffer.from(romPath).toString('base64') } });
  assert.equal(m.status, 401);

  // SD montada en el servidor: al aparecer se encola su sincronizacion
  const { checkLocalDevices } = await import('../src/modules/saves/sync.js');
  const sd = path.join(DATA, 'sd-montada');
  const dev = await api('POST', '/devices', { name: 'SD', consoleId: thor.id, firmwareId: knulli.id, connType: 'LOCAL', rootPath: sd, syncSaves: true }, userToken);
  await checkLocalDevices();
  fs.mkdirSync(sd, { recursive: true });
  const queued = await checkLocalDevices();
  assert.deepEqual(queued, [dev.json.id]);
  const job = await prisma.job.findFirstOrThrow({ where: { type: 'save-sync' }, orderBy: { id: 'desc' } });
  await waitJobDone(job.id);
});

test('fase2: semilla acumulada con evidencias, wikidata, parches y multimedia grande', async () => {
  const prisma = await prismaClient();
  // Rom que su DAT ya no trae: se guarda en la semilla y se recupera en un despliegue nuevo
  const gone = await prisma.rom.findFirstOrThrow({ where: { name: 'Zeta (Japan)' }, include: { parts: true } });
  await prisma.rom.update({ where: { id: gone.id }, data: { removedFromSource: true } });
  const r = await waitJob((await api('POST', '/admin/seed/export')).json.id);
  const seed = path.join(DATA, 'seed');
  assert.ok(r.result.evidence >= 2);
  const grouping = JSON.parse(fs.readFileSync(path.join(seed, 'grouping.json'), 'utf8'));
  assert.ok(grouping.evidence.some((e: any) => e.source === 'retool'));
  assert.ok(grouping.romRules.length >= 1);
  assert.ok(grouping.misses.length >= 1);
  const wd = JSON.parse(fs.readFileSync(path.join(seed, 'wikidata.json'), 'utf8'));
  assert.ok(wd.items.length >= 5);
  assert.ok(fs.existsSync(path.join(seed, 'patches', 'patches.json')));
  assert.ok(fs.readdirSync(path.join(seed, 'media-large'), { recursive: true }).some((f) => String(f).endsWith('.pdf')));
  const games = JSON.parse(fs.readFileSync(path.join(seed, 'games.json'), 'utf8'));
  assert.ok(games.every((g: any) => g.roms.length >= 1));
  const removed = JSON.parse(fs.readFileSync(path.join(seed, 'removed.json'), 'utf8'));
  assert.ok(removed.some((x: any) => x.name === 'Zeta (Japan)' && x.parts[0].sha1 === gone.parts[0].sha1));
  await prisma.rom.delete({ where: { id: gone.id } });
  const applied = await waitJob((await api('POST', '/admin/seed/apply')).json.id);
  assert.equal(applied.result.removed, 1);
  const back = await prisma.rom.findFirstOrThrow({ where: { name: 'Zeta (Japan)' }, include: { parts: true } });
  assert.equal(back.removedFromSource, true);
  assert.equal(back.parts[0].sha1, gone.parts[0].sha1);
});

test('sync client: pairing by code, whole-device sync with the shell client, sign-up', async () => {
  const client = path.join(ROOT, 'clients/linux/rommancer-sync.sh');
  const dir = path.join(DATA, 'sync-client');
  fs.rmSync(dir, { recursive: true, force: true });
  const run = (name: string, args: string[], env: Record<string, string> = {}) =>
    execFileP('sh', [client, ...args], { env: { ...process.env, ROMMANCER_STATE: path.join(dir, `${name}-state`), ...env } });
  const pair = async (name: string, firmware: string, root: string) => {
    const linking = run(name, ['link', base], { ROMMANCER_NAME: name, ROMMANCER_FIRMWARE: firmware, ROMMANCER_ROOT: root });
    const codeFile = path.join(dir, `${name}-state`, 'code.txt');
    for (let i = 0; i < 50 && !fs.existsSync(codeFile); i++) await new Promise((r) => setTimeout(r, 100));
    const code = fs.readFileSync(codeFile, 'utf8').split('\n')[0];
    const info = await api('GET', `/link/${code}`);
    assert.equal(info.json.deviceName, name);
    assert.equal(info.json.rootHint, root);
    assert.ok(info.json.suggestedFirmwareId, 'firmware detected by the client');
    const ok = await api('POST', `/link/${code}/approve`, { name, consoleId: info.json.suggestedConsoleId, firmwareId: info.json.suggestedFirmwareId });
    assert.equal(ok.status, 201);
    assert.match((await linking).stdout, /Linked to/);
    assert.equal((await api('POST', `/link/${code}/approve`, { name, consoleId: 1, firmwareId: 1 })).status, 404, 'a code is used once');
    return ok.json.deviceId as number;
  };
  const rom = 'Advance Wars (USA)';
  const onion = path.join(dir, 'onion');
  const thor = path.join(dir, 'thor');
  fs.mkdirSync(path.join(onion, 'Roms/GBA'), { recursive: true });
  fs.mkdirSync(path.join(onion, 'Saves/CurrentProfile/saves/gpSP'), { recursive: true });
  fs.mkdirSync(path.join(thor, 'ROMs/gba'), { recursive: true });
  fs.writeFileSync(path.join(onion, 'Roms/GBA', `${rom}.gba`), crypto.randomBytes(4096));
  fs.writeFileSync(path.join(thor, 'ROMs/gba', `${rom}.gba`), crypto.randomBytes(4096));
  const onionSave = path.join(onion, 'Saves/CurrentProfile/saves/gpSP', `${rom}.srm`);
  const thorSave = path.join(thor, 'ROMs/gba/mGBA', `${rom}.srm`);
  fs.writeFileSync(onionSave, 'FROM-ONION');

  await pair('onion', 'onion', onion);
  const thorId = await pair('thor', 'android-esde', thor);
  // Android RetroArch default: saves next to the content, one folder per core
  assert.equal((await api('PATCH', `/devices/${thorId}`, { overrides: { savesLayout: 'rom-core' } })).status, 200);

  // The save sits in the gpSP folder although the Onion template maps GBA to another core
  assert.match((await run('onion', ['sync'])).stdout, /1 up, 0 down, 0 errors/);
  assert.match((await run('thor', ['sync'])).stdout, /0 up, 1 down, 0 errors/);
  assert.equal(fs.readFileSync(thorSave, 'utf8'), 'FROM-ONION');

  fs.writeFileSync(thorSave, 'FROM-THOR-LONGER');
  assert.match((await run('thor', ['sync'])).stdout, /1 up, 0 down/);
  assert.match((await run('onion', ['sync'])).stdout, /0 up, 1 down/);
  assert.equal(fs.readFileSync(onionSave, 'utf8'), 'FROM-THOR-LONGER');
  assert.match((await run('onion', ['sync'])).stdout, /0 up, 0 down, 0 errors/, 'nothing to do when nothing changed');
  assert.match((await run('thor', ['sync'])).stdout, /0 up, 0 down, 0 errors/);

  // Both sides change: both versions are kept and the device keeps its own file
  fs.writeFileSync(onionSave, 'ONION-2');
  fs.writeFileSync(thorSave, 'THOR-2-LONGER');
  await run('onion', ['sync']);
  await run('thor', ['sync']);
  assert.equal(fs.readFileSync(thorSave, 'utf8'), 'THOR-2-LONGER');
  const conflicts = await api('GET', '/saves/conflicts');
  assert.ok(conflicts.json.some((c: any) => c.deviceId === thorId && !c.resolvedAt));

  // Bad token and the bundled client
  const bad = await fetch(`${base}/api/v1/agent/roots`, { headers: { 'X-Device-Token': 'nope' } });
  assert.equal(bad.status, 401);
  assert.match(await (await fetch(`${base}/api/v1/link/client.sh`)).text(), /^#!\/bin\/sh/);

  // Self-service sign-up only when the admin opens it, never as admin
  const signup = (u: string) => fetch(`${base}/api/v1/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, email: `${u}@example.com`, password: 'a-long-password-1' }) });
  assert.equal((await signup('selfservice')).status, 403);
  await api('PUT', '/admin/settings/signup', { open: true });
  const created = await signup('selfservice');
  assert.equal(created.status, 201);
  assert.equal(((await created.json()) as any).user.role, 'USER');
  await api('PUT', '/admin/settings/signup', { open: false });
});

test('sync client: installer package enrols the device by itself, once', async () => {
  const dir = path.join(DATA, 'sync-installer');
  fs.rmSync(dir, { recursive: true, force: true });
  const sd = path.join(dir, 'sd');
  fs.mkdirSync(path.join(sd, 'Roms/FC'), { recursive: true });
  const r = await fetch(`${base}/api/v1/link/package/onion?token=${encodeURIComponent(adminFiles)}`);
  assert.equal(r.status, 200);
  const zip = path.join(dir, 'pkg.zip');
  fs.writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
  execSync(`${SEVENZIP} x -y -o"${sd}" "${zip}"`, { stdio: 'ignore' });
  const app = path.join(sd, 'App/RommancerSync');
  for (const f of ['rommancer-sync.sh', 'cacert.pem', 'server.txt', 'enroll.txt', 'config.json', 'launch.sh', 'icon.png']) assert.ok(fs.existsSync(path.join(app, f)), f);
  assert.ok(fs.existsSync(path.join(sd, '.tmp_update/startup/rommancer-sync.sh')), 'Onion boot hook');
  assert.equal(fs.readFileSync(path.join(app, 'server.txt'), 'utf8').trim(), process.env.PUBLIC_URL || base);
  fs.writeFileSync(path.join(app, 'server.txt'), base + '\n');
  const enrollToken = fs.readFileSync(path.join(app, 'enroll.txt'), 'utf8').trim();
  const env = { ...process.env, ROMMANCER_STATE: path.join(dir, 'state'), ROMMANCER_FIRMWARE: 'onion', ROMMANCER_ROOT: sd, ROMMANCER_NAME: 'pkg-miyoo' };
  const out = await execFileP('sh', [path.join(app, 'rommancer-sync.sh'), 'enroll'], { env });
  assert.match(out.stdout, /Enrolled in .* as "pkg-miyoo" \(onion\)/);
  assert.ok(!fs.existsSync(path.join(app, 'enroll.txt')), 'token removed after use');
  const devices = await api('GET', '/devices');
  assert.ok(devices.json.some((d: any) => d.name === 'pkg-miyoo' && d.connType === 'AGENT'));
  assert.match((await execFileP('sh', [path.join(app, 'rommancer-sync.sh'), 'sync'], { env })).stdout, /0 errors/);
  // The token works once
  const again = await fetch(`${base}/api/v1/link/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `name=x&firmware=onion&root=/mnt/SDCARD&token=${encodeURIComponent(enrollToken)}` });
  assert.equal(again.status, 404);
});

test('sync client: login and sign-up typed on the console', async () => {
  const post = (p: string, form: Record<string, string>) =>
    fetch(`${base}/api/v1${p}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  const parse = async (r: Response) => Object.fromEntries((await r.text()).trim().split('\n').map((l) => l.split('\t')));
  const device = { name: 'console-ui', firmware: 'knulli', root: '/userdata', model: 'Anbernic RG40XX-V' };
  await api('PUT', '/admin/settings/signup', { open: false });
  assert.equal((await parse(await fetch(`${base}/api/v1/link/info`))).signup, '0');
  assert.equal((await post('/link/signup', { ...device, username: 'consoleuser', email: 'consoleuser@example.com', password: 'console-password-1' })).status, 403);
  await api('PUT', '/admin/settings/signup', { open: true });
  assert.equal((await parse(await fetch(`${base}/api/v1/link/info`))).signup, '1');
  const created = await post('/link/signup', { ...device, username: 'consoleuser', email: 'consoleuser@example.com', password: 'console-password-1' });
  assert.equal(created.status, 201);
  const c = await parse(created);
  assert.equal(c.user, 'consoleuser');
  const roots = await fetch(`${base}/api/v1/agent/roots`, { headers: { 'X-Device-Token': c.token } });
  assert.equal(roots.status, 200, 'the new device token works');
  await api('PUT', '/admin/settings/signup', { open: false });
  assert.equal((await post('/link/login', { ...device, username: 'consoleuser', password: 'wrong-password' })).status, 401);
  const logged = await post('/link/login', { ...device, username: 'consoleuser@example.com', password: 'console-password-1' });
  assert.equal(logged.status, 200);
  const l = await parse(logged);
  assert.ok(l.token && l.token !== c.token, 'each login registers its own device');
  assert.equal((await post('/link/login', { ...device, firmware: 'nope', username: 'consoleuser', password: 'console-password-1' })).status, 400);
});

test('sync client: roms with non-DAT names share saves by content hash', async () => {
  const client = path.join(ROOT, 'clients/linux/rommancer-sync.sh');
  const dir = path.join(DATA, 'sync-hash');
  fs.rmSync(dir, { recursive: true, force: true });
  const run = (name: string, args: string[], env: Record<string, string> = {}) =>
    execFileP('sh', [client, ...args], { env: { ...process.env, ROMMANCER_STATE: path.join(dir, `${name}-state`), ...env } });
  const enrol = async (name: string, firmware: string, root: string) => {
    const r = await api('POST', '/link/claim', { name, firmware, root });
    assert.equal(r.status, 201);
    fs.mkdirSync(path.join(dir, `${name}-state`), { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}-state`, 'config'), `SERVER=${base}\nTOKEN=${r.json.token}\n`);
  };
  const smb3 = fs.readFileSync(path.join(ROMS, 'nes', `${SMB3}.nes`));
  const onion = path.join(dir, 'onion');
  const knulli = path.join(dir, 'knulli');
  fs.mkdirSync(path.join(onion, 'Roms/FC'), { recursive: true });
  fs.mkdirSync(path.join(onion, 'Saves/CurrentProfile/saves/FCEUmm'), { recursive: true });
  fs.mkdirSync(path.join(knulli, 'roms/nes'), { recursive: true });
  // GoodNES-style name on one console, a user's own name on the other: only the content matches the DAT
  fs.writeFileSync(path.join(onion, 'Roms/FC', 'Super Mario Bros. 3 (U) (PRG1) [!].nes'), smb3);
  fs.writeFileSync(path.join(knulli, 'roms/nes', 'smb3.nes'), smb3);
  fs.writeFileSync(path.join(onion, 'Saves/CurrentProfile/saves/FCEUmm', 'Super Mario Bros. 3 (U) (PRG1) [!].srm'), 'WORLD-8');
  await enrol('hash-onion', 'onion', onion);
  await enrol('hash-knulli', 'knulli', knulli);
  assert.match((await run('hash-onion', ['sync'])).stdout, /1 up, 0 down, 0 errors/);
  assert.match((await run('hash-knulli', ['sync'])).stdout, /0 up, 1 down, 0 errors/);
  assert.equal(fs.readFileSync(path.join(knulli, 'saves/nes', 'smb3.srm'), 'utf8'), 'WORLD-8');
  const { prisma } = await import('../src/lib/prisma.js');
  const save = await prisma.save.findFirstOrThrow({ where: { baseName: 'Super Mario Bros. 3 (U) (PRG1) [!]' }, include: { game: true } });
  assert.equal(save.game?.title, 'Super Mario Bros. 3', 'the save knows its game from the rom hash');
});

test('sync client: several cores with their own file for one game keep separate saves', async () => {
  const client = path.join(ROOT, 'clients/linux/rommancer-sync.sh');
  const dir = path.join(DATA, 'sync-cores');
  fs.rmSync(dir, { recursive: true, force: true });
  const thor = path.join(dir, 'thor');
  const r = await api('POST', '/link/claim', { name: 'cores-thor', firmware: 'android-esde', root: thor, overrides: JSON.stringify({ savesLayout: 'rom-core' }) });
  assert.equal(r.status, 201);
  const state = path.join(dir, 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'config'), `SERVER=${base}\nTOKEN=${r.json.token}\n`);
  const run = () => execFileP('sh', [client, 'sync'], { env: { ...process.env, ROMMANCER_STATE: state } });
  const rom = 'Some Game (USA)';
  fs.mkdirSync(path.join(thor, 'ROMs/nes'), { recursive: true });
  fs.writeFileSync(path.join(thor, 'ROMs/nes', `${rom}.nes`), crypto.randomBytes(2048));
  // FCEUmm is known; "Mesen" is a core the server has never seen and registers on the fly
  for (const [core, content] of [['FCEUmm', 'FCEUMM-SAVE'], ['Mesen', 'MESEN-SAVE']]) {
    fs.mkdirSync(path.join(thor, 'ROMs/nes', core), { recursive: true });
    fs.writeFileSync(path.join(thor, 'ROMs/nes', core, `${rom}.srm`), content);
  }
  assert.match((await run()).stdout, /2 up, 0 down, 0 errors/);
  assert.match((await run()).stdout, /0 up, 0 down, 0 errors/, 'no core overwrites another');
  assert.equal(fs.readFileSync(path.join(thor, 'ROMs/nes/FCEUmm', `${rom}.srm`), 'utf8'), 'FCEUMM-SAVE');
  assert.equal(fs.readFileSync(path.join(thor, 'ROMs/nes/Mesen', `${rom}.srm`), 'utf8'), 'MESEN-SAVE');
  const { prisma } = await import('../src/lib/prisma.js');
  const saves = await prisma.save.findMany({ where: { baseName: rom }, include: { emulator: true } });
  assert.deepEqual(saves.map((s) => s.emulator.core).sort(), ['FCEUmm', 'Mesen']);
});

test('sync client: updates itself from the server', async () => {
  const dir = path.join(DATA, 'sync-update');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const real = fs.readFileSync(path.join(ROOT, 'clients/linux/rommancer-sync.sh'), 'utf8');
  // An older copy: same code, different bytes
  fs.writeFileSync(path.join(dir, 'rommancer-sync.sh'), real.replace('CLIENT_VERSION=', '# old\nCLIENT_VERSION='));
  const r = await api('POST', '/link/claim', { name: 'updater', firmware: 'knulli', root: dir });
  const state = path.join(dir, 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'config'), `SERVER=${base}\nTOKEN=${r.json.token}\n`);
  const run = () => execFileP('sh', [path.join(dir, 'rommancer-sync.sh'), 'update'], { env: { ...process.env, ROMMANCER_STATE: state } });
  assert.equal((await run()).stdout.trim(), 'restart');
  assert.equal(fs.readFileSync(path.join(dir, 'rommancer-sync.sh'), 'utf8'), real);
  assert.ok(fs.existsSync(path.join(dir, 'cacert.pem')), 'missing support files are fetched');
  assert.ok(!fs.existsSync(path.join(dir, 'savepoint.png')), 'setup-app files only where the app is installed');
  assert.equal((await run()).stdout.trim(), '', 'nothing to do when up to date');
  assert.equal((await fetch(`${base}/api/v1/link/client/file/..%2F.env`)).status, 404);

  // An Onion app from before it had an icon: the icon arrives and its config.json points at it
  fs.writeFileSync(path.join(dir, 'config.json'), '{\n"label":"Rommancer Sync",\n"icon":"../../Icons/Default/app/otaupdate.png",\n"launch":"launch.sh"\n}\n');
  await run();
  assert.ok(fs.existsSync(path.join(dir, 'icon.png')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).icon, 'icon.png');
  assert.ok(!fs.existsSync(path.join(dir, 'rommancer-art.png')), 'EmulationStation art only where the setup app is');
  // The server's clock comes with the manifest, for the update date of consoles whose clock drifts
  assert.match(await (await fetch(`${base}/api/v1/link/client/manifest`)).text(), /^now\t\d{4}-\d\d-\d\d \d\d:\d\d$/m);
});

test('sync client: roms of assigned lists, save before a game, conflicts resolved on the console', async () => {
  const client = path.join(ROOT, 'clients/linux/rommancer-sync.sh');
  const dir = path.join(DATA, 'sync-roms');
  fs.rmSync(dir, { recursive: true, force: true });
  const make = async (name: string) => {
    const root = path.join(dir, name);
    const r = await api('POST', '/link/claim', { name, firmware: 'knulli', root });
    const state = path.join(dir, `${name}-state`);
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'config'), `SERVER=${base}\nTOKEN=${r.json.token}\n`);
    const run = (...args: string[]) => execFileP('sh', [client, ...args], { env: { ...process.env, ROMMANCER_STATE: state } });
    return { id: r.json.deviceId as number, root, run };
  };
  // Start without the SMB3 saves of earlier tests, which would rightly turn A's first upload into a conflict
  const { prisma } = await import('../src/lib/prisma.js');
  const old = (await prisma.save.findMany({ where: { gameId: ctx.smb3GameId }, select: { id: true } })).map((x) => x.id);
  await prisma.saveConflict.deleteMany({ where: { saveId: { in: old } } });
  await prisma.saveDeviceState.deleteMany({ where: { saveId: { in: old } } });
  await prisma.save.updateMany({ where: { id: { in: old } }, data: { currentVersionId: null } });
  await prisma.saveVersion.deleteMany({ where: { saveId: { in: old } } });
  await prisma.save.deleteMany({ where: { id: { in: old } } });
  const a = await make('roms-a');
  const b = await make('roms-b');
  const list = await api('POST', '/lists', { name: 'Device roms' });
  assert.equal((await api('POST', `/lists/${list.json.id}/items`, { gameId: ctx.smb3GameId })).status, 201);
  // One list sent to several consoles at once
  assert.equal((await api('PUT', `/devices/by-list/${list.json.id}`, { deviceIds: [a.id, b.id] })).status, 200);
  assert.deepEqual((await api('GET', `/devices/by-list/${list.json.id}`)).json.sort(), [a.id, b.id].sort());

  const plan = await fetch(`${base}/api/v1/agent/roms`, { headers: { 'X-Device-Token': fs.readFileSync(path.join(dir, 'roms-a-state', 'config'), 'utf8').match(/TOKEN=(.*)/)![1] } });
  const planText = await plan.text();
  assert.match(planText, /^rom\t.*\/roms\/nes\//m);
  // A forged reference to another server file is refused
  const forged = planText.split('\t')[3].trim().replace(/^[^.]+/, Buffer.from(JSON.stringify({ d: a.id, p: '/etc/passwd', e: null })).toString('base64url'));
  assert.equal((await fetch(`${base}/api/v1/agent/rom?f=${forged}`, { headers: { 'X-Device-Token': fs.readFileSync(path.join(dir, 'roms-a-state', 'config'), 'utf8').match(/TOKEN=(.*)/)![1] } })).status, 403);

  assert.match((await a.run('roms')).stdout, /roms: [1-9]\d* downloaded, 0 already here, 0 failed/);
  assert.match((await a.run('roms')).stdout, /roms: 0 downloaded, [1-9]\d* already here, 0 failed/, 'nothing twice');
  await b.run('roms');
  const romA = fs.readdirSync(path.join(a.root, 'roms/nes')).find((f) => f.endsWith('.nes'))!;
  const romPath = (d: typeof a) => path.join(d.root, 'roms/nes', romA);
  assert.ok(fs.existsSync(romPath(b)));

  // A plays and saves; B fetches that save right before starting the game
  const saveA = path.join(a.root, 'saves/nes', romA.replace(/\.nes$/, '.srm'));
  fs.mkdirSync(path.dirname(saveA), { recursive: true });
  fs.writeFileSync(saveA, 'FROM-A');
  await a.run('sync');
  await b.run('game-start', romPath(b));
  const saveB = path.join(b.root, 'saves/nes', romA.replace(/\.nes$/, '.srm'));
  assert.equal(fs.readFileSync(saveB, 'utf8'), 'FROM-A');
  await b.run('sync');

  // Both change it: B gets a conflict, lists it and keeps the server's version
  fs.writeFileSync(saveA, 'A-AGAIN');
  fs.writeFileSync(saveB, 'B-AGAIN-LONGER');
  await a.run('sync');
  await b.run('sync');
  const conflicts = (await b.run('conflicts')).stdout.trim().split('\n').filter(Boolean);
  assert.equal(conflicts.length, 1);
  const id = conflicts[0].split('\t')[1];
  assert.match((await b.run('resolve', id, 'server')).stdout, /0 up, 1 down/);
  assert.equal(fs.readFileSync(saveB, 'utf8'), 'A-AGAIN');
  assert.equal((await b.run('conflicts')).stdout.trim(), '');
  // What the sync overwrote is kept in the console's state folder, away from the emulator
  const backups = path.join(dir, 'roms-b-state', 'backups');
  assert.deepEqual(fs.readdirSync(backups).map((f) => fs.readFileSync(path.join(backups, f), 'utf8')), ['B-AGAIN-LONGER']);

  // The resume state stays on its console; a newer save arriving puts it aside, so the game starts with that save
  const resumeB = saveB.replace(/\.srm$/, '.state.auto');
  fs.writeFileSync(resumeB, 'B-RESUME');
  await b.run('sync');
  assert.equal(await prisma.save.count({ where: { baseName: romA.replace(/\.nes$/, ''), kind: 'STATE', slot: -1 } }), 0, 'never sent to the server');
  fs.writeFileSync(saveA, 'A-THIRD');
  await a.run('sync');
  await b.run('sync');
  assert.equal(fs.readFileSync(saveB, 'utf8'), 'A-THIRD');
  assert.ok(!fs.existsSync(resumeB), 'resume state put aside');
  const kept = fs.readdirSync(backups).map((f) => fs.readFileSync(path.join(backups, f), 'utf8'));
  assert.ok(kept.includes('B-RESUME') && kept.includes('A-AGAIN'), JSON.stringify(kept));

  // EmulationStation collections on Knulli: the game whose save is synced, and the rom Rommancer copied
  const sysroot = path.join(dir, 'b-sys');
  const collections = (lang: string) =>
    execFileP('sh', [client, 'collections'], { env: { ...process.env, ROMMANCER_STATE: path.join(dir, 'roms-b-state'), ROMMANCER_FIRMWARE: 'knulli', ROMMANCER_SYSROOT: sysroot, LANG: lang } });
  await collections('C');
  const coll = path.join(sysroot, 'userdata/system/configs/emulationstation/collections');
  assert.deepEqual(fs.readFileSync(path.join(coll, 'custom-Rommancer - With saves.cfg'), 'utf8').trim().split('\n'), [romPath(b)]);
  assert.deepEqual(fs.readFileSync(path.join(coll, 'custom-Rommancer - New.cfg'), 'utf8').trim().split('\n'), [romPath(b)]);
  // Arrivals older than two weeks drop out, and the record forgets them
  const record = path.join(dir, 'roms-b-state', 'received-roms');
  fs.writeFileSync(record, fs.readFileSync(record, 'utf8').replace(/^\d+/gm, String(Math.floor(Date.now() / 1000) - 15 * 86400)));
  await collections('es_ES.UTF-8');
  assert.equal(fs.readFileSync(path.join(coll, 'custom-Rommancer - Nuevos.cfg'), 'utf8'), '');
  assert.equal(fs.readFileSync(record, 'utf8'), '');
  assert.deepEqual(fs.readFileSync(path.join(coll, 'custom-Rommancer - Con partida.cfg'), 'utf8').trim().split('\n'), [romPath(b)]);
});

test('collection: removing a hand-uploaded game deletes its file, list entries and records', async () => {
  const { prisma } = await import('../src/lib/prisma.js');
  const game = await prisma.game.findFirstOrThrow({ where: { title: 'Juego Snes' }, include: { hacks: { include: { files: { include: { romPath: true } } } }, roms: { include: { parts: { include: { files: { include: { romPath: true } } } } } } } });
  const files = [...game.roms.flatMap((r) => r.parts.flatMap((p) => p.files)), ...game.hacks.flatMap((h) => h.files)];
  assert.ok(files.length > 0);
  const abs = files.map((f) => path.join(f.romPath.path, f.relativePath));
  const list = await api('POST', '/lists', { name: 'to clean' });
  await api('POST', `/lists/${list.json.id}/items`, { gameId: game.id });
  const r = await api('DELETE', `/games/${game.id}/collection`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.gameDeleted, true);
  for (const f of abs) assert.ok(!fs.existsSync(f), `${f} deleted`);
  assert.equal((await api('GET', `/lists/${list.json.id}`)).json.items.length, 0);
  assert.equal((await api('DELETE', `/games/${game.id}/collection`, undefined, userToken)).status, 403, 'admins only');
});

test('desktop companion: a console card synced from a computer keeps the console paths', async () => {
  const dir = path.join(DATA, 'pc-mount');
  fs.rmSync(dir, { recursive: true, force: true });
  const consoleRoot = '/userdata';
  const claim = await api('POST', '/link/claim', { name: 'console-card', firmware: 'knulli', root: consoleRoot });
  const token = claim.json.token as string;
  const id = claim.json.deviceId as number;
  const mount = path.join(dir, 'SHARE');
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const agent = (p: string, init: RequestInit = {}) =>
    fetch(`${base}/api/v1/agent${p}`, { ...init, headers: { 'X-Device-Token': token, 'X-Device-Root-Temp-B64': b64(mount), 'Content-Type': 'application/octet-stream', ...(init.headers ?? {}) } }).then((r) => r.text())

  // The computer sees the card under its mount, only for its own requests
  assert.match(await agent('/roots'), new RegExp(`roms\t${mount}/roms`));
  const homebrew = `${mount}/roms/nes/Mount Homebrew (World).nes`;
  await agent('/sync', { method: 'POST', body: `rom\t${homebrew}\t${'a'.repeat(40)}\n` });
  const inv = (await api('GET', `/devices/${id}/inventory`)).json;
  assert.deepEqual(inv.items.map((i: any) => i.path), ['/userdata/roms/nes/Mount Homebrew (World).nes'], 'stored with the console paths');
  assert.equal((await api('GET', `/devices/${id}`)).json.rootPath, consoleRoot, 'the console root is untouched');

  // A request made from the web reaches each side with its own paths
  assert.equal((await api('POST', `/devices/${id}/pull`, {})).json.queued, 1);
  assert.match(await agent('/pulls'), new RegExp(`\t${homebrew.replace(/[()]/g, '\\$&')}\n`));
  const plain = await fetch(`${base}/api/v1/agent/pulls`, { headers: { 'X-Device-Token': token } }).then((r) => r.text());
  assert.match(plain, /\t\/userdata\/roms\/nes\/Mount Homebrew/);
  await api('DELETE', `/devices/${id}/pulls`);

  // A body the server cannot read (no content type) does not wipe the list
  await fetch(`${base}/api/v1/agent/sync`, { method: 'POST', headers: { 'X-Device-Token': token }, body: '' });
  assert.equal((await api('GET', `/devices/${id}/inventory`)).json.items.length, 1);
  assert.match(await agent('/whoami'), new RegExp(`id\t${id}\n`));
});

test('desktop companion: GBA flashcart (saves next to each rom) and card keys of an existing device', async () => {
  const card = '/media/me/SUPERCARD';
  const claim = await api('POST', '/link/claim', { name: 'supercard', firmware: 'gba-flashcart', root: card, offline: true });
  assert.equal(claim.status, 201, JSON.stringify(claim.json));
  const token = claim.json.token as string;
  const id = claim.json.deviceId as number;
  const agent = (p: string, init: RequestInit = {}, tok = token) =>
    fetch(`${base}/api/v1/agent${p}`, { ...init, headers: { 'X-Device-Token': tok, 'Content-Type': 'application/octet-stream', ...(init.headers ?? {}) } })
  const roots = await (await agent('/roots')).text();
  assert.match(roots, /scan\tdeep/);
  assert.match(roots, new RegExp(`saves\t${card}\n`));
  const rom = `${card}/Juegos/Estrategia/Mystery Game (USA).gba`;
  const save = `${card}/Juegos/Estrategia/Mystery Game (USA).sav`;
  const plan = await (await agent('/sync', { method: 'POST', body: `rom\t${rom}\t${'b'.repeat(40)}\nfile\t${save}\t${'c'.repeat(40)}\n` })).text();
  assert.match(plan, new RegExp(`^put\t${save.replace(/[()]/g, '\\$&')}\t`, 'm'), 'the save next to the rom, in its own folder');
  assert.equal((await api('GET', `/devices/${id}`)).json.offline, true);
  const inv = (await api('GET', `/devices/${id}/inventory`)).json;
  assert.equal(inv.items[0].system, 'gba', 'a .gba anywhere on a GBA card');
  // Any system goes on any device: a Game Boy rom for an emulator is GB, not GBA, and keeps its own folder
  await (await agent('/sync', { method: 'POST', body: `rom\t${rom}\t${'b'.repeat(40)}\nrom\t${card}/gb/Tiny (World).gb\t${'d'.repeat(40)}\n` })).text();
  const inv2 = (await api('GET', `/devices/${id}/inventory`)).json;
  assert.equal(inv2.items.find((i: any) => i.name === 'Tiny (World).gb').system, 'gb');
  const nesList = await api('POST', `/devices/${id}/send`, { gameIds: [ctx.smb3GameId] });
  assert.equal(nesList.status, 201);
  assert.match(await (await agent('/roms')).text(), new RegExp(`^rom\t${card}/nes/`, 'm'), 'a NES game sent to a GBA card goes to nes/');

  // A second key for the same device: the console keeps its own
  const extra = await api('POST', `/devices/${id}/card-token`, { label: 'spare card' });
  assert.equal(extra.status, 201);
  assert.match(await (await agent('/whoami', {}, extra.json.token)).text(), new RegExp(`id\t${id}\n`));
  assert.match(await (await agent('/whoami')).text(), new RegExp(`id\t${id}\n`));
  assert.equal((await api('DELETE', `/devices/${id}/card-tokens`)).json.revoked, 1);
  assert.equal((await agent('/whoami', {}, extra.json.token)).status, 401);
});

test('desktop companion: a layout the user defines (one system, saves next to each game) and file sizes', async () => {
  const card = '/media/me/CUSTOM';
  const rd = ctx.firmwares.find((f: any) => f.slug === 'retroarch-desktop');
  const overrides = JSON.stringify({ romsRoot: '', savesRoot: '', statesRoot: '', savesLayout: 'beside', systemMap: { gb: { folder: '' } }, systemMapOnly: true });
  const claim = await api('POST', '/link/claim', { name: 'custom card', firmware: 'retroarch-desktop', firmwareId: rd.id, root: card, overrides, offline: true });
  assert.equal(claim.status, 201, JSON.stringify(claim.json));
  const agent = (p: string, init: RequestInit = {}) =>
    fetch(`${base}/api/v1/agent${p}`, { ...init, headers: { 'X-Device-Token': claim.json.token, 'Content-Type': 'application/octet-stream', ...(init.headers ?? {}) } }).then((r) => r.text());
  const roots = await agent('/roots');
  assert.match(roots, /exts\t\.srm/, "the system's usual core decides the save extension");
  assert.match(roots, /scan\tdeep/);
  const rom = `${card}/juegos/Tiny (World).gb`;
  const save = `${card}/juegos/Tiny (World).srm`;
  const plan = await agent('/sync', { method: 'POST', body: `rom\t${rom}\t${'e'.repeat(40)}\t\t12345\nfile\t${save}\t${'f'.repeat(40)}\n` });
  assert.match(plan, /^put\t.*Tiny \(World\)\.srm/m);
  const inv = (await api('GET', `/devices/${claim.json.deviceId}/inventory`)).json;
  assert.equal(inv.items[0].system, 'gb');
  assert.equal(inv.items[0].size, 12345, 'the size the device reported');
});

test('storage: an unreachable folder keeps its index, mass removals wait for confirmation, destinations keep their reserve', async () => {
  const dir = path.join(DATA, 'storage-src');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'nes'), { recursive: true });
  const nesFiles = fs.readdirSync(path.join(ROMS, 'nes')).filter((f) => f.endsWith('.nes')).slice(0, 60);
  for (const f of nesFiles) fs.copyFileSync(path.join(ROMS, 'nes', f), path.join(dir, 'nes', f));
  const p = (await api('POST', '/admin/paths', { label: 'Storage src', path: dir })).json;
  await waitJob((await api('POST', `/admin/paths/${p.id}/scan`)).json.id);
  const count = async () => Object.values((await api('GET', '/admin/paths')).json.find((x: any) => x.id === p.id).files as Record<string, number>).reduce((a, b) => a + b, 0);
  const indexed = await count();
  assert.ok(indexed >= 50, `indexed ${indexed}`);

  // Disk gone (folder missing) or not mounted (empty mount point): offline, nothing removed
  fs.renameSync(dir, dir + '-away');
  const r1 = await waitJob((await api('POST', `/admin/paths/${p.id}/scan`)).json.id);
  assert.equal(r1.result.offline, true);
  assert.equal(await count(), indexed);
  let row = (await api('GET', '/admin/paths')).json.find((x: any) => x.id === p.id);
  assert.equal(row.offlineReason, 'missing');
  fs.mkdirSync(dir);
  const r2 = await waitJob((await api('POST', `/admin/paths/${p.id}/scan`)).json.id);
  assert.equal(r2.result.reason, 'empty');
  assert.equal(await count(), indexed);
  fs.rmSync(dir, { recursive: true });
  fs.renameSync(dir + '-away', dir);

  // Most of the folder vanishing at once is held back until confirmed
  for (const f of nesFiles.slice(0, 40)) fs.rmSync(path.join(dir, 'nes', f));
  const r3 = await waitJob((await api('POST', `/admin/paths/${p.id}/scan`)).json.id);
  assert.equal(r3.result.removed, 0);
  assert.ok(r3.result.heldBack >= 40);
  row = (await api('GET', '/admin/paths')).json.find((x: any) => x.id === p.id);
  assert.equal(row.offlineAt, null, 'back online');
  assert.match(row.scanWarning, /kept until confirmed/);
  const r4 = await waitJob((await api('POST', `/admin/paths/${p.id}/scan`, { allowMassRemoval: true })).json.id);
  assert.ok(r4.result.removed >= 40);
  assert.equal((await api('GET', '/admin/paths')).json.find((x: any) => x.id === p.id).scanWarning, null);

  // Overlapping folders are refused, the same folder elsewhere is recognised by its marker
  assert.equal((await api('POST', '/admin/paths', { label: 'Inside', path: path.join(dir, 'nes') })).status, 409);
  const dest = path.join(DATA, 'storage-dest');
  fs.rmSync(dest, { recursive: true, force: true });
  const d = (await api('POST', '/admin/paths', { label: 'Dest', path: dest, readOnly: false, targetSystems: ['lynx'], create: true, reservePercent: 90 })).json;
  assert.ok(fs.existsSync(path.join(dest, '.rommancer-id')), 'writable folders get a marker');
  const moved = dest + '-moved';
  fs.rmSync(moved, { recursive: true, force: true });
  fs.cpSync(dest, moved, { recursive: true });
  const again = await api('POST', '/admin/paths', { label: 'Again', path: moved });
  assert.equal(again.status, 409);
  assert.match(again.json.error, /^SAME_FOLDER/);

  // A destination that would cross its reserve refuses the upload (90% kept free on a disk that is fuller)
  const space = await fs.promises.statfs(dest);
  if (Number(space.bavail) / Number(space.blocks) < 0.9) {
    const fd = new FormData();
    fd.append('file', new Blob([crypto.randomBytes(4096)]), 'reserve.lnx');
    const lynx = (await api('GET', '/systems')).json.find((s: any) => s.slug === 'lynx');
    fd.append('systemId', String(lynx.id));
    fd.append('newGameTitle', 'Reserve test');
    // The system's destination is past its reserve: the file goes whole to the general destination instead
    const up = await api('POST', '/uploads/unverified', fd);
    assert.equal(up.status, 201, JSON.stringify(up.json));
    assert.ok(!fs.existsSync(path.join(dest, 'lynx', 'reserve.lnx')));
    assert.ok(fs.existsSync(path.join(DATA, 'uploads-target', 'lynx', 'reserve.lnx')));
  }
  await api('DELETE', `/admin/paths/${d.id}`);
});

test('organize: companions travel with their rom, multi-file games stay, a run can be undone', async () => {
  const dir = path.join(DATA, 'organize-journal');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(ROMS, 'nes', `${SMB3}.nes`), path.join(dir, 'mario.nes'));
  fs.writeFileSync(path.join(dir, 'mario.ips'), 'PATCH');
  const p = (await api('POST', '/admin/paths', { label: 'Journal', path: dir, readOnly: false })).json;
  await waitJob((await api('POST', `/admin/paths/${p.id}/scan`)).json.id);
  const plan = (await api('GET', `/admin/paths/${p.id}/organize?scheme=system`)).json;
  assert.deepEqual(plan.find((x: any) => x.from === 'mario.nes').companions, ['mario.ips']);
  const applied = (await api('POST', `/admin/paths/${p.id}/organize`, { scheme: 'system' })).json;
  assert.equal(applied.errors.length, 0, JSON.stringify(applied));
  assert.ok(fs.existsSync(path.join(dir, 'nes', `${SMB3}.nes`)));
  assert.ok(fs.existsSync(path.join(dir, 'nes', `${SMB3}.ips`)), 'the patch follows its rom');
  assert.ok(fs.existsSync(path.join(dir, '.rommancer-organize.json')));
  const undone = (await api('POST', `/admin/paths/${p.id}/organize/undo`)).json;
  assert.equal(undone.errors.length, 0);
  assert.ok(fs.existsSync(path.join(dir, 'mario.nes')) && fs.existsSync(path.join(dir, 'mario.ips')));
  const rescan = await waitJob((await api('POST', `/admin/paths/${p.id}/scan`)).json.id);
  assert.equal(rescan.result.hashed, 0, 'the index followed the undo');
});

test('device space: list roms are copied while the reserve holds, the rest waits and can be left out', async () => {
  const claim = await api('POST', '/link/claim', { name: 'small card', firmware: 'knulli', root: '/media/small' });
  const id = claim.json.deviceId as number;
  const agent = (p: string, init: RequestInit = {}) =>
    fetch(`${base}/api/v1/agent${p}`, { ...init, headers: { 'X-Device-Token': claim.json.token, 'Content-Type': 'application/octet-stream', ...(init.headers ?? {}) } }).then((r) => r.text());
  const sent = await api('POST', `/devices/${id}/send`, { gameIds: [ctx.smb3GameId] });
  assert.equal(sent.status, 201);
  // 1 MB free of 100 MB with a 5% reserve: nothing fits
  await agent('/sync', { method: 'POST', body: 'rom\t/media/small/roms/nes/x.nes\t\t\t1\n', headers: { 'X-Space': `${1e6} ${1e8}` } });
  let plan = (await api('GET', `/devices/${id}/plan`)).json;
  assert.equal(plan.fits, false);
  assert.equal(plan.reservePercent, 5);
  assert.ok(plan.systems[0].games[0].bytes > 0);
  assert.equal((await agent('/roms')).trim(), '', 'nothing copied past the reserve');
  assert.equal((await api('GET', `/devices/${id}`)).json.spaceShortfall.files, 1);
  // Plenty of room: copied
  await agent('/sync', { method: 'POST', body: 'rom\t/media/small/roms/nes/x.nes\t\t\t1\n', headers: { 'X-Space': `${9e8} ${1e9}` } });
  assert.match(await agent('/roms'), /^rom\t\/media\/small\/roms\/nes\//m);
  // Left out one by one: not copied even with room
  await api('PUT', `/devices/${id}/system-filter`, { newAuto: true, excluded: [], known: ['nes'], excludedGames: [ctx.smb3GameId] });
  assert.equal((await agent('/roms')).trim(), '');
  plan = (await api('GET', `/devices/${id}/plan`)).json;
  assert.equal(plan.systems[0].games[0].excluded, true);
  assert.equal((await api('PUT', `/devices/${id}/reserve`, { percent: 12 })).json.reservePercent, 12);
});

test('sync client: device inventory, fetching missing roms, sync on request, direct sends and list progress', async () => {
  const client = path.join(ROOT, 'clients/linux/rommancer-sync.sh');
  const dir = path.join(DATA, 'sync-inventory');
  fs.rmSync(dir, { recursive: true, force: true });
  const root = path.join(dir, 'console');
  fs.mkdirSync(path.join(root, 'roms/nes'), { recursive: true });
  const smb3 = `${SMB3}.nes`;
  fs.copyFileSync(path.join(ROMS, 'nes', smb3), path.join(root, 'roms/nes', smb3));
  const homebrew = 'Tiny Homebrew (World).nes';
  fs.writeFileSync(path.join(root, 'roms/nes', homebrew), Buffer.concat([Buffer.from('NES\x1a'), crypto.randomBytes(24 * 1024)]));
  const claim = await api('POST', '/link/claim', { name: 'inventory-console', firmware: 'knulli', root });
  const id = claim.json.deviceId as number;
  const state = path.join(dir, 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'config'), `SERVER=${base}\nTOKEN=${claim.json.token}\n`);
  const run = (...args: string[]) => execFileP('sh', [client, ...args], { env: { ...process.env, ROMMANCER_STATE: state } });
  const agent = (p: string) => fetch(`${base}/api/v1/agent${p}`, { headers: { 'X-Device-Token': claim.json.token } }).then((r) => r.text());

  await run('sync');
  let inv = (await api('GET', `/devices/${id}/inventory`)).json;
  assert.equal(inv.allowPull, true);
  assert.equal(inv.items.length, 2);
  assert.equal(inv.items.find((i: any) => i.name === smb3).onServer, true, 'identified by hash and owned');
  assert.equal(inv.items.find((i: any) => i.name === homebrew).onServer, false);

  // "Sync now" from the web reaches the client at its next poll, once
  await api('POST', `/devices/${id}/refresh`);
  assert.equal((await agent('/poll')).trim(), 'sync');
  assert.equal((await agent('/poll')).trim(), '');

  // Bring everything the server lacks: only the homebrew, stored as unverified in the NES library
  assert.equal((await api('POST', `/devices/${id}/pull`, {})).json.queued, 1);
  assert.equal((await agent('/poll')).trim(), 'pull');
  assert.match((await run('pulls')).stdout, /sent to server: 1 of 1/);
  const pulls = (await api('GET', `/devices/${id}/pulls`)).json;
  assert.equal(pulls[0].status, 'done', JSON.stringify(pulls[0]));
  assert.equal(pulls[0].result, 'stored as unverified');
  await run('sync');
  inv = (await api('GET', `/devices/${id}/inventory`)).json;
  assert.equal(inv.items.find((i: any) => i.name === homebrew).onServer, true, 'now in the collection');
  assert.equal((await api('POST', `/devices/${id}/pull`, {})).json.queued, 0, 'nothing left to bring');

  // A device that does not allow it is never asked
  await execFileP('sh', [client, 'set', 'ALLOW_PULL', '0'], { env: { ...process.env, ROMMANCER_STATE: state } });
  await run('sync');
  assert.equal((await api('GET', `/devices/${id}/inventory`)).json.allowPull, false);
  assert.equal((await api('POST', `/devices/${id}/pull`, {})).status, 403);

  // Direct send: the device's own list, already complete because it has the game
  const sent = await api('POST', `/devices/${id}/send`, { gameIds: [ctx.smb3GameId] });
  assert.equal(sent.status, 201);
  const progress = (await api('GET', `/devices/${id}/lists-progress`)).json;
  const own = progress.find((l: any) => l.id === sent.json.listId);
  assert.deepEqual([own.have, own.total], [1, 1]);
  const byList = (await api('GET', `/devices/by-list/${sent.json.listId}/progress`)).json;
  assert.deepEqual(byList.map((x: any) => [x.deviceId, x.have, x.total]), [[id, 1, 1]]);

  // Per-device override: NES left out, whatever the lists hold
  let sys = (await api('GET', `/devices/${id}/list-systems`)).json;
  assert.equal(sys.newAuto, true);
  assert.deepEqual(sys.systems.map((x: any) => [x.slug, x.games, x.copied, x.folder, x.fresh]), [['nes', 1, true, 'roms/nes', false]]);
  assert.equal((await api('PUT', `/devices/${id}/system-filter`, { newAuto: true, excluded: ['nes'], known: ['nes'] })).status, 200);
  assert.equal((await api('GET', `/devices/${id}/list-systems`)).json.systems[0].copied, false);
  assert.equal((await agent('/roms')).trim(), '', 'no NES rom is offered to the device');
  const left = (await api('GET', `/devices/${id}/lists-progress`)).json.find((l: any) => l.id === sent.json.listId);
  assert.equal(left.total, 0);
  // New systems not copied by themselves: a system the filter did not know arrives unticked, marked as new
  await api('PUT', `/devices/${id}/system-filter`, { newAuto: false, excluded: [], known: [] });
  sys = (await api('GET', `/devices/${id}/list-systems`)).json;
  assert.deepEqual(sys.systems.map((x: any) => [x.slug, x.copied, x.fresh]), [['nes', false, true]]);
  assert.equal((await agent('/roms')).trim(), '');
  await api('PUT', `/devices/${id}/system-filter`, { newAuto: false, excluded: [], known: ['nes'] });
  // (the device already has it, so /roms leaves it out: the list counts it again)
  assert.equal((await api('GET', `/devices/${id}/lists-progress`)).json.find((l: any) => l.id === sent.json.listId).total, 1, 'once ticked it is copied');
  await api('PUT', `/devices/${id}/system-filter`, { newAuto: true, excluded: [], known: ['nes'] });

  // Files without a hash a database knows (big ones go unhashed, .chd never hashes like the dump) still count by name
  const token = claim.json.token as string;
  const named = `${root}/roms/nes/${SMB3}.chd`;
  await fetch(`${base}/api/v1/agent/sync`, { method: 'POST', headers: { 'X-Device-Token': token, 'Content-Type': 'text/plain' }, body: `rom\t${named}\t\t\t700000000\nrom\t${root}/roms/nes/Nobody Knows This (World).nes\t\t\t1\nrom\t${root}/roms/nes/The Super Mario Bros 3 (Spain).nes\t\t\t1\nrom\t${root}/roms/nes/Super Mario Bros 3 (Spain) [T+Spa].nes\t\t\t1\n` });
  inv = (await api('GET', `/devices/${id}/inventory`)).json;
  assert.equal(inv.items.find((i: any) => i.path === named)?.gameId, ctx.smb3GameId, 'identified by its name');
  assert.equal(inv.items.find((i: any) => i.name === 'Nobody Knows This (World).nes')?.gameId, null);
  // Another set's way of naming it: the same game by its title; a fan translation is another game
  assert.equal(inv.items.find((i: any) => i.name === 'The Super Mario Bros 3 (Spain).nes')?.gameId, ctx.smb3GameId, 'identified by its title');
  assert.equal(inv.items.find((i: any) => i.name === 'Super Mario Bros 3 (Spain) [T+Spa].nes')?.gameId, null);
});

test('device config: your settings reach Knulli and Onion through the shell client; copies, edits and restores', async () => {
  const client = path.join(ROOT, 'clients/linux/rommancer-sync.sh');
  const dir = path.join(DATA, 'device-config');
  fs.rmSync(dir, { recursive: true, force: true });
  const sysroot = path.join(dir, 'onion-sys');
  const run = (name: string, args: string[], env: Record<string, string> = {}) =>
    execFileP('sh', [client, ...args], { env: { ...process.env, ROMMANCER_STATE: path.join(dir, `${name}-state`), ROMMANCER_ROOT: path.join(dir, name), ROMMANCER_SYSROOT: sysroot, ROMMANCER_WIFI_BANDS: '', ...env } });
  const pair = async (name: string, firmware: string, root: string, model: string) => {
    const linking = run(name, ['link', base], { ROMMANCER_NAME: name, ROMMANCER_FIRMWARE: firmware, ROMMANCER_ROOT: root, ROMMANCER_MODEL: model });
    const codeFile = path.join(dir, `${name}-state`, 'code.txt');
    for (let i = 0; i < 50 && !fs.existsSync(codeFile); i++) await new Promise((r) => setTimeout(r, 100));
    const code = fs.readFileSync(codeFile, 'utf8').split('\n')[0];
    const info = await api('GET', `/link/${code}`);
    const ok = await api('POST', `/link/${code}/approve`, { name, consoleId: info.json.suggestedConsoleId, firmwareId: info.json.suggestedFirmwareId });
    await linking;
    return ok.json.deviceId as number;
  };
  const knulli = path.join(dir, 'knulli');
  const conf = path.join(knulli, 'system/batocera.conf');
  fs.mkdirSync(path.join(knulli, 'system/configs/emulationstation'), { recursive: true });
  const original = '# Batocera settings\n#wifi.ssid=example\nwifi.enabled=1\nwifi.ssid=Old network\nwifi.key=old\\#key\naudio.volume=80\n';
  fs.writeFileSync(conf, original);
  fs.writeFileSync(path.join(knulli, 'system/configs/emulationstation/es_settings.cfg'), '<config><string name="Language" value="es_ES"/></config>\n');
  const onion = path.join(dir, 'onion');
  const raCfg = path.join(onion, 'RetroArch/.retroarch/retroarch.cfg');
  fs.mkdirSync(path.dirname(raCfg), { recursive: true });
  fs.writeFileSync(raCfg, 'video_smooth = "false"\ncheevos_enable = "false"\ncheevos_username = ""\n');
  const wpa = path.join(sysroot, 'appconfigs/wpa_supplicant.conf');
  fs.mkdirSync(path.dirname(wpa), { recursive: true });
  fs.writeFileSync(wpa, 'ctrl_interface=/var/run/wpa_supplicant\nupdate_config=1\n\nnetwork={\n\tssid="Neighbour"\n\tpsk="theirs123"\n\tpriority=1\n}\n');

  const kId = await pair('knulli', 'knulli', knulli, 'Anbernic RG40XX V');
  const oId = await pair('onion', 'onion', onion, 'Miyoo Mini Plus');
  const { prisma } = await import('../src/lib/prisma.js');

  // Before the user has settings only RetroArch's command port is to apply (sync messages during a game)
  assert.equal((await api('GET', `/devices/${kId}/config`)).json.settingsPending, true);
  assert.equal((await api('PUT', '/settings/consoles/ra', { username: 'raplayer', password: 'wrong' })).status, 400);
  const ra = await api('PUT', '/settings/consoles/ra', { username: 'raplayer', password: 'ra-secret-pass' });
  assert.equal(ra.status, 200, JSON.stringify(ra.json));
  assert.equal(ra.json.hasToken, true);
  assert.equal((await api('POST', '/settings/consoles/wifi', { ssid: 'Casa', password: 'short' })).status, 400, 'WPA needs 8+ characters');
  await api('POST', '/settings/consoles/wifi', { ssid: 'Casa', password: 'casa;password$1', band: 'dual' });
  await api('POST', '/settings/consoles/wifi', { ssid: 'Piso 5G', password: 'piso5-password', band: '5' });
  await api('POST', '/settings/consoles/wifi', { ssid: 'Oculta', password: 'oculta-pass', band: '2.4', hidden: true });
  const settings = (await api('GET', '/settings/consoles')).json;
  assert.equal(settings.ra.username, 'raplayer');
  assert.equal(settings.wifi.length, 3);
  assert.ok(!JSON.stringify(settings).includes('casa;password'), 'passwords never go back to the browser');

  // Knulli: everything in batocera.conf; the network it uses now keeps a slot
  assert.equal((await api('GET', `/devices/${kId}/config`)).json.settingsPending, true);
  await run('knulli', ['config']);
  let text = fs.readFileSync(conf, 'utf8');
  assert.match(text, /^global\.retroachievements=1$/m);
  assert.match(text, /^global\.retroachievements\.username=raplayer$/m);
  assert.match(text, /^global\.retroachievements\.password=ra-secret-pass$/m);
  assert.match(text, /^global\.retroachievements\.token=RATOKEN123$/m);
  // The console's own network keeps its slot (never reshuffled); ours take the free ones
  assert.match(text, /^wifi\.ssid=Old network$/m);
  assert.match(text, /^wifi\.key=old\\#key$/m);
  assert.match(text, /^wifi2\.ssid=Casa$/m);
  assert.equal(text.split('\n').find((l) => l.startsWith('wifi2.key=')), 'wifi2.key=casa\\;password\\$1', 'batocera.conf escapes ; and $');
  assert.match(text, /^wifi3\.ssid=Piso 5G$/m);
  assert.match(text, /^wifi\.hidden\.ssid=Oculta$/m);
  assert.match(text, /^audio\.volume=80$/m, 'other settings stay');
  assert.match(text, /^#wifi\.ssid=example$/m, 'comments stay');
  assert.match(text, /^global\.retroarch\.network_cmd_enable=true$/m, 'RetroArch takes commands: sync messages during a game');
  let cfg = (await api('GET', `/devices/${kId}/config`)).json;
  assert.equal(cfg.settingsPending, false);
  assert.equal(cfg.settingsError, null);
  const before = cfg.versions.find((v: any) => v.source === 'before');
  assert.ok(before, 'a copy is taken before changing anything');

  // A 2.4 GHz-only device loses the 5 GHz network; running again with nothing new changes nothing
  await api('PATCH', `/devices/${kId}/config`, { wifiBands: '2.4' });
  cfg = (await api('GET', `/devices/${kId}/config`)).json;
  assert.deepEqual(cfg.wifiLeftOut, ['Piso 5G']);
  assert.equal(cfg.settingsPending, true);
  await run('knulli', ['config']);
  text = fs.readFileSync(conf, 'utf8');
  assert.doesNotMatch(text, /Piso 5G/);
  assert.match(text, /^wifi\.ssid=Old network$/m);
  assert.match(text, /^wifi2\.ssid=Casa$/m);
  const versions = (await api('GET', `/devices/${kId}/config`)).json.versions.length;
  await run('knulli', ['config']);
  assert.equal((await api('GET', `/devices/${kId}/config`)).json.versions.length, versions, 'no copy when nothing changes');

  // Onion: RetroArch gets the token (no password), wpa_supplicant keeps the neighbour's network
  await run('onion', ['config']);
  const ocfg = fs.readFileSync(raCfg, 'utf8');
  assert.match(ocfg, /^cheevos_enable = "true"$/m);
  assert.match(ocfg, /^cheevos_username = "raplayer"$/m);
  assert.match(ocfg, /^cheevos_token = "RATOKEN123"$/m);
  assert.match(ocfg, /^cheevos_password = ""$/m);
  assert.match(ocfg, /^video_smooth = "false"$/m);
  const w = fs.readFileSync(wpa, 'utf8');
  assert.match(w, /ctrl_interface=\/var\/run\/wpa_supplicant/);
  assert.match(w, /ssid="Casa"\n\tpsk="casa;password\$1"/);
  assert.match(w, /ssid="Oculta"\n\tpsk="oculta-pass"\n\tscan_ssid=1/);
  assert.doesNotMatch(w, /Piso 5G/, 'the Miyoo Mini Plus model is 2.4 GHz only');
  assert.match(w, /ssid="Neighbour"/);
  const oDev = await prisma.device.findUniqueOrThrow({ where: { id: oId } });
  assert.ok(oDev.settingsHash, 'applied by the console itself');

  // A copy on demand, read in the web app, downloaded, edited and put back
  await api('POST', `/devices/${kId}/config/backup`);
  await run('knulli', ['config']);
  cfg = (await api('GET', `/devices/${kId}/config`)).json;
  const backup = cfg.versions.find((v: any) => v.source === 'backup');
  assert.ok(backup && backup.files >= 2, JSON.stringify(cfg.versions));
  const es = await fetch(`${base}/api/v1/devices/${kId}/config/versions/${backup.id}/file?path=${encodeURIComponent('system/configs/emulationstation/es_settings.cfg')}`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.match(await es.text(), /es_ES/);
  const zip = await fetch(`${base}/api/v1/devices/${kId}/config/versions/${backup.id}/zip`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(zip.status, 200);
  assert.equal(Buffer.from(await zip.arrayBuffer()).subarray(0, 2).toString(), 'PK');
  const edit = await api('PUT', `/devices/${kId}/config/versions/${backup.id}/file`, { path: 'system/configs/emulationstation/es_settings.cfg', content: '<config><string name="Language" value="en_US"/></config>\n' });
  assert.equal(edit.status, 201);
  await run('knulli', ['config']);
  assert.match(fs.readFileSync(path.join(knulli, 'system/configs/emulationstation/es_settings.cfg'), 'utf8'), /en_US/);
  assert.match(fs.readFileSync(conf, 'utf8'), /Oculta/, 'only the edited file is written');

  // The copy taken before the first change brings batocera.conf back; the next sync applies the settings again
  await api('PATCH', `/devices/${kId}/config`, { keepSettings: false });
  await api('POST', `/devices/${kId}/config/versions/${before.id}/restore`, { paths: ['system/batocera.conf'] });
  await run('knulli', ['config']);
  assert.equal(fs.readFileSync(conf, 'utf8'), original);
  const ops = (await api('GET', `/devices/${kId}/config`)).json.ops;
  assert.ok(ops.every((o: any) => o.status === 'done'), JSON.stringify(ops));

  // Android hands the networks to the system: they come with their passwords and bands
  const token = fs.readFileSync(path.join(dir, 'onion-state/config'), 'utf8').match(/TOKEN="?([^"\n]+)/)![1];
  const nets = await (await fetch(`${base}/api/v1/agent/config/wifi`, { headers: { 'X-Device-Token': token } })).text();
  const first = nets.split('\n')[0].split('\t');
  assert.equal(Buffer.from(first[1], 'base64').toString(), 'Casa');
  assert.equal(Buffer.from(first[2], 'base64').toString(), 'casa;password$1');
  assert.equal(first[3], 'dual');
});

test('favourite roms mark their game; RetroAchievements progress read with the user\'s own key', async () => {
  const { prisma } = await import('../src/lib/prisma.js');
  const rom = await prisma.rom.findFirstOrThrow({ where: { raGameId: { not: null } }, include: { game: true } });
  // Favourites are per rom; the game shows as favourite
  assert.equal((await api('PUT', `/roms/${rom.id}/favorite`)).status, 204);
  assert.equal((await api('PUT', `/roms/${rom.id}/favorite`)).status, 204, 'marking twice is fine');
  const favs = (await api('GET', '/games?favorites=1&pageSize=100')).json;
  assert.deepEqual(favs.items.map((g: any) => g.id), [rom.gameId]);
  assert.equal(favs.items[0].favorite, true);
  const detail = (await api('GET', `/games/${rom.gameId}`)).json;
  assert.equal(detail.favorite, true);
  assert.equal(detail.roms.find((r: any) => r.id === rom.id).favorite, true);
  assert.equal(detail.roms.find((r: any) => r.id === rom.id).favorites, undefined);
  // Another user does not see them
  const other = (await api('GET', '/games?favorites=1', undefined, userToken)).json;
  assert.equal(other.total, 0);
  assert.equal((await api('DELETE', `/roms/${rom.id}/favorite`)).status, 204);
  assert.equal((await api('GET', '/games?favorites=1')).json.total, 0);

  // RA progress: nothing until the user sets their RA user and Web API key
  assert.equal((await api('GET', '/ra/me')).json.configured, false);
  raProgressGames.push(rom.raGameId!);
  assert.equal((await api('PATCH', '/users/me', { raUser: 'raplayer', raApiKey: 'wrong-key' })).status, 400, 'a key RA refuses is said so');
  assert.equal((await api('PATCH', '/users/me', { raUser: 'raplayer', raApiKey: 'user-web-key' })).status, 204);
  const me = (await api('POST', '/ra/me/refresh')).json;
  assert.equal(me.configured, true);
  assert.equal(me.profile.points, 1234);
  assert.equal(me.profile.achievements, 12);
  assert.equal(me.profile.games, 1);
  const list = (await api('GET', `/games?systemId=${rom.game.systemId}&ra=1&pageSize=200`)).json;
  const row = list.items.find((g: any) => g.id === rom.gameId);
  assert.deepEqual({ awarded: row.raProgress.awarded, total: row.raProgress.total }, { awarded: 12, total: 40 });
  assert.equal(row.raGameId, rom.raGameId);
  const d = (await api('GET', `/games/${rom.gameId}`)).json;
  assert.equal(d.roms.find((r: any) => r.id === rom.id).raProgress.awarded, 12);
});

test('device config: muOS profiles on the card and ROCKNIX NetworkManager keyfiles, Rommancer\'s own files removed when no longer wanted', async () => {
  const client = path.join(ROOT, 'clients/linux/rommancer-sync.sh');
  const dir = path.join(DATA, 'device-config-2');
  fs.rmSync(dir, { recursive: true, force: true });
  const sysroot = path.join(dir, 'sys');
  const run = (name: string, args: string[], env: Record<string, string> = {}) =>
    execFileP('sh', [client, ...args], { env: { ...process.env, ROMMANCER_STATE: path.join(dir, `${name}-state`), ROMMANCER_ROOT: path.join(dir, name), ROMMANCER_SYSROOT: sysroot, ROMMANCER_WIFI_BANDS: '', ...env } });
  const pair = async (name: string, firmware: string, model: string) => {
    const linking = run(name, ['link', base], { ROMMANCER_NAME: name, ROMMANCER_FIRMWARE: firmware, ROMMANCER_MODEL: model });
    const codeFile = path.join(dir, `${name}-state`, 'code.txt');
    for (let i = 0; i < 50 && !fs.existsSync(codeFile); i++) await new Promise((r) => setTimeout(r, 100));
    const code = fs.readFileSync(codeFile, 'utf8').split('\n')[0];
    const info = await api('GET', `/link/${code}`);
    const ok = await api('POST', `/link/${code}/approve`, { name, consoleId: info.json.suggestedConsoleId, firmwareId: info.json.suggestedFirmwareId });
    await linking;
    return ok.json.deviceId as number;
  };
  const { wpaPsk } = await import('../src/modules/devconfig/adapters.js');
  // muOS: profiles on the card, RetroArch config inside the system
  const net = path.join(dir, 'muos/MUOS/network');
  fs.mkdirSync(net, { recursive: true });
  fs.writeFileSync(path.join(net, 'Casa.ini'), '[network]\nssid=Casa\npass=made-on-the-console\ntype=dhcp\npriority=1\nautoconnect=1\n');
  fs.writeFileSync(path.join(net, 'rommancer-vieja-abc123.ini'), '[network]\nssid=Vieja\npass=x\n');
  const muosRa = path.join(sysroot, 'opt/muos/share/info/config/retroarch.cfg');
  fs.mkdirSync(path.dirname(muosRa), { recursive: true });
  fs.writeFileSync(muosRa, 'video_smooth = "false"\n');
  await pair('muos', 'muos', 'Anbernic RG35XX Plus');
  await run('muos', ['config']);
  const ours = fs.readdirSync(net).filter((f) => f.startsWith('rommancer-')).sort();
  assert.equal(ours.length, 3, ours.join(','));
  assert.ok(!ours.includes('rommancer-vieja-abc123.ini'), 'a network Rommancer wrote before and no longer wants is removed');
  assert.ok(fs.existsSync(path.join(net, 'Casa.ini')), 'profiles made on the console stay');
  const casa = fs.readFileSync(path.join(net, ours.find((f) => f.startsWith('rommancer-casa-'))!), 'utf8');
  assert.match(casa, /^\[network\]\nssid=Casa\npass=[0-9a-f]{64}\ntype=dhcp\npriority=1\nautoconnect=1\n$/);
  assert.ok(casa.includes(`pass=${wpaPsk('Casa', 'casa;password$1')}`), 'the derived key, not the passphrase');
  assert.match(fs.readFileSync(muosRa, 'utf8'), /^cheevos_token = "RATOKEN123"$/m);
  assert.match(fs.readFileSync(path.join(sysroot, 'opt/muos/share/info/config/retroarch.cheevos.cfg'), 'utf8'), /^cheevos_username = "raplayer"$/m);

  // ROCKNIX: system.cfg on its storage, keyfiles that only root can read
  const sysCfg = path.join(dir, 'rocknix/.config/system/configs/system.cfg');
  fs.mkdirSync(path.dirname(sysCfg), { recursive: true });
  fs.writeFileSync(sysCfg, 'global.retroachievements=0\nglobal.retroachievements.username=\nglobal.retroachievements.password=\nwifi.enabled=1\n');
  const nm = path.join(sysroot, 'storage/.config/NetworkManager/system-connections');
  fs.mkdirSync(nm, { recursive: true });
  await pair('rocknix', 'rocknix', 'Anbernic RG353V');
  await run('rocknix', ['config']);
  const cfg = fs.readFileSync(sysCfg, 'utf8');
  assert.match(cfg, /^global\.retroachievements=1$/m);
  assert.match(cfg, /^global\.retroachievements\.username=raplayer$/m);
  assert.match(cfg, /^global\.retroachievements\.password=ra-secret-pass$/m);
  const keyfiles = fs.readdirSync(nm).sort();
  assert.equal(keyfiles.length, 3, keyfiles.join(','));
  const hidden = fs.readFileSync(path.join(nm, keyfiles.find((f) => f.startsWith('rommancer-oculta-'))!), 'utf8');
  assert.match(hidden, /\[wifi\]\nmode=infrastructure\nssid=Oculta\nhidden=true/);
  assert.match(hidden, /key-mgmt=wpa-psk\npsk=[0-9a-f]{64}/);
  assert.equal(fs.statSync(path.join(nm, keyfiles[0])).mode & 0o777, 0o600, 'NetworkManager ignores keyfiles others can read');

  // A network the user drops goes away from both, at the next application
  const nets = (await api('GET', '/settings/consoles')).json.wifi;
  await api('DELETE', `/settings/consoles/wifi/${nets.find((w: any) => w.ssid === 'Oculta').id}`);
  await run('rocknix', ['config']);
  await run('muos', ['config']);
  assert.equal(fs.readdirSync(nm).length, 2);
  assert.equal(fs.readdirSync(net).filter((f) => f.startsWith('rommancer-')).length, 2);
});

test('NextUI and ArkOS: minarch save and state names, a NextUI save reaching an ArkOS console, and their settings', async () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const claim = async (name: string, firmware: string, root: string) => {
    const r = await api('POST', '/link/claim', { name, firmware, root, offline: true });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const token = r.json.token as string;
    return (p: string, init: RequestInit = {}) =>
      fetch(`${base}/api/v1/agent${p}`, { ...init, headers: { 'X-Device-Token': token, 'Content-Type': 'application/octet-stream', ...(init.headers ?? {}) } });
  };
  const next = await claim('brick', 'nextui', '/mnt/SDCARD');
  const roots = await (await next('/roots')).text();
  assert.match(roots, /^saves\t\/mnt\/SDCARD\/Saves$/m);
  assert.match(roots, /^saves\t\/mnt\/SDCARD\/\.userdata\/shared$/m);
  const rom = '/mnt/SDCARD/Roms/Game Boy Advance (GBA)/Minarch Quest (USA).gba';
  const manifest = (await (await next('/manifest', { headers: { 'X-Rom-B64': b64(rom) } })).text()).trim().split('\n');
  assert.equal(manifest[0], '/mnt/SDCARD/Saves/GBA/Minarch Quest (USA).gba.sav', 'named after the whole rom file, in the tag folder');
  assert.ok(manifest.includes('/mnt/SDCARD/.userdata/shared/GBA-gpsp/Minarch Quest (USA).gba.st0'));
  assert.ok(manifest.includes('/mnt/SDCARD/.userdata/shared/GBA-gpsp/Minarch Quest (USA).gba.st9'), 'the auto-resume state');
  assert.ok(!manifest.some((p) => p.endsWith('.st8') || p.endsWith('.st')));
  const save = manifest[0];
  const state = '/mnt/SDCARD/.userdata/shared/GBA-gpsp/Minarch Quest (USA).gba.st0';
  const resume = '/mnt/SDCARD/.userdata/shared/GBA-gpsp/Minarch Quest (USA).gba.st9';
  const sav = Buffer.alloc(0x8000, 7);
  const plan = await (await next('/sync', { method: 'POST', body: `rom\t${rom}\t${'e'.repeat(40)}\nfile\t${save}\t${crypto.createHash('sha1').update(sav).digest('hex')}\nfile\t${state}\t${'f'.repeat(40)}\nfile\t${resume}\t${'a'.repeat(40)}\n` })).text();
  assert.match(plan, new RegExp(`^put\t${save.replace(/[().]/g, '\\$&')}\t`, 'm'));
  assert.match(plan, new RegExp(`^put\t${state.replace(/[().]/g, '\\$&')}\t`, 'm'));
  assert.ok(!plan.includes('.st9'), 'the auto-resume state stays on its console');
  assert.equal((await (await next('/upload', { method: 'POST', body: Buffer.from('resume'), headers: { 'X-Rom-B64': b64(rom), 'X-Path-B64': b64(resume) } })).text()).trim(), 'unchanged');
  const replies: string[] = [];
  for (const [p, body] of [[save, sav], [state, Buffer.from('state')]] as const) {
    const up = await next('/upload', { method: 'POST', body, headers: { 'X-Rom-B64': b64(rom), 'X-Path-B64': b64(p) } });
    replies.push(await up.text());
    assert.equal(replies.at(-1)!.split('\n')[0], 'uploaded', p);
  }
  assert.equal(replies[0], 'uploaded\n', 'a save has no screenshot');
  // minarch keeps each slot's screenshot (PNG data in a .bmp) under .minui/<tag>, named after the rom file
  assert.match(replies[1], /^tput\t\/mnt\/SDCARD\/\.userdata\/shared\/\.minui\/GBA\/Minarch Quest \(USA\)\.gba\.0\.bmp\t\d+$/m);
  const { prisma } = await import('../src/lib/prisma.js');
  const stored = await prisma.save.findMany({ where: { baseName: 'Minarch Quest (USA)' }, include: { emulator: true } });
  assert.deepEqual(stored.map((s) => `${s.emulator.slug} ${s.kind} ${s.slot}`).sort(), ['minui-gpsp SAVE 0', 'minui-gpsp STATE 0']);

  // ArkOS keeps RetroArch's .srm next to the rom: the NextUI save is offered there, the state is not (other emulator)
  const ark = await claim('rg353', 'arkos', '/roms');
  const arkRoots = await (await ark('/roots')).text();
  assert.match(arkRoots, /^roms\t\/roms$/m);
  const arkPlan = await (await ark('/sync', { method: 'POST', body: `rom\t/roms/gba/Minarch Quest (USA).gba\t${'e'.repeat(40)}\n` })).text();
  assert.match(arkPlan, /^get\t\/roms\/gba\/Minarch Quest \(USA\)\.srm\t\d+\t/m);
  assert.ok(!arkPlan.includes('.state'));

  const { adapterFor, wpaPsk } = await import('../src/modules/devconfig/adapters.js');
  // Knulli renamed batocera.conf to knulli.conf: the one present is the one written
  const kn = adapterFor('knulli')!.apply({ ra: { username: 'raplayer', password: 'pw', token: 'TOK' }, wifi: [], managed: [] }, new Map([['system/knulli.conf', 'global.retroachievements=0\n'], ['system/batocera.conf', null]]), () => true);
  assert.deepEqual([...kn.writes.keys()], ['system/knulli.conf']);
  assert.match(kn.writes.get('system/knulli.conf')!, /^global\.retroachievements=1$/m);
  const want = { ra: { username: 'raplayer', password: 'pw', token: 'TOK' }, wifi: [{ ssid: 'Casa', password: 'casa-pass', hidden: false }, { ssid: 'Oculta', password: 'x-pass', hidden: true }], managed: ['Casa', 'Oculta', 'Vieja'] };
  // NextUI on a TrimUI: minuisettings.txt on the card, wpa_supplicant.conf inside the system
  const nu = adapterFor('nextui')!;
  const wpa = 'ctrl_interface=/etc/wifi/sockets\nupdate_config=1\n\nnetwork={\n\tssid="Vecino"\n\tpsk="v"\n}\n';
  const files = new Map<string, string | null>([['.userdata/shared/minuisettings.txt', 'font=1\nraEnable=0\n'], ['.userdata/h700/wifi/wpa_supplicant.conf', null], ['/etc/wifi/wpa_supplicant/wpa_supplicant.conf', null], ['/etc/wifi/wpa_supplicant.conf', wpa]]);
  const out = nu.apply(want, files, () => true);
  assert.deepEqual(out.notes, []);
  const cfg = out.writes.get('.userdata/shared/minuisettings.txt')!;
  assert.match(cfg, /^font=1\nraEnable=1\n/);
  for (const line of ['raUsername=raplayer', 'raToken=TOK', 'raAuthenticated=1']) assert.ok(cfg.split('\n').includes(line), line);
  const conf = out.writes.get('/etc/wifi/wpa_supplicant.conf')!;
  assert.match(conf, /^ctrl_interface=\/etc\/wifi\/sockets/);
  assert.match(conf, /ssid="Oculta"\n\tpsk="x-pass"\n\tscan_ssid=1/);
  assert.ok(conf.includes('ssid="Vecino"'), 'networks made on the console stay');
  // From its card a TrimUI only gets RetroAchievements; without a token the user authenticates once
  const card = nu.apply({ ...want, ra: { ...want.ra, token: null } }, new Map([['.userdata/shared/minuisettings.txt', null], ['.userdata/h700/wifi/wpa_supplicant.conf', null]]), (f) => !f.startsWith('/'));
  assert.deepEqual(card.notes.sort(), ['raAuthenticate', 'wifiInternal']);
  assert.match(card.writes.get('.userdata/shared/minuisettings.txt')!, /^raEnable=1\nraUsername=raplayer\nraPassword=pw\n$/);

  // ArkOS: both RetroArch builds and NetworkManager; from the card, its one-network importer
  const ak = adapterFor('arkos')!;
  const ra64 = '/home/ark/.config/retroarch/retroarch.cfg';
  const ra32 = '/home/ark/.config/retroarch32/retroarch.cfg';
  const nm = '/etc/NetworkManager/system-connections/';
  const aout = ak.apply(want, new Map<string, string | null>([[ra64, 'cheevos_enable = "false"\ncheevos_token = ""\n'], [ra32, 'cheevos_enable = "false"\n'], [`${nm}rommancer-vieja-abc123.nmconnection`, 'x'], [`${nm}MiRed.nmconnection`, 'y']]), () => true);
  for (const f of [ra64, ra32]) assert.match(aout.writes.get(f)!, /^cheevos_enable = "true"$[\s\S]*^cheevos_token = "TOK"$/m);
  const keyfiles = [...aout.writes.keys()].filter((f) => f.startsWith(nm));
  assert.equal(keyfiles.length, 2);
  assert.ok(keyfiles.every((f) => aout.modes?.[f] === '600'));
  assert.ok(aout.writes.get(keyfiles.find((f) => f.includes('rommancer-casa-'))!)!.includes(`psk=${wpaPsk('Casa', 'casa-pass')}`));
  assert.deepEqual(aout.deletes, [`${nm}rommancer-vieja-abc123.nmconnection`]);
  const acard = ak.apply(want, new Map(), (f) => !f.startsWith('/'));
  assert.equal(acard.writes.get('tools/wifikeyfile.txt'), 'ssid="Casa"\npsk="casa-pass"\n');
  assert.deepEqual(acard.notes.sort(), ['raInternal', 'wifiOneAtBoot:Casa']);
});

test('sync client daemon: a full pass that hashed roms still applies the settings (its pass flag is not clobbered)', async () => {
  const dir = path.join(DATA, 'daemon-config');
  fs.rmSync(dir, { recursive: true, force: true });
  // A copy of the client: the daemon updates itself from the server and must not touch the repository
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const f of ['rommancer-sync.sh', 'cacert.pem']) fs.copyFileSync(path.join(ROOT, 'clients/linux', f), path.join(bin, f));
  const root = path.join(dir, 'storage');
  const cfg = path.join(root, '.config/system/configs/system.cfg');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, 'global.retroachievements=0\n');
  fs.mkdirSync(path.join(root, 'roms/gba'), { recursive: true });
  fs.writeFileSync(path.join(root, 'roms/gba/Hashed Game (USA).gba'), Buffer.alloc(4096, 3));
  const env = { ...process.env, ROMMANCER_STATE: path.join(dir, 'state'), ROMMANCER_ROOT: root, ROMMANCER_SYSROOT: path.join(dir, 'sys'), ROMMANCER_FIRMWARE: 'rocknix', ROMMANCER_NAME: 'daemon-rocknix', ROMMANCER_MODEL: 'Anbernic RG353V', ROMMANCER_WIFI_BANDS: '', ROMMANCER_WATCH_SECONDS: '1', TMPDIR: path.join(dir, 'tmp') };
  fs.mkdirSync(env.TMPDIR, { recursive: true });
  const client = path.join(bin, 'rommancer-sync.sh');
  const linking = execFileP('sh', [client, 'link', base], { env });
  const codeFile = path.join(dir, 'state', 'code.txt');
  for (let i = 0; i < 50 && !fs.existsSync(codeFile); i++) await new Promise((r) => setTimeout(r, 100));
  const code = fs.readFileSync(codeFile, 'utf8').split('\n')[0];
  const info = await api('GET', `/link/${code}`);
  await api('POST', `/link/${code}/approve`, { name: 'daemon-rocknix', consoleId: info.json.suggestedConsoleId, firmwareId: info.json.suggestedFirmwareId });
  await linking;
  const { spawn } = await import('node:child_process');
  const daemon = spawn('sh', [client, 'daemon'], { env, stdio: 'ignore', detached: true });
  try {
    let text = '';
    for (let i = 0; i < 60 && !/^global\.retroachievements=1$/m.test(text); i++) {
      await new Promise((r) => setTimeout(r, 500));
      text = fs.readFileSync(cfg, 'utf8');
    }
    assert.match(text, /^global\.retroachievements=1$/m, 'the first full pass applies the settings by itself');
  } finally {
    process.kill(-daemon.pid!, 'SIGTERM');
  }
});

test('lists hold roms: the Favorites list follows favourite roms; sublists ask what to do with games lacking the version', async () => {
  const { prisma } = await import('../src/lib/prisma.js');
  // Favorites: first in the index, cannot be deleted or renamed
  const lists = (await api('GET', '/lists?scope=mine')).json;
  const fav = lists[0];
  assert.equal(fav.kind, 'favorites');
  assert.equal((await api('DELETE', `/lists/${fav.id}`)).status, 400);
  assert.equal((await api('PATCH', `/lists/${fav.id}`, { name: 'Otra' })).status, 400);
  // Marking a rom adds it; adding a game to the list marks its best rom
  assert.equal((await api('PUT', `/roms/${ctx.smb3RomId}/favorite`)).status, 204);
  let items = (await api('GET', `/lists/${fav.id}`)).json.items;
  assert.deepEqual(items.map((i: any) => i.romId), [ctx.smb3RomId]);
  const games = (await api('GET', `/games?systemId=${ctx.nesSystemId}&status=owned&pageSize=20`)).json.items.filter((g: any) => g.id !== ctx.smb3GameId).slice(0, 4);
  assert.equal((await api('POST', `/lists/${fav.id}/items`, { items: games.map((g: any) => ({ gameId: g.id })) })).status, 201);
  items = (await api('GET', `/lists/${fav.id}`)).json.items;
  assert.ok(items.every((i: any) => i.kind === 'rom'), 'only roms in lists');
  assert.equal((await api('GET', '/games?favorites=1&pageSize=50')).json.total, items.length);
  // Removing it from the list unmarks it
  await api('DELETE', `/lists/${fav.id}/items/${items[items.length - 1].id}`);
  assert.equal((await api('GET', '/games?favorites=1&pageSize=50')).json.total, items.length - 1);

  // A sublist of European versions: games without one are listed with their versions
  const filters = { regions: ['Europe'], strictRegions: true };
  const preview = (await api('POST', `/lists/${fav.id}/derive/preview`, filters)).json;
  assert.equal(preview.matched.length + preview.missing.length, items.length - 1);
  assert.ok(preview.matched.some((m: any) => m.rom.id === ctx.smb3EuropeRomId), 'SMB3 has a European version');
  for (const m of preview.missing) assert.ok(m.versions.length > 0 && m.versions.every((v: any) => !v.regions.includes('Europe')));
  const perGame: Record<string, number | null> = {};
  if (preview.missing[0]) perGame[preview.missing[0].gameId] = preview.missing[0].versions.at(-1).id;
  if (preview.missing[1]) perGame[preview.missing[1].gameId] = null;
  const like = preview.missing[0]?.versions[0];
  const sub = await api('POST', `/lists/${fav.id}/derive`, { name: 'Favoritos EU', ...filters, perGame, rest: like ? { mode: 'like', romId: like.id } : { mode: 'skip' } });
  assert.equal(sub.status, 201, JSON.stringify(sub.json));
  const subItems = (await api('GET', `/lists/${sub.json.id}`)).json.items;
  const subRoms = subItems.map((i: any) => i.romId);
  assert.ok(subRoms.includes(ctx.smb3EuropeRomId));
  if (preview.missing[0]) assert.ok(subRoms.includes(perGame[preview.missing[0].gameId]), 'the chosen version');
  if (preview.missing[1]) assert.ok(sub.json.skipped.includes(preview.missing[1].title), 'left out as decided');
  // A refresh repeats the decisions
  const refreshed = await api('POST', `/lists/${sub.json.id}/refresh`);
  assert.equal(refreshed.json.added, subItems.length);
  // A new favourite reaches the sublist by itself
  const extra = (await api('GET', `/games?systemId=${ctx.nesSystemId}&status=owned&pageSize=40`)).json.items.find((g: any) => !games.some((x: any) => x.id === g.id) && g.id !== ctx.smb3GameId);
  const extraRom = (await api('GET', `/games/${extra.id}`)).json.roms[0];
  await api('PUT', `/roms/${extraRom.id}/favorite`);
  let grew = false;
  for (let i = 0; i < 20 && !grew; i++) {
    await new Promise((r) => setTimeout(r, 200));
    grew = (await api('GET', `/lists/${sub.json.id}`)).json.items.length > subItems.length || (await api('POST', `/lists/${fav.id}/derive/preview`, filters)).json.missing.some((m: any) => m.gameId === extra.id);
  }
  assert.ok(grew, 'the sublist followed the new favourite');

  // Lists saved with games before: each game becomes its best rom
  const old = await api('POST', '/lists', { name: 'Antigua' });
  await prisma.listItem.create({ data: { listId: old.json.id, gameId: ctx.smb3GameId, itemKey: `g${ctx.smb3GameId}` } });
  const { convertLegacyItems } = await import('../src/modules/lists/service.js');
  await convertLegacyItems();
  const conv = (await api('GET', `/lists/${old.json.id}`)).json.items;
  assert.equal(conv.length, 1);
  assert.equal(conv[0].kind, 'rom');
});

test('shared savestates: screenshots travel with the state, the core version is kept, other users copy them', async () => {
  const { prisma } = await import('../src/lib/prisma.js');
  const client = path.join(ROOT, 'clients/linux/rommancer-sync.sh');
  const dir = path.join(DATA, 'shared-states');
  fs.rmSync(dir, { recursive: true, force: true });
  const rom = 'Shared Quest (USA)';
  const device = async (name: string, version: string) => {
    const root = path.join(dir, name);
    const state = path.join(dir, `${name}-state`);
    fs.mkdirSync(path.join(root, 'Roms/GBA'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Roms/GBA', `${rom}.gba`), crypto.randomBytes(2048));
    // Onion's RetroArch names its info folder relative to itself
    fs.mkdirSync(path.join(root, 'RetroArch/.retroarch/info'), { recursive: true });
    fs.writeFileSync(path.join(root, 'RetroArch/.retroarch/retroarch.cfg'), 'libretro_info_path = ":/info"\n');
    fs.writeFileSync(path.join(root, 'RetroArch/.retroarch/info/mgba_libretro.info'), `corename = "mGBA"\ndisplay_version = "${version}"\n`);
    const r = await api('POST', '/link/claim', { name, firmware: 'onion', root });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'config'), `SERVER=${base}\nTOKEN=${r.json.token}\nUSER=admin\n`);
    const sync = async (env: Record<string, string> = {}) =>
      (await execFileP('sh', [client, 'sync'], { env: { ...process.env, ROMMANCER_STATE: state, ROMMANCER_ROOT: root, ROMMANCER_FIRMWARE: 'onion', VERBOSE: '1', ...env } })).stdout;
    return { id: r.json.deviceId as number, root, sync, states: path.join(root, 'Saves/CurrentProfile/states/mGBA') };
  };
  const a = await device('mini-a', '0.10.3');
  const b = await device('mini-b', '0.11.0');
  fs.mkdirSync(a.states, { recursive: true });
  const stateFile = path.join(a.states, `${rom}.state1`);
  fs.writeFileSync(stateFile, 'STATE-FROM-A');
  fs.writeFileSync(`${stateFile}.png`, PNG);

  // The state goes up with the screenshot RetroArch wrote beside it, dated with the core that made it
  assert.match(await a.sync(), /1 up, 0 down, 0 errors/);
  const devA = await prisma.device.findUniqueOrThrow({ where: { id: a.id } });
  // The card's RetroArch config comes first (this computer's own RetroArch may add other cores)
  assert.equal((devA.coreVersions as Record<string, string>).mGBA, '0.10.3');
  const mine = (await api('GET', '/saves?kind=STATE')).json.find((s: any) => s.baseName === rom);
  const cur = mine.versions.find((v: any) => v.id === mine.currentVersionId);
  assert.equal(cur.coreVersion, '0.10.3');
  assert.ok(cur.thumbPath, 'screenshot kept');
  const thumb = await fetch(`${base}/api/v1/saves/${mine.id}/versions/${cur.id}/thumb`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(thumb.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await thumb.arrayBuffer()), PNG);

  // Another console with the same core gets the state and its screenshot; its core is newer, which the web app warns about.
  // On Knulli EmulationStation says what arrived
  const notes: string[] = [];
  const es = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => (notes.push(`${req.method} ${req.url} ${body}`), res.end('ok')));
  });
  await new Promise<void>((r) => es.listen(0, '127.0.0.1', r));
  const esUrl = `http://127.0.0.1:${(es.address() as AddressInfo).port}/notify`;
  assert.match(await b.sync({ ROMMANCER_FIRMWARE: 'knulli', ROMMANCER_NO_NOTIFY: '', ROMMANCER_ES_NOTIFY: esUrl, LANG: 'C' }), /0 up, 1 down, 0 errors/);
  assert.deepEqual(notes, [`POST /notify Rommancer · Save received: ${rom}`]);
  assert.equal(fs.readFileSync(path.join(b.states, `${rom}.state1`), 'utf8'), 'STATE-FROM-A');
  assert.deepEqual(fs.readFileSync(path.join(b.states, `${rom}.state1.png`)), PNG);
  const warned = (await api('GET', `/saves/${mine.id}`)).json;
  // Where it is: both consoles hold the current version
  assert.deepEqual(
    warned.devices.filter((d: any) => d.deviceId === a.id || d.deviceId === b.id).map((d: any) => `${d.name} ${d.status}`),
    ['mini-a synced', 'mini-b synced'],
  );
  assert.deepEqual(warned.coreWarnings.filter((w: any) => w.deviceId === b.id || w.deviceId === a.id), [{ deviceId: b.id, name: 'mini-b', version: '0.11.0' }]);
  assert.match(await b.sync({ ROMMANCER_FIRMWARE: 'knulli', ROMMANCER_NO_NOTIFY: '', ROMMANCER_ES_NOTIFY: esUrl }), /0 up, 0 down, 0 errors/, 'nothing moves twice');
  assert.equal(notes.length, 1, 'nothing received, nothing said');
  es.close();

  // A state synced before screenshots were kept gets its screenshot at the next pass
  await prisma.saveVersion.update({ where: { id: cur.id }, data: { thumbPath: null } });
  await a.sync();
  assert.ok((await prisma.saveVersion.findUniqueOrThrow({ where: { id: cur.id } })).thumbPath);

  // Not an image: refused
  const tokenA = fs.readFileSync(path.join(dir, 'mini-a-state', 'config'), 'utf8').match(/TOKEN=(.*)/)![1];
  const notImage = await fetch(`${base}/api/v1/agent/thumb?v=${cur.id}`, { method: 'POST', body: 'hello', headers: { 'X-Device-Token': tokenA, 'Content-Type': 'application/octet-stream' } });
  assert.equal(notImage.status, 400);

  // Shared with every user: they see it in the game, with its screenshot, and copy it into a slot of theirs
  const shared = await api('PUT', `/saves/${mine.id}/versions/${cur.id}/share`, { note: 'before the boss' });
  assert.equal(shared.status, 200, JSON.stringify(shared.json));
  const seen = (await api('GET', `/saves/shared?q=${encodeURIComponent('Shared Quest')}`, undefined, userToken)).json;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].mine, false);
  assert.equal(seen[0].hasThumb, true);
  assert.equal(seen[0].shareNote, 'before the boss');
  assert.equal(seen[0].coreVersion, '0.10.3');
  assert.ok(!('path' in seen[0]) && !('thumbPath' in seen[0]), 'no server paths');
  const sharedThumb = await fetch(`${base}/api/v1/saves/shared/${cur.id}/thumb?token=${userFiles}`);
  assert.equal(sharedThumb.status, 200);
  const copy = await api('POST', `/saves/shared/${cur.id}/import`, { slot: 3 }, userToken);
  assert.equal(copy.status, 201, JSON.stringify(copy.json));
  const theirs = (await api('GET', '/saves?kind=STATE', undefined, userToken)).json.find((s: any) => s.id === copy.json.saveId);
  assert.equal(theirs.slot, 3);
  const theirVersion = theirs.versions[0];
  assert.match(theirVersion.note, /^shared by /);
  assert.equal(theirVersion.coreVersion, '0.10.3');
  assert.ok(theirVersion.thumbPath, 'the screenshot comes along');
  assert.equal((await api('GET', `/saves/${mine.id}`, undefined, userToken)).status, 403, 'the original stays private');

  // Unsharing hides it again
  assert.equal((await api('DELETE', `/saves/${mine.id}/versions/${cur.id}/share`)).status, 204);
  assert.equal((await api('GET', `/saves/shared?q=${encodeURIComponent('Shared Quest')}`, undefined, userToken)).json.length, 0);
  assert.equal((await fetch(`${base}/api/v1/saves/shared/${cur.id}/thumb?token=${userFiles}`)).status, 404);

  // A newer state on one console: the other gets it at its next sync; a NextUI console with the game cannot use it
  const brick = await api('POST', '/link/claim', { name: 'brick', firmware: 'nextui', root: '/mnt/SDCARD', offline: true });
  const inv = await fetch(`${base}/api/v1/agent/sync`, {
    method: 'POST',
    body: `rom\t/mnt/SDCARD/Roms/Game Boy Advance (GBA)/${rom}.gba\t\t\t2048\n`,
    headers: { 'X-Device-Token': brick.json.token, 'Content-Type': 'text/plain' },
  });
  assert.equal(inv.status, 200);
  fs.writeFileSync(stateFile, 'STATE-FROM-A-2');
  await a.sync();
  const later = (await api('GET', `/saves/${mine.id}`)).json.devices;
  assert.deepEqual(
    later.filter((d: any) => [a.id, b.id, brick.json.deviceId].includes(d.deviceId)).map((d: any) => `${d.name} ${d.status}`),
    ['brick incompatible', 'mini-a synced', 'mini-b pending'],
  );

  // RetroArch is told to write the screenshots where Rommancer edits its config
  const { adapterFor } = await import('../src/modules/devconfig/adapters.js');
  const out = adapterFor('onion')!.apply({ ra: null, wifi: [], managed: [], stateThumbs: true }, new Map([['RetroArch/.retroarch/retroarch.cfg', 'video_smooth = "false"\n']]), () => true);
  assert.match(out.writes.get('RetroArch/.retroarch/retroarch.cfg')!, /^savestate_thumbnail_enable = "true"$/m);
  assert.deepEqual(out.notes, []);
  assert.equal(adapterFor('knulli')!.stateThumbs, undefined, 'Batocera and Knulli turn it on themselves');
});

test('memory cards: PS1 saves sync entry by entry, several per game, only into a card no emulator holds', async () => {
  const { prisma } = await import('../src/lib/prisma.js');
  const { formatPs1Card, readMcs, readPs1Card, writePs1Card } = await import('../src/modules/saves/ps1card.js');
  const client = path.join(ROOT, 'clients/linux/rommancer-sync.sh');
  const dir = path.join(DATA, 'memcards');
  fs.rmSync(dir, { recursive: true, force: true });
  // Two games by serial: the card's own and another one whose save sits in that card too
  fs.writeFileSync(
    path.join(DATA, 'dats', 'psx-cards.dat'),
    `<?xml version="1.0"?><datafile><header><name>Sony - PlayStation</name><version>cards</version></header>
    <game name="Card Quest (USA)"><description>Card Quest (USA)</description><serial>SCUS-94163</serial>
    <rom name="Card Quest (USA).cue" size="80" crc="11111111" sha1="1111111111111111111111111111111111111111"/></game>
    <game name="Night Quest (USA)"><description>Night Quest (USA)</description><serial>SLUS-00067</serial>
    <rom name="Night Quest (USA).cue" size="80" crc="22222222" sha1="2222222222222222222222222222222222222222"/></game></datafile>`,
  );
  await waitJob((await api('POST', '/admin/dats/import-file', { file: 'psx-cards.dat' })).json.id);
  const games = await prisma.game.findMany({ where: { title: { in: ['Card Quest', 'Night Quest'] }, system: { slug: 'psx' } }, select: { id: true, title: true } });
  const gameId = (t: string) => games.find((g) => g.title === t)?.id;
  assert.ok(gameId('Card Quest') && gameId('Night Quest'), JSON.stringify(games));

  const entry = (name: string, seed: number, title: string) => {
    const buf = Buffer.alloc(128 + 0x2000, seed);
    buf.fill(0, 0, 128);
    buf.writeUInt32LE(0x51, 0);
    buf.writeUInt32LE(0x2000, 4);
    buf.writeUInt16LE(0xffff, 8);
    buf.write(name, 0x0a, 'latin1');
    buf.fill(0, 128, 128 + 0x44);
    buf.write('SC', 128, 'latin1');
    buf[131] = 1;
    buf.write(title, 132, 'latin1');
    return readMcs(buf);
  };
  const S01 = 'BASCUS-94163CQ-S01';
  const S02 = 'BASCUS-94163CQ-S02';
  const NQ = 'BASLUS-00067NQ';
  const HB = 'BASLUS-11111HB';
  // Each write a second apart, as an emulator saving: the client caches hashes by size and second
  let clock = Math.floor(Date.now() / 1000) + 10;
  const put = (f: string, buf: Buffer) => {
    fs.writeFileSync(f, buf);
    clock += 2;
    fs.utimesSync(f, clock, clock);
  };
  const names = (f: string) => readPs1Card(fs.readFileSync(f)).entries.map((e) => e.name).sort();
  const shaOf = (f: string, n: string) => readPs1Card(fs.readFileSync(f)).entries.find((e) => e.name === n)?.sha1;

  // "ps" is faked: an emulator runs while the file it names holds "retroarch"
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const psOut = path.join(dir, 'ps.txt');
  fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\ncat "${psOut}" 2>/dev/null\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(psOut, '');
  const device = async (name: string) => {
    const root = path.join(dir, name);
    const state = path.join(dir, `${name}-state`);
    fs.mkdirSync(path.join(root, 'roms/psx'), { recursive: true });
    fs.mkdirSync(path.join(root, 'saves/psx'), { recursive: true });
    fs.writeFileSync(path.join(root, 'roms/psx', 'Card Quest (USA).cue'), `FILE "${name}.bin" BINARY\n`);
    const r = await api('POST', '/link/claim', { name, firmware: 'knulli', root });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'config'), `SERVER=${base}\nTOKEN=${r.json.token}\nUSER=admin\n`);
    const sync = async () =>
      (
        await execFileP('sh', [client, 'sync'], {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ROMMANCER_STATE: state, ROMMANCER_ROOT: root, ROMMANCER_FIRMWARE: 'knulli', VERBOSE: '1' },
        })
      ).stdout;
    return { id: r.json.deviceId as number, root, sync, card: path.join(root, 'saves/psx', 'Card Quest (USA).srm'), shared: path.join(root, 'saves/psx', 'pcsx-card2.mcd') };
  };
  const a = await device('psx-a');
  const b = await device('psx-b');

  // Console A's card for the game holds two saves of it and one of another game
  put(a.card, writePs1Card(formatPs1Card(), [entry(S01, 1, 'CQ ONE'), entry(S02, 2, 'CQ TWO'), entry(NQ, 3, 'NIGHT')]).card);
  assert.match(await a.sync(), /1 up, 0 down, 0 errors/);
  const entries = (await api('GET', '/saves?kind=ENTRY')).json;
  const byName = (n: string) => entries.find((s: any) => s.baseName === n);
  assert.ok(byName(S01) && byName(S02) && byName(NQ), 'each save of the card is a save of its own');
  assert.equal(byName(S01).gameId, gameId('Card Quest'));
  assert.equal(byName(S02).gameId, gameId('Card Quest'));
  assert.equal(byName(NQ).gameId, gameId('Night Quest'), 'its own game, by the serial in its name');
  assert.equal(byName(S01).label, 'CQ ONE');

  // Console B has the game but no card: one is made with that game's saves only. Its shared card goes up and
  // gets the saves of games without a card of their own there
  put(b.shared, writePs1Card(formatPs1Card(), [entry(HB, 4, 'HOMEBREW')]).card);
  assert.match(await b.sync(), /1 up, 2 down, 0 errors/);
  assert.deepEqual(names(b.card), [S01, S02]);
  assert.deepEqual(names(b.shared), [NQ, HB]);
  // Synced as soon as the console says it swapped the card in
  const dcB = await prisma.deviceCard.findFirstOrThrow({ where: { deviceId: b.id, path: 'saves/psx/Card Quest (USA).srm' } });
  assert.equal(dcB.offerSha1, null, 'acknowledged by the client right after the swap');
  assert.equal(dcB.lastSha1, crypto.createHash('sha1').update(fs.readFileSync(b.card)).digest('hex'));
  assert.match(await b.sync(), /0 up, 0 down, 0 errors/);
  assert.match(await a.sync(), /0 up, 0 down, 0 errors/);

  // A saves again; B is playing: its card is not touched until the emulator is gone
  const s01v2 = entry(S01, 11, 'CQ ONE');
  put(a.card, writePs1Card(fs.readFileSync(a.card), [s01v2]).card);
  assert.match(await a.sync(), /1 up, 0 down, 0 errors/);
  const before = fs.readFileSync(b.card);
  fs.writeFileSync(psOut, '/usr/bin/retroarch -L pcsx_rearmed_libretro.so\n');
  assert.match(await b.sync(), /0 up, 0 down, 0 errors/);
  assert.ok(fs.readFileSync(b.card).equals(before));
  fs.writeFileSync(psOut, '');
  assert.match(await b.sync(), /0 up, 1 down, 0 errors/);
  assert.equal(shaOf(b.card, S01), s01v2.sha1);

  // The emulator had the old card in memory and wrote it back with its own new save in another slot: the old
  // S01 is not taken for a newer save (it is sent again), the new S02 goes up
  const s02b = entry(S02, 22, 'CQ TWO');
  put(b.card, writePs1Card(before, [s02b]).card);
  assert.match(await b.sync(), /1 up, 1 down, 0 errors/);
  assert.equal(shaOf(b.card, S01), s01v2.sha1);
  assert.equal(shaOf(b.card, S02), s02b.sha1);
  const s01 = (await api('GET', '/saves?kind=ENTRY')).json.find((s: any) => s.baseName === S01);
  assert.equal(s01.versions.find((v: any) => v.id === s01.currentVersionId).sha1, s01v2.sha1, "A's save stays the current one");
  assert.match(await a.sync(), /0 up, 1 down, 0 errors/);
  assert.equal(shaOf(a.card, S02), s02b.sha1);
  assert.deepEqual(names(a.card), [NQ, S01, S02].sort(), 'the other game stays in the card it was in');

  // A save taken out on a console stays out there
  put(b.card, writePs1Card(fs.readFileSync(b.card), [], [S02]).card);
  assert.match(await b.sync(), /1 up, 0 down, 0 errors/);
  assert.match(await b.sync(), /0 up, 0 down, 0 errors/);
  assert.deepEqual(names(b.card), [S01]);
  const conflicts = (await api('GET', '/saves/conflicts')).json.filter((c: any) => c.save.kind === 'ENTRY');
  assert.equal(conflicts.length, 0);

  // The web app lists the card files with their snapshots; a card uploaded by hand joins the user's card too
  const cards = (await api('GET', '/saves/cards')).json.filter((c: any) => [a.id, b.id].includes(c.device.id));
  assert.equal(cards.length, 3);
  assert.ok(cards.every((c: any) => c.snapshots.length > 0));
  const snap = cards[0].snapshots[0];
  const img = await fetch(`${base}/api/v1/saves/cards/${cards[0].id}/snapshots/${snap.id}`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(Buffer.from(await img.arrayBuffer()).length, 0x20000);
  const fd = new FormData();
  fd.append('file', new Blob([writePs1Card(formatPs1Card(), [entry('BASLUS-22222UP', 5, 'UPLOADED')]).card]), 'Some Disc (USA).srm');
  fd.append('emulatorId', String((await prisma.emulator.findUniqueOrThrow({ where: { slug: 'ra-pcsx-rearmed' } })).id));
  const up = await api('POST', '/saves/upload', fd);
  assert.equal(up.json.entries, 1);
  const all = (await api('GET', '/saves')).json;
  assert.ok(all.some((s: any) => s.baseName === 'BASLUS-22222UP' && s.kind === 'ENTRY'));
  assert.ok(!all.some((s: any) => s.id === up.json.saveId), 'the whole card is kept but not listed');

  // An SD card mounted on the server: its card is read and written by the server itself
  const sd = path.join(dir, 'sd');
  fs.mkdirSync(path.join(sd, 'roms/psx'), { recursive: true });
  fs.mkdirSync(path.join(sd, 'saves/psx'), { recursive: true });
  fs.writeFileSync(path.join(sd, 'roms/psx', 'Card Quest (USA).cue'), 'FILE "sd.bin" BINARY\n');
  const sdCard = path.join(sd, 'saves/psx', 'Card Quest (USA).srm');
  const s03 = entry('BASCUS-94163CQ-S03', 33, 'CQ THREE');
  fs.writeFileSync(sdCard, writePs1Card(formatPs1Card(), [s03]).card);
  const consoles = (await api('GET', '/devices/consoles')).json;
  const knulli = (await api('GET', '/devices/firmwares')).json.find((x: any) => x.slug === 'knulli');
  const local = await api('POST', '/devices', { name: 'PSX SD', consoleId: consoles[0].id, firmwareId: knulli.id, connType: 'LOCAL', rootPath: sd });
  assert.equal(local.status, 201, JSON.stringify(local.json));
  const job = await waitJob((await api('POST', `/saves/sync/${local.json.id}`, { direction: 'both' })).json.id);
  assert.equal(job.status, 'DONE', JSON.stringify(job));
  // S03 went up; S01 came in (S02 too: only console B took it out of its own card)
  assert.deepEqual(names(sdCard), [S01, S02, 'BASCUS-94163CQ-S03']);
  assert.equal(shaOf(sdCard, 'BASCUS-94163CQ-S03'), s03.sha1);
  const sdDc = await prisma.deviceCard.findFirstOrThrow({ where: { deviceId: local.json.id } });
  assert.equal(sdDc.offerSha1, null, 'written and read back by the server: synced at once');
  const again = await waitJob((await api('POST', `/saves/sync/${local.json.id}`, { direction: 'both' })).json.id);
  assert.equal(again.result.pushed, 0);
  assert.match(await a.sync(), /0 up, 1 down, 0 errors/);
  assert.deepEqual(names(a.card), [NQ, S01, S02, 'BASCUS-94163CQ-S03'].sort());
});

test('memory cards: GameCube saves sync one by one between Dolphin GCI folders and card images, by region', async () => {
  const { formatGcCard, readGcCard, readGci, writeGcCard } = await import('../src/modules/saves/gccard.js');
  const client = path.join(ROOT, 'clients/linux/rommancer-sync.sh');
  const dir = path.join(DATA, 'gccards');
  fs.rmSync(dir, { recursive: true, force: true });
  const BLOCK = 0x2000;
  const gci = (game: string, file: string, blocks: number, seed: number) => {
    const d = Buffer.alloc(0x40, 0xff);
    d.write(game, 0, 'latin1');
    d.write('01', 4, 'latin1');
    d[7] = 0;
    d.fill(0, 8, 0x28);
    d.write(file, 8, 'latin1');
    d.writeUInt32BE(1000 + seed, 0x28);
    d.writeUInt16BE(blocks, 0x38);
    d.writeUInt32BE(0, 0x3c);
    const data = Buffer.alloc(blocks * BLOCK, seed);
    data.fill(0, 0, 0x40);
    data.write(`Game ${game}`, 0, 'latin1');
    return Buffer.concat([d, data]);
  };
  let clock = Math.floor(Date.now() / 1000) + 10;
  const put = (f: string, buf: Buffer) => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, buf);
    clock += 2;
    fs.utimesSync(f, clock, clock);
  };
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const device = async (name: string) => {
    const root = path.join(dir, name);
    const state = path.join(dir, `${name}-state`);
    fs.mkdirSync(path.join(root, 'roms/gamecube'), { recursive: true });
    fs.mkdirSync(path.join(root, 'saves'), { recursive: true });
    const r = await api('POST', '/link/claim', { name, firmware: 'knulli', root });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'config'), `SERVER=${base}\nTOKEN=${r.json.token}\nUSER=admin\n`);
    const sync = async () =>
      (
        await execFileP('sh', [client, 'sync'], {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ROMMANCER_STATE: state, ROMMANCER_ROOT: root, ROMMANCER_FIRMWARE: 'knulli', VERBOSE: '1' },
        })
      ).stdout;
    const usa = path.join(root, 'saves/dolphin-emu/GC/USA/Card A');
    return { id: r.json.deviceId as number, root, sync, usa, raw: path.join(root, 'saves/dolphin-emu/GC/MemoryCardA.USA.raw') };
  };
  const names = (folder: string) => (fs.existsSync(folder) ? fs.readdirSync(folder).filter((f) => f.endsWith('.gci')).sort() : []);

  // Console A plays in GCI folder mode: two saves of one game, a ghost of another
  const a = await device('gc-a');
  put(path.join(a.usa, '01-GZLE-gczelda.gci'), gci('GZLE', 'gczelda', 2, 1));
  put(path.join(a.usa, '01-GZLE-gczelda2.gci'), gci('GZLE', 'gczelda2', 1, 2));
  put(path.join(a.usa, '8P-GFZE-f_zero.dat.gci'), gci('GFZE', 'f_zero.dat', 4, 3));
  assert.match(await a.sync(), /3 up, 0 down, 0 errors/);
  const entries = (await api('GET', '/saves?kind=ENTRY')).json.filter((s: any) => /^\w\w-G/.test(s.baseName));
  assert.deepEqual(entries.map((s: any) => s.baseName).sort(), ['01-GFZE-f_zero.dat', '01-GZLE-gczelda', '01-GZLE-gczelda2']);
  assert.match(await a.sync(), /0 up, 0 down, 0 errors/);

  // Console B, GCI folder too, with a save of its own: it goes up first; files for A's saves are made once the
  // server has read every file of the folder (a file not read yet may hold any of them)
  const b = await device('gc-b');
  put(path.join(b.usa, '01-GMSE-mario.gci'), gci('GMSE', 'mario', 3, 9));
  assert.match(await b.sync(), /1 up, 0 down, 0 errors/);
  assert.match(await b.sync(), /0 up, 3 down, 0 errors/);
  assert.deepEqual(names(b.usa), ['01-GFZE-f_zero.dat.gci', '01-GMSE-mario.gci', '01-GZLE-gczelda.gci', '01-GZLE-gczelda2.gci']);
  assert.equal(readGci(fs.readFileSync(path.join(b.usa, '01-GZLE-gczelda.gci'))).sha1, readGci(gci('GZLE', 'gczelda', 2, 1)).sha1);
  assert.match(await b.sync(), /0 up, 0 down, 0 errors/);
  assert.match(await a.sync(), /0 up, 1 down, 0 errors/);
  assert.deepEqual(names(a.usa), ['01-GMSE-mario.gci', '01-GZLE-gczelda.gci', '01-GZLE-gczelda2.gci', '8P-GFZE-f_zero.dat.gci'], 'files keep the name they had');

  // Console C keeps a card image (USA) holding a European save: it goes up, the American saves go in, and the
  // European one reaches no American folder
  const c = await device('gc-c');
  put(c.raw, writeGcCard(formatGcCard(4, 42n), [readGci(gci('GZLP', 'gczelda', 2, 7))]).card);
  assert.match(await c.sync(), /1 up, 1 down, 0 errors/);
  let img = readGcCard(fs.readFileSync(c.raw));
  assert.deepEqual(img.problems, []);
  assert.deepEqual(img.entries.map((e) => e.name).sort(), ['01-GFZE-f_zero.dat', '01-GMSE-mario', '01-GZLE-gczelda', '01-GZLE-gczelda2', '01-GZLP-gczelda']);
  assert.match(await c.sync(), /0 up, 0 down, 0 errors/);
  assert.match(await a.sync(), /0 up, 0 down, 0 errors/);

  // A deletes a save in Dolphin (it renames the file): it stays deleted there
  fs.renameSync(path.join(a.usa, '01-GZLE-gczelda2.gci'), path.join(a.usa, '01-GZLE-gczelda2.gci.deleted'));
  assert.match(await a.sync(), /0 up, 0 down, 0 errors/);
  assert.match(await a.sync(), /0 up, 0 down, 0 errors/);
  assert.ok(!names(a.usa).includes('01-GZLE-gczelda2.gci'));
  // until it changes elsewhere
  put(path.join(b.usa, '01-GZLE-gczelda2.gci'), gci('GZLE', 'gczelda2', 1, 22));
  assert.match(await b.sync(), /1 up, 0 down, 0 errors/);
  assert.match(await a.sync(), /0 up, 1 down, 0 errors/);
  assert.equal(readGci(fs.readFileSync(path.join(a.usa, '01-GZLE-gczelda2.gci'))).sha1, readGci(gci('GZLE', 'gczelda2', 1, 22)).sha1);

  // A save made on C into its image (PSO, signed with that card's serial) reaches A as a file, the same save
  put(c.raw, writeGcCard(fs.readFileSync(c.raw), [readGci(gci('GPOE', 'PSO_SYSTEM', 2, 5))]).card);
  assert.match(await c.sync(), /1 up, \d down, 0 errors/);
  assert.match(await a.sync(), /0 up, 1 down, 0 errors/);
  assert.equal(readGci(fs.readFileSync(path.join(a.usa, '01-GPOE-PSO_SYSTEM.gci'))).sha1, readGci(gci('GPOE', 'PSO_SYSTEM', 2, 5)).sha1);
  img = readGcCard(fs.readFileSync(c.raw));
  assert.equal(img.entries.find((e) => e.name === '01-GZLE-gczelda2')?.sha1, readGci(gci('GZLE', 'gczelda2', 1, 22)).sha1);

  // A folder found empty (a new card, a reinstall) gets every save back
  fs.rmSync(b.usa, { recursive: true });
  fs.mkdirSync(b.usa, { recursive: true });
  assert.match(await b.sync(), /0 up, 5 down, 0 errors/);
  assert.equal(names(b.usa).length, 5);
  const conflicts = (await api('GET', '/saves/conflicts')).json.filter((x: any) => x.save.kind === 'ENTRY');
  assert.equal(conflicts.length, 0);
});

test('header probes: roms read by their product code, inside a CHD too; hacks linked to their game', async () => {
  const { prisma } = await import('../src/lib/prisma.js');
  const client = path.join(ROOT, 'clients/linux/rommancer-sync.sh');
  const dir = path.join(DATA, 'sync-probe');
  fs.rmSync(dir, { recursive: true, force: true });
  // Two games of the database with codes of our own: one a file names loosely, one a hack is made from
  const gbaId = (await prisma.system.findUniqueOrThrow({ where: { slug: 'gba' } })).id;
  const source = await prisma.datSource.findFirstOrThrow();
  const picks = [];
  for (const title of ['Guru Logichamp', 'Pokemon - FireRed Version']) {
    const g = await prisma.game.create({ data: { systemId: gbaId, title, titleNormalized: title.toLowerCase() } });
    picks.push(await prisma.rom.create({ data: { gameId: g.id, datSourceId: source.id, name: `${title} (USA)`, regions: ['USA'], languages: [], flags: [] }, select: { id: true, name: true, gameId: true } }));
  }
  await prisma.rom.updateMany({ where: { serial: { in: ['XAGJ', 'XBPE'] } }, data: { serial: null } });
  await prisma.rom.update({ where: { id: picks[0].id }, data: { serial: 'XAGJ' } });
  await prisma.rom.update({ where: { id: picks[1].id }, data: { serial: 'XBPE' } });
  const loose = picks[0].name.replace(/ \(USA\).*/, '').replace(/(\w)(\w)\b/, '$2$1') + ' (Japan).gba';
  const root = path.join(dir, 'console');
  fs.mkdirSync(path.join(root, 'roms/gba'), { recursive: true });
  const gba = (code: string) => {
    const b = crypto.randomBytes(1 << 20);
    b.write(code, 0xac, 'latin1');
    b[0xb2] = 0x96;
    return b;
  };
  fs.writeFileSync(path.join(root, 'roms/gba', loose), gba('XAGJ'));
  fs.writeFileSync(path.join(root, 'roms/gba', 'Pokemon Radical Red.gba'), gba('XBPE'));
  fs.writeFileSync(path.join(root, 'roms/gba', 'Unknown Thing.gba'), gba('ZZZZ'));
  // A folder named as another firmware names it, and one of no system (a port)
  fs.mkdirSync(path.join(root, 'roms/genesis'), { recursive: true });
  fs.writeFileSync(path.join(root, 'roms/genesis', 'Odd Cart.md'), crypto.randomBytes(4096));
  fs.mkdirSync(path.join(root, 'roms/ports'), { recursive: true });
  fs.writeFileSync(path.join(root, 'roms/ports', 'Some Port.sh'), 'echo port');
  const chd = path.join(DATA, 'ps1/psx/Test Game (USA).chd');
  const disc = fs.existsSync(chd);
  if (disc) {
    fs.mkdirSync(path.join(root, 'roms/psx'), { recursive: true });
    fs.copyFileSync(chd, path.join(root, 'roms/psx', 'Mystery Disc.chd'));
    const psx = (await prisma.system.findUniqueOrThrow({ where: { slug: 'psx' } })).id;
    const g = await prisma.game.create({ data: { systemId: psx, title: 'Probe Disc', titleNormalized: 'probe disc' } });
    await prisma.rom.create({ data: { gameId: g.id, datSourceId: source.id, name: 'Probe Disc (USA)', serial: 'SLUS-99999', regions: ['USA'], languages: [], flags: [] } });
  }
  const claim = await api('POST', '/link/claim', { name: 'probe-console', firmware: 'knulli', root });
  const id = claim.json.deviceId as number;
  const state = path.join(dir, 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'config'), `SERVER=${base}\nTOKEN=${claim.json.token}\n`);
  const run = (...args: string[]) => execFileP('sh', [client, ...args], { env: { ...process.env, ROMMANCER_STATE: state } });

  await run('sync');
  const item = async (name: string) => (await api('GET', `/devices/${id}/inventory`)).json.items.find((i: any) => i.name === name);
  const guru = await item(loose);
  assert.equal(guru.gameId, picks[0].gameId, `its own code, whatever its name says (${loose})`);
  assert.equal(guru.serial, 'XAGJ');
  const hack = await item('Pokemon Radical Red.gba');
  assert.equal(hack.gameId, null, 'a hack is not the game');
  assert.equal(hack.baseGameId, picks[1].gameId);
  assert.equal((await item('Unknown Thing.gba')).gameId, null);
  if (disc) assert.equal((await item('Mystery Disc.chd')).gameId, (await prisma.rom.findFirstOrThrow({ where: { name: 'Probe Disc (USA)' } })).gameId, 'read inside the CHD');

  // Read once: the next sync asks for nothing and keeps what the headers said
  const probes = await prisma.deviceProbe.count({ where: { deviceId: id } });
  assert.equal(probes, disc ? 5 : 4);
  const r = await fetch(`${base}/api/v1/agent/sync`, { method: 'POST', headers: { 'X-Device-Token': claim.json.token, 'X-Probe': '1', 'Content-Type': 'text/plain' }, body: fs.readFileSync(path.join(os.tmpdir(), `rommancer-${process.getuid!()}`, 'request')) });
  const plan = await r.text();
  assert.doesNotMatch(plan, /^probe\t/m);
  assert.match(plan, /^backups\t20$/m);
  assert.equal((await item(loose)).gameId, picks[0].gameId);
  assert.equal((await item('Pokemon Radical Red.gba')).baseGameId, picks[1].gameId);
  // The copy window counts hacks apart: neither new games nor unidentified
  const summary = (await api('GET', `/devices/${id}/inventory`)).json.summary;
  assert.equal(summary.hacks, 1);
  assert.equal((await item('Odd Cart.md')).system, 'md');
  assert.equal(summary.unidentified, 2, 'the file with an unknown code and the odd cart, not the port');
  assert.equal((await api('POST', `/devices/${id}/pull`, { systems: [], unidentifiedSystems: [], hackSystems: ['gba'] })).json.queued, 1);
});

test('lists: whole systems at once, in the regions asked for', async () => {
  const { prisma } = await import('../src/lib/prisma.js');
  const nes = (await prisma.system.findUniqueOrThrow({ where: { slug: 'nes' } })).id;
  const list = (await api('POST', '/lists', { name: 'Every NES' })).json;
  const preview = async (body: object) => (await api('POST', `/lists/${list.id}/items/bulk/preview`, { systemIds: [nes], ...body })).json;
  const best = await preview({});
  assert.ok(best.roms > 0, JSON.stringify(best));
  assert.equal(best.roms, best.games, 'one version per game');
  const all = await preview({ mode: 'all' });
  assert.ok(all.roms >= best.roms);
  const europe = await preview({ regions: ['Europe'] });
  assert.ok(europe.games <= best.games);
  // Only European (or World) versions go in
  const added = (await api('POST', `/lists/${list.id}/items/bulk`, { systemIds: [nes], regions: ['Europe'] })).json.added;
  assert.equal(added, europe.roms);
  const items = await prisma.listItem.findMany({ where: { listId: list.id }, include: { rom: { select: { regions: true } } } });
  assert.ok(items.every((i) => (i.rom!.regions as string[]).some((r) => r === 'Europe' || r === 'World')));
  assert.equal((await api('POST', `/lists/${list.id}/items/bulk`, { systemIds: [nes], regions: ['Europe'] })).json.added, 0, 'nothing twice');
});

test('device prune: roms in no list leave the console once the server has them; the console has the last word', async () => {
  const { prisma } = await import('../src/lib/prisma.js');
  const client = path.join(ROOT, 'clients/linux/rommancer-sync.sh');
  const dir = path.join(DATA, 'sync-prune');
  fs.rmSync(dir, { recursive: true, force: true });
  const root = path.join(dir, 'console');
  const nesDir = path.join(root, 'roms/nes');
  fs.mkdirSync(nesDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'roms/ports'), { recursive: true });
  const smb3 = `${SMB3}.nes`;
  const other = 'Arkanoid (USA).nes';
  const homebrew = 'Prune Homebrew (World).nes';
  const track = `${SMB3} (Track 2).bin`;
  fs.copyFileSync(path.join(ROMS, 'nes', smb3), path.join(nesDir, smb3));
  fs.copyFileSync(path.join(ROMS, 'nes', other), path.join(nesDir, other));
  fs.writeFileSync(path.join(nesDir, homebrew), Buffer.concat([Buffer.from('NES\x1a'), crypto.randomBytes(20 * 1024)]));
  fs.writeFileSync(path.join(nesDir, track), crypto.randomBytes(4096));
  fs.writeFileSync(path.join(root, 'roms/ports', 'Some Port.zip'), crypto.randomBytes(2048));
  const claim = await api('POST', '/link/claim', { name: 'prune-console', firmware: 'knulli', root });
  const id = claim.json.deviceId as number;
  const state = path.join(dir, 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'config'), `SERVER=${base}\nTOKEN=${claim.json.token}\n`);
  const run = (...args: string[]) => execFileP('sh', [client, ...args], { env: { ...process.env, ROMMANCER_STATE: state } });
  const there = (n: string) => fs.existsSync(path.join(nesDir, n));
  const prune = async () => (await api('GET', `/devices/${id}/prune`)).json;

  // Off by default; the web app tells what turning it on would delete (the homebrew, uploaded first)
  await run('sync');
  assert.equal((await api('POST', `/devices/${id}/send`, { gameIds: [ctx.smb3GameId] })).status, 201);
  let st = await prune();
  assert.equal(st.on, false);
  assert.deepEqual([st.plan.del, st.plan.upload, st.plan.stuck], [1, 1, 0], JSON.stringify(st.plan));
  assert.ok(st.plan.sample.includes(other) && st.plan.sample.includes(homebrew) && !st.plan.sample.includes(track), 'a track of a kept game stays');
  assert.match((await run('prune')).stdout, /^on\t0\n(.|\n)*intro\t0/);

  // Turned on from the web: the console asks its user, and deletes nothing meanwhile
  await api('PUT', `/devices/${id}/prune`, { on: true });
  assert.equal((await prune()).remote, true);
  await run('sync');
  assert.match((await run('prune')).stdout, /ask\t2\t\d+/);
  await run('prune', 'run');
  assert.ok(there(other), 'nothing deleted before the answer');
  // The user keeps it: the server hears the answer; the owned rom goes, the homebrew is fetched first
  await run('prune', 'set', '1');
  st = await prune();
  assert.deepEqual([st.on, st.remote], [true, false]);
  assert.match((await run('prune', 'run')).stdout, /deleted: 1 roms/);
  assert.ok(!there(other) && there(smb3) && there(track) && there(homebrew));
  assert.ok(fs.existsSync(path.join(root, 'roms/ports', 'Some Port.zip')), 'files of no system are never touched');
  assert.match((await run('pulls')).stdout, /sent to server: 1 of 1/);
  await run('sync');
  assert.match((await run('prune', 'run')).stdout, /deleted: 1 roms/);
  assert.ok(!there(homebrew), 'deleted once on the server');
  assert.match((await run('prune')).stdout, /cleanable\t2/);
  // The clean-up names the saves of the deleted roms (not of a rom whose name another one still has)
  const token = claim.json.token as string;
  const saves = await fetch(`${base}/api/v1/agent/prune/saves`, { method: 'POST', headers: { 'X-Device-Token': token, 'Content-Type': 'text/plain' }, body: `${path.join(nesDir, other)}\n${path.join(nesDir, smb3)}\n` }).then((r) => r.text());
  assert.ok(saves.includes(`saves/nes/Arkanoid (USA).srm`), saves);
  assert.ok(!saves.includes(SMB3), 'SMB3 is still there');

  // A list emptied by mistake: deleting more than half of the console's roms waits for a confirmation
  await prisma.deviceList.deleteMany({ where: { deviceId: id } });
  const smbPath = path.join(nesDir, smb3);
  const sha = crypto.createHash('sha1').update(fs.readFileSync(smbPath)).digest('hex');
  const fake = Array.from({ length: 12 }, (_, i) => `rom\t${nesDir}/Copy ${i}.nes\t${sha}\t\t1`).join('\n');
  await fetch(`${base}/api/v1/agent/sync`, { method: 'POST', headers: { 'X-Device-Token': token, 'Content-Type': 'text/plain', 'X-Prune': '1' }, body: fake + '\n' });
  const agent = (p: string) => fetch(`${base}/api/v1/agent${p}`, { headers: { 'X-Device-Token': token } }).then((r) => r.text());
  assert.equal((await agent('/prune')).trim(), 'hold\t12\t12');
  assert.equal((await prune()).held, 12);
  assert.equal((await api('POST', `/devices/${id}/prune/confirm`)).status, 200);
  assert.equal((await agent('/prune')).trim().split('\n').filter((l) => l.startsWith('del\t')).length, 12, 'confirmed: it goes ahead');

  // Turned off from the web: the console applies it at its next sync and tells the server back
  await api('PUT', `/devices/${id}/prune`, { on: false });
  await run('sync');
  assert.match((await run('prune')).stdout, /^on\t0/);
  await run('sync');
  st = await prune();
  assert.deepEqual([st.on, st.remote], [false, false]);
  // Another account on this console: the setting starts off and is offered again
  await run('prune', 'set', '1');
  await run('unlink');
  assert.match(fs.readFileSync(path.join(state, 'settings'), 'utf8'), /PRUNE_ROMS=0/);
});

test('two versions of one game on a console keep a save each (one sync never writes one over the other)', async () => {
  const { prisma } = await import('../src/lib/prisma.js');
  const client = path.join(ROOT, 'clients/linux/rommancer-sync.sh');
  const dir = path.join(DATA, 'sync-two-versions');
  fs.rmSync(dir, { recursive: true, force: true });
  const root = path.join(dir, 'console');
  fs.mkdirSync(path.join(root, 'roms/nes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'saves/nes'), { recursive: true });
  const usa = SMB3;
  const europe = 'Super Mario Bros. 3 (Europe) (Two Versions)';
  fs.copyFileSync(path.join(ROMS, 'nes', `${usa}.nes`), path.join(root, 'roms/nes', `${usa}.nes`));
  fs.copyFileSync(path.join(ROMS, 'nes', `${usa}.nes`), path.join(root, 'roms/nes', `${europe}.nes`));
  const usaSave = crypto.randomBytes(8192);
  const euSave = crypto.randomBytes(8192);
  fs.writeFileSync(path.join(root, 'saves/nes', `${usa}.srm`), usaSave);
  fs.writeFileSync(path.join(root, 'saves/nes', `${europe}.srm`), euSave);
  const claim = await api('POST', '/link/claim', { name: 'two-versions', firmware: 'knulli', root });
  const state = path.join(dir, 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'config'), `SERVER=${base}\nTOKEN=${claim.json.token}\n`);
  const run = (...args: string[]) => execFileP('sh', [client, ...args], { env: { ...process.env, ROMMANCER_STATE: state } });
  await run('sync');
  await run('sync');
  assert.match((await run('sync')).stdout, /sync: 0 up, 0 down/, 'settled');
  assert.deepEqual(fs.readFileSync(path.join(root, 'saves/nes', `${usa}.srm`)), usaSave);
  assert.deepEqual(fs.readFileSync(path.join(root, 'saves/nes', `${europe}.srm`)), euSave, 'each file keeps its own save');
  const saves = await prisma.save.findMany({ where: { baseName: { in: [usa, europe] }, kind: 'SAVE' }, include: { versions: true } });
  const sha = (b: Buffer) => crypto.createHash('sha1').update(b).digest('hex');
  assert.ok(saves.find((s) => s.baseName === europe)?.versions.some((v) => v.sha1 === sha(euSave)), 'the European version has a save of its own');
});

test('sync client: one rom download at a time, and it can be stopped', async () => {
  const client = path.join(ROOT, 'clients/linux/rommancer-sync.sh');
  const dir = path.join(DATA, 'sync-roms-stop');
  fs.rmSync(dir, { recursive: true, force: true });
  const root = path.join(dir, 'console');
  fs.mkdirSync(path.join(root, 'roms/nes'), { recursive: true });
  const claim = await api('POST', '/link/claim', { name: 'roms-stop', firmware: 'knulli', root });
  const id = claim.json.deviceId as number;
  const state = path.join(dir, 'state');
  const work = path.join(dir, 'work');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'config'), `SERVER=${base}\nTOKEN=${claim.json.token}\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, ROMMANCER_STATE: state, TMPDIR: work };
  fs.mkdirSync(work, { recursive: true });
  const run = (...args: string[]) => execFileP('sh', [client, ...args], { env });
  await run('sync');
  assert.equal((await api('POST', `/devices/${id}/send`, { gameIds: [ctx.smb3GameId] })).status, 201);
  assert.match((await run('roms-stop')).stdout, /nothing to stop/);
  assert.ok(fs.existsSync(path.join(state, 'roms-stopped')), 'background passes leave the roms alone');
  // Another download under way (a live process holds the lock): one asked on screen waits for it
  const lockDir = fs.readdirSync(work).map((d) => path.join(work, d)).find((d) => fs.statSync(d).isDirectory())!;
  const holder = spawn('sleep', ['3']);
  fs.mkdirSync(path.join(lockDir, 'roms-lock'));
  fs.writeFileSync(path.join(lockDir, 'roms-lock/pid'), `${holder.pid}\n`);
  assert.equal((await run('roms-status')).stdout, '\t\t\n', 'the menus see it running');
  const t0 = Date.now();
  assert.match((await run('roms')).stdout, /roms: 1 downloaded/);
  assert.ok(Date.now() - t0 >= 2000, 'it waited for the running one');
  assert.ok(!fs.existsSync(path.join(state, 'roms-stopped')), 'asked on screen: no longer stopped');
  // A download cut halfway goes on where it stopped: the bytes already here are kept (a marked byte proves it)
  const rom = fs.readdirSync(path.join(root, 'roms/nes')).map((f) => path.join(root, 'roms/nes', f))[0];
  const whole = fs.readFileSync(rom);
  const half = Buffer.from(whole.subarray(0, Math.floor(whole.length / 2)));
  half[0] ^= 0xff;
  fs.rmSync(rom);
  fs.writeFileSync(`${rom}.part`, half);
  // The firmware's game lists are read again once roms came: EmulationStation is told to reload
  const reloads: string[] = [];
  const es = http.createServer((q, r) => { reloads.push(q.url ?? ''); r.end('ok'); });
  await new Promise<void>((resolve) => es.listen(0, '127.0.0.1', resolve));
  env.ROMMANCER_ES_API = `http://127.0.0.1:${(es.address() as { port: number }).port}`;
  await run('sync');
  Object.assign(env, { ROMMANCER_FIRMWARE: 'knulli', ROMMANCER_SYSROOT: dir });
  try {
    assert.match((await run('roms')).stdout, /roms: 1 downloaded/);
  } finally {
    delete env.ROMMANCER_FIRMWARE;
    es.close();
  }
  assert.deepEqual(reloads, ['/reloadgames']);
  assert.ok(!fs.existsSync(path.join(state, 'lists-changed')));
  // Onion (its menu not running): the system's list caches go, at the next game end too
  const gb = path.join(root, 'Roms/GB');
  fs.mkdirSync(gb, { recursive: true });
  for (const c of ['GB_cache6.db', 'GB_cache2.db']) fs.writeFileSync(path.join(gb, c), 'cache');
  fs.writeFileSync(path.join(state, 'lists-changed'), `${gb}/Tetris (World).gb\n`);
  Object.assign(env, { ROMMANCER_FIRMWARE: 'onion', ROMMANCER_ROOT: root });
  try {
    await run('game-stop');
  } finally {
    delete env.ROMMANCER_FIRMWARE;
    delete env.ROMMANCER_ROOT;
  }
  assert.deepEqual(fs.readdirSync(gb), [], 'Onion list caches cleared');
  assert.ok(!fs.existsSync(path.join(state, 'lists-changed')));
  const resumed = fs.readFileSync(rom);
  assert.equal(resumed.length, whole.length);
  assert.equal(resumed[0], half[0], 'resumed, not started again');
  assert.ok(resumed.subarray(1).equals(whole.subarray(1)));
  // Stopping a running download: it ends at the next file
  const holder2 = spawn('sleep', ['2']);
  fs.mkdirSync(path.join(lockDir, 'roms-lock'));
  fs.writeFileSync(path.join(lockDir, 'roms-lock/pid'), `${holder2.pid}\n`);
  assert.match((await run('roms-stop')).stdout, /roms: stopped/);
  assert.equal((await run('roms-status')).stdout, '');
});

test('sync state: the console says when it cannot reach the server and why, Onion is asked to set its clock, the web app shows where the sync stands', async () => {
  const client = path.join(ROOT, 'clients/linux/rommancer-sync.sh');
  const dir = path.join(DATA, 'sync-state');
  fs.rmSync(dir, { recursive: true, force: true });
  const root = path.join(dir, 'console');
  fs.mkdirSync(path.join(root, 'roms/nes'), { recursive: true });
  const claim = await api('POST', '/link/claim', { name: 'sync-state', firmware: 'knulli', root });
  const id = claim.json.deviceId as number;
  const token = claim.json.token as string;
  const state = path.join(dir, 'state');
  const work = path.join(dir, 'work');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  // A server that cannot be reached: the failure is said in words, with its details for the "details" button
  fs.writeFileSync(path.join(state, 'config'), `SERVER=http://127.0.0.1:9\nTOKEN=${token}\n`);
  const env = { ...process.env, ROMMANCER_STATE: state, TMPDIR: work };
  const run = (...args: string[]) => execFileP('sh', [client, ...args], { env });
  const failed = await run('sync').then((r) => r.stdout, (e) => (e as { stdout: string }).stdout);
  assert.match(failed, /Cannot reach 127\.0\.0\.1:9|No llega a 127\.0\.0\.1:9|No network/);
  const details = (await run('fail-details')).stdout;
  assert.match(details, /Server: http:\/\/127\.0\.0\.1:9/);
  assert.match(details, /Error: curl 7/);
  assert.match(details, /Clock \(UTC\): \d{4}-/);

  // The web app: no contact yet, the last failure the console reported once it is back
  let st = (await api('GET', `/devices/${id}/sync-state`)).json;
  assert.equal(st.agent, true);
  assert.equal(st.quiet, true);
  assert.equal(st.conflicts, 0);
  const agentPost = (url: string, body: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/v1/agent${url}`, { method: 'POST', headers: { 'X-Device-Token': token, 'Content-Type': 'text/plain', ...headers }, body });
  await agentPost('/log', '2026-10-12 10:00:00 sync: 0 up, 0 down, 0 errors\n2026-10-12 10:05:00 failed: Cannot reach x: check the WiFi network\n');
  st = (await api('GET', `/devices/${id}/sync-state`)).json;
  assert.equal(st.lastError, 'Cannot reach x: check the WiFi network');
  assert.equal(st.quiet, false, 'it was seen just now');
  await agentPost('/log', '2026-10-12 10:05:00 failed: Cannot reach x: check the WiFi network\n2026-10-12 10:06:00 sync: 0 up, 0 down, 0 errors\n');
  assert.equal((await api('GET', `/devices/${id}/sync-state`)).json.lastError, null, 'a sync went through since');

  // Onion's clock from the internet: reported by the console, turned on from the web app at its next sync
  const sync = async (clock: string) => (await (await agentPost('/sync', '', { 'X-Clock-Sync': clock })).text());
  assert.doesNotMatch(await sync('0'), /clocksync/);
  let cfg = (await api('GET', `/devices/${id}/config`)).json;
  assert.equal(cfg.clockSync, false);
  assert.equal((await api('PATCH', `/devices/${id}/config`, { clockSyncWant: true })).status, 204);
  assert.match(await sync('0'), /^clocksync\t1$/m);
  assert.doesNotMatch(await sync('1'), /clocksync/);
  cfg = (await api('GET', `/devices/${id}/config`)).json;
  assert.equal(cfg.clockSync, true);
  assert.equal(cfg.clockSyncWant, false);
  // Saves waiting for a choice reach the consoles through their poll
  const poll = await (await fetch(`${base}/api/v1/agent/poll`, { headers: { 'X-Device-Token': token } })).text();
  assert.doesNotMatch(poll, /conflicts/);
});
