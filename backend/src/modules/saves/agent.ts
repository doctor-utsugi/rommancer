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
import { layoutOf } from '../devices/sink.js';
import { contentFor, decide, deviceFileName, findLogicalSave, receiveFromDevice, saveDirs, setBase, sha1 } from './core.js';
import { identifyRom, parseSaveFile } from './service.js';

export const agentRouter = Router();

type AgentDevice = Device & { firmware: Firmware };

async function deviceFromToken(req: Request): Promise<AgentDevice> {
  const token = req.header('x-device-token');
  if (!token) throw new HttpError(401, 'Missing device token');
  const device = await prisma.device.findUnique({ where: { tokenHash: sha256(token) }, include: { firmware: true } });
  if (!device) throw new HttpError(401, 'Invalid device token');
  await prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
  return device;
}

const b64 = (v: string | undefined) => (v ? Buffer.from(v, 'base64').toString('utf8') : '');

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
  const roms: string[] = [];
  const present = new Map<string, string>();
  for (const line of String(req.body ?? '').split('\n')) {
    const [kind, p, h] = line.replace(/\r$/, '').split('\t');
    if (kind === 'rom' && p) roms.push(p);
    else if (kind === 'file' && p && /^[0-9a-f]{40}$/.test(h ?? '')) present.set(p, h);
  }
  const userSaves = await prisma.save.findMany({ where: { userId: device.userId }, select: { baseName: true, gameId: true } });
  const savedNames = new Set(userSaves.map((s) => s.baseName));
  const savedGames = new Set(userSaves.map((s) => s.gameId).filter((g): g is number => g !== null));
  const systemIds = new Map<string, number | undefined>();
  const coreEmus = (await prisma.emulator.findMany({ where: { core: { not: null } } })) as Emulator[];
  const out: string[] = [];
  for (const rom of roms) {
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
    // Cheap exact lookup; the scanned-file fallback of identifyRom is too slow for thousands of roms
    const known = savedGames.size ? await prisma.rom.findFirst({ where: { name: ctx.baseName, game: { systemId: systemIds.get(ctx.slug) } }, select: { gameId: true } }) : null;
    if (!hasLocal && !savedNames.has(ctx.baseName) && !(known && savedGames.has(known.gameId))) continue;
    const gameId = known?.gameId ?? (hasLocal ? ((await identifyRom(ctx.baseName, systemIds.get(ctx.slug)))?.gameId ?? null) : null);
    for (const f of candidates) {
      const save = await findLogicalSave(device.userId, f.emu, f.kind, f.slot, ctx.baseName, gameId);
      const deviceSha1 = present.get(f.path);
      const d = await decide(save, device, f.emu, deviceSha1 ? { sha1: deviceSha1 } : null);
      if (d.action === 'download') out.push(`get\t${f.path}\t${d.versionId}\t${rom}`);
      else if (d.action === 'upload' || d.action === 'conflict') out.push(`put\t${f.path}\t${rom}`);
      else if (d.action === 'adopt' && save) await setBase(save.id, device.id, save.currentVersionId, deviceSha1!);
    }
  }
  await prisma.device.update({ where: { id: device.id }, data: { lastSyncAt: new Date() } });
  res.type('text/plain').send(out.join('\n') + (out.length ? '\n' : ''));
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
  const r = await receiveFromDevice(device, ctx.slug, emu, parsed.kind, parsed.slot, ctx.baseName, buf);
  await prisma.device.update({ where: { id: device.id }, data: { lastSyncAt: new Date() } });
  res.type('text/plain').send(`${r.action}\n`);
});
