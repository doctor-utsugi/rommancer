/**
 * What a device's lists would copy to it: every file with its size, whether the device already has it, and
 * whether the user left it out (by system or by game). The same plan decides what an automatic copy sends
 * (in list order, while the device keeps its free-space reserve) and feeds the "choose what not to copy" tree.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Device, Firmware } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { resolveListFiles } from '../lists/service.js';
import { copiesSystem, folderFor, layoutOf, systemFilterOf } from './sink.js';

export interface PlanFile {
  dest: string;
  size: number;
  absPath: string;
  archiveEntry: string | null;
  system: string;
  gameId: number | null;
  title: string;
  present: boolean;
  excluded: boolean;
}

export interface Plan {
  files: PlanFile[];
  /** Bytes still to copy (not present, not left out) */
  missingBytes: number;
  free: number | null;
  total: number | null;
  reserveBytes: number | null;
  /** Bytes that can be copied before reaching the reserve (null: space unknown) */
  budget: number | null;
}

const pathKey = (p: string) => crypto.createHash('sha1').update(p).digest('hex');

/** ROOT: where the device is seen for this plan (a computer may see a console's card under its own mount) */
export async function devicePlan(device: Device & { firmware: Firmware }, root = device.rootPath, homeRoot = device.rootPath): Promise<Plan> {
  const layout = layoutOf(device);
  const filter = systemFilterOf(device);
  const excludedGames = new Set(filter.excludedGames);
  const inv = await prisma.deviceRom.findMany({ where: { deviceId: device.id }, select: { pathHash: true, gameId: true } });
  const havePaths = new Set(inv.map((r) => r.pathHash));
  const haveGames = new Set(inv.flatMap((r) => (r.gameId ? [r.gameId] : [])));
  const files: PlanFile[] = [];
  const seen = new Set<string>();
  for (const { listId } of await prisma.deviceList.findMany({ where: { deviceId: device.id }, select: { listId: true } })) {
    const { items } = await resolveListFiles(listId);
    const romIds = items.flatMap((i) => (i.romId ? [i.romId] : []));
    const hackIds = items.flatMap((i) => (i.hackId ? [i.hackId] : []));
    const roms = romIds.length ? await prisma.rom.findMany({ where: { id: { in: romIds } }, select: { id: true, gameId: true, parts: { select: { size: true } } } }) : [];
    const hacks = hackIds.length ? await prisma.romHack.findMany({ where: { id: { in: hackIds } }, select: { id: true, gameId: true } }) : [];
    const romOf = new Map(roms.map((r) => [r.id, r]));
    const hackGame = new Map(hacks.map((h) => [h.id, h.gameId]));
    for (const it of items) {
      const folder = folderFor(layout, it.systemSlug);
      const gameId = it.romId ? (romOf.get(it.romId)?.gameId ?? null) : it.hackId ? (hackGame.get(it.hackId) ?? null) : null;
      for (const f of it.files) {
        const rel = path.posix.join(layout.romsRoot, folder, f.destName);
        const dest = path.posix.join(root.replace(/\/+$/, ''), rel);
        if (seen.has(dest)) continue;
        seen.add(dest);
        // Archive entries: the catalogue knows the size; plain files: the file itself
        const size = f.archiveEntry
          ? Number(romOf.get(it.romId ?? -1)?.parts.reduce((n, p) => n + Number(p.size), 0) ?? 0)
          : ((await fs.promises.stat(f.absPath).catch(() => null))?.size ?? 0);
        const present = havePaths.has(pathKey(path.posix.join(homeRoot.replace(/\/+$/, ''), rel))) || (gameId !== null && haveGames.has(gameId));
        const excluded = !copiesSystem(filter, it.systemSlug) || (gameId !== null && excludedGames.has(gameId));
        files.push({ dest, size, absPath: f.absPath, archiveEntry: f.archiveEntry ?? null, system: it.systemSlug, gameId, title: it.title, present, excluded });
      }
    }
  }
  const missingBytes = files.filter((f) => !f.present && !f.excluded).reduce((n, f) => n + f.size, 0);
  const free = device.spaceFree != null ? Number(device.spaceFree) : null;
  const total = device.spaceTotal != null ? Number(device.spaceTotal) : null;
  const reserveBytes = total != null ? Math.round((total * device.reservePercent) / 100) : null;
  const budget = free != null && reserveBytes != null ? Math.max(0, free - reserveBytes) : null;
  return { files, missingBytes, free, total, reserveBytes, budget };
}
