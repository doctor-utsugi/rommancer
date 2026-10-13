import path from 'node:path';
import type { List } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { forbidden, notFound } from '../../lib/http.js';
import { safeFileName } from '../../lib/romname.js';
import type { AuthUser } from '../auth/middleware.js';
import { ownedRomIds, pickFromWork, pickRom, type RomPreference } from '../roms/service.js';
import { materializeHack } from '../patches/service.js';

export async function loadList(id: number, user: AuthUser, edit = false): Promise<List> {
  const list = await prisma.list.findUnique({ where: { id }, include: { shares: true } });
  if (!list) throw notFound('List');
  const share = list.shares.find((s) => s.userId === user.id);
  const isOwner = list.ownerId === user.id;
  const canView = isOwner || user.role === 'ADMIN' || list.visibility === 'PUBLIC' || !!share;
  const canEdit = isOwner || !!share?.canEdit || (list.isCollaborative && canView && (list.visibility === 'PUBLIC' || !!share));
  if (!canView || (edit && !canEdit)) throw forbidden();
  return list;
}

export function itemKey(i: { gameId?: number | null; romId?: number | null; hackId?: number | null; workId?: number | null; unknownId?: number | null }) {
  if (i.romId) return `r${i.romId}`;
  if (i.hackId) return `h${i.hackId}`;
  if (i.unknownId) return `u${i.unknownId}`;
  if (i.workId) return `w${i.workId}`;
  if (i.gameId) return `g${i.gameId}`;
  throw new Error('Empty item');
}

export interface TransferItem {
  listItemId: number;
  systemSlug: string;
  title: string;
  romId: number | null;
  hackId: number | null;
  // Content of a file nobody identified: a device with it has the item wherever it keeps it
  sha1?: string | null;
  // Ficheros a copiar
  files: { absPath: string; archiveEntry: string | null; destName: string }[];
}

/** Resuelve los ficheros a copiar para cada elemento de la lista. Los que no se tienen quedan en missing. */
export async function resolveListFiles(listId: number, pref: RomPreference = {}) {
  const list = await prisma.list.findUniqueOrThrow({ where: { id: listId } });
  const effective: RomPreference = { ...((list.derivedFilter as RomPreference | null) ?? {}), ...pref, ownedOnly: true };
  const items = await prisma.listItem.findMany({
    where: { listId },
    orderBy: { position: 'asc' },
    include: {
      game: { include: { system: true, roms: true } },
      rom: { include: { game: { include: { system: true } } } },
      hack: { include: { game: { include: { system: true } }, files: { include: { romPath: true } } } },
      work: { include: { games: { include: { system: true, roms: true } } } },
      unknown: { include: { system: true } },
    },
  });
  const romIds = items.flatMap((i) => (i.rom ? [i.rom.id] : (i.game?.roms.map((r) => r.id) ?? i.work?.games.flatMap((g) => g.roms.map((r) => r.id)) ?? [])));
  // Listas y dispositivos usan tambien las roms no verificadas
  const owned = await ownedRomIds({ romIds, include: 'any' });
  const serverCopy = await unknownFilesOnServer(items.flatMap((i) => (i.unknown ? [i.unknown] : [])));
  const out: TransferItem[] = [];
  const missing: { listItemId: number; title: string }[] = [];

  for (const it of items) {
    if (it.hack) {
      // Sin fichero pero con parche y base: se genera en su destino final
      const f = it.hack.files[0] ?? (await materializeHack(it.hack.id).catch(() => null));
      if (!f) {
        missing.push({ listItemId: it.id, title: it.hack.title });
        continue;
      }
      const ext = path.extname(f.archiveEntry ?? f.relativePath);
      out.push({
        listItemId: it.id,
        systemSlug: it.hack.game.system.slug,
        title: it.hack.title,
        romId: null,
        hackId: it.hack.id,
        files: [{ absPath: path.join(f.romPath.path, f.relativePath), archiveEntry: f.archiveEntry, destName: safeFileName(it.hack.title + ext) }],
      });
      continue;
    }
    if (it.unknown) {
      const f = serverCopy(it.unknown);
      if (!f || !it.unknown.system) {
        missing.push({ listItemId: it.id, title: it.unknown.name });
        continue;
      }
      out.push({
        listItemId: it.id,
        systemSlug: it.unknown.system.slug,
        title: it.unknown.name,
        romId: null,
        hackId: null,
        sha1: it.unknown.sha1,
        files: [{ absPath: path.join(f.romPath.path, f.relativePath), archiveEntry: f.archiveEntry, destName: safeFileName(it.unknown.name) }],
      });
      continue;
    }
    const fromWork = it.work ? pickFromWork(it.work.games, effective, owned) : null;
    const rom = it.rom ?? (it.game ? pickRom(it.game.roms, effective, owned) : (fromWork?.rom ?? null));
    const system = it.rom?.game.system ?? it.game?.system ?? fromWork?.game.system;
    const title = it.rom?.name ?? it.game?.title ?? it.work?.title ?? '?';
    if (!rom || !system || !owned.has(rom.id)) {
      missing.push({ listItemId: it.id, title });
      continue;
    }
    out.push({ listItemId: it.id, systemSlug: system.slug, title: rom.name, romId: rom.id, hackId: null, files: await romFiles(rom.id) });
  }
  return { items: out, missing };
}

/** The server's copies of files no database identified, by sha1 ("h:" + headerless sha1 for the same content without its header) */
export async function unknownFilesOnServer(us: { sha1: string | null; headerlessSha1: string | null }[]) {
  const sha1s = us.flatMap((u) => (u.sha1 ? [u.sha1] : []));
  const bare = us.flatMap((u) => (u.headerlessSha1 ? [u.headerlessSha1] : []));
  const or = [...(sha1s.length ? [{ sha1: { in: sha1s } }] : []), ...(bare.length ? [{ headerlessSha1: { in: bare } }] : [])];
  const files = or.length ? await prisma.romFile.findMany({ where: { OR: or }, include: { romPath: true } }) : [];
  const by = new Map<string, (typeof files)[number]>();
  for (const f of files) {
    if (f.sha1) by.set(f.sha1, f);
    if (f.headerlessSha1 && !by.has(`h:${f.headerlessSha1}`)) by.set(`h:${f.headerlessSha1}`, f);
  }
  return (u: { sha1: string | null; headerlessSha1: string | null }) => (u.sha1 ? by.get(u.sha1) : undefined) ?? (u.headerlessSha1 ? by.get(`h:${u.headerlessSha1}`) : undefined) ?? null;
}

/** Ficheros en disco de una rom poseida, con el nombre de destino canonico. */
export async function romFiles(romId: number) {
  const rom = await prisma.rom.findUniqueOrThrow({
    where: { id: romId },
    include: { game: { include: { system: true } }, parts: { include: { files: { include: { romPath: true } } } } },
  });
  const files: TransferItem['files'] = [];
  const seen = new Set<string>();
  const isArcade = rom.game.system.mediaType === 'arcade';
  for (const part of rom.parts) {
    const f = part.files[0];
    if (!f) continue;
    const abs = path.join(f.romPath.path, f.relativePath);
    const ext = path.extname(f.relativePath).toLowerCase();
    if (f.archiveEntry && (isArcade || ext === '.chd' || rom.parts.length === 1)) {
      // Se copia el contenedor completo (zip de arcade, CHD, zip de una sola rom)
      if (seen.has(abs)) continue;
      seen.add(abs);
      files.push({ absPath: abs, archiveEntry: null, destName: safeFileName(rom.name + ext) });
    } else if (rom.game.system.mediaType === 'disc' && rom.parts.length > 1) {
      // Pistas de disco: se conserva el nombre original para que el .cue siga siendo valido
      files.push({ absPath: abs, archiveEntry: f.archiveEntry, destName: path.basename(f.archiveEntry ?? f.relativePath) });
    } else {
      files.push({ absPath: abs, archiveEntry: f.archiveEntry, destName: safeFileName(part.name) });
    }
  }
  // .cue de discos multi-pista: se busca junto a las pistas
  const hasCuePart = rom.parts.some((p) => p.name.toLowerCase().endsWith('.cue'));
  if (hasCuePart && !files.some((f) => f.destName.toLowerCase().endsWith('.cue')) && files[0] && !files[0].archiveEntry) {
    const dir = path.dirname(files[0].absPath);
    const { readdir, readFile } = await import('node:fs/promises');
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!name.toLowerCase().endsWith('.cue')) continue;
      const text = await readFile(path.join(dir, name), 'utf8').catch(() => '');
      if (files.some((f) => text.includes(f.destName))) {
        files.push({ absPath: path.join(dir, name), archiveEntry: null, destName: name });
        break;
      }
    }
  }
  return files;
}

export interface ItemInput {
  gameId?: number;
  romId?: number;
  hackId?: number;
  workId?: number;
  unknownId?: number;
  note?: string;
}

/** Lists hold roms (and romhacks): a game or a work given by the web app becomes its best rom, owned ones first */
export async function toRomItems<T extends ItemInput>(items: T[]): Promise<(T & { romId?: number; hackId?: number })[]> {
  const gameIds = [...new Set(items.flatMap((i) => (!i.romId && !i.hackId && i.gameId ? [i.gameId] : [])))];
  const workIds = [...new Set(items.flatMap((i) => (!i.romId && !i.hackId && !i.gameId && i.workId ? [i.workId] : [])))];
  const games = gameIds.length ? await prisma.game.findMany({ where: { id: { in: gameIds } }, include: { roms: true, hacks: { select: { id: true }, take: 1 } } }) : [];
  const works = workIds.length ? await prisma.work.findMany({ where: { id: { in: workIds } }, include: { games: { include: { system: true, roms: true } } } }) : [];
  const owned = await ownedRomIds({ romIds: [...games.flatMap((g) => g.roms.map((r) => r.id)), ...works.flatMap((w) => w.games.flatMap((g) => g.roms.map((r) => r.id)))], include: 'any' });
  // Asked for by hand: a game whose only versions are betas, pirates or demos still goes in
  const gameRom = new Map(games.map((g) => [g.id, (pickRom(g.roms, {}, owned) ?? pickRom(g.roms, { excludeFlags: [] }, owned))?.id]));
  const workRom = new Map(works.map((w) => [w.id, (pickFromWork(w.games, {}, owned) ?? pickFromWork(w.games, { excludeFlags: [] }, owned))?.rom.id]));
  return items.flatMap((i) => {
    if (i.romId || i.hackId || i.unknownId) return [{ ...i, gameId: undefined, workId: undefined }];
    const romId = i.gameId ? gameRom.get(i.gameId) : i.workId ? workRom.get(i.workId) : undefined;
    if (romId) return [{ ...i, romId, gameId: undefined, workId: undefined }];
    // A game known only through romhacks goes in as its romhack
    const hackId = i.gameId ? games.find((g) => g.id === i.gameId)?.hacks[0]?.id : undefined;
    return hackId ? [{ ...i, hackId, gameId: undefined, workId: undefined }] : [];
  });
}

/** Game and work items saved before lists held roms only: each becomes its best rom (or goes, if it has none) */
export async function convertLegacyItems() {
  const legacy = await prisma.listItem.findMany({ where: { romId: null, hackId: null, unknownId: null }, select: { id: true, listId: true, gameId: true, workId: true } });
  let converted = 0;
  for (const it of legacy) {
    const [rom] = await toRomItems([{ gameId: it.gameId ?? undefined, workId: it.workId ?? undefined }]);
    const key = rom?.romId ? `r${rom.romId}` : null;
    const taken = key ? await prisma.listItem.findUnique({ where: { listId_itemKey: { listId: it.listId, itemKey: key } } }) : null;
    if (!key || taken) await prisma.listItem.delete({ where: { id: it.id } });
    else {
      await prisma.listItem.update({ where: { id: it.id }, data: { romId: rom.romId, gameId: null, workId: null, itemKey: key } });
      converted++;
    }
  }
  return { converted, removed: legacy.length - converted };
}

/** The user's favourites list, created on first use with the roms already marked */
export async function favoritesList(userId: number) {
  // Named in the user's language, so every client (desktop app, consoles) shows it right
  const { locale } = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { locale: true } });
  const name = locale === 'es' ? 'Favoritos' : 'Favorites';
  const existing = await prisma.list.findFirst({ where: { ownerId: userId, kind: 'favorites' } });
  if (existing) return existing.name === name ? existing : prisma.list.update({ where: { id: existing.id }, data: { name } });
  const list = await prisma.list.create({ data: { ownerId: userId, name, kind: 'favorites' } });
  const favs = await prisma.romFavorite.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  if (favs.length) await prisma.listItem.createMany({ data: favs.map((f, i) => ({ listId: list.id, romId: f.romId, itemKey: `r${f.romId}`, position: i })), skipDuplicates: true });
  return list;
}
