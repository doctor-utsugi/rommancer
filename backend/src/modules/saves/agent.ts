/**
 * API para los scripts de eventos de los dispositivos (ES-DE game-start/game-end, Batocera/Knulli).
 * El script no conoce formatos: pide la lista de rutas de saves de una rom, envia los ficheros y
 * descarga lo que le indique el servidor, ya convertido para su emulador.
 */
import path from 'node:path';
import express, { Router, type Request } from 'express';
import type { Device, Emulator, Firmware } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { sha256 } from '../../lib/crypto.js';
import { HttpError, badRequest } from '../../lib/http.js';
import { layoutOf, type DeviceLayout } from '../devices/sink.js';
import { contentFor, decide, deviceFileName, findLogicalSave, receiveFromDevice, saveDirs, setBase, sha1 } from './core.js';
import { identifyRom, parseSaveFile } from './service.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { extractEntryStream } from '../../lib/tools.js';
import { resolveListFiles } from '../lists/service.js';
import { resolveConflict } from './core.js';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { normalizeTitle, parseRomName } from '../../lib/romname.js';
import { ingestUnverified, ingestVerified } from '../uploads/ingest.js';

export const agentRouter = Router();

type AgentDevice = Device & { firmware: Firmware };

const b64 = (v: string | undefined) => (v ? Buffer.from(v, 'base64').toString('utf8') : '');

async function deviceFromToken(req: Request): Promise<AgentDevice> {
  const token = req.header('x-device-token');
  if (!token) throw new HttpError(401, 'Missing device token');
  const device = await prisma.device.findUnique({ where: { tokenHash: sha256(token) }, include: { firmware: true } });
  if (!device) throw new HttpError(401, 'Invalid device token');
  // SD cards synced from a computer are mounted wherever the computer puts them: the client says where
  const root = b64(req.header('x-device-root-b64'));
  const moved = root.startsWith('/') && root.length <= 512 && root.replace(/\/+$/, '') !== device.rootPath.replace(/\/+$/, '');
  await prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date(), ...(moved ? { rootPath: root } : {}) } });
  return moved ? { ...device, rootPath: root } : device;
}

/** Sistema y emulador de una rom del dispositivo a partir de su carpeta. */
async function romContext(device: AgentDevice, romPath: string) {
  const layout = layoutOf(device);
  const root = device.rootPath.replace(/\/+$/, '');
  const rel = romPath.startsWith(root + '/') ? romPath.slice(root.length + 1) : romPath;
  const romsRoot = layout.romsRoot.replace(/\/+$/, '');
  const afterRoms = rel.startsWith(romsRoot + '/') ? rel.slice(romsRoot.length + 1) : rel;
  const folder = afterRoms.split('/')[0];
  let slug = Object.entries(layout.systemMap).find(([, v]) => v.folder === folder)?.[0] ?? null;
  const baseName = path.posix.basename(romPath).replace(/\.[^.]+$/, '');
  if (!slug) {
    const ident = await identifyRom(baseName);
    if (ident) slug = (await prisma.system.findUnique({ where: { id: ident.systemId } }))?.slug ?? null;
  }
  if (!slug || !layout.systemMap[slug]) throw badRequest(`Unknown system for ${romPath}`);
  const emu = await prisma.emulator.findUniqueOrThrow({ where: { slug: layout.systemMap[slug].emulator } });
  return { layout, slug, emu, baseName, root };
}

type RomCtx = Awaited<ReturnType<typeof romContext>>;

function candidatePaths(ctx: RomCtx, emu: Emulator = ctx.emu) {
  ctx = { ...ctx, emu };
  const dirs = saveDirs(ctx.layout, ctx.slug, ctx.emu);
  const abs = (p: string) => path.posix.join(ctx.root, p);
  const files: { kind: 'SAVE' | 'STATE'; slot: number; path: string }[] = [{ kind: 'SAVE', slot: 0, path: abs(path.posix.join(dirs.saves, deviceFileName(ctx.baseName, ctx.emu, 'SAVE', 0))) }];
  if (ctx.emu.stateExt) for (const slot of [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) files.push({ kind: 'STATE', slot, path: abs(path.posix.join(dirs.states, deviceFileName(ctx.baseName, ctx.emu, 'STATE', slot))) });
  return files;
}

const SHA1 = /^[0-9a-f]{40}$/;

/** Game of a rom by its content (full or headerless sha1), whatever the file is called. */
async function gameByHash(hashes: string[], systemId: number | undefined): Promise<{ gameId: number; romId: number | null } | null> {
  const list = hashes.filter((h) => SHA1.test(h));
  if (!list.length) return null;
  const part = await prisma.romPart.findFirst({
    where: { OR: [{ sha1: { in: list } }, { headerlessSha1: { in: list } }], ...(systemId ? { rom: { game: { systemId } } } : {}) },
    select: { rom: { select: { id: true, gameId: true } } },
  });
  if (part) return { gameId: part.rom.gameId, romId: part.rom.id };
  const hack = await prisma.romHack.findFirst({ where: { OR: [{ sha1: { in: list } }, { headerlessSha1: { in: list } }] }, select: { gameId: true } });
  return hack ? { gameId: hack.gameId, romId: null } : null;
}

/**
 * RetroArch names each per-core save folder after the core and always uses .srm/.state, so a folder
 * for a core we do not list yet (Mesen, Gearsystem, Beetle PSX...) becomes an emulator on first sight.
 */
async function registerUnknownCores(layout: DeviceLayout, root: string, files: Iterable<string>) {
  if (!coreLayout(layout)) return;
  const known = new Set((await prisma.emulator.findMany({ where: { core: { not: null } }, select: { core: true } })).map((e) => e.core));
  const systemFolders = new Map(Object.entries(layout.systemMap).map(([slug, v]) => [v.folder, slug]));
  const base = path.posix.join(root, layout.savesLayout === 'rom-core' ? layout.romsRoot : layout.savesRoot);
  const found = new Map<string, string | undefined>();
  for (const f of files) {
    if (!f.startsWith(base + '/')) continue;
    const parts = f.slice(base.length + 1).split('/');
    // rom-core: <system>/<core>/<file>; core: <core>/<file>
    const [system, core] = layout.savesLayout === 'rom-core' ? [parts[0], parts[1]] : [undefined, parts[0]];
    if (parts.length !== (layout.savesLayout === 'rom-core' ? 3 : 2) || !core || core.startsWith('.') || known.has(core) || systemFolders.has(core)) continue;
    found.set(core, system ? systemFolders.get(system) : undefined);
  }
  for (const [core, systemSlug] of found) {
    const ps1 = systemSlug === 'psx' || /psx|pcsx|swanstation|duckstation/i.test(core);
    const slug = 'ra-' + core.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    await prisma.emulator.upsert({ where: { slug }, create: { slug, name: `RetroArch ${core}`, core, saveFormat: ps1 ? 'ps1card' : 'raw', saveExt: '.srm', stateExt: '.state' }, update: {} });
  }
}

/** Keeps the device's rom list (only names and hashes) and identifies each game by its content. */
async function storeInventory(device: AgentDevice, roms: { path: string; hashes: string[] }[], allowPull: string | undefined) {
  const layout = layoutOf(device);
  const base = path.posix.join(device.rootPath.replace(/\/+$/, ''), layout.romsRoot) + '/';
  const byFolder = new Map(Object.entries(layout.systemMap).map(([slug, v]) => [v.folder, slug]));
  const hashes = [...new Set(roms.flatMap((r) => r.hashes).filter((h) => SHA1.test(h)))];
  const known = new Map<string, { romId: number; gameId: number }>();
  for (let i = 0; i < hashes.length; i += 500) {
    const chunk = hashes.slice(i, i + 500);
    const parts = await prisma.romPart.findMany({ where: { OR: [{ sha1: { in: chunk } }, { headerlessSha1: { in: chunk } }] }, select: { sha1: true, headerlessSha1: true, rom: { select: { id: true, gameId: true } } } });
    for (const p of parts) for (const h of [p.sha1, p.headerlessSha1]) if (h) known.set(h, { romId: p.rom.id, gameId: p.rom.gameId });
  }
  const rows = roms.map((r) => {
    const folder = r.path.startsWith(base) ? r.path.slice(base.length).split('/')[0] : '';
    const hit = r.hashes.map((h) => known.get(h)).find(Boolean);
    return {
      deviceId: device.id,
      pathHash: crypto.createHash('sha1').update(r.path).digest('hex'),
      path: r.path.slice(0, 1024),
      systemSlug: byFolder.get(folder) ?? null,
      sha1: SHA1.test(r.hashes[0] ?? '') ? r.hashes[0] : null,
      headerlessSha1: SHA1.test(r.hashes[1] ?? '') ? r.hashes[1] : null,
      romId: hit?.romId ?? null,
      gameId: hit?.gameId ?? null,
    };
  });
  await prisma.$transaction([
    prisma.deviceRom.deleteMany({ where: { deviceId: device.id } }),
    prisma.deviceRom.createMany({ data: rows, skipDuplicates: true }),
    prisma.device.update({ where: { id: device.id }, data: { inventoryAt: new Date(), ...(allowPull === '0' || allowPull === '1' ? { allowPull: allowPull === '1' } : {}) } }),
  ]);
}

const coreLayout = (layout: { savesLayout: string }) => layout.savesLayout === 'core' || layout.savesLayout === 'rom-core';

/** In per-core layouts the save's folder names the core, which may differ from the firmware default. */
async function emulatorForPath(ctx: RomCtx, filePath: string): Promise<Emulator> {
  if (!coreLayout(ctx.layout)) return ctx.emu;
  const core = path.posix.basename(path.posix.dirname(filePath));
  if (core === ctx.emu.core) return ctx.emu;
  return (await prisma.emulator.findFirst({ where: { core } })) ?? ctx.emu;
}

/**
 * Whole-device sync for the standalone clients. Body lines: "rom<TAB>path" for every rom on the
 * device and "file<TAB>path<TAB>sha1" for every save file found. Reply: "get<TAB>save<TAB>version<TAB>rom"
 * and "put<TAB>save<TAB>rom"; the client then uses /file and /upload with that rom.
 */
agentRouter.post('/sync', express.text({ limit: '16mb', type: '*/*' }), async (req, res) => {
  const device = await deviceFromToken(req);
  // "rom<TAB>path[<TAB>sha1[<TAB>headerless sha1]]": the hashes identify roms with non-DAT names
  const roms: { path: string; hashes: string[] }[] = [];
  const present = new Map<string, string>();
  for (const line of String(req.body ?? '').split('\n')) {
    const [kind, p, h, h2] = line.replace(/\r$/, '').split('\t');
    if (kind === 'rom' && p) roms.push({ path: p, hashes: [h ?? '', h2 ?? ''].filter(Boolean) });
    else if (kind === 'file' && p && SHA1.test(h ?? '')) present.set(p, h);
  }
  await storeInventory(device, roms, req.header('x-allow-pull'));
  const userSaves = await prisma.save.findMany({ where: { userId: device.userId }, select: { baseName: true, gameId: true } });
  const savedNames = new Set(userSaves.map((s) => s.baseName));
  const savedGames = new Set(userSaves.map((s) => s.gameId).filter((g): g is number => g !== null));
  const systemIds = new Map<string, number | undefined>();
  await registerUnknownCores(layoutOf(device), device.rootPath.replace(/\/+$/, ''), present.keys());
  const coreEmus = (await prisma.emulator.findMany({ where: { core: { not: null } } })) as Emulator[];
  const out: string[] = [];
  for (const { path: rom, hashes } of roms) {
    const ctx = await romContext(device, rom).catch(() => null);
    if (!ctx) continue;
    // Emulators whose save folder already holds files for this rom; the firmware default otherwise
    let emus: Emulator[] = [ctx.emu];
    if (coreLayout(ctx.layout)) {
      const found = coreEmus.filter((e) => candidatePaths(ctx, e).some((f) => present.has(f.path)));
      if (found.length) emus = found;
    }
    const candidates = emus.flatMap((e) => candidatePaths(ctx, e).map((f) => ({ ...f, emu: e })));
    const hasLocal = candidates.some((f) => present.has(f.path));
    if (!systemIds.has(ctx.slug)) systemIds.set(ctx.slug, (await prisma.system.findUnique({ where: { slug: ctx.slug } }))?.id);
    const systemId = systemIds.get(ctx.slug);
    // Cheap exact lookups (name, then content hash); the scanned-file fallback of identifyRom is too slow for thousands of roms
    const needGame = hasLocal || savedGames.size > 0;
    const known = needGame
      ? ((await prisma.rom.findFirst({ where: { name: ctx.baseName, game: { systemId } }, select: { gameId: true } })) ?? (await gameByHash(hashes, systemId)))
      : null;
    if (!hasLocal && !savedNames.has(ctx.baseName) && !(known && savedGames.has(known.gameId))) continue;
    const gameId = known?.gameId ?? (hasLocal ? ((await identifyRom(ctx.baseName, systemId))?.gameId ?? null) : null);
    // Saves uploaded before the rom could be identified get their game now
    if (gameId && hasLocal) await prisma.save.updateMany({ where: { userId: device.userId, baseName: ctx.baseName, gameId: null }, data: { gameId } });
    // Several cores with their own file for this game on this device: each keeps its own save
    const exactOnly = emus.length > 1;
    for (const f of candidates) {
      const save = await findLogicalSave(device.userId, f.emu, f.kind, f.slot, ctx.baseName, gameId, exactOnly);
      const deviceSha1 = present.get(f.path);
      const d = await decide(save, device, f.emu, deviceSha1 ? { sha1: deviceSha1 } : null);
      if (d.action === 'download') out.push(`get\t${f.path}\t${d.versionId}\t${rom}`);
      else if (d.action === 'upload' || d.action === 'conflict') out.push(`put\t${f.path}\t${rom}${exactOnly ? '\t1' : ''}`);
      else if (d.action === 'adopt' && save) await setBase(save.id, device.id, save.currentVersionId, deviceSha1!);
    }
  }
  await prisma.device.update({ where: { id: device.id }, data: { lastSyncAt: new Date() } });
  res.type('text/plain').send(out.join('\n') + (out.length ? '\n' : ''));
});

// Last lines of the client's log, kept for troubleshooting from the web app
agentRouter.post('/log', express.text({ limit: '64kb', type: '*/*' }), async (req, res) => {
  const device = await deviceFromToken(req);
  const text = String(req.body ?? '').slice(-16_000);
  await prisma.device.update({ where: { id: device.id }, data: { lastLog: text, clientVersion: (req.header('x-client-version') ?? '').slice(0, 32) || null } });
  res.status(204).end();
});

// ---------- roms from the lists assigned to the device ----------

/** Opaque, signed reference to a server file, so a device can only fetch what its plan offered. */
function fileRef(deviceId: number, absPath: string, entry: string | null) {
  const body = Buffer.from(JSON.stringify({ d: deviceId, p: absPath, e: entry })).toString('base64url');
  const sig = crypto.createHmac('sha256', env.jwtSecret).update(body).digest('base64url').slice(0, 32);
  return `${body}.${sig}`;
}

function readRef(ref: string, deviceId: number): { p: string; e: string | null } {
  const [body, sig] = ref.split('.');
  const expected = crypto.createHmac('sha256', env.jwtSecret).update(body ?? '').digest('base64url').slice(0, 32);
  if (!body || !sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw new HttpError(403, 'Bad file reference');
  const v = JSON.parse(Buffer.from(body, 'base64url').toString()) as { d: number; p: string; e: string | null };
  if (v.d !== deviceId) throw new HttpError(403, 'Bad file reference');
  return v;
}

/**
 * Roms the device should have: "rom<TAB>destination<TAB>size<TAB>ref" per file (size 0 = unknown,
 * for files inside archives). The client downloads the ones it lacks with GET /agent/rom?f=ref.
 */
agentRouter.get('/roms', async (req, res) => {
  const device = await deviceFromToken(req);
  const layout = layoutOf(device);
  const root = device.rootPath.replace(/\/+$/, '');
  const lists = await prisma.deviceList.findMany({ where: { deviceId: device.id }, select: { listId: true } });
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { listId } of lists) {
    const { items } = await resolveListFiles(listId);
    for (const it of items) {
      const folder = layout.systemMap[it.systemSlug]?.folder;
      if (!folder) continue; // a system this firmware does not have
      for (const f of it.files) {
        const dest = path.posix.join(root, layout.romsRoot, folder, f.destName);
        if (seen.has(dest)) continue;
        seen.add(dest);
        const size = f.archiveEntry ? 0 : ((await fs.promises.stat(f.absPath).catch(() => null))?.size ?? 0);
        out.push(`rom\t${dest}\t${size}\t${fileRef(device.id, f.absPath, f.archiveEntry)}`);
      }
    }
  }
  res.type('text/plain').send(out.join('\n') + (out.length ? '\n' : ''));
});

agentRouter.get('/rom', async (req, res) => {
  const device = await deviceFromToken(req);
  const ref = readRef(String(req.query.f ?? ''), device.id);
  res.type('application/octet-stream');
  if (ref.e) extractEntryStream(ref.p, ref.e).on('error', () => res.destroy()).pipe(res);
  else res.sendFile(ref.p);
});

// ---------- conflicts this device is part of ----------

agentRouter.get('/conflicts', async (req, res) => {
  const device = await deviceFromToken(req);
  const rows = await prisma.saveConflict.findMany({ where: { deviceId: device.id, resolvedAt: null }, include: { save: true }, orderBy: { createdAt: 'desc' } });
  const versions = await prisma.saveVersion.findMany({
    where: { id: { in: rows.flatMap((c) => [c.deviceVersionId, c.serverVersionId]) } },
    include: { sourceDevice: { select: { name: true } } },
  });
  const v = new Map(versions.map((x) => [x.id, x]));
  // conflict<TAB>id<TAB>game<TAB>kind<TAB>this device's version date<TAB>server version date<TAB>server version's device
  const lines = rows.map((c) =>
    ['conflict', c.id, c.save.baseName, c.save.kind, v.get(c.deviceVersionId)?.createdAt.toISOString() ?? '-', v.get(c.serverVersionId)?.createdAt.toISOString() ?? '-', v.get(c.serverVersionId)?.sourceDevice?.name ?? '-'].join('\t'),
  );
  res.type('text/plain').send(lines.join('\n') + (lines.length ? '\n' : ''));
});

agentRouter.post('/conflicts/:id', express.urlencoded({ extended: false }), async (req, res) => {
  const device = await deviceFromToken(req);
  const keep = String(req.body?.keep ?? req.query.keep ?? '');
  if (keep !== 'device' && keep !== 'server') throw badRequest('keep must be device or server');
  const c = await prisma.saveConflict.findUnique({ where: { id: Number(req.params.id) } });
  if (!c || c.deviceId !== device.id) throw new HttpError(404, 'Conflict not found');
  await resolveConflict(c.id, keep, device.userId);
  res.type('text/plain').send('resolved\n');
});

// ---------- requests from the web app ----------

// Polled every few seconds by the client: "sync" when asked to sync now, "pull" when roms are requested
agentRouter.get('/poll', async (req, res) => {
  const device = await deviceFromToken(req);
  const out: string[] = [];
  if (device.wantSyncAt) {
    out.push('sync');
    await prisma.device.update({ where: { id: device.id }, data: { wantSyncAt: null } });
  }
  if (await prisma.devicePull.count({ where: { deviceId: device.id, status: 'pending' } })) out.push('pull');
  res.type('text/plain').send(out.join('\n') + (out.length ? '\n' : ''));
});

agentRouter.get('/pulls', async (req, res) => {
  const device = await deviceFromToken(req);
  const rows = await prisma.devicePull.findMany({ where: { deviceId: device.id, status: 'pending' }, orderBy: { id: 'asc' }, take: 200 });
  res.type('text/plain').send(rows.map((r) => `pull\t${r.id}\t${r.path}`).join('\n') + (rows.length ? '\n' : ''));
});

/**
 * A requested rom sent by the device (body = the file). Stored like a verified upload; roms no
 * database knows come in as unverified, in the system of their folder, under a game with their title.
 */
agentRouter.post('/pull/:id', async (req, res) => {
  const device = await deviceFromToken(req);
  const pull = await prisma.devicePull.findUnique({ where: { id: Number(req.params.id) } });
  if (!pull || pull.deviceId !== device.id || pull.status !== 'pending') throw new HttpError(404, 'Pull not found');
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: device.userId }, select: { id: true, username: true } });
  const name = path.posix.basename(pull.path);
  // Container readers need the right extension on the temporary file
  const tmp = path.join(os.tmpdir(), `pull-${pull.id}-${Date.now()}${path.extname(name).toLowerCase()}`);
  await pipeline(req, fs.createWriteStream(tmp));
  let result: string;
  try {
    try {
      const r = await ingestVerified(tmp, name, owner);
      result = r.status === 'already-owned' ? 'already owned' : 'stored';
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 422) throw e;
      const inv = await prisma.deviceRom.findFirst({ where: { deviceId: device.id, path: pull.path } });
      const system = inv?.systemSlug ? await prisma.system.findUnique({ where: { slug: inv.systemSlug } }) : null;
      if (!system) throw badRequest('Unknown system for an unverified rom');
      const title = parseRomName(name.replace(/\.[^.]+$/, '')).title || name;
      const game = await prisma.game.findFirst({ where: { systemId: system.id, titleNormalized: normalizeTitle(title).slice(0, 255) } });
      await ingestUnverified(tmp, name, owner, { systemId: system.id, ...(game ? { gameId: game.id } : { newGameTitle: title }) });
      result = 'stored as unverified';
    }
    await prisma.devicePull.update({ where: { id: pull.id }, data: { status: 'done', result, doneAt: new Date() } });
  } catch (e) {
    result = e instanceof Error ? e.message : String(e);
    await prisma.devicePull.update({ where: { id: pull.id }, data: { status: 'failed', result: result.slice(0, 500), doneAt: new Date() } });
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
  res.type('text/plain').send(result + '\n');
});

// Folders the client must list: roms (to know what is installed) and save locations
agentRouter.get('/roots', async (req, res) => {
  const device = await deviceFromToken(req);
  const layout = layoutOf(device);
  const root = device.rootPath.replace(/\/+$/, '');
  const abs = (p: string) => path.posix.join(root, p);
  const lines = [`roms\t${abs(layout.romsRoot)}`, `saves\t${abs(layout.savesLayout.startsWith('rom') ? layout.romsRoot : layout.savesRoot)}`];
  if (!layout.savesLayout.startsWith('rom') && layout.statesRoot !== layout.savesRoot) lines.push(`saves\t${abs(layout.statesRoot)}`);
  const exts = new Set<string>();
  for (const v of Object.values(layout.systemMap)) {
    const emu = await prisma.emulator.findUnique({ where: { slug: v.emulator } });
    if (emu) [emu.saveExt, emu.stateExt].forEach((e) => e && exts.add(e.toLowerCase()));
  }
  lines.push(`exts\t${[...exts].join(' ')}`);
  res.type('text/plain').send(lines.join('\n') + '\n');
});

// Rutas de saves y savestates de una rom en este dispositivo (una por linea)
agentRouter.get('/manifest', async (req, res) => {
  const device = await deviceFromToken(req);
  const ctx = await romContext(device, b64(req.header('x-rom-b64')));
  res.type('text/plain').send(candidatePaths(ctx).map((f) => f.path).join('\n') + '\n');
});

/**
 * Inicio de juego. Cuerpo: lineas "ruta<TAB>sha1" de los ficheros que existen.
 * Respuesta: "get<TAB>ruta<TAB>version" para bajar o "put<TAB>ruta" para subir.
 */
agentRouter.post('/start', express.text({ limit: '1mb', type: '*/*' }), async (req, res) => {
  const device = await deviceFromToken(req);
  const ctx = await romContext(device, b64(req.header('x-rom-b64')));
  const present = new Map<string, string>();
  for (const line of String(req.body ?? '').split('\n')) {
    const [p, h] = line.trim().split('\t');
    if (p && /^[0-9a-f]{40}$/.test(h ?? '')) present.set(p, h);
  }
  const ident = await identifyRom(ctx.baseName, (await prisma.system.findUnique({ where: { slug: ctx.slug } }))?.id);
  const out: string[] = [];
  for (const f of candidatePaths(ctx)) {
    const save = await findLogicalSave(device.userId, ctx.emu, f.kind, f.slot, ctx.baseName, ident?.gameId ?? null);
    const deviceSha1 = present.get(f.path);
    const d = await decide(save, device, ctx.emu, deviceSha1 ? { sha1: deviceSha1 } : null);
    if (d.action === 'download') out.push(`get\t${f.path}\t${d.versionId}`);
    // En conflicto tambien se sube: el servidor guarda ambas versiones y avisa
    else if (d.action === 'upload' || d.action === 'conflict') out.push(`put\t${f.path}`);
    else if (d.action === 'adopt' && save) await setBase(save.id, device.id, save.currentVersionId, deviceSha1!);
  }
  res.type('text/plain').send(out.join('\n') + (out.length ? '\n' : ''));
});

// Descarga de una version convertida para el emulador del dispositivo; anota la base
agentRouter.get('/file', async (req, res) => {
  const device = await deviceFromToken(req);
  const ctx = await romContext(device, b64(req.header('x-rom-b64')));
  const target = b64(req.header('x-path-b64'));
  const versionId = Number(req.query.v);
  const v = await prisma.saveVersion.findUnique({ where: { id: versionId }, include: { save: { include: { emulator: true } } } });
  if (!v || v.save.userId !== device.userId) throw new HttpError(404, 'Version not found');
  const content = await contentFor(v.save, v.id, target ? await emulatorForPath(ctx, target) : ctx.emu);
  if (target) await setBase(v.saveId, device.id, v.id, sha1(content));
  res.type('application/octet-stream').send(content);
});

// Fin de juego: subida de un fichero de save o savestate tal cual esta en el dispositivo
agentRouter.post('/upload', express.raw({ limit: '128mb', type: '*/*' }), async (req, res) => {
  const device = await deviceFromToken(req);
  const ctx = await romContext(device, b64(req.header('x-rom-b64')));
  const filePath = b64(req.header('x-path-b64'));
  const emu = await emulatorForPath(ctx, filePath);
  const parsed = parseSaveFile(path.posix.basename(filePath), emu);
  if (!parsed) throw badRequest('Not a save file for this emulator');
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!buf.length) throw badRequest('Empty file');
  const systemId = (await prisma.system.findUnique({ where: { slug: ctx.slug } }))?.id;
  const byHash = await gameByHash((req.header('x-rom-sha1') ?? '').split(',').map((h) => h.trim()), systemId);
  const r = await receiveFromDevice(device, ctx.slug, emu, parsed.kind, parsed.slot, ctx.baseName, buf, byHash, req.header('x-save-exact') === '1');
  await prisma.device.update({ where: { id: device.id }, data: { lastSyncAt: new Date() } });
  res.type('text/plain').send(`${r.action}\n`);
});
