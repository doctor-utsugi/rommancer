import { Router } from 'express';
import { ZipArchive } from 'archiver';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, intParam } from '../../lib/http.js';
import { safeFileName } from '../../lib/romname.js';
import { extractEntryStream } from '../../lib/tools.js';
import { me } from '../auth/middleware.js';
import { ownedRomIds, pickRom, type RomPreference } from '../roms/service.js';
import { itemKey, loadList, resolveListFiles } from './service.js';

export const listsRouter = Router();

const listBody = z.object({
  name: z.string().min(1).max(191),
  description: z.string().max(5000).nullable().optional(),
  visibility: z.enum(['PRIVATE', 'SHARED', 'PUBLIC']).default('PRIVATE'),
  isCollaborative: z.boolean().default(false),
});

const prefSchema = z.object({
  regions: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
  raOnly: z.boolean().optional(),
  ownedOnly: z.boolean().optional(),
  strictRegions: z.boolean().optional(),
  excludeFlags: z.array(z.string()).optional(),
});

listsRouter.get('/', async (req, res) => {
  const u = me(req);
  const scope = z.enum(['mine', 'shared', 'public', 'all']).default('all').parse(req.query.scope);
  const where: Prisma.ListWhereInput =
    scope === 'mine'
      ? { ownerId: u.id }
      : scope === 'shared'
        ? { shares: { some: { userId: u.id } } }
        : scope === 'public'
          ? { visibility: 'PUBLIC' }
          : { OR: [{ ownerId: u.id }, { shares: { some: { userId: u.id } } }, { visibility: 'PUBLIC' }] };
  const lists = await prisma.list.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    include: { owner: { select: { id: true, username: true } }, _count: { select: { items: true } }, shares: { select: { userId: true, canEdit: true } } },
  });
  res.json(lists);
});

listsRouter.post('/', async (req, res) => {
  const body = listBody.parse(req.body);
  res.status(201).json(await prisma.list.create({ data: { ...body, ownerId: me(req).id } }));
});

listsRouter.get('/:id', async (req, res) => {
  const u = me(req);
  const list = await loadList(intParam(req), u);
  const full = await prisma.list.findUniqueOrThrow({
    where: { id: list.id },
    include: {
      owner: { select: { id: true, username: true } },
      shares: { include: { user: { select: { id: true, username: true } } } },
      parent: { select: { id: true, name: true } },
      items: {
        orderBy: { position: 'asc' },
        include: {
          game: { include: { system: { select: { slug: true, name: true } }, roms: { select: { id: true, name: true, regions: true, languages: true, flags: true, revision: true, raGameId: true, isBios: true } }, media: { where: { type: 'COVER' }, take: 1 } } },
          rom: { include: { game: { include: { system: { select: { slug: true, name: true } }, media: { where: { type: 'COVER' }, take: 1 } } } } },
          hack: { include: { game: { include: { system: { select: { slug: true, name: true } } } }, _count: { select: { files: true } } } },
        },
      },
    },
  });
  const romIds = full.items.flatMap((i) => (i.rom ? [i.rom.id] : (i.game?.roms.map((r) => r.id) ?? [])));
  const owned = await ownedRomIds({ romIds });
  const pref = { ...((full.derivedFilter as RomPreference | null) ?? {}) };
  const share = full.shares.find((s) => s.userId === u.id);
  res.json({
    ...full,
    canEdit: full.ownerId === u.id || !!share?.canEdit || (full.isCollaborative && (full.visibility === 'PUBLIC' || !!share)),
    items: full.items.map((i) => {
      const cover = i.game?.media[0] ?? i.rom?.game.media[0];
      let owned_ = false;
      let selectedRom = null;
      if (i.rom) owned_ = owned.has(i.rom.id);
      else if (i.game) {
        const pick = pickRom(i.game.roms, { ...pref, ownedOnly: false }, owned);
        selectedRom = pick ? { id: pick.id, name: pick.name } : null;
        owned_ = i.game.roms.some((r) => owned.has(r.id));
      } else if (i.hack) owned_ = i.hack._count.files > 0;
      return {
        id: i.id,
        position: i.position,
        note: i.note,
        kind: i.rom ? 'rom' : i.hack ? 'hack' : 'game',
        gameId: i.gameId ?? i.rom?.gameId ?? i.hack?.gameId,
        romId: i.romId,
        hackId: i.hackId,
        title: i.rom?.name ?? i.hack?.title ?? i.game?.title,
        system: i.game?.system ?? i.rom?.game.system ?? i.hack?.game.system,
        cover: cover ? `/api/v1/media/${cover.id}` : null,
        owned: owned_,
        selectedRom,
        ra: i.rom ? !!i.rom.raGameId : !!i.game?.roms.some((r) => r.raGameId),
      };
    }),
  });
});

listsRouter.patch('/:id', async (req, res) => {
  const u = me(req);
  const list = await loadList(intParam(req), u, true);
  const body = listBody.partial().parse(req.body);
  // Solo el propietario cambia visibilidad y modo colaborativo
  if (list.ownerId !== u.id && (body.visibility || body.isCollaborative !== undefined)) throw badRequest('Only the owner can change sharing');
  res.json(await prisma.list.update({ where: { id: list.id }, data: body }));
});

listsRouter.delete('/:id', async (req, res) => {
  const u = me(req);
  const list = await loadList(intParam(req), u);
  if (list.ownerId !== u.id && u.role !== 'ADMIN') throw badRequest('Only the owner can delete');
  await prisma.list.delete({ where: { id: list.id } });
  res.status(204).end();
});

const itemSchema = z
  .object({
    gameId: z.number().int().optional(),
    romId: z.number().int().optional(),
    hackId: z.number().int().optional(),
    note: z.string().max(512).optional(),
  })
  .refine((i) => i.gameId || i.romId || i.hackId, 'gameId, romId or hackId required');

async function addItems(listId: number, items: z.infer<typeof itemSchema>[]) {
  const max = await prisma.listItem.aggregate({ where: { listId }, _max: { position: true } });
  let pos = (max._max.position ?? -1) + 1;
  const data = items.map((i) => ({
    listId,
    gameId: i.romId || i.hackId ? null : i.gameId,
    romId: i.romId ?? null,
    hackId: i.romId ? null : (i.hackId ?? null),
    note: i.note,
    itemKey: itemKey(i),
    position: pos++,
  }));
  const r = await prisma.listItem.createMany({ data, skipDuplicates: true });
  await prisma.list.update({ where: { id: listId }, data: { updatedAt: new Date() } });
  return r.count;
}

listsRouter.post('/:id/items', async (req, res) => {
  const list = await loadList(intParam(req), me(req), true);
  const body = z.union([itemSchema, z.object({ items: z.array(itemSchema).max(10000) })]).parse(req.body);
  const items = 'items' in body ? body.items : [body];
  res.status(201).json({ added: await addItems(list.id, items) });
});

listsRouter.delete('/:id/items/:itemId', async (req, res) => {
  const list = await loadList(intParam(req), me(req), true);
  await prisma.listItem.deleteMany({ where: { id: intParam(req, 'itemId'), listId: list.id } });
  res.status(204).end();
});

listsRouter.put('/:id/order', async (req, res) => {
  const list = await loadList(intParam(req), me(req), true);
  const { itemIds } = z.object({ itemIds: z.array(z.number().int()) }).parse(req.body);
  await prisma.$transaction(itemIds.map((id, position) => prisma.listItem.updateMany({ where: { id, listId: list.id }, data: { position } })));
  res.status(204).end();
});

listsRouter.put('/:id/shares', async (req, res) => {
  const u = me(req);
  const list = await loadList(intParam(req), u);
  if (list.ownerId !== u.id) throw badRequest('Only the owner can share');
  const shares = z.array(z.object({ userId: z.number().int(), canEdit: z.boolean().default(false) })).parse(req.body);
  await prisma.$transaction([
    prisma.listShare.deleteMany({ where: { listId: list.id } }),
    prisma.listShare.createMany({ data: shares.filter((s) => s.userId !== u.id).map((s) => ({ ...s, listId: list.id })) }),
    ...(list.visibility === 'PRIVATE' && shares.length ? [prisma.list.update({ where: { id: list.id }, data: { visibility: 'SHARED' } })] : []),
  ]);
  res.status(204).end();
});

listsRouter.post('/:id/clone', async (req, res) => {
  const u = me(req);
  const src = await loadList(intParam(req), u);
  const { name } = z.object({ name: z.string().min(1).max(191).optional() }).parse(req.body ?? {});
  const items = await prisma.listItem.findMany({ where: { listId: src.id }, orderBy: { position: 'asc' } });
  const copy = await prisma.list.create({
    data: {
      ownerId: u.id,
      name: name ?? `${src.name} (copy)`,
      description: src.description,
      derivedFilter: src.derivedFilter ?? undefined,
      items: { create: items.map(({ gameId, romId, hackId, itemKey, position, note }) => ({ gameId, romId, hackId, itemKey, position, note })) },
    },
  });
  res.status(201).json(copy);
});

/** Genera los elementos de una sublista derivada: para cada juego, la mejor rom segun preferencias. */
async function deriveItems(sourceListId: number, pref: RomPreference) {
  const items = await prisma.listItem.findMany({
    where: { listId: sourceListId },
    orderBy: { position: 'asc' },
    include: { game: { include: { roms: true } }, rom: { include: { game: { include: { roms: true } } } }, hack: true },
  });
  const allRomIds = items.flatMap((i) => (i.game ?? i.rom?.game)?.roms.map((r) => r.id) ?? []);
  const owned = await ownedRomIds({ romIds: allRomIds });
  const out: { romId?: number; hackId?: number }[] = [];
  const skipped: string[] = [];
  for (const i of items) {
    if (i.hack) {
      out.push({ hackId: i.hack.id });
      continue;
    }
    const game = i.game ?? i.rom?.game;
    if (!game) continue;
    const pick = pickRom(game.roms, pref, owned);
    if (pick) out.push({ romId: pick.id });
    else skipped.push(game.title);
  }
  return { items: out, skipped };
}

listsRouter.post('/:id/derive', async (req, res) => {
  const u = me(req);
  const src = await loadList(intParam(req), u);
  const body = prefSchema.extend({ name: z.string().min(1).max(191) }).parse(req.body);
  const { name, ...pref } = body;
  const { items, skipped } = await deriveItems(src.id, pref);
  const list = await prisma.list.create({ data: { ownerId: u.id, name, parentListId: src.id, derivedFilter: pref } });
  const added = await addItems(list.id, items);
  res.status(201).json({ ...list, added, skipped });
});

listsRouter.post('/:id/refresh', async (req, res) => {
  const list = await loadList(intParam(req), me(req), true);
  if (!list.parentListId) throw badRequest('Not a derived list');
  const { items, skipped } = await deriveItems(list.parentListId, (list.derivedFilter ?? {}) as RomPreference);
  await prisma.listItem.deleteMany({ where: { listId: list.id } });
  res.json({ added: await addItems(list.id, items), skipped });
});

listsRouter.get('/:id/export', async (req, res) => {
  const list = await loadList(intParam(req), me(req));
  const format = z.enum(['json', 'txt']).default('json').parse(req.query.format);
  const items = await prisma.listItem.findMany({
    where: { listId: list.id },
    orderBy: { position: 'asc' },
    include: {
      game: { include: { system: true } },
      rom: { include: { game: { include: { system: true } }, parts: { take: 1 } } },
      hack: { include: { game: { include: { system: true } } } },
    },
  });
  const rows = items.map((i) => ({
    system: (i.game?.system ?? i.rom?.game.system ?? i.hack?.game.system)!.slug,
    type: i.rom ? 'rom' : i.hack ? 'hack' : 'game',
    title: i.game?.title ?? i.rom?.game.title ?? i.hack?.game.title,
    rom: i.rom?.name,
    hack: i.hack?.title,
    sha1: i.rom?.parts[0]?.sha1 ?? i.hack?.sha1 ?? undefined,
    note: i.note ?? undefined,
  }));
  const fname = safeFileName(list.name);
  if (format === 'txt') {
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fname)}.txt"`);
    res.type('text/plain').send(rows.map((r) => `${r.system}\t${r.rom ?? r.hack ?? r.title}`).join('\n') + '\n');
    return;
  }
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fname)}.json"`);
  res.json({ format: 'rommancer-list', version: 1, name: list.name, description: list.description, items: rows });
});

listsRouter.post('/import', async (req, res) => {
  const u = me(req);
  const body = z
    .object({
      name: z.string().max(191).optional(),
      description: z.string().nullable().optional(),
      items: z.array(
        z.object({
          system: z.string(),
          type: z.enum(['game', 'rom', 'hack']).default('game'),
          title: z.string().optional(),
          rom: z.string().optional(),
          hack: z.string().optional(),
          sha1: z.string().optional(),
          note: z.string().optional(),
        }),
      ),
    })
    .parse(req.body);
  const resolved: z.infer<typeof itemSchema>[] = [];
  const unresolved: unknown[] = [];
  const { normalizeTitle } = await import('../../lib/romname.js');
  for (const it of body.items) {
    const system = await prisma.system.findUnique({ where: { slug: it.system } });
    if (!system) {
      unresolved.push(it);
      continue;
    }
    if (it.type === 'rom') {
      const rom =
        (it.sha1 ? (await prisma.romPart.findFirst({ where: { sha1: it.sha1 }, select: { romId: true } }))?.romId : null) ??
        (await prisma.rom.findFirst({ where: { name: it.rom ?? '', game: { systemId: system.id } }, select: { id: true } }))?.id;
      if (rom) resolved.push({ romId: rom, note: it.note });
      else unresolved.push(it);
    } else if (it.type === 'hack') {
      const hack = await prisma.romHack.findFirst({ where: it.sha1 ? { sha1: it.sha1 } : { title: it.hack ?? '', game: { systemId: system.id } } });
      if (hack) resolved.push({ hackId: hack.id, note: it.note });
      else unresolved.push(it);
    } else {
      const game = await prisma.game.findFirst({ where: { systemId: system.id, titleNormalized: normalizeTitle(it.title ?? '') } });
      if (game) resolved.push({ gameId: game.id, note: it.note });
      else unresolved.push(it);
    }
  }
  const list = await prisma.list.create({ data: { ownerId: u.id, name: body.name ?? 'Imported list', description: body.description ?? null } });
  await addItems(list.id, resolved);
  res.status(201).json({ list, added: resolved.length, unresolved });
});

listsRouter.get('/:id/files', async (req, res) => {
  const list = await loadList(intParam(req), me(req));
  const pref = prefSchema.parse(req.query.pref ? JSON.parse(String(req.query.pref)) : {});
  res.json(await resolveListFiles(list.id, pref));
});

// Descarga zip de las roms de la lista, organizadas por carpeta de sistema o de firmware
listsRouter.get('/:id/download', async (req, res) => {
  const list = await loadList(intParam(req), me(req));
  const fwSlug = typeof req.query.firmware === 'string' ? req.query.firmware : null;
  const fw = fwSlug ? await prisma.firmware.findUnique({ where: { slug: fwSlug } }) : null;
  const { items } = await resolveListFiles(list.id);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeFileName(list.name))}.zip"`);
  const zip = new ZipArchive({ store: true });
  zip.on('error', (e: Error) => res.destroy(e));
  zip.pipe(res);
  for (const it of items) {
    const folder = (fw?.systemMap as Record<string, { folder: string }> | undefined)?.[it.systemSlug]?.folder ?? it.systemSlug;
    for (const f of it.files) {
      const name = path.posix.join(fw ? fw.romsRoot : '', folder, f.destName);
      if (f.archiveEntry) zip.append(extractEntryStream(f.absPath, f.archiveEntry), { name });
      else zip.append(fs.createReadStream(f.absPath), { name });
    }
  }
  await zip.finalize();
});
