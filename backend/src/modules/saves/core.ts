/**
 * Sincronizacion de saves estilo Steam Cloud.
 *
 * Para cada save y dispositivo se recuerda la ultima version sincronizada (base) y el sha1 del fichero
 * tal como quedo en el dispositivo. Asi se sabe que lado ha cambiado sin mirar relojes:
 *   - solo cambio el dispositivo -> se sube y pasa a ser la version actual
 *   - solo cambio el servidor    -> se baja, convertida al formato del emulador del dispositivo
 *   - cambiaron los dos          -> conflicto: se guardan ambas, el dispositivo conserva la suya y el usuario elige
 */
import crypto from 'node:crypto';
import path from 'node:path';
import type { Device, Emulator, Firmware, Save, SaveKind } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { DeviceLayout } from '../devices/sink.js';
import { convertSave, type SaveFormat } from './convert.js';
import { identifyRom, readVersion, storeVersion } from './service.js';

export const sha1 = (b: Buffer) => crypto.createHash('sha1').update(b).digest('hex');
const family = (f: string) => (f.startsWith('ps1') ? 'ps1' : f);

export type DeviceWithFirmware = Device & { firmware: Firmware };

/** NextUI/MinUI: the tag in a rom folder's last parentheses ("Game Boy Advance (GBA)" is GBA), or the whole name */
export const minuiTag = (folder: string) => /\(([^()]*)\)[^()]*$/.exec(folder)?.[1] ?? folder;

export function saveDirs(layout: DeviceLayout, slug: string, emu: Emulator) {
  const folder = layout.systemMap[slug]?.folder ?? slug;
  if (layout.savesLayout === 'minui') {
    const tag = minuiTag(folder);
    return { saves: path.posix.join(layout.savesRoot, tag), states: path.posix.join(layout.statesRoot, `${tag}-${emu.slug.replace(/^minui-/, '')}`), roms: path.posix.join(layout.romsRoot, folder) };
  }
  const sub = (root: string) => {
    switch (layout.savesLayout) {
      case 'system':
        return path.posix.join(root, folder);
      case 'core':
        return path.posix.join(root, emu.core ?? emu.name);
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
  return { saves: sub(layout.savesRoot), states: sub(layout.statesRoot), roms: path.posix.join(layout.romsRoot, folder) };
}

/** Nombre del fichero en el dispositivo para un save de un tipo y ranura. */
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
 * Save logico de un juego para un emulador: el del propio emulador o, si no existe, uno de formato
 * compatible de otro emulador (asi un save de SNES de Snes9x sirve en cualquier dispositivo).
 * Los savestates solo valen para el mismo emulador.
 */
export async function findLogicalSave(userId: number, emu: Emulator, kind: SaveKind, slot: number, baseName: string, gameId: number | null, exactOnly = false) {
  // Same rom name first; otherwise the most recently updated save of the same game
  const exact =
    (await prisma.save.findFirst({ where: { userId, emulatorId: emu.id, kind, slot, baseName, supersededAt: null }, include: { emulator: true } })) ??
    (gameId ? await prisma.save.findFirst({ where: { userId, emulatorId: emu.id, kind, slot, gameId, supersededAt: null }, include: { emulator: true }, orderBy: { updatedAt: 'desc' } }) : null);
  // exactOnly: the device keeps one file per emulator for this game, so they must not be merged
  if (exact || kind === 'STATE' || exactOnly) return exact;
  // Unidentified roms (homebrew, odd names) still share by file name
  const others = await prisma.save.findMany({ where: { userId, kind, slot, supersededAt: null, ...(gameId ? { gameId } : { baseName }) }, include: { emulator: true }, orderBy: { updatedAt: 'desc' } });
  return others.find((s) => family(s.emulator.saveFormat) === family(emu.saveFormat)) ?? null;
}

/** Contenido del save convertido al formato que espera el emulador del dispositivo. */
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
}

/** Decide que hacer con un save en un dispositivo. */
export async function decide(save: (Save & { emulator: Emulator }) | null, device: Device, emu: Emulator, deviceFile: DeviceFileInfo | null): Promise<Decision> {
  if (!save) return deviceFile ? { action: 'upload' } : { action: 'none' };
  const open = await prisma.saveConflict.findFirst({ where: { saveId: save.id, deviceId: device.id, resolvedAt: null } });
  if (open) return { action: 'none' };
  const base = await prisma.saveDeviceState.findUnique({ where: { saveId_deviceId: { saveId: save.id, deviceId: device.id } } });
  const current = save.currentVersionId;
  if (!deviceFile) return current ? { action: 'download', versionId: current } : { action: 'none' };
  if (!current) return { action: 'upload' };
  const deviceChanged = !base || deviceFile.sha1 !== base.deviceSha1;
  const serverChanged = !base || current !== base.versionId;
  if (!deviceChanged && !serverChanged) return { action: 'none' };
  if (deviceChanged && !serverChanged) return { action: 'upload' };
  if (!deviceChanged && serverChanged) return { action: 'download', versionId: current };
  // Los dos lados "cambiaron": si el contenido ya coincide solo se anota la base
  const serverContent = await contentFor(save, current, emu).catch(() => null);
  if (serverContent && sha1(serverContent) === deviceFile.sha1) return { action: 'adopt' };
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
 * Procesa un fichero recibido del dispositivo (subida al cerrar un juego o lectura por SD/SSH).
 * Devuelve el resultado para registro.
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
) {
  const systemId = systemSlug ? (await prisma.system.findUnique({ where: { slug: systemSlug } }))?.id : undefined;
  const ident = known ?? (await identifyRom(baseName, systemId));
  const save = await findLogicalSave(device.userId, emu, kind, slot, baseName, ident?.gameId ?? null, exactOnly);
  const deviceSha1 = sha1(buf);
  const d = await decide(save, device, emu, { sha1: deviceSha1 });
  // Se guarda en el formato del save logico (si es de otro emulador compatible se convierte)
  const toSaveFormat = (target: Save & { emulator: Emulator }) =>
    kind === 'STATE' || target.emulator.saveFormat === emu.saveFormat ? buf : convertSave(buf, emu.saveFormat as SaveFormat, target.emulator.saveFormat as SaveFormat);
  const keyFor = (target: (Save & { emulator: Emulator }) | null) =>
    target ? { userId: target.userId, emulatorId: target.emulatorId, kind: target.kind, slot: target.slot, baseName: target.baseName } : { userId: device.userId, emulatorId: emu.id, kind, slot, baseName };
  const coreVersion = kind === 'STATE' ? coreVersionOf(device, emu) : null;

  if (d.action === 'upload') {
    const r = await storeVersion(keyFor(save), save ? toSaveFormat(save) : buf, new Date(), { sourceDeviceId: device.id, gameId: ident?.gameId ?? null, romId: ident?.romId ?? null, coreVersion });
    await setBase(r.save.id, device.id, r.version.id, deviceSha1);
    return { action: 'uploaded' as const, saveId: r.save.id, versionId: r.version.id };
  }
  if (d.action === 'adopt' && save) {
    await setBase(save.id, device.id, save.currentVersionId, deviceSha1);
    return { action: 'unchanged' as const, saveId: save.id, versionId: null };
  }
  if (d.action === 'conflict' && save) {
    const r = await storeVersion(keyFor(save), toSaveFormat(save), new Date(), { sourceDeviceId: device.id, note: 'conflict', makeCurrent: false, force: true, coreVersion });
    await prisma.saveConflict.create({ data: { saveId: save.id, deviceId: device.id, deviceVersionId: r.version.id, serverVersionId: save.currentVersionId! } });
    // El dispositivo conserva su fichero; se anota lo que tiene para no repetir el conflicto
    const base = await prisma.saveDeviceState.findUnique({ where: { saveId_deviceId: { saveId: save.id, deviceId: device.id } } });
    await setBase(save.id, device.id, base?.versionId ?? null, deviceSha1);
    return { action: 'conflict' as const, saveId: save.id, versionId: r.version.id };
  }
  return { action: d.action === 'download' ? ('server-newer' as const) : ('unchanged' as const), saveId: save?.id ?? null, versionId: null };
}

/** Resuelve un conflicto quedandose con la version del dispositivo o con la del servidor. */
export async function resolveConflict(conflictId: number, keep: 'device' | 'server', userId: number) {
  const c = await prisma.saveConflict.findUniqueOrThrow({ where: { id: conflictId }, include: { save: true } });
  if (c.save.userId !== userId) throw new Error('Forbidden');
  const base = await prisma.saveDeviceState.findUnique({ where: { saveId_deviceId: { saveId: c.saveId, deviceId: c.deviceId } } });
  if (keep === 'device') {
    await prisma.save.update({ where: { id: c.saveId }, data: { currentVersionId: c.deviceVersionId } });
    await setBase(c.saveId, c.deviceId, c.deviceVersionId, base?.deviceSha1 ?? '');
  } else {
    // La base queda en la version anterior: en la siguiente sincronizacion se baja la del servidor
    await setBase(c.saveId, c.deviceId, null, base?.deviceSha1 ?? '');
  }
  await prisma.saveConflict.update({ where: { id: c.id }, data: { resolvedAt: new Date(), resolution: keep } });
}
