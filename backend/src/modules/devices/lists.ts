import path from 'node:path';
import type { Device, Firmware } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { forbidden } from '../../lib/http.js';
import { hasPermission, normalizePermissions } from '../../lib/permissions.js';
import type { AuthUser } from '../auth/middleware.js';
import { favoritesList, loadList } from '../lists/service.js';
import { prunePlan } from './prune.js';

/** The device's owner, for what the console does on their behalf (it holds no session of its own) */
export async function deviceUser(d: Device): Promise<AuthUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: d.userId } });
  return { id: u.id, username: u.username, role: u.role, permissions: normalizePermissions(u.permissions), mustChangePassword: false };
}

/** The lists a user may give a device: their own, those shared with them and the public ones; their favourites first */
export async function visibleLists(u: AuthUser) {
  if (!hasPermission(u, 'lists')) return [];
  await favoritesList(u.id);
  const lists = await prisma.list.findMany({
    // What the lists page shows them (an admin too: others' private lists stay out of the way)
    where: { OR: [{ ownerId: u.id }, { shares: { some: { userId: u.id } } }, { visibility: 'PUBLIC' }] },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, name: true, kind: true, ownerId: true, owner: { select: { username: true } }, _count: { select: { items: true } } },
  });
  return lists.sort((a, b) => Number(b.kind === 'favorites' && b.ownerId === u.id) - Number(a.kind === 'favorites' && a.ownerId === u.id));
}

/** Gives the device these lists (and only these); the console looks at them again on its next poll */
export async function setDeviceLists(d: Device, u: AuthUser, listIds: number[]) {
  if (!hasPermission(u, 'roms.download')) throw forbidden();
  const ids = [...new Set(listIds)];
  for (const id of ids) await loadList(id, u);
  await prisma.$transaction([
    prisma.deviceList.deleteMany({ where: { deviceId: d.id } }),
    prisma.deviceList.createMany({ data: ids.map((listId) => ({ deviceId: d.id, listId })) }),
    prisma.device.update({ where: { id: d.id }, data: { wantSyncAt: new Date() } }),
  ]);
  return ids;
}

/**
 * What giving the device these lists would delete from it: nothing unless it deletes roms in no list; then the files
 * that would go now, those that go once the server has them, and those that stay (the server cannot get them)
 */
export async function listsPreview(d: Device & { firmware: Firmware }, u: AuthUser, listIds: number[]) {
  for (const id of listIds) await loadList(id, u);
  if (!d.pruneRoms || !d.inventoryAt) return { prune: d.pruneRoms, inventory: !!d.inventoryAt };
  const now = await prunePlan(d);
  const next = await prunePlan(d, d.rootPath, [...new Set(listIds)]);
  // Only what this change adds to what would go anyway
  const before = new Set([...now.del, ...now.upload].map((f) => f.path));
  const fresh = (files: { path: string; size: number }[]) => files.filter((f) => !before.has(f.path));
  const del = fresh(next.del);
  const upload = fresh(next.upload);
  const bytes = (files: { size: number }[]) => files.reduce((n, f) => n + f.size, 0);
  return {
    prune: true,
    inventory: true,
    del: del.length,
    delBytes: bytes(del),
    upload: upload.length,
    uploadBytes: bytes(upload),
    stuck: Math.max(0, next.stuck - now.stuck),
    total: next.total,
    sample: [...del, ...upload].slice(0, 50).map((f) => path.posix.basename(f.path)),
  };
}
