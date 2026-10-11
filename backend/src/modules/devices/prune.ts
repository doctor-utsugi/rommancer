/**
 * Roms on a device that belong to none of its lists, for devices whose owner asked to delete them. The device's
 * own inventory decides: a file stays when a list puts it there (by path), when a list holds its game (another
 * version counts, as for copying) or when it goes with a file that stays (a cue sheet's tracks). Files of no
 * system (ports, apps, BIOS folders) never go. A file the server does not have yet is first fetched from the
 * device (only where the device lets the server fetch roms and the user may upload them) and deleted once it is
 * stored; without that it stays. A deletion of more than half of the device's roms waits for the user's word.
 */
import path from 'node:path';
import type { Device, Firmware } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { hasPermission, normalizePermissions } from '../../lib/permissions.js';
import { ownedRomIds } from '../roms/service.js';
import { devicePlan } from './plan.js';

export interface PruneFile {
  path: string;
  size: number;
}

export interface PrunePlan {
  /** Files to delete now (paths as the device sees itself) */
  del: PruneFile[];
  /** Files that go once the server has them (being fetched, or to be) */
  upload: PruneFile[];
  /** Files that stay although in no list: the server cannot get them */
  stuck: number;
  /** Roms with a system on the device */
  total: number;
  /** The deletion is big enough to wait for the user's word (null: it goes ahead) */
  held: number | null;
}

/** Above this share of the device's roms (and this many files), a deletion is held for confirmation */
const HOLD_SHARE = 0.5;
const HOLD_MIN = 10;

const stem = (name: string) => name.replace(/\.[^.]+$/, '');

/** A file that goes with one that stays: same folder, its name starts with the other's ("Game (Track 2).bin" by "Game.cue") */
function companionOf(file: string, kept: Map<string, string[]>) {
  const stems = kept.get(path.posix.dirname(file));
  if (!stems) return false;
  const name = path.posix.basename(file);
  return stems.some((s) => name === s || name.startsWith(`${s}.`) || name.startsWith(`${s} (`));
}

/** HOME: the device's own root (inventory paths are kept in its terms) */
export async function prunePlan(device: Device & { firmware: Firmware }, home = device.rootPath): Promise<PrunePlan> {
  const plan = await devicePlan(device, home, home);
  const listPaths = new Set(plan.files.map((f) => f.dest));
  const listGames = new Set(plan.files.flatMap((f) => (f.gameId ? [f.gameId] : [])));
  const rows = await prisma.deviceRom.findMany({ where: { deviceId: device.id } });
  // A game's system when its folder named none (the same rule as the inventory)
  const gameIds = [...new Set(rows.flatMap((r) => [r.gameId, r.baseGameId].filter((x): x is number => !!x)))];
  const games = gameIds.length ? await prisma.game.findMany({ where: { id: { in: gameIds } }, select: { id: true, system: { select: { slug: true } } } }) : [];
  const slugOf = new Map(games.map((g) => [g.id, g.system.slug]));
  const roms = rows.filter((r) => r.systemSlug ?? slugOf.get(r.gameId ?? r.baseGameId ?? 0));
  const stays = (r: (typeof rows)[number]) => listPaths.has(r.path) || (r.gameId !== null && listGames.has(r.gameId));
  const kept = new Map<string, string[]>();
  for (const r of roms.filter(stays)) {
    const dir = path.posix.dirname(r.path);
    kept.set(dir, [...(kept.get(dir) ?? []), stem(path.posix.basename(r.path))]);
  }
  const extra = roms.filter((r) => !stays(r) && !companionOf(r.path, kept));
  // On the server: its rom is owned, the same content is stored, or a fetch of this very file finished
  const ownedRoms = await ownedRomIds({ romIds: [...new Set(extra.flatMap((r) => (r.romId ? [r.romId] : [])))], include: 'any' });
  const sha1s = [...new Set(extra.flatMap((r) => [r.sha1, r.headerlessSha1].filter((x): x is string => !!x)))];
  const stored = new Set(sha1s.length ? (await prisma.romFile.findMany({ where: { sha1: { in: sha1s } }, select: { sha1: true } })).map((f) => f.sha1) : []);
  const pulls = await prisma.devicePull.findMany({ where: { deviceId: device.id, path: { in: extra.map((r) => r.path) } }, select: { path: true, status: true } });
  const pullOf = new Map<string, string>();
  for (const p of pulls) if (pullOf.get(p.path) !== 'done') pullOf.set(p.path, p.status);
  const user = await prisma.user.findUnique({ where: { id: device.userId }, select: { role: true, permissions: true } });
  const canFetch = device.allowPull && !!user && hasPermission({ role: user.role, permissions: normalizePermissions(user.permissions) }, 'roms.upload');
  const del: PruneFile[] = [];
  const upload: PruneFile[] = [];
  let stuck = 0;
  for (const r of extra) {
    const file = { path: r.path, size: Number(r.size) };
    const onServer = (r.romId && ownedRoms.has(r.romId)) || (r.sha1 && stored.has(r.sha1)) || (r.headerlessSha1 && stored.has(r.headerlessSha1)) || pullOf.get(r.path) === 'done';
    if (onServer) del.push(file);
    else if (canFetch && pullOf.get(r.path) !== 'failed') upload.push(file);
    else stuck++;
  }
  const big = del.length >= HOLD_MIN && del.length > roms.length * HOLD_SHARE;
  const held = big && !(device.pruneAllow !== null && del.length <= device.pruneAllow) ? del.length : null;
  return { del, upload, stuck, total: roms.length, held };
}

/** Asks the device for the files still to fetch before they can be deleted (once per file) */
export async function queuePrunePulls(deviceId: number, files: PruneFile[]) {
  if (!files.length) return;
  const queued = new Set(
    (await prisma.devicePull.findMany({ where: { deviceId, path: { in: files.map((f) => f.path) }, status: { in: ['pending', 'sending', 'paused'] } }, select: { path: true } })).map((p) => p.path),
  );
  const fresh = files.filter((f) => !queued.has(f.path));
  if (fresh.length) await prisma.devicePull.createMany({ data: fresh.map((f) => ({ deviceId, path: f.path })) });
}
