import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Emulator, SaveKind } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';

const MAX_VERSIONS = 50;

export interface SaveKey {
  userId: number;
  emulatorId: number;
  kind: SaveKind;
  slot: number;
  baseName: string;
}

/** Busca la rom/juego que corresponde a un nombre de fichero (sin extension). */
export async function identifyRom(baseName: string, systemId?: number | null) {
  const rom = await prisma.rom.findFirst({
    where: { name: baseName, ...(systemId ? { game: { systemId } } : {}) },
    select: { id: true, gameId: true, game: { select: { systemId: true } } },
  });
  if (rom) return { romId: rom.id, gameId: rom.gameId, systemId: rom.game.systemId };
  // Nombre de fichero local distinto del DAT: se busca por el fichero escaneado
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

export async function storeVersion(key: SaveKey, buf: Buffer, fileMtime: Date, opts: { sourceDeviceId?: number; note?: string; gameId?: number | null; romId?: number | null; force?: boolean } = {}) {
  const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
  let save = await prisma.save.findUnique({
    where: { userId_emulatorId_kind_slot_baseName: key },
    include: { versions: { orderBy: { fileMtime: 'desc' } } },
  });
  if (!save) {
    const ident = opts.gameId !== undefined ? { gameId: opts.gameId ?? null, romId: opts.romId ?? null } : await identifyRom(key.baseName);
    save = await prisma.save.create({
      data: { ...key, gameId: ident?.gameId ?? null, romId: ident?.romId ?? null },
      include: { versions: { orderBy: { fileMtime: 'desc' } } },
    });
  }
  const existing = save.versions.find((v) => v.sha1 === sha1);
  if (existing && !opts.force) return { save, version: existing, created: false };
  const dir = path.join(env.savesDir, String(key.userId), String(save.id));
  await fs.promises.mkdir(dir, { recursive: true });
  const version = await prisma.saveVersion.create({
    data: { saveId: save.id, path: '', size: buf.length, sha1, fileMtime, sourceDeviceId: opts.sourceDeviceId ?? null, note: opts.note ?? null },
  });
  const rel = path.join(String(key.userId), String(save.id), `${version.id}-${sha1.slice(0, 8)}.bin`);
  await fs.promises.writeFile(path.join(env.savesDir, rel), buf);
  await prisma.saveVersion.update({ where: { id: version.id }, data: { path: rel } });
  // El mas reciente gana; las versiones anteriores quedan en el historial
  const current = save.versions.find((v) => v.id === save!.currentVersionId);
  if (!current || fileMtime >= current.fileMtime) await prisma.save.update({ where: { id: save.id }, data: { currentVersionId: version.id } });
  await pruneVersions(save.id);
  return { save, version: { ...version, path: rel }, created: true };
}

async function pruneVersions(saveId: number) {
  const save = await prisma.save.findUniqueOrThrow({ where: { id: saveId } });
  const old = await prisma.saveVersion.findMany({ where: { saveId }, orderBy: { createdAt: 'desc' }, skip: MAX_VERSIONS });
  for (const v of old) {
    if (v.id === save.currentVersionId) continue;
    await fs.promises.rm(path.join(env.savesDir, v.path), { force: true });
    await prisma.saveVersion.delete({ where: { id: v.id } });
  }
}

export async function readVersion(versionId: number): Promise<Buffer> {
  const v = await prisma.saveVersion.findUniqueOrThrow({ where: { id: versionId } });
  return fs.promises.readFile(path.join(env.savesDir, v.path));
}
