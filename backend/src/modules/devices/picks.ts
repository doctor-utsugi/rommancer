/**
 * The list of games picked for a device: browsed on the console (modules/browse) or sent from the web app. A list
 * given to the device like any other, so its games download, count against the free-space reserve, survive "delete
 * games in no list" and show as a collection; marked by Device.picksListId so a rename or an untick never makes another.
 */
import type { Device } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { itemKey, toRomItems } from '../lists/service.js';

const picksName = (d: Device) => `→ ${d.name}`;

/** The device's picks list, made on first use (an older one found by its name is taken over), given to the device */
export async function picksList(d: Device) {
  let list = d.picksListId ? await prisma.list.findUnique({ where: { id: d.picksListId } }) : null;
  list ??= await prisma.list.findFirst({ where: { ownerId: d.userId, name: picksName(d), devices: { some: { deviceId: d.id } } } });
  list ??= await prisma.list.create({ data: { ownerId: d.userId, name: picksName(d), kind: 'device', description: `Games picked for ${d.name}` } });
  if (d.picksListId !== list.id) await prisma.device.update({ where: { id: d.id }, data: { picksListId: list.id } });
  if (list.name !== picksName(d) || list.kind !== 'device') list = await prisma.list.update({ where: { id: list.id }, data: { name: picksName(d), kind: 'device' } });
  // Unticked on the console or in the web app: picking again gives it back
  await prisma.deviceList.upsert({ where: { deviceId_listId: { deviceId: d.id, listId: list.id } }, create: { deviceId: d.id, listId: list.id }, update: {} });
  return list;
}

/** Adds roms and romhacks (already chosen) to the device's picks; returns how many were new */
export async function addPicks(d: Device, items: { romId?: number; hackId?: number }[]) {
  const list = await picksList(d);
  const last = await prisma.listItem.aggregate({ where: { listId: list.id }, _max: { position: true } });
  let pos = (last._max.position ?? 0) + 1;
  const r = await prisma.listItem.createMany({
    data: items.map((i) => ({ listId: list.id, romId: i.romId ?? null, hackId: i.hackId ?? null, itemKey: itemKey(i), position: pos++ })),
    skipDuplicates: true,
  });
  await prisma.list.update({ where: { id: list.id }, data: { updatedAt: new Date() } });
  return { listId: list.id, added: r.count };
}

/** Games sent from the web app: each becomes its best rom, as the web's own list adds do */
export async function sendGames(d: Device, gameIds: number[]) {
  const items = await toRomItems(gameIds.map((gameId) => ({ gameId })));
  return addPicks(d, items.map((i) => ({ romId: i.romId, hackId: i.hackId })));
}
