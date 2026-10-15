import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Emulator, SaveKind } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { nudgeDevices } from './nudge.js';

/** Versions kept of each save, set by the admin; consoles keep as many copies of what a sync overwrote */
export const HISTORY_KEY = 'saves.history';
export async function saveHistory() {
  const v = Number((await prisma.setting.findUnique({ where: { key: HISTORY_KEY } }))?.value);
  return Number.isInteger(v) && v >= 1 ? v : 20;
}

export interface SaveKey {
  userId: number;
  emulatorId: number;
  kind: SaveKind;
  slot: number;
  baseName: string;
}

/** Finds the rom/game matching a file name (no extension). */
export async function identifyRom(baseName: string, systemId?: number | null) {
  const rom = await prisma.rom.findFirst({
    where: { name: baseName, ...(systemId ? { game: { systemId } } : {}) },
    select: { id: true, gameId: true, game: { select: { systemId: true } } },
  });
  if (rom) return { romId: rom.id, gameId: rom.gameId, systemId: rom.game.systemId };
  // Local file name differs from the DAT: look it up by the scanned file
  const files = await prisma.romFile.findMany({
    where: { relativePath: { contains: baseName }, status: { in: ['MATCHED', 'HACK'] } },
    include: { romPart: { include: { rom: { include: { game: true } } } }, romHack: { include: { game: true } } },
    take: 20,
  });
  for (const f of files) {
    const b = path.basename(f.archiveEntry ?? f.relativePath).replace(/\.[^.]+$/, '');
    if (b !== baseName) continue;
    if (f.romPart) return { romId: f.romPart.romId, gameId: f.romPart.rom.gameId, systemId: f.romPart.rom.game.systemId };
    if (f.romHack) return { romId: null, gameId: f.romHack.gameId, systemId: f.romHack.game.systemId };
  }
  return null;
}

export function parseSaveFile(name: string, emu: Emulator): { kind: SaveKind; slot: number; baseName: string } | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(emu.saveExt.toLowerCase())) return { kind: 'SAVE', slot: 0, baseName: name.slice(0, -emu.saveExt.length) };
  if (emu.stateExt) {
    const se = emu.stateExt.toLowerCase();
    // RetroArch: .state, .state1..9, .state.auto
    const m = lower.match(new RegExp(`^(.*)${se.replace('.', '\\.')}(\\d+|\\.auto)?$`));
    if (m) {
      const suffix = m[2];
      const slot = !suffix ? 0 : suffix === '.auto' ? -1 : Number(suffix);
      return { kind: 'STATE', slot, baseName: name.slice(0, m[1].length) };
    }
  }
  return null;
}

/** A save file as found on a device; NextUI names it after the whole rom file ("Game.gba.sav", "Game.gba.st9") */
export function parseDeviceSave(name: string, emu: Emulator, savesLayout: string) {
  const parsed = parseSaveFile(name, emu);
  if (!parsed || savesLayout !== 'minui') return parsed;
  if (parsed.kind === 'STATE' && parsed.slot === 8) return null;
  return { ...parsed, baseName: parsed.baseName.replace(/\.[^.]+$/, ''), slot: parsed.kind === 'STATE' && parsed.slot === 9 ? -1 : parsed.slot };
}

export async function storeVersion(
  key: SaveKey,
  buf: Buffer,
  fileMtime: Date,
  opts: { sourceDeviceId?: number; note?: string; gameId?: number | null; romId?: number | null; force?: boolean; makeCurrent?: boolean; coreVersion?: string | null; cardId?: number; label?: string | null } = {},
) {
  const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
  let save = await prisma.save.findUnique({
    where: { userId_emulatorId_kind_slot_baseName: key },
    include: { versions: { orderBy: { fileMtime: 'desc' } } },
  });
  if (!save) {
    const ident = opts.gameId !== undefined ? { gameId: opts.gameId ?? null, romId: opts.romId ?? null } : await identifyRom(key.baseName);
    save = await prisma.save.create({
      data: { ...key, gameId: ident?.gameId ?? null, romId: ident?.romId ?? null, cardId: opts.cardId ?? null, label: opts.label?.slice(0, 128) || null },
      include: { versions: { orderBy: { fileMtime: 'desc' } } },
    });
  }
  if (opts.label && opts.label !== save.label) await prisma.save.update({ where: { id: save.id }, data: { label: opts.label.slice(0, 128) } });
  const existing = save.versions.find((v) => v.sha1 === sha1);
  if (existing && !opts.force) {
    // An earlier version again (a save loaded back and written): the other devices fetch it like a new one
    if (opts.makeCurrent !== false && save.currentVersionId !== existing.id) {
      await prisma.save.update({ where: { id: save.id }, data: { currentVersionId: existing.id } });
      await nudgeDevices(key.userId, opts.sourceDeviceId);
    }
    return { save, version: existing, created: false };
  }
  const dir = path.join(env.savesDir, String(key.userId), String(save.id));
  await fs.promises.mkdir(dir, { recursive: true });
  const version = await prisma.saveVersion.create({
    data: { saveId: save.id, path: '', size: buf.length, sha1, fileMtime, sourceDeviceId: opts.sourceDeviceId ?? null, note: opts.note ?? null, coreVersion: opts.coreVersion?.slice(0, 64) || null },
  });
  const rel = path.join(String(key.userId), String(save.id), `${version.id}-${sha1.slice(0, 8)}.bin`);
  await fs.promises.writeFile(path.join(env.savesDir, rel), buf);
  await prisma.saveVersion.update({ where: { id: version.id }, data: { path: rel } });
  // The new version becomes current unless told otherwise (conflicts).
  // Dates are not compared: handheld clocks are unreliable.
  if (opts.makeCurrent !== false || !save.currentVersionId) {
    await prisma.save.update({ where: { id: save.id }, data: { currentVersionId: version.id } });
    // The user's other devices fetch it now instead of at their next regular pass
    await nudgeDevices(key.userId, opts.sourceDeviceId);
  }
  await pruneVersions(save.id);
  return { save, version: { ...version, path: rel }, created: true };
}

async function pruneVersions(saveId: number) {
  const save = await prisma.save.findUniqueOrThrow({ where: { id: saveId } });
  const old = await prisma.saveVersion.findMany({ where: { saveId }, orderBy: { createdAt: 'desc' }, skip: await saveHistory() });
  const keep = new Set((await prisma.saveConflict.findMany({ where: { saveId, resolvedAt: null } })).flatMap((c) => [c.deviceVersionId, c.serverVersionId]));
  // What each device holds stays: a sync only overwrites a device's file when it is that version, so its content
  // is always on the server
  for (const d of await prisma.saveDeviceState.findMany({ where: { saveId }, select: { versionId: true } })) if (d.versionId) keep.add(d.versionId);
  for (const v of old) {
    // Shared versions stay until their owner stops sharing them
    if (v.id === save.currentVersionId || keep.has(v.id) || v.sharedAt) continue;
    await removeVersion(v);
  }
}

export async function removeVersion(v: { id: number; path: string; thumbPath: string | null }) {
  await fs.promises.rm(path.join(env.savesDir, v.path), { force: true });
  if (v.thumbPath) await fs.promises.rm(path.join(env.savesDir, v.thumbPath), { force: true });
  await prisma.saveVersion.delete({ where: { id: v.id } });
}

export const THUMB_MAX = 4 * 1024 * 1024;

/** Media type of a screenshot by its first bytes; NextUI writes PNG data into its .bmp files */
export function imageType(buf: Buffer): string | null {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 26 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return null;
}

/** Keeps the emulator's screenshot of a savestate next to the version's file */
export async function storeThumb(versionId: number, buf: Buffer) {
  if (!buf.length || buf.length > THUMB_MAX || !imageType(buf)) return false;
  const v = await prisma.saveVersion.findUniqueOrThrow({ where: { id: versionId } });
  const rel = v.path.replace(/\.bin$/, '') + '-thumb';
  await fs.promises.writeFile(path.join(env.savesDir, rel), buf);
  if (v.thumbPath !== rel) await prisma.saveVersion.update({ where: { id: v.id }, data: { thumbPath: rel } });
  return true;
}

export async function readThumb(thumbPath: string) {
  const buf = await fs.promises.readFile(path.join(env.savesDir, thumbPath));
  return { buf, type: imageType(buf) ?? 'application/octet-stream' };
}

export async function readVersion(versionId: number): Promise<Buffer> {
  const v = await prisma.saveVersion.findUniqueOrThrow({ where: { id: versionId } });
  return fs.promises.readFile(path.join(env.savesDir, v.path));
}

/** The server's rom a save belongs to: its own, one of its game's (the one named like the save first), or by name */
export async function romForSave(s: { romId: number | null; gameId: number | null; baseName: string }) {
  const withFile = { parts: { some: { files: { some: { status: { in: ['MATCHED' as const, 'UNVERIFIED' as const] } } } } } };
  const include = { game: { include: { system: true } } };
  if (s.romId) {
    const r = await prisma.rom.findFirst({ where: { id: s.romId, ...withFile }, include });
    if (r) return r;
  }
  if (s.gameId) {
    const roms = await prisma.rom.findMany({ where: { gameId: s.gameId, ...withFile }, include });
    const named = roms.find((r) => r.name.toLowerCase() === s.baseName.toLowerCase());
    if (named ?? roms[0]) return named ?? roms[0];
  }
  return prisma.rom.findFirst({ where: { name: s.baseName, ...withFile }, include });
}

/**
 * A file on the server named like the save that belongs to no rom of the catalogue (a translation only
 * RetroAchievements knows, fetched from a console for its saves)
 */
export async function looseRomFile(baseName: string) {
  const files = await prisma.romFile.findMany({
    where: { romPartId: null, romHackId: null, status: 'UNVERIFIED', relativePath: { contains: `${baseName}.` } },
    include: { romPath: true },
  });
  const f = files.find((f) => path.posix.basename(f.relativePath).replace(/\.[^.]+$/, '') === baseName && f.systemId);
  return f ? { ...f, system: await prisma.system.findUniqueOrThrow({ where: { id: f.systemId! } }) } : null;
}
