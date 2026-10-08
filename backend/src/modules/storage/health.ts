/**
 * Folder health: whether a registered folder really is there before anything trusts its contents. A disk
 * that is unplugged or not mounted usually leaves an empty mount point behind, which a scan would read as
 * "every file was deleted"; here it is "offline" instead, and its index and destinations are left alone.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { RomPath } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

/** Marker written at the root of folders Rommancer may write to; holds RomPath.volumeId */
export const MARKER = '.rommancer-id';
/** Hidden folder at the root of a destination for files being written; leftovers of a crash are removed */
export const TMP_DIR = '.rommancer-tmp';

export interface Health {
  online: boolean;
  reason?: 'missing' | 'not-directory' | 'unreadable' | 'not-mounted' | 'other-volume' | 'empty';
  free?: number;
  total?: number;
}

const devOf = async (p: string) => (await fs.promises.stat(p).catch(() => null))?.dev;

/** Disk space of the filesystem holding P (bytes available to this process, and its size) */
export async function diskSpace(p: string): Promise<{ free: number; total: number } | null> {
  const s = await fs.promises.statfs(p).catch(() => null);
  return s ? { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) } : null;
}

/** Filesystem id of P: destinations on the same disk share their free space */
export const volumeKey = async (p: string) => String((await devOf(p)) ?? p);

/**
 * Gives a folder its identity when it is registered (or made writable): an id, whether it is a mount point,
 * and the marker file when Rommancer may write there (read-only sources are never written).
 */
export async function registerIdentity(rp: RomPath): Promise<RomPath> {
  const volumeId = rp.volumeId ?? crypto.randomUUID();
  const here = await devOf(rp.path);
  const parent = await devOf(path.dirname(rp.path));
  const wasMount = here !== undefined && parent !== undefined && here !== parent;
  if (!rp.readOnly) await fs.promises.writeFile(path.join(rp.path, MARKER), volumeId + '\n').catch(() => {});
  return prisma.romPath.update({ where: { id: rp.id }, data: { volumeId, wasMount: rp.wasMount || wasMount } });
}

/** Checks that the folder is reachable and is the same one; KNOWN = files the index holds for it */
export async function checkPath(rp: RomPath, known = 0): Promise<Health> {
  const st = await fs.promises.stat(rp.path).catch(() => null);
  if (!st) return { online: false, reason: 'missing' };
  if (!st.isDirectory()) return { online: false, reason: 'not-directory' };
  const entries = await fs.promises.readdir(rp.path).catch(() => null);
  if (!entries) return { online: false, reason: 'unreadable' };
  // It was a mount point and now lives on its parent's disk: the disk is not mounted
  if (rp.wasMount && st.dev === (await devOf(path.dirname(rp.path)))) return { online: false, reason: 'not-mounted' };
  if (rp.volumeId && !rp.readOnly) {
    const marker = (await fs.promises.readFile(path.join(rp.path, MARKER), 'utf8').catch(() => null))?.trim();
    // Another Rommancer folder mounted in its place (a missing marker proves nothing: it may never have been written)
    if (marker && marker !== rp.volumeId) return { online: false, reason: 'other-volume' };
  }
  if (!entries.some((e) => !e.startsWith('.')) && known > 0) return { online: false, reason: 'empty' };
  return { online: true, ...(await diskSpace(rp.path)) };
}

/** Checks a folder and records the result (offline since when, and why) */
export async function refreshHealth(rp: RomPath, known?: number): Promise<Health> {
  const files = known ?? (await prisma.romFile.count({ where: { romPathId: rp.id } }));
  const h = await checkPath(rp, files);
  if (h.online && rp.offlineAt) await prisma.romPath.update({ where: { id: rp.id }, data: { offlineAt: null, offlineReason: null } });
  if (!h.online && (!rp.offlineAt || rp.offlineReason !== h.reason)) {
    await prisma.romPath.update({ where: { id: rp.id }, data: { offlineAt: rp.offlineAt ?? new Date(), offlineReason: h.reason } });
  }
  // Older folders get their identity the first time they are seen healthy
  if (h.online && !rp.volumeId) await registerIdentity(rp);
  return h;
}

/** Files left half-written by a crash (older than an hour, so nothing being written right now) */
async function cleanTmp(root: string) {
  const dir = path.join(root, TMP_DIR);
  for (const f of await fs.promises.readdir(dir).catch(() => [] as string[])) {
    const st = await fs.promises.stat(path.join(dir, f)).catch(() => null);
    if (st && Date.now() - st.mtimeMs > 3600_000) await fs.promises.rm(path.join(dir, f), { force: true, recursive: true });
  }
}

let timer: NodeJS.Timeout | null = null;

/** Every few minutes: which folders are reachable (cheap: a stat and a readdir of each root) */
export function startHealthWatch(intervalMs = 5 * 60_000) {
  const run = async () => {
    for (const rp of await prisma.romPath.findMany()) {
      const h = await refreshHealth(rp).catch(() => null);
      if (h?.online && !rp.readOnly) await cleanTmp(rp.path);
    }
  };
  void run().catch(() => {});
  timer = setInterval(() => void run().catch((e) => console.error('health watch', e)), intervalMs);
}

export function stopHealthWatch() {
  if (timer) clearInterval(timer);
}
