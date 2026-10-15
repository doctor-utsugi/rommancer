import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { HttpError, badRequest } from '../../lib/http.js';
import { hash, HASH, UUID, type Entry } from './manifest.js';
import { nudgeDevices } from '../saves/nudge.js';

export const blobPath = (userId: number, sha1: string) => path.join(env.savesDir, 'journeys', String(userId), sha1.slice(0, 2), sha1);
const json = (entries: Entry[]) => entries as unknown as Prisma.InputJsonValue;

export async function owned(userId: number, id: string) {
  const j = await prisma.journey.findFirst({ where: { id, userId } });
  if (!j) throw new HttpError(404, 'Journey not found');
  return j;
}

export async function revision(userId: number, id: string, number?: number) {
  const j = await owned(userId, id);
  const r = await prisma.journeyRevision.findFirst({ where: { journeyId: id, number: number ?? j.head, conflict: false } });
  return { journey: j, revision: r, entries: (r?.manifest ?? []) as unknown as Entry[] };
}

export async function putBlob(userId: number, sha1: string, data: Buffer) {
  if (!HASH.test(sha1) || hash(data) !== sha1) throw badRequest('Journey checksum mismatch');
  const dest = blobPath(userId, sha1);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${crypto.randomUUID()}.tmp`;
  const file = await fs.open(tmp, 'wx');
  try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
  try { await fs.rename(tmp, dest); } finally { await fs.rm(tmp, { force: true }); }
  const dir = await fs.open(path.dirname(dest), 'r');
  try { await dir.sync(); } finally { await dir.close(); }
  await prisma.journeyBlob.upsert({ where: { userId_sha1: { userId, sha1 } }, create: { userId, sha1, size: data.length }, update: {} });
}

export async function createJourney(userId: number, input: { id: string; identityId: string; name: string; sourceId?: string; sourceRevision?: number }) {
  if (!UUID.test(input.id) || !HASH.test(input.identityId) || !input.name.trim() || input.name.length > 80) throw badRequest('Invalid journey');
  const existing = await prisma.journey.findUnique({ where: { id: input.id } });
  if (existing) {
    if (existing.userId !== userId || existing.identityId !== input.identityId) throw new HttpError(409, 'Journey id already used');
    return existing;
  }
  if (!(await prisma.romIdentity.findUnique({ where: { id: input.identityId } }))) throw badRequest('Unknown ROM identity');
  let entries: Entry[] = [];
  if (input.sourceId) {
    if (input.sourceRevision === undefined) throw badRequest('Source revision required');
    const source = await revision(userId, input.sourceId, input.sourceRevision);
    if (source.journey.identityId !== input.identityId || (input.sourceRevision > 0 && !source.revision)) throw badRequest('Invalid source checkpoint');
    entries = source.entries;
  }
  const created = await prisma.journey.create({ data: {
    id: input.id, userId, identityId: input.identityId, name: input.name.trim(), head: entries.length ? 1 : 0,
    ...(entries.length ? { revisions: { create: { id: crypto.randomUUID(), number: 1, base: 0, manifest: json(entries) } } } : {}),
  } });
  await nudgeDevices(userId);
  return created;
}

export async function commit(userId: number, id: string, base: number, operation: string, entries: Entry[], sourceDeviceId?: number) {
  await owned(userId, id);
  if (!UUID.test(operation) || !Number.isInteger(base) || base < 0) throw badRequest('Invalid checkpoint operation');
  const old = await prisma.journeyRevision.findUnique({ where: { id: operation } });
  if (old) {
    if (old.journeyId !== id || old.base !== base || JSON.stringify(old.manifest) !== JSON.stringify(entries)) throw new HttpError(409, 'Operation id already used');
    return old;
  }
  const blobs = await prisma.journeyBlob.findMany({ where: { userId, sha1: { in: entries.map((e) => e.sha1) } } });
  if (entries.some((e) => !blobs.some((b) => b.sha1 === e.sha1 && b.size === e.size))) throw badRequest('Missing journey files');
  const result = await prisma.$transaction(async (tx) => {
    const changed = await tx.journey.updateMany({ where: { id, userId, head: base, archived: false }, data: { head: { increment: 1 } } });
    const j = await tx.journey.findUniqueOrThrow({ where: { id } });
    if (j.archived) throw new HttpError(409, 'Journey archived; local progress must be kept for recovery');
    return tx.journeyRevision.create({ data: { id: operation, journeyId: id, base, number: changed.count ? base + 1 : j.head, conflict: !changed.count, manifest: json(entries), sourceDeviceId } });
  });
  if (!result.conflict) await nudgeDevices(userId);
  return result;
}

export async function select(userId: number, deviceId: number, bindingId: string, journeyId: string, generation: number, operation: string, commandId?: string) {
  const j = await owned(userId, journeyId);
  if (!UUID.test(operation) || !Number.isSafeInteger(generation) || generation < 1) throw badRequest('Invalid selection');
  return prisma.$transaction(async (tx) => {
    const binding = await tx.journeyBinding.findFirst({ where: { id: bindingId, deviceId } });
    if (!binding || binding.identityId !== j.identityId || j.archived) throw badRequest('Invalid journey selection');
    if (binding.operation === operation && binding.generation === generation && binding.journeyId === journeyId) return binding;
    if (generation <= binding.generation) throw new HttpError(409, 'Selection superseded');
    const updated = await tx.journeyBinding.updateMany({ where: { id: binding.id, generation: binding.generation }, data: { journeyId, generation, operation } });
    if (!updated.count) throw new HttpError(409, 'Selection changed concurrently');
    await tx.journeyCommand.updateMany({ where: { bindingId, status: { in: ['pending', 'waiting', 'downloading', 'error'] } }, data: { status: 'superseded' } });
    if (commandId) await tx.journeyCommand.updateMany({ where: { id: commandId, bindingId, journeyId, generation: generation - 1, status: 'superseded' }, data: { status: 'applied' } });
    return tx.journeyBinding.findUniqueOrThrow({ where: { id: binding.id } });
  });
}

export async function isManaged(deviceId: number, romPath?: string, filePath?: string) {
  const bindings = await prisma.journeyBinding.findMany({ where: { deviceId } });
  return bindings.some((b) => b.romPath === romPath || Object.values(b.layout as Record<string, unknown>).some((v) => typeof v === 'string' && filePath && filePath.startsWith(v) && v.startsWith('/')));
}

export async function listJourneys(userId: number, identityId?: string) {
  const journeys = await prisma.journey.findMany({ where: { userId, ...(identityId ? { identityId } : {}) }, include: { identity: true }, orderBy: { updatedAt: 'desc' } });
  const bindings = await prisma.journeyBinding.findMany({ where: { device: { userId } }, include: { device: { select: { id: true, name: true, lastSeenAt: true } }, commands: { orderBy: { createdAt: 'desc' }, take: 10 } } });
  return Promise.all(journeys.map(async (j) => {
    const devices = bindings.filter((b) => b.identityId === j.identityId);
    const title = devices[0] ? path.posix.basename(devices[0].romPath) : `${j.identity.platform} ROM ${j.identity.digest.slice(0, 12)}`;
    return { ...j, identity: { ...j.identity, title }, entries: (await revision(userId, j.id)).entries, devices };
  }));
}
