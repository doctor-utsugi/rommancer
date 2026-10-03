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

export function itemKey(i: { gameId?: number | null; romId?: number | null; hackId?: number | null; workId?: number | null }) {
  if (i.romId) return `r${i.romId}`;
  if (i.hackId) return `h${i.hackId}`;
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
    },
  });
  const romIds = items.flatMap((i) => (i.rom ? [i.rom.id] : (i.game?.roms.map((r) => r.id) ?? i.work?.games.flatMap((g) => g.roms.map((r) => r.id)) ?? [])));
  // Listas y dispositivos usan tambien las roms no verificadas
  const owned = await ownedRomIds({ romIds, include: 'any' });
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
