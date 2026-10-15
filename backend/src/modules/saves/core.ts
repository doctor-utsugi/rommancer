/**
 * Steam Cloud-style save sync.
 *
 * For each save and device the last synced version (base) and the sha1 of the file as it was left on the
 * device are remembered. That tells which side changed without looking at clocks:
 *   - only the device changed -> uploaded, becomes the current version
 *   - only the server changed -> downloaded, converted to the device emulator's format
 *   - both changed            -> conflict: both are kept, the device keeps its own and the user picks
 */
import crypto from 'node:crypto';
import path from 'node:path';
import type { Device, Emulator, Firmware, Save, SaveKind } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { DeviceLayout } from '../devices/sink.js';
import { convertSave, type SaveFormat } from './convert.js';
import { identifyRom, readVersion, storeVersion } from './service.js';
import { folderHash, readPspFolder } from './pspsave.js';

export const sha1 = (b: Buffer) => crypto.createHash('sha1').update(b).digest('hex');
const family = (f: string) => (f.startsWith('ps1') ? 'ps1' : f);

export type DeviceWithFirmware = Device & { firmware: Firmware };

/** NextUI/MinUI: the tag in a rom folder's last parentheses ("Game Boy Advance (GBA)" is GBA), or the whole name */
export const minuiTag = (folder: string) => /\(([^()]*)\)[^()]*$/.exec(folder)?.[1] ?? folder;

/**
 * Folders (relative to the device root) of a system's saves, states and roms. ROMREL, the rom's path relative to the
 * root, names the content folder of the "content" layouts (RetroArch's "sort by content directory")
 */
export function saveDirs(layout: DeviceLayout, slug: string, emu: Emulator, romRel?: string) {
  const folder = layout.systemMap[slug]?.folder ?? slug;
  if (layout.savesLayout === 'minui') {
    const tag = minuiTag(folder);
    return { saves: path.posix.join(layout.savesRoot, tag), states: path.posix.join(layout.statesRoot, `${tag}-${emu.slug.replace(/^minui-/, '')}`), roms: path.posix.join(layout.romsRoot, folder) };
  }
  const content = romRel ? path.posix.basename(path.posix.dirname(romRel)) : folder;
  const sub = (root: string, kind: string) => {
    switch (kind) {
      case 'system':
        return path.posix.join(root, folder);
      // A standalone emulator (no core) has no folder among RetroArch's per-core ones: its saves sit next to the rom
      case 'core':
        return emu.core ? path.posix.join(root, emu.core) : path.posix.join(layout.romsRoot, folder);
      // RetroArch sorting by content directory: the folder the rom is in, then (content-core) the core
      case 'content':
        return path.posix.join(root, content);
      case 'content-core':
        return emu.core ? path.posix.join(root, content, emu.core) : path.posix.join(layout.romsRoot, folder);
      case 'rom':
        return path.posix.join(layout.romsRoot, folder);
      // TWiLight Menu++ and some flashcarts: a "saves" folder inside each rom folder
      case 'rom-saves':
        return path.posix.join(layout.romsRoot, folder, 'saves');
      // RetroArch with saves next to the content, sorted by core (Android default)
      // Standalone emulators (no core) keep their saves right next to the rom
      case 'rom-core':
        return emu.core ? path.posix.join(layout.romsRoot, folder, emu.core) : path.posix.join(layout.romsRoot, folder);
      default:
        return root;
    }
  };
  return { saves: sub(layout.savesRoot, layout.savesLayout), states: sub(layout.statesRoot, layout.statesLayout ?? layout.savesLayout), roms: path.posix.join(layout.romsRoot, folder) };
}

/** File name on the device for a save of a kind and slot. */
export function deviceFileName(base: string, emu: Emulator, kind: SaveKind, slot: number, minui = false) {
  if (kind === 'SAVE') return base + emu.saveExt;
  // minarch: base is the rom's whole file name; slots 0-7 by number, 9 the auto-resume one
  if (minui) return `${base}${emu.stateExt}${slot === -1 ? 9 : slot}`;
  return base + (emu.stateExt ?? '.state') + (slot > 0 ? String(slot) : slot === -1 ? '.auto' : '');
}

/**
 * Where the emulator keeps its screenshot of a savestate: RetroArch writes "<state>.png" (with
 * savestate_thumbnail_enable), NextUI's minarch "<shared>/.minui/<tag>/<rom file>.<slot>.bmp". Null for the others.
 */
export function deviceThumbPath(statePath: string, emu: Emulator, savesLayout: string): string | null {
  if (savesLayout === 'minui') {
    const dir = path.posix.dirname(statePath);
    const core = emu.slug.replace(/^minui-/, '');
    const folder = path.posix.basename(dir);
    const m = /^(.*)\.st(\d)$/.exec(path.posix.basename(statePath));
    if (!m || !folder.endsWith(`-${core}`)) return null;
    return path.posix.join(path.posix.dirname(dir), '.minui', folder.slice(0, -core.length - 1), `${m[1]}.${m[2]}.bmp`);
  }
  return emu.core ? `${statePath}.png` : null;
}

/** Version of the emulator's core on a device, as its client reported it (RetroArch's core info files) */
export function coreVersionOf(device: Device, emu: Emulator): string | null {
  if (!emu.core || !device.coreVersions || typeof device.coreVersions !== 'object') return null;
  const cores = device.coreVersions as Record<string, string>;
  const name = emu.core.toLowerCase();
  const key = Object.keys(cores).find((k) => k.toLowerCase() === name);
  return key ? String(cores[key]) : null;
}

/**
 * Logical save of a game for an emulator: the emulator's own or, failing that, one in a compatible format
 * from another emulator (so a Snes9x SNES save works on any device). Savestates only fit the same emulator.
 */
/**
 * DEVICE_ID: the device the file is on. A save found by its game, not by its name, is not this file's when the
 * device also has the rom of that name (two versions of a game on one console, "(USA)" and "(Europe)": each keeps
 * its own save, or one sync would write each over the other).
 */
export async function findLogicalSave(userId: number, emu: Emulator, kind: SaveKind, slot: number, baseName: string, gameId: number | null, exactOnly = false, deviceId?: number) {
  const byName = await prisma.save.findFirst({ where: { userId, emulatorId: emu.id, kind, slot, baseName, supersededAt: null }, include: { emulator: true } });
  if (byName) return byName;
  const mine = async <T extends { baseName: string } | null>(s: T) => (s && deviceId && s.baseName !== baseName && (await deviceHasRomNamed(deviceId, s.baseName)) ? null : s);
  // Same rom name first; otherwise the most recently updated save of the same game
  const exact = gameId ? await mine(await prisma.save.findFirst({ where: { userId, emulatorId: emu.id, kind, slot, gameId, supersededAt: null }, include: { emulator: true }, orderBy: { updatedAt: 'desc' } })) : null;
  // exactOnly: the device keeps one file per emulator for this game, so they must not be merged
  if (exact || kind === 'STATE' || exactOnly) return exact;
  // Unidentified roms (homebrew, odd names) still share by file name
  const others = await prisma.save.findMany({ where: { userId, kind, slot, supersededAt: null, ...(gameId ? { gameId } : { baseName }) }, include: { emulator: true }, orderBy: { updatedAt: 'desc' } });
  return mine(others.find((s) => family(s.emulator.saveFormat) === family(emu.saveFormat)) ?? null);
}

/** Whether the device's last inventory has a rom whose file name (without extension) is NAME */
async function deviceHasRomNamed(deviceId: number, name: string) {
  const rows = await prisma.deviceRom.findMany({ where: { deviceId, path: { contains: name } }, select: { path: true } });
  return rows.some((r) => path.posix.basename(r.path).replace(/\.[^.]+$/, '') === name);
}

/** The save's content converted to the format the device's emulator expects. */
export async function contentFor(save: Save & { emulator: Emulator }, versionId: number, emu: Emulator) {
  const buf = await readVersion(versionId);
  if (save.kind === 'STATE' || save.emulator.saveFormat === emu.saveFormat) return buf;
  return convertSave(buf, save.emulator.saveFormat as SaveFormat, emu.saveFormat as SaveFormat);
}

export type Decision =
  | { action: 'none' }
  | { action: 'upload' }
  | { action: 'download'; versionId: number }
  | { action: 'conflict' }
  | { action: 'adopt' };

export interface DeviceFileInfo {
  sha1: string;
  /** The file itself, when the device sent it: lets an empty or padded save be told from a different one */
  buf?: Buffer;
}

/** A save that holds no data: every byte erased (0x00) or never written (0xFF) */
const blank = (b: Buffer) => b.every((x) => x === 0 || x === 0xff);

/** One save padded to another size (8 KiB of data in a 128 KiB file): the longer one only adds blank bytes */
function samePadded(a: Buffer, b: Buffer) {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long.subarray(0, short.length).equals(short) && blank(long.subarray(short.length));
}

/** Whether the device's file is the server's current version (converted for it, or only padded otherwise) */
async function holdsCurrent(save: Save & { emulator: Emulator }, emu: Emulator, deviceFile: DeviceFileInfo) {
  if (!save.currentVersionId) return false;
  const content = await contentFor(save, save.currentVersionId, emu).catch(() => null);
  if (!content) return false;
  return saveHash(content, emu.saveFormat) === deviceFile.sha1 || (!!deviceFile.buf && save.kind === 'SAVE' && samePadded(content, deviceFile.buf));
}

/**
 * Closes the device's open conflict on a save once the device holds the server's version (picked on the device,
 * or copied over by hand); true when there is no open conflict left
 */
export async function settleHeldConflict(save: Save & { emulator: Emulator }, device: Device, emu: Emulator, deviceFile: DeviceFileInfo) {
  const open = await prisma.saveConflict.findFirst({ where: { saveId: save.id, deviceId: device.id, resolvedAt: null } });
  if (!open) return true;
  if (!(await holdsCurrent(save, emu, deviceFile))) return false;
  await prisma.saveConflict.update({ where: { id: open.id }, data: { resolvedAt: new Date(), resolution: 'server' } });
  await setBase(save.id, device.id, save.currentVersionId, deviceFile.sha1);
  return true;
}

/** Decides what to do with a save on a device. */
/** A save's hash as its device reports it: a 3DS save folder's is its manifest's, however its tar was made */
export const saveHash = (buf: Buffer, format: string) => (format === 'ctrdir' ? folderHash(buf) : sha1(buf));

export async function decide(save: (Save & { emulator: Emulator }) | null, device: Device, emu: Emulator, deviceFile: DeviceFileInfo | null): Promise<Decision> {
  if (!save) return deviceFile ? { action: 'upload' } : { action: 'none' };
  const open = await prisma.saveConflict.findFirst({ where: { saveId: save.id, deviceId: device.id, resolvedAt: null } });
  if (open) return deviceFile && (await settleHeldConflict(save, device, emu, deviceFile)) ? { action: 'adopt' } : { action: 'none' };
  const base = await prisma.saveDeviceState.findUnique({ where: { saveId_deviceId: { saveId: save.id, deviceId: device.id } } });
  const current = save.currentVersionId;
  if (!deviceFile) return current ? { action: 'download', versionId: current } : { action: 'none' };
  if (!current) return { action: 'upload' };
  const deviceChanged = !base || deviceFile.sha1 !== base.deviceSha1;
  const serverChanged = !base || current !== base.versionId;
  if (!deviceChanged && !serverChanged) return { action: 'none' };
  if (deviceChanged && !serverChanged) return { action: 'upload' };
  if (!deviceChanged && serverChanged) return { action: 'download', versionId: current };
  // Both sides "changed": if the content already matches, only the base is recorded
  const serverContent = await contentFor(save, current, emu).catch(() => null);
  if (serverContent && saveHash(serverContent, emu.saveFormat) === deviceFile.sha1) return { action: 'adopt' };
  if (serverContent && deviceFile.buf && save.kind === 'SAVE') {
    if (samePadded(serverContent, deviceFile.buf)) return { action: 'adopt' };
    // A save never written to gives way to the other side: no progress is lost
    if (blank(deviceFile.buf)) return { action: 'download', versionId: current };
    if (blank(serverContent)) return { action: 'upload' };
  }
  return { action: 'conflict' };
}

export async function setBase(saveId: number, deviceId: number, versionId: number | null, deviceSha1: string) {
  await prisma.saveDeviceState.upsert({
    where: { saveId_deviceId: { saveId, deviceId } },
    create: { saveId, deviceId, versionId, deviceSha1 },
    update: { versionId, deviceSha1, syncedAt: new Date() },
  });
}

/**
 * Processes a file received from the device (upload on game close, or a read over SD/SSH).
 * Returns the result for logging.
 */
export async function receiveFromDevice(
  device: Device,
  systemSlug: string | null,
  emu: Emulator,
  kind: SaveKind,
  slot: number,
  baseName: string,
  buf: Buffer,
  known?: { gameId: number; romId: number | null } | null,
  exactOnly = false,
  fileMtime?: Date,
) {
  const systemId = systemSlug ? (await prisma.system.findUnique({ where: { slug: systemSlug } }))?.id : undefined;
  const ident = known ?? (await identifyRom(baseName, systemId));
  const save = await findLogicalSave(device.userId, emu, kind, slot, baseName, ident?.gameId ?? null, exactOnly, device.id);
  // A save folder is kept as the canonical tar of its files, whichever client packed it
  if (emu.saveFormat === 'ctrdir') buf = readPspFolder(buf).tar;
  const deviceSha1 = saveHash(buf, emu.saveFormat);
  const d = await decide(save, device, emu, { sha1: deviceSha1, buf });
  // Stored in the logical save's format (converted if it comes from another compatible emulator)
  const toSaveFormat = (target: Save & { emulator: Emulator }) =>
    kind === 'STATE' || target.emulator.saveFormat === emu.saveFormat ? buf : convertSave(buf, emu.saveFormat as SaveFormat, target.emulator.saveFormat as SaveFormat);
  const keyFor = (target: (Save & { emulator: Emulator }) | null) =>
    target ? { userId: target.userId, emulatorId: target.emulatorId, kind: target.kind, slot: target.slot, baseName: target.baseName } : { userId: device.userId, emulatorId: emu.id, kind, slot, baseName };
  const coreVersion = kind === 'STATE' ? coreVersionOf(device, emu) : null;

  if (d.action === 'upload') {
    const r = await storeVersion(keyFor(save), save ? toSaveFormat(save) : buf, fileMtime ?? new Date(), { sourceDeviceId: device.id, gameId: ident?.gameId ?? null, romId: ident?.romId ?? null, coreVersion });
    await setBase(r.save.id, device.id, r.version.id, deviceSha1);
    return { action: 'uploaded' as const, saveId: r.save.id, versionId: r.version.id };
  }
  if (d.action === 'adopt' && save) {
    await setBase(save.id, device.id, save.currentVersionId, deviceSha1);
    return { action: 'unchanged' as const, saveId: save.id, versionId: null };
  }
  if (d.action === 'conflict' && save) {
    const r = await storeVersion(keyFor(save), toSaveFormat(save), fileMtime ?? new Date(), { sourceDeviceId: device.id, note: 'conflict', makeCurrent: false, force: true, coreVersion });
    await prisma.saveConflict.create({ data: { saveId: save.id, deviceId: device.id, deviceVersionId: r.version.id, serverVersionId: save.currentVersionId! } });
    // The device keeps its file; what it holds is recorded so the conflict is not repeated
    const base = await prisma.saveDeviceState.findUnique({ where: { saveId_deviceId: { saveId: save.id, deviceId: device.id } } });
    await setBase(save.id, device.id, base?.versionId ?? null, deviceSha1);
    return { action: 'conflict' as const, saveId: save.id, versionId: r.version.id };
  }
  // The device's file holds nothing: its base is left behind the server's version, so the next sync downloads it
  if (d.action === 'download' && save && blank(buf)) await setBase(save.id, device.id, null, deviceSha1);
  return { action: d.action === 'download' ? ('server-newer' as const) : ('unchanged' as const), saveId: save?.id ?? null, versionId: null };
}

/** Settles a conflict by keeping the device's version or the server's. */
export async function resolveConflict(conflictId: number, keep: 'device' | 'server', userId: number) {
  const c = await prisma.saveConflict.findUniqueOrThrow({ where: { id: conflictId }, include: { save: true } });
  if (c.save.userId !== userId) throw new Error('Forbidden');
  const base = await prisma.saveDeviceState.findUnique({ where: { saveId_deviceId: { saveId: c.saveId, deviceId: c.deviceId } } });
  if (keep === 'device') {
    await prisma.save.update({ where: { id: c.saveId }, data: { currentVersionId: c.deviceVersionId } });
    await setBase(c.saveId, c.deviceId, c.deviceVersionId, base?.deviceSha1 ?? '');
  } else {
    // The base stays at the previous version: the next sync downloads the server's
    await setBase(c.saveId, c.deviceId, null, base?.deviceSha1 ?? '');
  }
  await prisma.saveConflict.update({ where: { id: c.id }, data: { resolvedAt: new Date(), resolution: keep } });
  // Memory card entries keep their bases per card file
  if (c.save.kind === 'ENTRY') await (await import('./cards.js')).settleEntryConflict(c.saveId, c.deviceId, keep === 'device' ? c.deviceVersionId : null);
}
