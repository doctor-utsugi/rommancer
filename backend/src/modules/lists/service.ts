import crypto from 'node:crypto';
import path from 'node:path';
import type { List } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { forbidden, notFound } from '../../lib/http.js';
import { hasPermission, normalizePermissions } from '../../lib/permissions.js';
import { safeFileName } from '../../lib/romname.js';
import type { AuthUser } from '../auth/middleware.js';
import { ownedRomIds, pickFromWork, pickRom, type RomPreference } from '../roms/service.js';
import { materializeHack } from '../patches/service.js';
import { localePrefs } from '../../lib/locales.js';

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
  // Files to copy
  files: { absPath: string; archiveEntry: string | null; destName: string }[];
}

/** Resolves the files to copy for each list item. Those not held go to missing. */
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
  // Lists and devices also use unverified roms
  const owned = await ownedRomIds({ romIds, include: 'any' });
  const serverCopy = await unknownFilesOnServer(items.flatMap((i) => (i.unknown ? [i.unknown] : [])));
  const out: TransferItem[] = [];
  const missing: { listItemId: number; title: string }[] = [];

  for (const it of items) {
    if (it.hack) {
      // No file but patch and base: generated at its final destination
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

type UnknownRow = { id: number; sha1: string | null; headerlessSha1: string | null; systemId: number | null; size: bigint; name: string };

/**
 * The server's copies of files no database identified: the same content, or the same without its header; a file the
 * device never hashed (a big disc image) by the same name and size, whose content is kept from then on. Only files
 * of a system: the server keeps nothing else
 */
export async function unknownFilesOnServer(us: UnknownRow[]) {
  const kept = us.filter((u) => u.systemId !== null);
  const sha1s = kept.flatMap((u) => (u.sha1 ? [u.sha1] : []));
  const bare = kept.flatMap((u) => (u.headerlessSha1 ? [u.headerlessSha1] : []));
  const or = [...(sha1s.length ? [{ sha1: { in: sha1s } }] : []), ...(bare.length ? [{ headerlessSha1: { in: bare } }] : [])];
  const files = or.length ? await prisma.romFile.findMany({ where: { OR: or }, include: { romPath: true } }) : [];
  const by = new Map<string, (typeof files)[number]>();
  for (const f of files) {
    if (f.sha1) by.set(f.sha1, f);
    if (f.headerlessSha1 && !by.has(`h:${f.headerlessSha1}`)) by.set(`h:${f.headerlessSha1}`, f);
  }
  const blind = kept.filter((u) => !u.sha1);
  const sameSize = blind.length ? await prisma.romFile.findMany({ where: { fileSize: { in: blind.map((u) => u.size) }, archiveEntry: null }, include: { romPath: true } }) : [];
  const byName = new Map(sameSize.map((f) => [`${path.posix.basename(f.relativePath)}\0${f.fileSize}`, f]));
  const found = new Map<number, (typeof files)[number]>();
  for (const u of kept) {
    const f = (u.sha1 ? by.get(u.sha1) : undefined) ?? (u.headerlessSha1 ? by.get(`h:${u.headerlessSha1}`) : undefined) ?? (u.sha1 ? undefined : byName.get(`${u.name}\0${u.size}`));
    if (f) found.set(u.id, f);
  }
  for (const u of blind) {
    const f = found.get(u.id);
    if (f?.sha1) await prisma.unknownFile.update({ where: { id: u.id }, data: { sha1: f.sha1, headerlessSha1: f.headerlessSha1 } });
  }
  return (u: { id: number }) => found.get(u.id) ?? null;
}

/**
 * How a file no database identified is kept: a game of a system by its content; one never hashed, and anything
 * that is not a game of a system (an app shortcut, an empty launcher file), by its system, size, name and content
 */
export function unknownKey(f: { sha1: string | null; systemSlug: string | null; size: bigint; path: string }) {
  if (f.sha1 && f.systemSlug && Number(f.size) > 0) return f.sha1;
  const name = path.posix.basename(f.path).slice(0, 255);
  return crypto.createHash('sha1').update(`${f.systemSlug ?? ''}\0${f.size}\0${name}${f.sha1 ? `\0${f.sha1}` : ''}`).digest('hex');
}

/**
 * Asks the user's consoles for the files no database identified that the server lacks (UNKNOWNIDS), so lists can
 * copy them to other devices. Says what could not be asked for: files of no system the server keeps (NOSYSTEM), the
 * user may not upload roms (DENIED), the only consoles with the file do not let the server fetch roms (NOTALLOWED),
 * or no console of theirs has it (NOWHERE)
 */
export async function pullUnknownFiles(userId: number, unknownIds: number[]) {
  const out = { asked: 0, noSystem: 0, notAllowed: 0, nowhere: 0, denied: false };
  const unknowns = unknownIds.length ? await prisma.unknownFile.findMany({ where: { id: { in: unknownIds } } }) : [];
  out.noSystem = unknowns.filter((u) => u.systemId === null).length;
  const copy = await unknownFilesOnServer(unknowns);
  const lacking = unknowns.filter((u) => u.systemId !== null && !copy(u));
  if (!lacking.length) return out;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { role: true, permissions: true } });
  if (!hasPermission({ role: user.role, permissions: normalizePermissions(user.permissions) }, 'roms.upload')) {
    out.denied = true;
    out.notAllowed = lacking.length;
    return out;
  }
  const devices = await prisma.device.findMany({ where: { userId }, select: { id: true, allowPull: true } });
  const allows = new Map(devices.map((d) => [d.id, d.allowPull]));
  const sha1s = lacking.flatMap((u) => (u.sha1 ? [u.sha1] : []));
  const sizes = lacking.filter((u) => !u.sha1).map((u) => u.size);
  const rows = await prisma.deviceRom.findMany({
    where: { deviceId: { in: devices.map((d) => d.id) }, OR: [{ sha1: { in: sha1s } }, ...(sizes.length ? [{ sha1: null, size: { in: sizes } }] : [])] },
    select: { deviceId: true, path: true, sha1: true, systemSlug: true, size: true },
  });
  const holders = new Map<string, typeof rows>();
  for (const r of rows) holders.set(unknownKey(r), [...(holders.get(unknownKey(r)) ?? []), r]);
  const want: { deviceId: number; path: string }[] = [];
  for (const u of lacking) {
    const has = holders.get(u.fileKey) ?? [];
    const from = has.find((r) => allows.get(r.deviceId));
    if (from) want.push({ deviceId: from.deviceId, path: from.path });
    else if (has.length) out.notAllowed++;
    else out.nowhere++;
  }
  // Once per file while a request for it is open
  const open = await prisma.devicePull.findMany({ where: { path: { in: want.map((w) => w.path) }, status: { in: ['pending', 'sending', 'paused'] } }, select: { deviceId: true, path: true } });
  const asked = new Set(open.map((p) => `${p.deviceId}\t${p.path}`));
  const fresh = want.filter((w) => !asked.has(`${w.deviceId}\t${w.path}`));
  if (fresh.length) await prisma.devicePull.createMany({ data: fresh });
  out.asked = want.length;
  return out;
}

/** On-disk files of an owned rom, with the canonical destination name. */
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
      // The whole container is copied (arcade zip, CHD, single-rom zip)
      if (seen.has(abs)) continue;
      seen.add(abs);
      files.push({ absPath: abs, archiveEntry: null, destName: safeFileName(rom.name + ext) });
    } else if (rom.game.system.mediaType === 'disc' && rom.parts.length > 1) {
      // Disc tracks: the original name is kept so the .cue stays valid
      files.push({ absPath: abs, archiveEntry: f.archiveEntry, destName: path.basename(f.archiveEntry ?? f.relativePath) });
    } else {
      files.push({ absPath: abs, archiveEntry: f.archiveEntry, destName: safeFileName(part.name) });
    }
  }
  // .cue of multi-track discs: looked up next to the tracks
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
  const name = localePrefs(locale).favorites;
  const existing = await prisma.list.findFirst({ where: { ownerId: userId, kind: 'favorites' } });
  if (existing) return existing.name === name ? existing : prisma.list.update({ where: { id: existing.id }, data: { name } });
  const list = await prisma.list.create({ data: { ownerId: userId, name, kind: 'favorites' } });
  const favs = await prisma.romFavorite.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  if (favs.length) await prisma.listItem.createMany({ data: favs.map((f, i) => ({ listId: list.id, romId: f.romId, itemKey: `r${f.romId}`, position: i })), skipDuplicates: true });
  return list;
}
