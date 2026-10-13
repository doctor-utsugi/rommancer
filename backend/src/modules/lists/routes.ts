import { Router } from 'express';
import { ZipArchive } from 'archiver';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { bulkRoms, bulkSchema } from './bulk.js';
import { hasPermission } from '../../lib/permissions.js';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, intParam } from '../../lib/http.js';
import { safeFileName } from '../../lib/romname.js';
import { extractEntryStream } from '../../lib/tools.js';
import { me, requirePerm, type AuthUser } from '../auth/middleware.js';
import { queueListScrape } from '../scrape/routes.js';
import { ownedRomIds, pickFromWork, pickRom, type RomPreference } from '../roms/service.js';
import { favoritesList, itemKey, loadList, pullUnknownFiles, resolveListFiles, toRomItems, unknownFilesOnServer, unknownKey } from './service.js';
import { previewDerive, resolveDerive, specOf, type DerivedSpec } from './derive.js';

export const listsRouter = Router();
listsRouter.use(requirePerm('lists'));

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
  platforms: z.array(z.string()).optional(),
  strictLanguages: z.boolean().optional(),
  verifiedOnly: z.boolean().optional(),
});

const decisionsSchema = z.object({
  perGame: z.record(z.string(), z.number().int().nullable()).default({}),
  rest: z.union([z.object({ mode: z.literal('skip') }), z.object({ mode: z.literal('like'), romId: z.number().int() })]).default({ mode: 'skip' }),
});

listsRouter.get('/', async (req, res) => {
  const u = me(req);
  await favoritesList(u.id);
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
    include: {
      owner: { select: { id: true, username: true } },
      _count: { select: { items: true } },
      shares: { select: { userId: true, canEdit: true } },
      // Only the user's own consoles that have it
      devices: { where: { device: { userId: u.id } }, select: { device: { select: { id: true, name: true } } } },
    },
  });
  // The user's favourites always come first
  res.json(lists.sort((a, b) => Number(b.kind === 'favorites' && b.ownerId === u.id) - Number(a.kind === 'favorites' && a.ownerId === u.id)));
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
          hack: { include: { game: { include: { system: { select: { slug: true, name: true } } } }, _count: { select: { files: true, patches: true } } } },
          work: { include: { games: { include: { system: { select: { slug: true, name: true } }, roms: { select: { id: true, name: true, regions: true, languages: true, flags: true, revision: true, raGameId: true, isBios: true } }, media: { where: { type: 'COVER' }, take: 1 } } } } },
          unknown: { include: { system: { select: { slug: true, name: true } }, baseGame: { select: { id: true, title: true, media: { where: { type: 'COVER' }, take: 1 } } } } },
        },
      },
    },
  });
  const serverCopy = await unknownFilesOnServer(full.items.flatMap((i) => (i.unknown ? [i.unknown] : [])));
  const romIds = full.items.flatMap((i) => (i.rom ? [i.rom.id] : (i.game?.roms.map((r) => r.id) ?? i.work?.games.flatMap((g) => g.roms.map((r) => r.id)) ?? [])));
  const owned = await ownedRomIds({ romIds, include: 'any' });
  // Pending media: list games without a cover that have a queued scraping task
  const pendingScrape = await prisma.job.findMany({ where: { type: 'scrape', status: { in: ['PENDING', 'RUNNING'] }, userId: u.id }, select: { params: true } });
  const pendingGames = new Set(pendingScrape.flatMap((j) => ((j.params as { gameIds?: number[] }).gameIds ?? [])));
  const pref = { ...((full.derivedFilter as RomPreference | null) ?? {}) };
  const share = full.shares.find((s) => s.userId === u.id);
  res.json({
    ...full,
    canEdit: full.ownerId === u.id || !!share?.canEdit || (full.isCollaborative && (full.visibility === 'PUBLIC' || !!share)),
    items: full.items.map((i) => {
      const workPick = i.work ? pickFromWork(i.work.games, { ...pref, ownedOnly: false }, owned) : null;
      const cover = i.game?.media[0] ?? i.rom?.game.media[0] ?? workPick?.game.media[0] ?? i.work?.games.find((g) => g.media[0])?.media[0] ?? i.unknown?.baseGame?.media[0];
      let owned_ = false;
      let selectedRom = null;
      if (i.rom) owned_ = owned.has(i.rom.id);
      else if (i.work) {
        selectedRom = workPick ? { id: workPick.rom.id, name: workPick.rom.name, system: workPick.game.system.slug } : null;
        owned_ = i.work.games.some((g) => g.roms.some((r) => owned.has(r.id)));
      }
      else if (i.game) {
        const pick = pickRom(i.game.roms, { ...pref, ownedOnly: false }, owned);
        selectedRom = pick ? { id: pick.id, name: pick.name } : null;
        owned_ = i.game.roms.some((r) => owned.has(r.id));
      } else if (i.hack) owned_ = i.hack._count.files > 0 || i.hack._count.patches > 0;
      else if (i.unknown) owned_ = !!serverCopy(i.unknown);
      const gameId = i.gameId ?? i.rom?.gameId ?? i.hack?.gameId ?? workPick?.game.id ?? i.unknown?.baseGameId ?? undefined;
      return {
        id: i.id,
        position: i.position,
        note: i.note,
        kind: i.rom ? 'rom' : i.hack ? 'hack' : i.work ? 'work' : i.unknown ? 'unknown' : 'game',
        gameId,
        romId: i.romId,
        hackId: i.hackId,
        workId: i.workId,
        unknownId: i.unknownId,
        platforms: i.work?.games.map((g) => g.system.slug),
        title: i.rom?.name ?? i.hack?.title ?? i.game?.title ?? i.work?.title ?? i.unknown?.name,
        gameTitle: i.rom?.game.title ?? i.hack?.game.title ?? i.unknown?.baseGame?.title ?? null,
        regions: (i.rom?.regions as string[] | undefined) ?? [],
        languages: (i.rom?.languages as string[] | undefined) ?? [],
        system: i.game?.system ?? i.rom?.game.system ?? i.hack?.game.system ?? workPick?.game.system ?? i.work?.games[0]?.system ?? i.unknown?.system,
        pendingMedia: !cover && !!gameId && pendingGames.has(gameId),
        cover: cover ? `/api/v1/media/${cover.id}` : null,
        owned: owned_,
        selectedRom,
        ra: i.rom ? !!i.rom.raGameId : i.work ? !!workPick?.rom.raGameId : !!i.game?.roms.some((r) => r.raGameId),
      };
    }),
  });
});

listsRouter.patch('/:id', async (req, res) => {
  const u = me(req);
  const list = await loadList(intParam(req), u, true);
  const body = listBody.partial().parse(req.body);
  // Only the owner changes visibility and collaborative mode
  if (list.ownerId !== u.id && (body.visibility || body.isCollaborative !== undefined)) throw badRequest('Only the owner can change sharing');
  if (list.kind === 'favorites' && body.name && body.name !== list.name) throw badRequest('FAVORITES_FIXED');
  res.json(await prisma.list.update({ where: { id: list.id }, data: body }));
});

listsRouter.delete('/:id', async (req, res) => {
  const u = me(req);
  const list = await loadList(intParam(req), u);
  if (list.ownerId !== u.id && u.role !== 'ADMIN') throw badRequest('Only the owner can delete');
  if (list.kind === 'favorites') throw badRequest('FAVORITES_FIXED');
  await prisma.list.delete({ where: { id: list.id } });
  res.status(204).end();
});

const itemSchema = z
  .object({
    gameId: z.number().int().optional(),
    romId: z.number().int().optional(),
    hackId: z.number().int().optional(),
    workId: z.number().int().optional(),
    unknownId: z.number().int().optional(),
    note: z.string().max(512).optional(),
  })
  .refine((i) => i.gameId || i.romId || i.hackId || i.workId || i.unknownId, 'gameId, romId, hackId, workId or unknownId required');

async function addItems(listId: number, given: z.infer<typeof itemSchema>[], user?: AuthUser) {
  const items = await toRomItems(given);
  const max = await prisma.listItem.aggregate({ where: { listId }, _max: { position: true } });
  let pos = (max._max.position ?? -1) + 1;
  const data = items.map((i) => ({
    listId,
    gameId: i.romId || i.hackId || i.workId || i.unknownId ? null : i.gameId,
    romId: i.romId ?? null,
    hackId: i.romId ? null : (i.hackId ?? null),
    workId: i.romId || i.hackId || i.unknownId ? null : (i.workId ?? null),
    unknownId: i.romId || i.hackId ? null : (i.unknownId ?? null),
    note: i.note,
    itemKey: itemKey(i),
    position: pos++,
  }));
  const r = await prisma.listItem.createMany({ data, skipDuplicates: true });
  await prisma.list.update({ where: { id: listId }, data: { updatedAt: new Date() } });
  // Media for what was added, with the user's own account
  if (user && r.count) {
    const gameIds = new Set<number>(items.map((i) => i.gameId).filter((x): x is number => !!x));
    const romIds = items.map((i) => i.romId).filter((x): x is number => !!x);
    const hackIds = items.map((i) => i.hackId).filter((x): x is number => !!x);
    const workIds = items.map((i) => i.workId).filter((x): x is number => !!x);
    if (romIds.length) (await prisma.rom.findMany({ where: { id: { in: romIds } }, select: { gameId: true } })).forEach((x) => gameIds.add(x.gameId));
    if (hackIds.length) (await prisma.romHack.findMany({ where: { id: { in: hackIds } }, select: { gameId: true } })).forEach((x) => gameIds.add(x.gameId));
    if (workIds.length) (await prisma.game.findMany({ where: { workId: { in: workIds } }, select: { id: true } })).forEach((x) => gameIds.add(x.id));
    await queueListScrape(user, [...gameIds]);
  }
  return r.count;
}

interface UnknownInput {
  fileKey: string;
  sha1: string | null;
  headerlessSha1: string | null;
  name: string;
  size: bigint;
  systemSlug: string | null;
  baseGameId: number | null;
}

/**
 * What a device holds, as list items: every rom a database identified (whether or not the server has its file), hacks
 * or translations the server knows by their content, and every other file as a file of its own (UNKNOWNS)
 */
async function deviceItems(deviceId: number, user: AuthUser) {
  const device = await prisma.device.findFirst({ where: { id: deviceId, userId: user.id }, select: { id: true } });
  if (!device) throw badRequest('Unknown device');
  const rows = await prisma.deviceRom.findMany({
    where: { deviceId },
    select: { path: true, systemSlug: true, size: true, romId: true, gameId: true, baseGameId: true, sha1: true, headerlessSha1: true },
  });
  const loose = rows.filter((r) => !r.romId && !r.gameId).flatMap((r) => [r.sha1, r.headerlessSha1].filter((h): h is string => !!h));
  const hacks = loose.length
    ? await prisma.romHack.findMany({ where: { OR: [{ sha1: { in: loose } }, { headerlessSha1: { in: loose } }] }, select: { id: true, sha1: true, headerlessSha1: true } })
    : [];
  const hackBy = new Map(hacks.flatMap((h) => [h.sha1, h.headerlessSha1].filter((x): x is string => !!x).map((x) => [x, h.id] as const)));
  // Games known by their product code alone go in as their best rom
  const gameIds = [...new Set(rows.flatMap((r) => (!r.romId && r.gameId ? [r.gameId] : [])))];
  const gameItem = new Map((await toRomItems(gameIds.map((g) => ({ gameId: g, of: g })))).map((i) => [i.of, { romId: i.romId, hackId: i.hackId }]));
  const items = new Map<string, { romId?: number; hackId?: number }>();
  const unknowns = new Map<string, UnknownInput>();
  for (const r of rows) {
    const hackId = r.romId || r.gameId ? undefined : (hackBy.get(r.sha1 ?? '') ?? hackBy.get(r.headerlessSha1 ?? ''));
    const item = r.romId ? { romId: r.romId } : r.gameId ? gameItem.get(r.gameId) : hackId ? { hackId } : undefined;
    if (item) {
      items.set(itemKey(item), item);
      continue;
    }
    const fileKey = unknownKey(r);
    unknowns.set(fileKey, { fileKey, sha1: r.sha1, headerlessSha1: r.headerlessSha1, name: path.posix.basename(r.path).slice(0, 255), size: r.size, systemSlug: r.systemSlug, baseGameId: r.baseGameId ?? r.gameId });
  }
  return { items: [...items.values()], unknowns: [...unknowns.values()] };
}

/** The files no database identified, kept as such (once per content), as list items */
async function unknownItems(files: UnknownInput[]) {
  if (!files.length) return [];
  const systems = new Map((await prisma.system.findMany({ select: { id: true, slug: true } })).map((s) => [s.slug, s.id]));
  await prisma.unknownFile.createMany({
    data: files.map(({ systemSlug, ...f }) => ({ ...f, systemId: systemSlug ? (systems.get(systemSlug) ?? null) : null })),
    skipDuplicates: true,
  });
  const kept = await prisma.unknownFile.findMany({ where: { fileKey: { in: files.map((f) => f.fileKey) } }, select: { id: true, fileKey: true } });
  return kept.map((u) => ({ unknownId: u.id, fileKey: u.fileKey }));
}

listsRouter.get('/from-device/:deviceId', async (req, res) => {
  const r = await deviceItems(Number(req.params.deviceId), me(req));
  res.json({ items: r.items.length + r.unknowns.length, unknown: r.unknowns.length });
});

// A new list of every game a device holds
listsRouter.post('/from-device/:deviceId', async (req, res) => {
  const u = me(req);
  const body = listBody.parse(req.body);
  const r = await deviceItems(Number(req.params.deviceId), u);
  const unknown = await unknownItems(r.unknowns);
  const list = await prisma.list.create({ data: { ...body, ownerId: u.id } });
  // Covers for thousands of games are a bulk scrape: only for those allowed to run one
  const added = await addItems(list.id, [...r.items, ...unknown], hasPermission(u, 'scrape.bulk') ? u : undefined);
  // The files only the console has are asked from it, so the list can reach other devices
  const pulls = await pullUnknownFiles(u.id, unknown.map((k) => k.unknownId));
  // Anything that did not go in, or cannot be fetched, is said, never dropped quietly
  res.status(201).json({ id: list.id, added, unknown: r.unknowns.length, dropped: r.items.length + r.unknowns.length - added, pulls });
});

listsRouter.post('/:id/items', async (req, res) => {
  const list = await loadList(intParam(req), me(req), true);
  const body = z.union([itemSchema, z.object({ items: z.array(itemSchema).max(10000) })]).parse(req.body);
  let items = 'items' in body ? body.items : [body];
  if (list.kind === 'favorites') {
    // Favourites are roms: what goes in is marked as favourite too
    items = (await toRomItems(items)).filter((i) => i.romId);
    await prisma.romFavorite.createMany({ data: items.map((i) => ({ userId: list.ownerId, romId: i.romId! })), skipDuplicates: true });
  }
  const added = await addItems(list.id, items, me(req));
  if (added) void refreshChildren(list.id);
  res.status(201).json({ added });
});

// Whole systems at once ("every European Game Boy and NES game"): what it would add, then adding it
listsRouter.post('/:id/items/bulk/preview', async (req, res) => {
  await loadList(intParam(req), me(req), true);
  const r = await bulkRoms(bulkSchema.parse(req.body));
  res.json({ games: r.games, roms: r.romIds.length, perSystem: r.perSystem });
});

listsRouter.post('/:id/items/bulk', async (req, res) => {
  const list = await loadList(intParam(req), me(req), true);
  const { romIds } = await bulkRoms(bulkSchema.parse(req.body));
  if (romIds.length > 50_000) throw badRequest('Too many roms at once');
  const items = romIds.map((romId) => ({ romId }));
  if (list.kind === 'favorites') await prisma.romFavorite.createMany({ data: romIds.map((romId) => ({ userId: list.ownerId, romId })), skipDuplicates: true });
  // Covers for thousands of games are a bulk scrape: only for those allowed to run one
  const added = await addItems(list.id, items, hasPermission(me(req), 'scrape.bulk') ? me(req) : undefined);
  if (added) void refreshChildren(list.id);
  res.status(201).json({ added });
});

listsRouter.delete('/:id/items/:itemId', async (req, res) => {
  const list = await loadList(intParam(req), me(req), true);
  const item = await prisma.listItem.findFirst({ where: { id: intParam(req, 'itemId'), listId: list.id } });
  if (item) {
    await prisma.listItem.delete({ where: { id: item.id } });
    if (list.kind === 'favorites' && item.romId) await prisma.romFavorite.deleteMany({ where: { userId: list.ownerId, romId: item.romId } });
    void refreshChildren(list.id);
  }
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
      items: { create: items.map(({ gameId, romId, hackId, unknownId, itemKey, position, note }) => ({ gameId, romId, hackId, unknownId, itemKey, position, note })) },
    },
  });
  // Unidentified files the server lacks are asked from the user's own consoles
  const pulls = await pullUnknownFiles(u.id, items.flatMap((i) => (i.unknownId ? [i.unknownId] : [])));
  res.status(201).json({ ...copy, pulls });
});

/** Sublists of a list follow it: their filters and decisions are applied again when it changes */
export async function refreshChildren(listId: number) {
  for (const child of await prisma.list.findMany({ where: { parentListId: listId } })) {
    const { items } = await resolveDerive(listId, specOf(child.derivedFilter));
    await prisma.listItem.deleteMany({ where: { listId: child.id } });
    await addItems(child.id, items);
  }
}

listsRouter.post('/:id/derive/preview', async (req, res) => {
  const src = await loadList(intParam(req), me(req));
  res.json(await previewDerive(src.id, prefSchema.parse(req.body ?? {})));
});

listsRouter.post('/:id/derive', async (req, res) => {
  const u = me(req);
  const src = await loadList(intParam(req), u);
  const body = prefSchema.merge(decisionsSchema).extend({ name: z.string().min(1).max(191) }).parse(req.body);
  const { name, perGame, rest, ...filters } = body;
  const spec: DerivedSpec = { v: 2, filters, perGame, rest };
  const { items, skipped } = await resolveDerive(src.id, spec);
  const list = await prisma.list.create({ data: { ownerId: u.id, name, parentListId: src.id, derivedFilter: spec as unknown as Prisma.InputJsonValue } });
  const added = await addItems(list.id, items, me(req));
  res.status(201).json({ ...list, added, skipped });
});

listsRouter.post('/:id/refresh', async (req, res) => {
  const list = await loadList(intParam(req), me(req), true);
  if (!list.parentListId) throw badRequest('Not a derived list');
  const { items, skipped } = await resolveDerive(list.parentListId, specOf(list.derivedFilter));
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
      work: { include: { games: { include: { system: true }, take: 1 } } },
      unknown: { include: { system: true, baseGame: { select: { title: true } } } },
    },
  });
  const rows = items.map((i) => ({
    system: (i.game?.system ?? i.rom?.game.system ?? i.hack?.game.system ?? i.work?.games[0]?.system ?? i.unknown?.system)?.slug ?? '',
    type: i.rom ? 'rom' : i.hack ? 'hack' : i.work ? 'work' : i.unknown ? 'unknown' : 'game',
    title: i.game?.title ?? i.rom?.game.title ?? i.hack?.game.title ?? i.work?.title ?? i.unknown?.baseGame?.title,
    wikidataId: i.work?.wikidataId ?? undefined,
    rom: i.rom?.name,
    hack: i.hack?.title,
    file: i.unknown?.name,
    size: i.unknown ? Number(i.unknown.size) : undefined,
    sha1: i.rom?.parts[0]?.sha1 ?? i.hack?.sha1 ?? i.unknown?.sha1 ?? undefined,
    note: i.note ?? undefined,
  }));
  const fname = safeFileName(list.name);
  if (format === 'txt') {
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fname)}.txt"`);
    res.type('text/plain').send(rows.map((r) => `${r.system}\t${r.rom ?? r.hack ?? r.file ?? r.title}`).join('\n') + '\n');
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
          type: z.enum(['game', 'rom', 'hack', 'work', 'unknown']).default('game'),
          wikidataId: z.string().optional(),
          title: z.string().optional(),
          rom: z.string().optional(),
          hack: z.string().optional(),
          file: z.string().max(255).optional(),
          size: z.number().int().nonnegative().optional(),
          sha1: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
          note: z.string().optional(),
        }),
      ),
    })
    .parse(req.body);
  const resolved: z.infer<typeof itemSchema>[] = [];
  const unresolved: unknown[] = [];
  const unknowns: (UnknownInput & { note?: string })[] = [];
  const { normalizeTitle } = await import('../../lib/romname.js');
  for (const it of body.items) {
    if (it.type === 'work') {
      const work = it.wikidataId ? await prisma.work.findUnique({ where: { wikidataId: it.wikidataId } }) : await prisma.work.findFirst({ where: { title: it.title ?? '' } });
      if (work) resolved.push({ workId: work.id, note: it.note });
      else unresolved.push(it);
      continue;
    }
    // Files no database identified come back as such, by their content
    if (it.type === 'unknown') {
      if (it.sha1 && it.file) unknowns.push({ fileKey: it.sha1.toLowerCase(), sha1: it.sha1.toLowerCase(), headerlessSha1: null, name: it.file, size: BigInt(it.size ?? 0), systemSlug: it.system || null, baseGameId: null, note: it.note });
      else unresolved.push(it);
      continue;
    }
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
  const noteOf = new Map(unknowns.map((f) => [f.fileKey, f.note]));
  resolved.push(...(await unknownItems(unknowns)).map((k) => ({ unknownId: k.unknownId, note: noteOf.get(k.fileKey) })));
  const list = await prisma.list.create({ data: { ownerId: u.id, name: body.name ?? 'Imported list', description: body.description ?? null } });
  await addItems(list.id, resolved, u);
  const pulls = await pullUnknownFiles(u.id, resolved.flatMap((i) => (i.unknownId ? [i.unknownId] : [])));
  res.status(201).json({ list, added: resolved.length, unresolved, pulls });
});

listsRouter.get('/:id/files', requirePerm('roms.download'), async (req, res) => {
  const list = await loadList(intParam(req), me(req));
  const pref = prefSchema.parse(req.query.pref ? JSON.parse(String(req.query.pref)) : {});
  res.json(await resolveListFiles(list.id, pref));
});

// Zip download of the list's roms, organized by system or firmware folder
listsRouter.get('/:id/download', requirePerm('roms.download'), async (req, res) => {
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
