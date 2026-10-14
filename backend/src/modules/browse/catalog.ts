/**
 * The games the server can send to a console, kept in memory for browsing and the typeahead: one entry per game with
 * the version that would go (its best owned rom, else a romhack with a file) and that version's size as the
 * download plan counts it. Rebuilt in the background once stale and the stored files changed; requests are served
 * from the previous catalogue meanwhile.
 */
import fs from 'node:fs';
import { prisma } from '../../lib/prisma.js';
import { romFiles } from '../lists/service.js';
import { ownedRomIds, pickRom } from '../roms/service.js';
import { searchable, type Searchable } from './fuzzy.js';

export interface CatalogGame {
  gameId: number;
  romId: number | null;
  hackId: number | null;
  system: string;
  title: string;
  bytes: number;
  s: Searchable;
}

export interface Catalog {
  games: CatalogGame[];
  byId: Map<number, CatalogGame>;
  systems: Map<string, string>;
}

const STALE_MS = 2 * 60_000;
const MAX_AGE_MS = 30 * 60_000;
let current: { at: number; signature: string; catalog: Catalog } | null = null;
let building: Promise<void> | null = null;

async function signature() {
  const [f] = await prisma.$queryRaw<{ n: bigint; m: number | null; s: bigint | null }[]>`SELECT COUNT(*) AS n, MAX(id) AS m, SUM(romPartId IS NOT NULL) AS s FROM RomFile`;
  return `${f.n}:${f.m}:${f.s}`;
}

/** Bytes the download plan counts for these files: an archive entry by the catalogue's parts, a file by its size */
async function filesBytes(files: { absPath: string; archiveEntry?: string | null }[], partsBytes: number) {
  let n = 0;
  for (const f of files) n += f.archiveEntry ? partsBytes : ((await fs.promises.stat(f.absPath).catch(() => null))?.size ?? 0);
  return n;
}

async function build(): Promise<Catalog> {
  const owned = await ownedRomIds({ include: 'any' });
  const games: CatalogGame[] = [];
  const ids = [...owned];
  const withRom = new Set<number>();
  for (let i = 0; i < ids.length; i += 2000) {
    const roms = await prisma.rom.findMany({ where: { id: { in: ids.slice(i, i + 2000) } }, select: { gameId: true } });
    roms.forEach((r) => withRom.add(r.gameId));
  }
  const gameIds = [...withRom];
  for (let i = 0; i < gameIds.length; i += 500) {
    const rows = await prisma.game.findMany({
      where: { id: { in: gameIds.slice(i, i + 500) } },
      select: { id: true, title: true, system: { select: { slug: true } }, roms: { include: { parts: { select: { size: true } } } } },
    });
    for (const g of rows) {
      // As a game sent from the web app: its best owned version, betas and demos only when there is nothing else
      const rom = pickRom(g.roms, { ownedOnly: true }, owned) ?? pickRom(g.roms, { ownedOnly: true, excludeFlags: [] }, owned);
      if (!rom) continue;
      const parts = rom.parts.reduce((n, p) => n + Number(p.size), 0);
      const bytes = await filesBytes(await romFiles(rom.id), parts);
      games.push({ gameId: g.id, romId: rom.id, hackId: null, system: g.system.slug, title: g.title, bytes, s: searchable(g.title) });
    }
  }
  // Games the server holds only as a romhack's file
  const hacks = await prisma.romHack.findMany({
    where: { files: { some: {} }, gameId: { notIn: gameIds.length ? gameIds : [0] } },
    select: { id: true, gameId: true, title: true, game: { select: { system: { select: { slug: true } } } }, files: { take: 1, include: { romPath: true } } },
    orderBy: { id: 'asc' },
  });
  const seen = new Set<number>();
  for (const h of hacks) {
    if (seen.has(h.gameId)) continue;
    seen.add(h.gameId);
    const f = h.files[0];
    const bytes = f.archiveEntry ? 0 : await filesBytes([{ absPath: `${f.romPath.path}/${f.relativePath}` }], 0);
    games.push({ gameId: h.gameId, romId: null, hackId: h.id, system: h.game.system.slug, title: h.title, bytes, s: searchable(h.title) });
  }
  games.sort((a, b) => a.title.localeCompare(b.title));
  const systems = new Map((await prisma.system.findMany({ select: { slug: true, name: true } })).map((s) => [s.slug, s.name]));
  return { games, byId: new Map(games.map((g) => [g.gameId, g])), systems };
}

function rebuild(sig: string) {
  building ??= build()
    .then((catalog) => {
      current = { at: Date.now(), signature: sig, catalog };
    })
    .finally(() => {
      building = null;
    });
  return building;
}

export async function catalog(): Promise<Catalog> {
  if (!current) {
    await rebuild(await signature());
    return current!.catalog;
  }
  const age = Date.now() - current.at;
  if (age > STALE_MS && !building) {
    const sig = await signature();
    if (sig !== current.signature || age > MAX_AGE_MS) void rebuild(sig).catch(() => undefined);
    else current.at = Date.now();
  }
  return current.catalog;
}

/** For tests: the next call builds again */
export function dropCatalog() {
  current = null;
}
