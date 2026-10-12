import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, intParam, notFound } from '../../lib/http.js';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { env } from '../../config/env.js';
import { hackLabel } from '../../lib/romname.js';
import { extractEntryStream } from '../../lib/tools.js';
import { me, requireAdmin, requirePerm } from '../auth/middleware.js';
import { matchHashes } from '../scanner/service.js';
import { addRomRule, mergeGameInto, resolveRomGroups } from '../grouping/service.js';
import { applyMeta } from '../scrape/meta.js';
import { addPatch, makePatch, materializeHack } from '../patches/service.js';
import { ownedGameIds, ownedRomIds, systemStats } from './service.js';
import { progressFor } from '../ra/progress.js';
import { favoritesList } from '../lists/service.js';
import { refreshChildren } from '../lists/routes.js';

export const collectionRouter = Router();
collectionRouter.use(requirePerm('collection.view'));

const patchUpload = multer({ dest: path.join(env.uploadsDir, 'incoming'), limits: { fileSize: 64 * 1024 * 1024 } });

const page = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

collectionRouter.get('/systems', async (_req, res) => {
  res.json(await systemStats());
});

collectionRouter.get('/regions', async (_req, res) => {
  const rows = await prisma.$queryRaw<{ r: string }[]>`SELECT DISTINCT jt.r FROM Rom, JSON_TABLE(regions, '$[*]' COLUMNS (r VARCHAR(64) PATH '$')) jt ORDER BY jt.r`;
  res.json(rows.map((x) => x.r));
});

collectionRouter.get('/games', async (req, res) => {
  const q = z
    .object({
      systemId: z.coerce.number().int().optional(),
      q: z.string().optional(),
      status: z.enum(['all', 'owned', 'missing', 'hacks']).default('all'),
      region: z.string().optional(),
      ra: z.enum(['1', '0']).optional(),
      favorites: z.enum(['1']).optional(),
      workId: z.coerce.number().int().optional(),
      franchiseId: z.coerce.number().int().optional(),
      lowConfidence: z.enum(['1']).optional(),
      sort: z.enum(['title', 'id']).default('title'),
    })
    .extend(page.shape)
    .parse(req.query);
  const where: Prisma.GameWhereInput = {};
  if (q.systemId) where.systemId = q.systemId;
  if (q.q) where.title = { contains: q.q };
  if (q.workId) where.workId = q.workId;
  if (q.franchiseId) where.work = { franchiseId: q.franchiseId };
  if (q.lowConfidence) where.groupConfidence = 'low';
  const romWhere: Prisma.RomWhereInput = { isBios: false };
  if (q.region) romWhere.regions = { array_contains: q.region };
  if (q.ra === '1') romWhere.raGameId = { not: null };
  where.OR = [{ roms: { some: romWhere } }, ...(q.region || q.ra ? [] : [{ hacks: { some: {} } }])];
  if (q.status === 'owned' || q.status === 'missing') {
    const owned = [...(await ownedGameIds(q.systemId))];
    where.id = q.status === 'owned' ? { in: owned } : { notIn: owned };
  }
  if (q.status === 'hacks') where.hacks = { some: {} };
  const userId = me(req).id;
  if (q.favorites) where.AND = [{ roms: { some: { favorites: { some: { userId } } } } }];
  const [total, games] = await Promise.all([
    prisma.game.count({ where }),
    prisma.game.findMany({
      where,
      orderBy: q.sort === 'title' ? { title: 'asc' } : { id: 'asc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: {
        system: { select: { slug: true, name: true } },
        roms: { select: { id: true, name: true, regions: true, flags: true, raGameId: true, favorites: { where: { userId }, select: { romId: true } } } },
        media: { where: { type: 'COVER' }, take: 1, select: { id: true, path: true } },
        work: { select: { id: true, title: true, franchise: { select: { id: true, name: true } } } },
        _count: { select: { hacks: true } },
      },
    }),
  ]);
  const allRomIds = games.flatMap((g) => g.roms.map((r) => r.id));
  const owned = await ownedRomIds({ romIds: allRomIds });
  const ownedAny = await ownedRomIds({ romIds: allRomIds, include: 'any' });
  const raIds = [...new Set(games.flatMap((g) => g.roms.flatMap((r) => (r.raGameId ? [r.raGameId] : []))))];
  const raGames = new Map((await prisma.raGame.findMany({ where: { id: { in: raIds } }, select: { id: true, numAchievements: true } })).map((r) => [r.id, r.numAchievements]));
  const progress = await progressFor(userId, raIds);
  res.json({
    total,
    page: q.page,
    pageSize: q.pageSize,
    items: games.map((g) => ({
      id: g.id,
      title: g.title,
      system: g.system,
      releaseYear: g.releaseYear,
      genre: g.genre,
      cover: g.media[0] ? `/api/v1/media/${g.media[0].id}` : null,
      romCount: g.roms.length,
      ownedCount: g.roms.filter((r) => owned.has(r.id)).length,
      unverifiedCount: g.roms.filter((r) => ownedAny.has(r.id) && !owned.has(r.id)).length,
      work: g.work,
      groupConfidence: g.groupConfidence,
      regions: [...new Set(g.roms.flatMap((r) => r.regions as string[]))],
      ra: g.roms.some((r) => r.raGameId),
      raGameId: g.roms.find((r) => r.raGameId)?.raGameId ?? null,
      raAchievements: Math.max(0, ...g.roms.map((r) => (r.raGameId ? (raGames.get(r.raGameId) ?? 0) : 0))),
      // The user's best progress among the game's roms
      raProgress: g.roms.map((r) => (r.raGameId ? progress.get(r.raGameId) : undefined)).filter((p) => !!p).sort((a, b) => b!.awarded - a!.awarded)[0] ?? null,
      favorite: g.roms.some((r) => r.favorites.length > 0),
      hackCount: g._count.hacks,
    })),
  });
});

collectionRouter.get('/games/:id', async (req, res) => {
  const g = await prisma.game.findUnique({
    where: { id: intParam(req) },
    include: {
      system: true,
      roms: {
        orderBy: { name: 'asc' },
        include: {
          favorites: { where: { userId: me(req).id }, select: { romId: true } },
          datSource: { select: { type: true, name: true } },
          parts: { include: { files: { include: { romPath: { select: { id: true, label: true, path: true } } } } } },
        },
      },
      hacks: {
        include: {
          files: { include: { romPath: { select: { id: true, label: true } } } },
          baseRom: { select: { id: true, name: true, regions: true, revision: true } },
          patches: { select: { id: true, format: true, baseRomId: true, sourceUrl: true } },
        },
      },
      media: true,
      work: { include: { franchise: true, games: { select: { id: true, title: true, system: { select: { slug: true, name: true } } } } } },
    },
  });
  if (!g) throw notFound('Game');
  const romIds = g.roms.map((r) => r.id);
  const owned = await ownedRomIds({ romIds });
  const ownedAny = await ownedRomIds({ romIds, include: 'any' });
  const raGames = await prisma.raGame.findMany({ where: { id: { in: g.roms.map((r) => r.raGameId).filter((x): x is number => !!x) } } });
  const progress = await progressFor(me(req).id, raGames.map((x) => x.id));
  // La version solo se muestra si el juego tiene varias
  const revisions = new Set(g.roms.map((r) => r.revision ?? ''));
  const uploaders = new Map((await prisma.user.findMany({ where: { id: { in: g.roms.map((r) => r.createdById).filter((x): x is number => !!x) } }, select: { id: true, username: true } })).map((u) => [u.id, u.username]));
  res.json({
    ...g,
    showRevision: revisions.size > 1,
    favorite: g.roms.some((r) => r.favorites.length > 0),
    media: g.media.map((m) => ({ ...m, url: `/api/v1/media/${m.id}` })),
    work: g.work ? { ...g.work, games: g.work.games.filter((x) => x.id !== g.id) } : null,
    roms: g.roms.map((r) => ({
      ...r,
      owned: owned.has(r.id),
      unverified: r.datSource.type === 'USER' || (ownedAny.has(r.id) && !owned.has(r.id)),
      uploadedBy: r.createdById ? uploaders.get(r.createdById) ?? null : null,
      raGame: raGames.find((x) => x.id === r.raGameId) ?? null,
      raProgress: r.raGameId ? (progress.get(r.raGameId) ?? null) : null,
      favorite: r.favorites.length > 0,
      favorites: undefined,
    })),
    hacks: g.hacks.map((h) => ({
      ...h,
      label: hackLabel(h.baseRom, h),
      canGenerate: !h.files.length && h.patches.some((p) => p.baseRomId),
      canMakePatch: h.files.length > 0 && !!h.baseRomId && !h.patches.length && ownedAny.has(h.baseRomId),
    })),
  });
});

collectionRouter.get('/works/:id', async (req, res) => {
  const w = await prisma.work.findUnique({
    where: { id: intParam(req) },
    include: { franchise: true, games: { include: { system: { select: { slug: true, name: true } }, roms: { select: { id: true } }, media: { where: { type: 'COVER' }, take: 1, select: { id: true } } } } },
  });
  if (!w) throw notFound('Work');
  const owned = await ownedRomIds({ romIds: w.games.flatMap((g) => g.roms.map((r) => r.id)) });
  res.json({
    ...w,
    games: w.games.map((g) => ({ id: g.id, title: g.title, system: g.system, cover: g.media[0] ? `/api/v1/media/${g.media[0].id}` : null, owned: g.roms.some((r) => owned.has(r.id)) })),
  });
});

collectionRouter.get('/franchises', async (req, res) => {
  const q = z.object({ q: z.string().optional() }).parse(req.query);
  res.json(
    await prisma.franchise.findMany({
      where: q.q ? { name: { contains: q.q } } : {},
      orderBy: { name: 'asc' },
      take: 500,
      include: { _count: { select: { works: true } } },
    }),
  );
});

collectionRouter.get('/franchises/:id', async (req, res) => {
  const f = await prisma.franchise.findUnique({
    where: { id: intParam(req) },
    include: { works: { orderBy: { releaseYear: 'asc' }, include: { games: { select: { id: true, title: true, system: { select: { slug: true } }, roms: { select: { id: true } } } } } } },
  });
  if (!f) throw notFound('Franchise');
  const owned = await ownedRomIds({ romIds: f.works.flatMap((w) => w.games.flatMap((g) => g.roms.map((r) => r.id))) });
  res.json({
    ...f,
    works: f.works.map((w) => ({
      ...w,
      games: w.games.map((g) => ({ id: g.id, title: g.title, system: g.system, owned: g.roms.some((r) => owned.has(r.id)) })),
      // "Me falta en alguna plataforma"
      missingPlatforms: w.games.filter((g) => !g.roms.some((r) => owned.has(r.id))).map((g) => g.system.slug),
    })),
  });
});

collectionRouter.patch('/games/:id', requireAdmin, async (req, res) => {
  const body = z
    .object({
      title: z.string().min(1).max(255).optional(),
      releaseYear: z.number().int().nullable().optional(),
      developer: z.string().max(128).nullable().optional(),
      publisher: z.string().max(128).nullable().optional(),
      genre: z.string().max(128).nullable().optional(),
      players: z.string().max(32).nullable().optional(),
      description: z.string().nullable().optional(),
    })
    .parse(req.body);
  const id = intParam(req);
  const { title, ...meta } = body;
  // Edicion manual: prioridad maxima sobre cualquier fuente externa
  await applyMeta(id, 'manual', { ...meta, ...(title ? { title } : {}) } as Parameters<typeof applyMeta>[2]);
  // Vaciar un campo a mano tambien es una decision manual
  const cleared = Object.fromEntries(Object.entries(meta).filter(([, v]) => v === null));
  if (Object.keys(cleared).length) await prisma.game.update({ where: { id }, data: cleared });
  if (title) await prisma.game.update({ where: { id }, data: { title } });
  res.json(await prisma.game.findUniqueOrThrow({ where: { id } }));
});

// Une un juego con otro (p.ej. "Rockman" dentro de "Mega Man")
/**
 * Removes a game (or one rom of it) from the collection: its files on the server, its list entries
 * and, for hand-uploaded roms, their records. Catalogue (DAT) records stay, now as not owned, since the
 * next DAT import would recreate them anyway. Saves are kept. Consoles keep what they already downloaded.
 */
collectionRouter.delete('/games/:id/collection', requireAdmin, async (req, res) => {
  const gameId = intParam(req);
  const romId = req.query.romId ? Number(req.query.romId) : null;
  const game = await prisma.game.findUnique({ where: { id: gameId }, include: { roms: { include: { datSource: true } }, hacks: { include: { datSource: true } } } });
  if (!game) throw notFound('Game');
  const roms = game.roms.filter((r) => !romId || r.id === romId);
  if (romId && !roms.length) throw notFound('Rom');
  const hackIds = romId ? [] : game.hacks.map((h) => h.id);
  const files = await prisma.romFile.findMany({
    where: { OR: [{ romPart: { romId: { in: roms.map((r) => r.id) } } }, ...(hackIds.length ? [{ romHackId: { in: hackIds } }] : [])] },
    include: { romPath: true },
  });
  let deletedFiles = 0;
  for (const f of files) {
    // An archive that also holds other roms stays on disk; only this record goes
    const shared = await prisma.romFile.count({ where: { romPathId: f.romPathId, relativePath: f.relativePath, id: { notIn: files.map((x) => x.id) } } });
    if (!shared && !f.romPath.readOnly) {
      await fs.promises.rm(path.join(f.romPath.path, f.relativePath), { force: true });
      deletedFiles++;
    }
  }
  await prisma.romFile.deleteMany({ where: { id: { in: files.map((f) => f.id) } } });
  await prisma.listItem.deleteMany({
    where: { OR: [...(romId ? [] : [{ gameId }]), { romId: { in: roms.map((r) => r.id) } }, ...(hackIds.length ? [{ hackId: { in: hackIds } }] : [])] },
  });
  const userRoms = roms.filter((r) => r.datSource.type === 'USER').map((r) => r.id);
  if (userRoms.length) await prisma.rom.deleteMany({ where: { id: { in: userRoms } } });
  // Romhacks that came from no hacks DAT were uploaded or identified from files: their records go too
  const localHacks = romId ? [] : game.hacks.filter((h) => !h.datSource || h.datSource.type === 'USER').map((h) => h.id);
  if (localHacks.length) await prisma.romHack.deleteMany({ where: { id: { in: localHacks } } });
  const gameGone = (await prisma.rom.count({ where: { gameId } })) === 0 && (await prisma.romHack.count({ where: { gameId } })) === 0;
  if (gameGone) await prisma.game.delete({ where: { id: gameId } });
  res.json({ deletedFiles, records: files.length, removedRoms: userRoms.length, removedHacks: localHacks.length, gameDeleted: gameGone });
});

collectionRouter.post('/games/:id/merge', requireAdmin, async (req, res) => {
  const { intoGameId } = z.object({ intoGameId: z.number().int() }).parse(req.body);
  const id = intParam(req);
  if (id === intoGameId) throw badRequest('Same game');
  const [from, into] = await Promise.all([prisma.game.findUniqueOrThrow({ where: { id } }), prisma.game.findUniqueOrThrow({ where: { id: intoGameId } })]);
  if (from.systemId !== into.systemId) throw badRequest('Different systems');
  // Regla manual permanente para que el resolvedor no los vuelva a separar
  const a = await prisma.rom.findFirst({ where: { gameId: id }, orderBy: { id: 'asc' } });
  const b = await prisma.rom.findFirst({ where: { gameId: intoGameId }, orderBy: { id: 'asc' } });
  if (a && b) await addRomRule('same', [b.id, a.id], me(req).id);
  await mergeGameInto(id, intoGameId);
  res.status(204).end();
});

// Separa roms de un juego: quedan marcadas como juego distinto del resto
collectionRouter.post('/games/:id/split', requireAdmin, async (req, res) => {
  const { romIds } = z.object({ romIds: z.array(z.number().int()).min(1) }).parse(req.body);
  const id = intParam(req);
  const game = await prisma.game.findUniqueOrThrow({ where: { id }, include: { roms: { select: { id: true } } } });
  const moving = game.roms.filter((r) => romIds.includes(r.id)).map((r) => r.id);
  const staying = game.roms.filter((r) => !romIds.includes(r.id)).map((r) => r.id);
  if (!moving.length || !staying.length) throw badRequest('Nothing to split');
  for (const m of moving) await addRomRule('different', [staying[0], m], me(req).id);
  for (let i = 1; i < moving.length; i++) await addRomRule('same', [moving[0], moving[i]], me(req).id);
  // Las evidencias de union entre ambos lados quedan anuladas por las reglas
  res.json(await resolveRomGroups(game.systemId));
});

// Typeahead of roms by name (e.g. the base rom of a hack being uploaded)
collectionRouter.get('/rom-search', async (req, res) => {
  const { q, systemId } = z.object({ q: z.string().trim().min(2).max(100), systemId: z.coerce.number().int().optional() }).parse(req.query);
  const roms = await prisma.rom.findMany({
    where: { name: { contains: q }, isBios: false, ...(systemId ? { game: { systemId } } : {}) },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
    take: 25,
  });
  res.json(roms);
});

collectionRouter.get('/roms/:id', async (req, res) => {
  const r = await prisma.rom.findUnique({
    where: { id: intParam(req) },
    include: { game: { include: { system: true } }, parts: { include: { files: true } }, datSource: true },
  });
  if (!r) throw notFound('Rom');
  res.json({ ...r, owned: (await ownedRomIds({ romIds: [r.id] })).has(r.id) });
});

collectionRouter.get('/missing', async (req, res) => {
  const q = z
    .object({
      systemId: z.coerce.number().int(),
      region: z.string().optional(),
      excludeFlags: z.string().default('proto,beta,demo,sample,pirate,unlicensed,aftermarket'),
    })
    .extend(page.shape)
    .parse(req.query);
  const owned = [...(await ownedRomIds({ systemId: q.systemId }))];
  const exclude = q.excludeFlags.split(',').filter(Boolean);
  const all = await prisma.rom.findMany({
    where: {
      game: { systemId: q.systemId },
      isBios: false,
      id: { notIn: owned },
      ...(q.region ? { regions: { array_contains: q.region } } : {}),
    },
    select: { id: true, name: true, gameId: true, regions: true, flags: true, raGameId: true },
    orderBy: { name: 'asc' },
  });
  const filtered = all.filter((r) => !(r.flags as string[]).some((f) => exclude.includes(f)));
  res.json({
    total: filtered.length,
    page: q.page,
    pageSize: q.pageSize,
    items: filtered.slice((q.page - 1) * q.pageSize, q.page * q.pageSize),
  });
});

// Comprobacion previa de una rom por hash (subidas)
collectionRouter.post('/roms/match', async (req, res) => {
  const h = z
    .object({
      sha1: z.string().length(40).optional(),
      md5: z.string().length(32).optional(),
      crc32: z.string().length(8).default('00000000'),
      size: z.number().int().default(0),
      headerless: z.object({ sha1: z.string().length(40), md5: z.string().length(32).optional() }).optional(),
    })
    .parse(req.body);
  const m = await matchHashes({ ...h, sha1: h.sha1?.toLowerCase(), md5: h.md5?.toLowerCase(), headerless: h.headerless ? { sha1: h.headerless.sha1.toLowerCase(), md5: h.headerless.md5?.toLowerCase() ?? '' } : undefined });
  let raGameId: number | null = null;
  if (m.status === 'UNKNOWN' && h.md5) {
    const ra = await prisma.raHash.findFirst({ where: { hash: { in: [h.md5.toLowerCase(), h.headerless?.md5?.toLowerCase()].filter(Boolean) as string[] } } });
    raGameId = ra?.raGameId ?? null;
  }
  let rom = null;
  if (m.romPartId) {
    const part = await prisma.romPart.findUnique({ where: { id: m.romPartId }, include: { rom: { include: { game: { select: { id: true, title: true } } } } } });
    rom = part ? { id: part.rom.id, name: part.rom.name, partName: part.name, game: part.rom.game, owned: (await ownedRomIds({ romIds: [part.rom.id] })).has(part.rom.id) } : null;
  }
  res.json({ ...m, rom, raGameId, accepted: m.status !== 'UNKNOWN' || raGameId != null });
});

collectionRouter.get('/files', async (req, res) => {
  const q = z
    .object({
      romPathId: z.coerce.number().int().optional(),
      systemId: z.coerce.number().int().optional(),
      status: z.enum(['MATCHED', 'HACK', 'UNVERIFIED', 'UNKNOWN']).optional(),
      q: z.string().optional(),
    })
    .extend(page.shape)
    .parse(req.query);
  const where: Prisma.RomFileWhereInput = {
    ...(q.romPathId ? { romPathId: q.romPathId } : {}),
    ...(q.systemId ? { systemId: q.systemId } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.q ? { relativePath: { contains: q.q } } : {}),
  };
  const [total, items] = await Promise.all([
    prisma.romFile.count({ where }),
    prisma.romFile.findMany({
      where,
      orderBy: { relativePath: 'asc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: {
        romPath: { select: { id: true, label: true } },
        romPart: { select: { name: true, rom: { select: { id: true, name: true, gameId: true } } } },
        romHack: { select: { id: true, title: true, gameId: true } },
      },
    }),
  ]);
  const uploaders = new Map((await prisma.user.findMany({ where: { id: { in: items.map((i) => i.uploadedById).filter((x): x is number => !!x) } }, select: { id: true, username: true } })).map((u) => [u.id, u.username]));
  res.json({ total, page: q.page, pageSize: q.pageSize, items: items.map((i) => ({ ...i, uploadedBy: i.uploadedById ? uploaders.get(i.uploadedById) ?? null : null })) });
});

// Asociacion manual de un fichero desconocido a una rom: queda como no verificado
collectionRouter.post('/files/:id/link-rom', requireAdmin, async (req, res) => {
  const { romId } = z.object({ romId: z.number().int() }).parse(req.body);
  const f = await prisma.romFile.findUniqueOrThrow({ where: { id: intParam(req) } });
  const rom = await prisma.rom.findUniqueOrThrow({ where: { id: romId }, include: { parts: { take: 1 }, game: true } });
  if (!rom.parts[0]) throw badRequest('Rom without parts');
  res.json(await prisma.romFile.update({ where: { id: f.id }, data: { status: 'UNVERIFIED', romPartId: rom.parts[0].id, systemId: rom.game.systemId } }));
});

// Registra manualmente un fichero desconocido como romhack/traduccion de un juego
collectionRouter.post('/files/:id/link-hack', requireAdmin, async (req, res) => {
  const body = z
    .object({
      gameId: z.number().int(),
      type: z.enum(['HACK', 'TRANSLATION', 'IMPROVEMENT', 'OTHER']).default('HACK'),
      title: z.string().max(255).optional(),
      author: z.string().max(255).optional(),
      version: z.string().max(64).optional(),
      language: z.string().max(32).optional(),
      sourceUrl: z.string().max(512).optional(),
    })
    .parse(req.body);
  const f = await prisma.romFile.findUniqueOrThrow({ where: { id: intParam(req) } });
  const game = await prisma.game.findUniqueOrThrow({ where: { id: body.gameId } });
  const hack = await prisma.romHack.create({
    data: {
      gameId: game.id,
      type: body.type,
      title: body.title ?? (f.archiveEntry ?? f.relativePath).split('/').pop()!.replace(/\.[^.]+$/, ''),
      author: body.author,
      version: body.version,
      language: body.language,
      sourceUrl: body.sourceUrl,
      baseEvidence: 'manual',
      size: f.size,
      crc32: f.crc32,
      md5: f.md5,
      sha1: f.sha1,
    },
  });
  await prisma.romFile.updateMany({ where: { sha1: f.sha1, status: 'UNKNOWN' }, data: { status: 'HACK', romHackId: hack.id, systemId: game.systemId } });
  res.status(201).json(hack);
});

collectionRouter.get('/hacks', async (req, res) => {
  const q = z.object({ systemId: z.coerce.number().int().optional(), q: z.string().optional() }).extend(page.shape).parse(req.query);
  const where: Prisma.RomHackWhereInput = {
    ...(q.systemId ? { game: { systemId: q.systemId } } : {}),
    ...(q.q ? { title: { contains: q.q } } : {}),
  };
  const [total, items] = await Promise.all([
    prisma.romHack.count({ where }),
    prisma.romHack.findMany({
      where,
      orderBy: { title: 'asc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: {
        game: { select: { id: true, title: true, system: { select: { slug: true } } } },
        baseRom: { select: { id: true, name: true } },
        _count: { select: { files: true, patches: true } },
      },
    }),
  ]);
  res.json({ total, page: q.page, pageSize: q.pageSize, items: items.map((h) => ({ ...h, label: hackLabel(h.baseRom, h) })) });
});

collectionRouter.post('/hacks', requireAdmin, async (req, res) => {
  const body = z
    .object({
      gameId: z.number().int(),
      baseRomId: z.number().int().optional(),
      type: z.enum(['HACK', 'TRANSLATION', 'IMPROVEMENT', 'OTHER']).default('HACK'),
      title: z.string().min(1).max(255),
      hackName: z.string().max(255).optional(),
      author: z.string().max(255).optional(),
      version: z.string().max(64).optional(),
      language: z.string().max(32).optional(),
      description: z.string().optional(),
      sourceUrl: z.string().max(512).optional(),
      sha1: z.string().length(40).optional(),
      md5: z.string().length(32).optional(),
      crc32: z.string().length(8).optional(),
      size: z.number().int().optional(),
    })
    .parse(req.body);
  const hack = await prisma.romHack.create({ data: { ...body, baseEvidence: 'manual', size: body.size != null ? BigInt(body.size) : null } });
  res.status(201).json(hack);
});

collectionRouter.delete('/hacks/:id', requireAdmin, async (req, res) => {
  await prisma.romHack.delete({ where: { id: intParam(req) } });
  res.status(204).end();
});

// Edicion manual de etiquetas de un romhack
collectionRouter.patch('/hacks/:id', requireAdmin, async (req, res) => {
  const body = z
    .object({
      type: z.enum(['HACK', 'TRANSLATION', 'IMPROVEMENT', 'OTHER']).optional(),
      title: z.string().min(1).max(255).optional(),
      hackName: z.string().max(255).nullable().optional(),
      author: z.string().max(255).nullable().optional(),
      version: z.string().max(64).nullable().optional(),
      language: z.string().max(32).nullable().optional(),
      baseRomId: z.number().int().nullable().optional(),
      sourceUrl: z.string().max(512).nullable().optional(),
    })
    .parse(req.body);
  res.json(await prisma.romHack.update({ where: { id: intParam(req) }, data: { ...body, ...(body.baseRomId !== undefined ? { baseEvidence: 'manual' } : {}) } }));
});

// Parche de un romhack (IPS/BPS/UPS), subido por el admin
collectionRouter.post('/hacks/:id/patches', requireAdmin, patchUpload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('Missing file');
  try {
    const body = z.object({ baseRomId: z.coerce.number().int().optional(), sourceUrl: z.string().max(512).optional() }).parse(req.body ?? {});
    const patch = await fs.promises.readFile(req.file.path);
    res.status(201).json(await addPatch(intParam(req), patch, { ...body, userId: me(req).id }));
  } finally {
    await fs.promises.rm(req.file.path, { force: true });
  }
});

// Parche BPS generado desde el romhack que se tiene y su rom base
collectionRouter.post('/hacks/:id/make-patch', requireAdmin, async (req, res) => {
  res.status(201).json(await makePatch(intParam(req), me(req).id));
});

collectionRouter.delete('/patches/:id', requireAdmin, async (req, res) => {
  const p = await prisma.romPatch.delete({ where: { id: intParam(req) } });
  await fs.promises.rm(path.join(env.patchesDir, p.path), { force: true });
  res.status(204).end();
});

export async function sendRomFile(res: import('express').Response, f: { relativePath: string; archiveEntry: string | null; romPath: { path: string } }, name: string) {
  const abs = path.join(f.romPath.path, f.relativePath);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  if (f.archiveEntry) extractEntryStream(abs, f.archiveEntry).pipe(res);
  else res.sendFile(abs);
}

// Descarga de un romhack: si solo hay parche y base, se genera en su destino final
collectionRouter.get('/hacks/:id/download', requirePerm('roms.download'), async (req, res) => {
  const f = await materializeHack(intParam(req), me(req).id);
  if (!f) throw notFound('Hack file');
  await sendRomFile(res, f, path.basename(f.archiveEntry ?? f.relativePath));
});

// Descarga de una rom de un solo fichero
collectionRouter.get('/roms/:id/download', requirePerm('roms.download'), async (req, res) => {
  const part = await prisma.romPart.findFirst({ where: { romId: intParam(req) }, include: { files: { where: { status: { in: ['MATCHED', 'UNVERIFIED'] } }, include: { romPath: true } } } });
  const f = part?.files[0];
  if (!part || !f) throw notFound('Rom file');
  await sendRomFile(res, f, part.name);
});

/** Favourite roms: per user, and a game with one shows as favourite */
collectionRouter.put('/roms/:id/favorite', async (req, res) => {
  const romId = intParam(req);
  if (!(await prisma.rom.findUnique({ where: { id: romId }, select: { id: true } }))) throw notFound('Rom');
  const userId = me(req).id;
  await prisma.romFavorite.upsert({ where: { userId_romId: { userId, romId } }, create: { userId, romId }, update: {} });
  // The favourites list follows, and so do its sublists
  const fav = await favoritesList(userId);
  const max = await prisma.listItem.aggregate({ where: { listId: fav.id }, _max: { position: true } });
  await prisma.listItem.createMany({ data: [{ listId: fav.id, romId, itemKey: `r${romId}`, position: (max._max.position ?? -1) + 1 }], skipDuplicates: true });
  void refreshChildren(fav.id);
  res.status(204).end();
});

collectionRouter.delete('/roms/:id/favorite', async (req, res) => {
  const userId = me(req).id;
  await prisma.romFavorite.deleteMany({ where: { userId, romId: intParam(req) } });
  const fav = await favoritesList(userId);
  await prisma.listItem.deleteMany({ where: { listId: fav.id, romId: intParam(req) } });
  void refreshChildren(fav.id);
  res.status(204).end();
});
