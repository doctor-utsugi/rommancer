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
import { copiesSystem, folderFor, layoutOf, systemFilterOf, type DeviceLayout } from '../devices/sink.js';
import { raDefaults } from '../../seed/data.js';
import { contentFor, decide, deviceFileName, deviceThumbPath, findLogicalSave, receiveFromDevice, saveDirs, setBase, sha1 } from './core.js';
import { THUMB_MAX, identifyRom, parseSaveFile, readThumb, storeThumb } from './service.js';
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
import { serverKey } from '../devices/ssh.js';
import { devicePlan } from '../devices/plan.js';
import { Prisma } from '@prisma/client';
import { storeWifiBands } from '../devconfig/service.js';
import { cardAction, deviceCard, findDeviceCard, gameForSerial, hasWantedSaves, isCardEmulator, namedCard, observeCard, prepareCard, recordOffer } from './cards.js';

export const agentRouter = Router();

/** Requests still to be sent: "sending" ones whose transfer died with the server are sent again */
export const OPEN_PULL = ['pending', 'sending'];
/** Transfers in progress, for the progress shown in the web app (bytes received so far) */
export const pullTransfers = new Map<number, { received: number; size: number; startedAt: number }>();

/** homeRoot: the device's own root while a computer syncs its card under another one for this request */
type AgentDevice = Device & { firmware: Firmware; homeRoot?: string };

const ROOT = /^(\/|[A-Za-z]:\/)/;
const trimRoot = (r: string) => r.replace(/\/+$/, '');
/** A path under one root moved under another (same relative part) */
const reroot = (p: string, from: string, to: string) => (p.startsWith(trimRoot(from) + '/') ? trimRoot(to) + p.slice(trimRoot(from).length) : p);

const b64 = (v: string | undefined) => (v ? Buffer.from(v, 'base64').toString('utf8') : '');

export async function deviceFromToken(req: Request): Promise<AgentDevice> {
  const token = req.header('x-device-token');
  if (!token) throw new HttpError(401, 'Missing device token');
  // The console's own key, or the key of one of its SD cards synced from a computer
  const device =
    (await prisma.device.findUnique({ where: { tokenHash: sha256(token) }, include: { firmware: true } })) ??
    (await prisma.deviceToken.findUnique({ where: { tokenHash: sha256(token) }, include: { device: { include: { firmware: true } } } }))?.device;
  if (!device) throw new HttpError(401, 'Invalid device token');
  // SD cards synced from a computer are mounted wherever the computer puts them: the client says where.
  // A card that only lives in a computer moves its root for good; the card of a console that syncs by itself
  // is only seen under the computer's mount for this request (its own paths stay the console's).
  const root = b64(req.header('x-device-root-b64'));
  const temp = b64(req.header('x-device-root-temp-b64'));
  const moved = ROOT.test(root) && root.length <= 512 && trimRoot(root) !== trimRoot(device.rootPath);
  await prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date(), ...(moved ? { rootPath: root } : {}) } });
  if (ROOT.test(temp) && temp.length <= 512) return { ...device, rootPath: temp, homeRoot: device.rootPath };
  return moved ? { ...device, rootPath: root } : device;
}

/** Extensions that belong to one system only (".gb", ".sfc"...), to tell a rom's system without its folder */
let extSystems: { at: number; map: Map<string, string>; exts: Map<string, string[]> } | null = null;
async function systemsByExtension() {
  if (!extSystems || Date.now() - extSystems.at > 10 * 60_000) {
    const rows = await prisma.system.findMany({ select: { slug: true, extensions: true } });
    const owners = new Map<string, string[]>();
    const exts = new Map<string, string[]>();
    for (const r of rows) {
      const list = (Array.isArray(r.extensions) ? (r.extensions as string[]) : []).map((e) => e.toLowerCase());
      exts.set(r.slug, list);
      for (const e of list) owners.set(e, [...(owners.get(e) ?? []), r.slug]);
    }
    extSystems = { at: Date.now(), map: new Map([...owners].filter(([, s]) => s.length === 1).map(([e, s]) => [e, s[0]])), exts };
  }
  return extSystems;
}

/** A rom's system on a device: its folder, the card's only system when the extension fits, or the extension */
async function systemOf(layout: DeviceLayout, folder: string, romPath: string): Promise<string | null> {
  const byFolder = Object.entries(layout.systemMap).find(([, v]) => v.folder === folder && v.folder !== '')?.[0];
  if (byFolder) return byFolder;
  const ext = path.posix.extname(romPath).toLowerCase();
  const { map, exts } = await systemsByExtension();
  const only = Object.keys(layout.systemMap);
  if (only.length === 1 && (exts.get(only[0]) ?? []).includes(ext)) return only[0];
  return map.get(ext) ?? (only.length === 1 && !map.has(ext) && !ext ? only[0] : null);
}

/** Sistema y emulador de una rom del dispositivo a partir de su carpeta. */
async function romContext(device: AgentDevice, romPath: string) {
  const layout = layoutOf(device);
  const root = device.rootPath.replace(/\/+$/, '');
  const rel = romPath.startsWith(root + '/') ? romPath.slice(root.length + 1) : romPath;
  const romsRoot = layout.romsRoot.replace(/\/+$/, '');
  const afterRoms = rel.startsWith(romsRoot + '/') ? rel.slice(romsRoot.length + 1) : rel;
  const folder = afterRoms.split('/')[0];
  let slug = await systemOf(layout, folder, romPath);
  const baseName = path.posix.basename(romPath).replace(/\.[^.]+$/, '');
  if (!slug) {
    const ident = await identifyRom(baseName);
    if (ident) slug = (await prisma.system.findUnique({ where: { id: ident.systemId } }))?.slug ?? null;
  }
  if (!slug) throw badRequest(`Unknown system for ${romPath}`);
  // Systems the firmware does not list are played with RetroArch's usual core for them
  const emuSlug = layout.systemMap[slug]?.emulator ?? raDefaults[slug];
  if (!emuSlug) throw badRequest(`No emulator known for ${slug}`);
  const emu = await prisma.emulator.findUniqueOrThrow({ where: { slug: emuSlug } });
  return { layout, slug, emu, baseName, root, rel };
}

type RomCtx = Awaited<ReturnType<typeof romContext>>;

function candidatePaths(ctx: RomCtx, emu: Emulator = ctx.emu) {
  ctx = { ...ctx, emu };
  // "beside": flashcarts keep each save next to its rom, in whatever folder the rom is
  const dirs = ctx.layout.savesLayout === 'beside' ? { saves: path.posix.dirname(ctx.rel), states: path.posix.dirname(ctx.rel) } : saveDirs(ctx.layout, ctx.slug, ctx.emu);
  const abs = (p: string) => path.posix.join(ctx.root, p);
  const minui = ctx.layout.savesLayout === 'minui';
  const base = minui ? path.posix.basename(ctx.rel) : ctx.baseName;
  const files: { kind: 'SAVE' | 'STATE'; slot: number; path: string }[] = [{ kind: 'SAVE', slot: 0, path: abs(path.posix.join(dirs.saves, deviceFileName(base, ctx.emu, 'SAVE', 0))) }];
  const slots = minui ? [-1, 0, 1, 2, 3, 4, 5, 6, 7] : [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  if (ctx.emu.stateExt) for (const slot of slots) files.push({ kind: 'STATE', slot, path: abs(path.posix.join(dirs.states, deviceFileName(base, ctx.emu, 'STATE', slot, minui))) });
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

/**
 * "X-Ssh: user@host:port" when the console runs an SSH server and accepts the server's key ("0" when the
 * user turned that off); "X-Client-Path" is the script the server runs over SSH when the console is quiet.
 */
async function storeSshOffer(device: AgentDevice, req: Request) {
  const offer = req.header('x-ssh');
  const clientPath = b64(req.header('x-client-path-b64'));
  if (offer === undefined && !clientPath) return;
  const data: Prisma.DeviceUpdateInput = {};
  if (clientPath.startsWith('/') && clientPath.length <= 512) data.clientPath = clientPath;
  const m = offer?.match(/^([A-Za-z0-9._-]{1,64})@([A-Za-z0-9.:-]{1,255}):(\d{1,5})$/);
  // Addresses typed in the web app win: behind NAT or a VPN the console does not know how it is reached
  if (m && !device.sshManual) Object.assign(data, { sshUser: m[1], sshHost: m[2], sshPort: Number(m[3]) });
  else if (offer === '0' && !device.sshManual) Object.assign(data, { sshHost: null });
  if (Object.keys(data).length) await prisma.device.update({ where: { id: device.id }, data });
}

/** Keeps the device's rom list (only names and hashes) and identifies each game by its content. */
async function storeInventory(device: AgentDevice, scanned: { path: string; hashes: string[]; size?: number }[], allowPull: string | undefined) {
  // Kept under the device's own root, so requests made later reach the console with its paths
  const roms = device.homeRoot ? scanned.map((r) => ({ ...r, path: reroot(r.path, device.rootPath, device.homeRoot!) })) : scanned;
  device = device.homeRoot ? { ...device, rootPath: device.homeRoot } : device;
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
  const systemsOf = new Map<string, string | null>();
  for (const r of roms) {
    const folder = r.path.startsWith(base) ? r.path.slice(base.length).split('/')[0] : '';
    systemsOf.set(r.path, await systemOf(layout, folder, r.path));
  }
  const rows = roms.map((r) => {
    const folder = r.path.startsWith(base) ? r.path.slice(base.length).split('/')[0] : '';
    const hit = r.hashes.map((h) => known.get(h)).find(Boolean);
    return {
      deviceId: device.id,
      pathHash: crypto.createHash('sha1').update(r.path).digest('hex'),
      path: r.path.slice(0, 1024),
      systemSlug: systemsOf.get(r.path) ?? byFolder.get(folder) ?? null,
      sha1: SHA1.test(r.hashes[0] ?? '') ? r.hashes[0] : null,
      headerlessSha1: SHA1.test(r.hashes[1] ?? '') ? r.hashes[1] : null,
      romId: hit?.romId ?? null,
      gameId: hit?.gameId ?? null,
      size: BigInt(r.size ?? 0),
    };
  });
  await prisma.$transaction([
    prisma.deviceRom.deleteMany({ where: { deviceId: device.id } }),
    prisma.deviceRom.createMany({ data: rows, skipDuplicates: true }),
    prisma.device.update({ where: { id: device.id }, data: { inventoryAt: new Date(), ...(allowPull === '0' || allowPull === '1' ? { allowPull: allowPull === '1' } : {}) } }),
  ]);
}

/**
 * Savestate screenshots travel beside their state: "tget<TAB>path<TAB>version" sends the server's with a state it
 * sends, "tput<TAB>path<TAB>version" asks for the device's when the server has none for the state the device holds.
 */
async function thumbLine(statePath: string, emu: Emulator, savesLayout: string, versionId: number | null, deviceSha1: string | null) {
  const thumb = versionId ? deviceThumbPath(statePath, emu, savesLayout) : null;
  if (!thumb) return null;
  const v = await prisma.saveVersion.findUnique({ where: { id: versionId! }, select: { sha1: true, thumbPath: true } });
  if (!v) return null;
  if (deviceSha1 === null) return v.thumbPath ? `tget\t${thumb}\t${versionId}` : null;
  return !v.thumbPath && deviceSha1 === v.sha1 ? `tput\t${thumb}\t${versionId}` : null;
}

/** "core<TAB>name<TAB>version" lines: the RetroArch cores installed on the device, kept to date its savestates */
async function storeCoreVersions(device: AgentDevice, cores: Map<string, string>) {
  if (!cores.size) return;
  const data = Object.fromEntries([...cores].slice(0, 500).map(([k, v]) => [k.slice(0, 64), v.slice(0, 64)]));
  await prisma.device.update({ where: { id: device.id }, data: { coreVersions: data } });
}

const coreLayout = (layout: { savesLayout: string }) => layout.savesLayout === 'core' || layout.savesLayout === 'rom-core';

/** In per-core layouts the save's folder names the core, which may differ from the firmware default. */
async function emulatorForPath(ctx: RomCtx, filePath: string): Promise<Emulator> {
  if (!coreLayout(ctx.layout)) return ctx.emu;
  const core = path.posix.basename(path.posix.dirname(filePath));
  if (core === ctx.emu.core) return ctx.emu;
  return (await prisma.emulator.findFirst({ where: { core } })) ?? ctx.emu;
}

/** A path on the device relative to its root, as card files are kept */
const relToRoot = (device: AgentDevice, abs: string) => {
  const root = trimRoot(device.rootPath);
  return abs.startsWith(root + '/') ? abs.slice(root.length + 1) : abs;
};

/** Emulator of a card file found by its name (pcsx-card2.mcd), or any PS1 one */
async function namedCardEmulator(slug: string) {
  return (await prisma.emulator.findUnique({ where: { slug } })) ?? (await prisma.emulator.findFirstOrThrow({ where: { saveFormat: 'ps1card' }, orderBy: { id: 'asc' } }));
}

/**
 * The line for a memory card file: "put<TAB>path<TAB>rom" to read it, "cget<TAB>path<TAB>sha1|-<TAB>rom" when the
 * server has entries for it (the client swaps the file only while it is still that sha1 and no emulator runs).
 * Per-game cards the device lacks are made when the user has saves of that game.
 */
async function cardLine(device: AgentDevice, absPath: string, emu: Emulator, scope: { shared: boolean; gameId: number | null }, deviceSha1: string | null, rom: string, start = false) {
  const rel = relToRoot(device, absPath);
  if (!(await findDeviceCard(device.id, rel)) && !deviceSha1 && !(scope.gameId && !scope.shared && (await hasWantedSaves(device.userId, scope.gameId)))) return null;
  const dc = await deviceCard(device, rel, emu, scope);
  const action = await cardAction(device, dc, emu, deviceSha1);
  // Game start only takes: a changed card goes up when the game ends
  if (action === 'put') return start ? null : `put\t${absPath}\t${rom}`;
  if (action === 'cget') return `cget\t${absPath}\t${deviceSha1 ?? '-'}${start ? '' : `\t${rom}`}`;
  return null;
}

/**
 * Whole-device sync for the standalone clients. Body lines: "rom<TAB>path" for every rom on the
 * device and "file<TAB>path<TAB>sha1" for every save file found. Reply: "get<TAB>save<TAB>version<TAB>rom"
 * and "put<TAB>save<TAB>rom"; the client then uses /file and /upload with that rom.
 */
agentRouter.post('/sync', express.text({ limit: '16mb', type: '*/*' }), async (req, res) => {
  const device = await deviceFromToken(req);
  // "rom<TAB>path[<TAB>sha1[<TAB>headerless sha1[<TAB>size]]]": the hashes identify roms with non-DAT names
  const roms: { path: string; hashes: string[]; size: number }[] = [];
  const present = new Map<string, string>();
  const cores = new Map<string, string>();
  for (const line of String(req.body ?? '').split('\n')) {
    const [kind, p, h, h2, size] = line.replace(/\r$/, '').split('\t');
    if (kind === 'rom' && p) roms.push({ path: p, hashes: [h ?? '', h2 ?? ''].filter(Boolean), size: Number(size) || 0 });
    else if (kind === 'file' && p && SHA1.test(h ?? '')) present.set(p, h);
    else if (kind === 'core' && p && h) cores.set(p, h);
  }
  await storeCoreVersions(device, cores);
  // An unreadable body (a client that sent no content type) must not wipe the device's list
  if (typeof req.body === 'string' && req.body.length) await storeInventory(device, roms, req.header('x-allow-pull'));
  await storeSshOffer(device, req);
  // "X-Wifi-Bands: 2.4 | dual | none": what its WiFi chip can do, so it is only given networks it can see
  await storeWifiBands(device, req.header('x-wifi-bands'));
  // "X-Space: <free bytes> <total bytes>" of the device's storage, for the list copy budget
  const space = req.header('x-space')?.trim().split(/\s+/).map(Number);
  if (space?.length === 2 && space.every((n) => Number.isFinite(n) && n >= 0)) {
    await prisma.device.update({ where: { id: device.id }, data: { spaceFree: BigInt(Math.round(space[0])), spaceTotal: BigInt(Math.round(space[1])), spaceAt: new Date() } });
  }
  const userSaves = await prisma.save.findMany({ where: { userId: device.userId }, select: { baseName: true, gameId: true } });
  const savedNames = new Set(userSaves.map((s) => s.baseName));
  const savedGames = new Set(userSaves.map((s) => s.gameId).filter((g): g is number => g !== null));
  const systemIds = new Map<string, number | undefined>();
  await registerUnknownCores(layoutOf(device), device.rootPath.replace(/\/+$/, ''), present.keys());
  const coreEmus = (await prisma.emulator.findMany({ where: { core: { not: null } } })) as Emulator[];
  const out: string[] = [];
  const cardFiles = new Set<string>();
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
      if (f.kind === 'SAVE' && isCardEmulator(f.emu)) {
        cardFiles.add(f.path);
        const line = await cardLine(device, f.path, f.emu, { shared: false, gameId }, present.get(f.path) ?? null, rom);
        if (line) out.push(line);
        continue;
      }
      const save = await findLogicalSave(device.userId, f.emu, f.kind, f.slot, ctx.baseName, gameId, exactOnly);
      const deviceSha1 = present.get(f.path);
      const d = await decide(save, device, f.emu, deviceSha1 ? { sha1: deviceSha1 } : null);
      if (d.action === 'download') out.push(`get\t${f.path}\t${d.versionId}\t${rom}`);
      else if (d.action === 'upload' || d.action === 'conflict') out.push(`put\t${f.path}\t${rom}${exactOnly ? '\t1' : ''}`);
      else if (d.action === 'adopt' && save) await setBase(save.id, device.id, save.currentVersionId, deviceSha1!);
      if (f.kind !== 'STATE') continue;
      const thumb =
        d.action === 'download'
          ? await thumbLine(f.path, f.emu, ctx.layout.savesLayout, d.versionId, null)
          : deviceSha1 && save && d.action !== 'upload' && d.action !== 'conflict'
            ? await thumbLine(f.path, f.emu, ctx.layout.savesLayout, save.currentVersionId, deviceSha1)
            : null;
      if (thumb) out.push(thumb);
    }
  }
  // Card files named for no rom: shared by every game (pcsx-card2.mcd) or kept under a disc's serial
  for (const [p, h] of present) {
    const named = cardFiles.has(p) ? null : namedCard(path.posix.basename(p));
    if (!named) continue;
    const emu = await namedCardEmulator(named.emulator);
    const line = await cardLine(device, p, emu, { shared: named.shared, gameId: named.serial ? await gameForSerial(named.serial) : null }, h, '-');
    if (line) out.push(line);
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
  // The lists' files minus what the user left out; missing ones only while the device keeps its reserve
  const plan = await devicePlan(device, device.rootPath, device.homeRoot ?? device.rootPath);
  let budget = plan.budget;
  const skipped = { files: 0, bytes: 0 };
  const out: string[] = [];
  for (const f of plan.files) {
    if (f.excluded) continue;
    if (!f.present && budget !== null) {
      if (f.size > budget) {
        skipped.files++;
        skipped.bytes += f.size;
        continue;
      }
      budget -= f.size;
    }
    const size = f.archiveEntry ? 0 : f.size;
    out.push(`rom\t${f.dest}\t${size}\t${fileRef(device.id, f.absPath, f.archiveEntry)}`);
  }
  await prisma.device.update({ where: { id: device.id }, data: { spaceShortfall: skipped.files ? { at: new Date().toISOString(), ...skipped } : Prisma.DbNull } });
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
  if (await prisma.devicePull.count({ where: { deviceId: device.id, status: { in: OPEN_PULL } } })) out.push('pull');
  res.type('text/plain').send(out.join('\n') + (out.length ? '\n' : ''));
});

agentRouter.get('/pulls', async (req, res) => {
  const device = await deviceFromToken(req);
  const rows = await prisma.devicePull.findMany({ where: { deviceId: device.id, status: { in: OPEN_PULL } }, orderBy: { id: 'asc' }, take: 200 });
  const here = (p: string) => (device.homeRoot ? reroot(p, device.homeRoot, device.rootPath) : p);
  res.type('text/plain').send(rows.map((r) => `pull\t${r.id}\t${here(r.path)}`).join('\n') + (rows.length ? '\n' : ''));
});

/**
 * A requested rom sent by the device (body = the file). Stored like a verified upload; roms no
 * database knows come in as unverified, in the system of their folder, under a game with their title.
 * A transfer cut halfway (console switched off, network gone, client hung) leaves the request pending,
 * so the next contact sends it again; a partial file is never stored.
 */
agentRouter.post('/pull/:id', async (req, res) => {
  const device = await deviceFromToken(req);
  const pull = await prisma.devicePull.findUnique({ where: { id: Number(req.params.id) } });
  if (!pull || pull.deviceId !== device.id || !OPEN_PULL.includes(pull.status)) throw new HttpError(404, 'Pull not found');
  // The client tells when the file is gone from the device: nothing to retry
  if (req.header('x-missing') === '1') {
    await prisma.devicePull.update({ where: { id: pull.id }, data: { status: 'failed', result: 'not on the device any more', doneAt: new Date() } });
    res.type('text/plain').send('noted\n');
    return;
  }
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: device.userId }, select: { id: true, username: true } });
  const name = path.posix.basename(pull.path);
  // Container readers need the right extension on the temporary file
  const tmp = path.join(os.tmpdir(), `pull-${pull.id}-${Date.now()}${path.extname(name).toLowerCase()}`);
  const expected = Number(req.header('content-length') ?? NaN);
  await prisma.devicePull.update({ where: { id: pull.id }, data: { status: 'sending' } });
  const live = { received: 0, size: Number.isFinite(expected) ? expected : 0, startedAt: Date.now() };
  pullTransfers.set(pull.id, live);
  req.on('data', (c: Buffer) => (live.received += c.length));
  let result: string;
  try {
    try {
      await pipeline(req, fs.createWriteStream(tmp));
      const got = (await fs.promises.stat(tmp)).size;
      if (Number.isFinite(expected) && got !== expected) throw new Error(`incomplete: ${got} of ${expected} bytes`);
    } catch (e) {
      // Cut halfway: back to the queue for the next contact
      await prisma.devicePull.update({ where: { id: pull.id }, data: { status: 'pending', result: `interrupted (${e instanceof Error ? e.message : e})`.slice(0, 500) } });
      if (!res.headersSent && !req.destroyed) res.status(409).type('text/plain').send('interrupted, will retry\n');
      return;
    }
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
        try {
          await ingestUnverified(tmp, name, owner, { systemId: system.id, ...(game ? { gameId: game.id } : { newGameTitle: title }) });
          result = 'stored as unverified';
        } catch (dup) {
          // The same file came in before: nothing missing, not a failure
          if (!(dup instanceof HttpError) || dup.status !== 409) throw dup;
          result = 'already owned';
        }
      }
      await prisma.devicePull.update({ where: { id: pull.id }, data: { status: 'done', result, doneAt: new Date() } });
    } catch (e) {
      result = e instanceof Error ? e.message : String(e);
      await prisma.devicePull.update({ where: { id: pull.id }, data: { status: 'failed', result: result.slice(0, 500), doneAt: new Date() } });
    }
    res.type('text/plain').send(result + '\n');
  } finally {
    pullTransfers.delete(pull.id);
    await fs.promises.rm(tmp, { force: true });
  }
});

// Which device a token belongs to (the desktop companion keeps only the token on the card)
agentRouter.get('/whoami', async (req, res) => {
  const device = await deviceFromToken(req);
  res.type('text/plain').send(`id\t${device.id}\nname\t${device.name}\nfirmware\t${device.firmware.slug}\n`);
});

// The server's public key, which the client adds to the console's authorized_keys (when allowed there)
agentRouter.get('/ssh-key', async (req, res) => {
  await deviceFromToken(req);
  res.type('text/plain').send((await serverKey()).publicKey + '\n');
});

// Folders the client must list: roms (to know what is installed) and save locations
agentRouter.get('/roots', async (req, res) => {
  const device = await deviceFromToken(req);
  const layout = layoutOf(device);
  const root = device.rootPath.replace(/\/+$/, '');
  const abs = (p: string) => path.posix.join(root, p);
  const nextToRoms = layout.savesLayout.startsWith('rom') || layout.savesLayout === 'beside';
  const lines = [`roms\t${abs(layout.romsRoot)}`, `saves\t${abs(nextToRoms ? layout.romsRoot : layout.savesRoot)}`];
  if (!nextToRoms && layout.statesRoot !== layout.savesRoot) lines.push(`saves\t${abs(layout.statesRoot)}`);
  // Roms anywhere under the roms folder, not only <system>/<file> (clients that know it look deeper)
  if (layout.savesLayout === 'beside') lines.push('scan\tdeep');
  const exts = new Set<string>();
  for (const [slug, v] of Object.entries(layout.systemMap)) {
    // Layouts the user defined may leave the emulator out: RetroArch's usual core for the system
    const emuSlug = v.emulator ?? raDefaults[slug];
    if (!emuSlug) continue;
    const emu = await prisma.emulator.findUnique({ where: { slug: emuSlug } });
    if (emu) [emu.saveExt, emu.stateExt].forEach((e) => e && exts.add(e.toLowerCase()));
    // Memory cards every game shares (pcsx-card2.mcd) or kept under a serial sit in the same folders
    if (emu && isCardEmulator(emu)) ['.mcd', '.mcr'].forEach((e) => exts.add(e));
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
    if (f.kind === 'SAVE' && isCardEmulator(ctx.emu)) {
      const line = await cardLine(device, f.path, ctx.emu, { shared: false, gameId: ident?.gameId ?? null }, present.get(f.path) ?? null, '', true);
      if (line) out.push(line);
      continue;
    }
    const save = await findLogicalSave(device.userId, ctx.emu, f.kind, f.slot, ctx.baseName, ident?.gameId ?? null);
    const deviceSha1 = present.get(f.path);
    const d = await decide(save, device, ctx.emu, deviceSha1 ? { sha1: deviceSha1 } : null);
    if (d.action === 'download') out.push(`get\t${f.path}\t${d.versionId}`);
    // En conflicto tambien se sube: el servidor guarda ambas versiones y avisa
    else if (d.action === 'upload' || d.action === 'conflict') out.push(`put\t${f.path}`);
    else if (d.action === 'adopt' && save) await setBase(save.id, device.id, save.currentVersionId, deviceSha1!);
    const thumb = d.action === 'download' && f.kind === 'STATE' ? await thumbLine(f.path, ctx.emu, ctx.layout.savesLayout, d.versionId, null) : null;
    if (thumb) out.push(thumb);
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
  const filePath = b64(req.header('x-path-b64'));
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!buf.length) throw badRequest('Empty file');
  const romPath = b64(req.header('x-rom-b64'));
  // A card file named for no rom (shared, or kept under a serial)
  const named = namedCard(path.posix.basename(filePath));
  if (named && (!romPath || romPath === '-')) {
    const emu = await namedCardEmulator(named.emulator);
    const dc = await deviceCard(device, relToRoot(device, filePath), emu, { shared: named.shared, gameId: named.serial ? await gameForSerial(named.serial) : null });
    res.type('text/plain').send(await cardUpload(device, dc, emu, filePath, buf, '-'));
    return;
  }
  const ctx = await romContext(device, romPath);
  const emu = await emulatorForPath(ctx, filePath);
  const parsed = candidatePaths(ctx, emu).find((f) => f.path === filePath) ?? parseSaveFile(path.posix.basename(filePath), emu);
  if (!parsed) throw badRequest('Not a save file for this emulator');
  const systemId = (await prisma.system.findUnique({ where: { slug: ctx.slug } }))?.id;
  const byHash = await gameByHash((req.header('x-rom-sha1') ?? '').split(',').map((h) => h.trim()), systemId);
  if (parsed.kind === 'SAVE' && isCardEmulator(emu)) {
    const gameId = byHash?.gameId ?? (await identifyRom(ctx.baseName, systemId))?.gameId ?? null;
    const dc = await deviceCard(device, relToRoot(device, filePath), emu, { shared: false, gameId });
    res.type('text/plain').send(await cardUpload(device, dc, emu, filePath, buf, romPath));
    return;
  }
  const r = await receiveFromDevice(device, ctx.slug, emu, parsed.kind, parsed.slot, ctx.baseName, buf, byHash, req.header('x-save-exact') === '1');
  await prisma.device.update({ where: { id: device.id }, data: { lastSyncAt: new Date() } });
  // A new savestate: the client sends the emulator's screenshot of it next
  const thumb = parsed.kind === 'STATE' && r.versionId ? deviceThumbPath(filePath, emu, ctx.layout.savesLayout) : null;
  res.type('text/plain').send(`${r.action}\n${thumb ? `tput\t${thumb}\t${r.versionId}\n` : ''}`);
});

/** Reads a card file the device sent; the reply asks for the card back at once when the server has entries for it */
async function cardUpload(device: AgentDevice, dc: Awaited<ReturnType<typeof deviceCard>>, emu: Emulator, filePath: string, buf: Buffer, rom: string) {
  const r = await observeCard(device, dc, emu, buf);
  await prisma.device.update({ where: { id: device.id }, data: { lastSyncAt: new Date() } });
  const fresh = (await findDeviceCard(device.id, dc.path))!;
  const back = await prepareCard(device, fresh, emu, sha1(buf));
  return `${r.conflicts ? 'conflict' : r.uploaded ? 'uploaded' : 'unchanged'}\n${back ? `cget\t${filePath}\t${sha1(buf)}\t${rom}\n` : ''}`;
}

/**
 * A card file with the server's newer entries put in, built from the file the server last read from the device
 * ("expect": its sha1, "-" when the device has none). 409 when the device's file is no longer that one,
 * 204 when nothing has to change. The entries count as synced once the device is seen with this card.
 */
agentRouter.get('/card', async (req, res) => {
  const device = await deviceFromToken(req);
  const dc = await findDeviceCard(device.id, relToRoot(device, b64(req.header('x-path-b64'))));
  if (!dc) throw new HttpError(404, 'Unknown card');
  const expect = String(req.query.expect ?? '-');
  const deviceSha1 = SHA1.test(expect) ? expect : null;
  if (deviceSha1 !== dc.lastSha1) throw new HttpError(409, 'The card changed since it was read');
  const emu = await prisma.emulator.findUniqueOrThrow({ where: { id: dc.emulatorId } });
  const prepared = await prepareCard(device, dc, emu, deviceSha1);
  if (!prepared) {
    res.status(204).end();
    return;
  }
  await recordOffer(device, dc, prepared);
  res.setHeader('X-Card-Sha1', prepared.sha1);
  res.type('application/octet-stream').send(prepared.file);
});

async function stateVersion(device: AgentDevice, id: number) {
  const v = await prisma.saveVersion.findUnique({ where: { id }, include: { save: true } });
  if (!v || v.save.userId !== device.userId || v.save.kind !== 'STATE') throw new HttpError(404, 'Version not found');
  return v;
}

// The emulator's screenshot of a savestate version ("tput" lines)
agentRouter.post('/thumb', express.raw({ limit: THUMB_MAX, type: '*/*' }), async (req, res) => {
  const device = await deviceFromToken(req);
  const v = await stateVersion(device, Number(req.query.v));
  if (!(await storeThumb(v.id, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)))) throw badRequest('Not an image');
  res.type('text/plain').send('stored\n');
});

// The screenshot of a savestate the device just received ("tget" lines)
agentRouter.get('/thumb', async (req, res) => {
  const device = await deviceFromToken(req);
  const v = await stateVersion(device, Number(req.query.v));
  if (!v.thumbPath) throw new HttpError(404, 'No screenshot');
  res.type('application/octet-stream').send((await readThumb(v.thumbPath)).buf);
});
