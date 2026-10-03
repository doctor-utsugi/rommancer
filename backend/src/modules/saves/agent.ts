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

function candidatePaths(ctx: Awaited<ReturnType<typeof romContext>>) {
  const dirs = saveDirs(ctx.layout, ctx.slug, ctx.emu);
  const abs = (p: string) => path.posix.join(ctx.root, p);
  const files: { kind: 'SAVE' | 'STATE'; slot: number; path: string }[] = [{ kind: 'SAVE', slot: 0, path: abs(path.posix.join(dirs.saves, deviceFileName(ctx.baseName, ctx.emu, 'SAVE', 0))) }];
  if (ctx.emu.stateExt) for (const slot of [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) files.push({ kind: 'STATE', slot, path: abs(path.posix.join(dirs.states, deviceFileName(ctx.baseName, ctx.emu, 'STATE', slot))) });
  return files;
}

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
  const content = await contentFor(v.save, v.id, ctx.emu);
  if (target) await setBase(v.saveId, device.id, v.id, sha1(content));
  res.type('application/octet-stream').send(content);
});

// Fin de juego: subida de un fichero de save o savestate tal cual esta en el dispositivo
agentRouter.post('/upload', express.raw({ limit: '128mb', type: '*/*' }), async (req, res) => {
  const device = await deviceFromToken(req);
  const ctx = await romContext(device, b64(req.header('x-rom-b64')));
  const filePath = b64(req.header('x-path-b64'));
  const parsed = parseSaveFile(path.posix.basename(filePath), ctx.emu as Emulator);
  if (!parsed) throw badRequest('Not a save file for this emulator');
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!buf.length) throw badRequest('Empty file');
  const r = await receiveFromDevice(device, ctx.slug, ctx.emu, parsed.kind, parsed.slot, ctx.baseName, buf);
  await prisma.device.update({ where: { id: device.id }, data: { lastSyncAt: new Date() } });
  res.type('text/plain').send(`${r.action}\n`);
});
