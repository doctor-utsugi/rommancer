import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

// Parts that do not count toward a complete rom (.cue files often differ from the DAT)
const IGNORED_PART = `(p.name LIKE '%.cue' OR p.name LIKE '%.gdi' OR p.name LIKE '%.sub' OR p.name LIKE '%.m3u')`;

/** Ids of complete roms on disk. Verified only by default; 'any' includes unverified ones (lists, devices). */
export async function ownedRomIds(filter: { systemId?: number; romIds?: number[]; include?: 'verified' | 'any' } = {}): Promise<Set<number>> {
  if (filter.romIds && !filter.romIds.length) return new Set();
  if (filter.include === 'any') {
    const [a, b] = await Promise.all([ownedRomIds({ ...filter, include: 'verified' }), ownedWithStatus(filter, 'UNVERIFIED')]);
    return new Set([...a, ...b]);
  }
  return ownedWithStatus(filter, 'MATCHED');
}

async function ownedWithStatus(filter: { systemId?: number; romIds?: number[] }, status: 'MATCHED' | 'UNVERIFIED'): Promise<Set<number>> {
  const conds: Prisma.Sql[] = [Prisma.raw(`NOT ${IGNORED_PART}`)];
  if (filter.systemId) conds.push(Prisma.sql`g.systemId = ${filter.systemId}`);
  if (filter.romIds) conds.push(Prisma.sql`p.romId IN (${Prisma.join(filter.romIds)})`);
  const rows = await prisma.$queryRaw<{ romId: number }[]>`
    SELECT p.romId AS romId
    FROM RomPart p
    JOIN Rom r ON r.id = p.romId
    JOIN Game g ON g.id = r.gameId
    LEFT JOIN (SELECT DISTINCT romPartId FROM RomFile WHERE romPartId IS NOT NULL AND status = ${status}) f ON f.romPartId = p.id
    WHERE ${Prisma.join(conds, ' AND ')}
    GROUP BY p.romId
    HAVING COUNT(*) = COUNT(f.romPartId)`;
  return new Set(rows.map((r) => Number(r.romId)));
}

export async function ownedGameIds(systemId?: number): Promise<Set<number>> {
  const owned = await ownedRomIds({ systemId });
  if (!owned.size) return new Set();
  const ids = [...owned];
  const out = new Set<number>();
  for (let i = 0; i < ids.length; i += 5000) {
    const rows = await prisma.rom.findMany({ where: { id: { in: ids.slice(i, i + 5000) } }, select: { gameId: true } });
    rows.forEach((r) => out.add(r.gameId));
  }
  // Games with any romhack present also count as "I have something"
  return out;
}

export async function systemStats() {
  const systems = await prisma.system.findMany({ orderBy: { sortOrder: 'asc' } });
  const totals = await prisma.$queryRaw<{ systemId: number; roms: bigint; games: bigint }[]>`
    SELECT g.systemId AS systemId, COUNT(r.id) AS roms, COUNT(DISTINCT g.id) AS games
    FROM Game g JOIN Rom r ON r.gameId = g.id JOIN DatSource d ON d.id = r.datSourceId WHERE r.isBios = 0 AND d.type NOT IN ('USER', 'HACKS') GROUP BY g.systemId`;
  const files = await prisma.$queryRaw<{ systemId: number | null; status: string; n: bigint }[]>`
    SELECT systemId, status, COUNT(*) AS n FROM RomFile GROUP BY systemId, status`;
  const owned = await prisma.$queryRaw<{ systemId: number; n: bigint }[]>`
    SELECT x.systemId, COUNT(*) AS n FROM (
      SELECT g.systemId AS systemId, p.romId
      FROM RomPart p JOIN Rom r ON r.id = p.romId JOIN Game g ON g.id = r.gameId
      LEFT JOIN (SELECT DISTINCT romPartId FROM RomFile WHERE romPartId IS NOT NULL AND status = 'MATCHED') f ON f.romPartId = p.id
      WHERE NOT ${Prisma.raw(IGNORED_PART)} AND r.isBios = 0 AND r.datSourceId NOT IN (SELECT id FROM DatSource WHERE type = 'USER')
      GROUP BY g.systemId, p.romId HAVING COUNT(*) = COUNT(f.romPartId)
    ) x GROUP BY x.systemId`;
  const hackCount = await prisma.$queryRaw<{ systemId: number; n: bigint }[]>`
    SELECT g.systemId, COUNT(*) AS n FROM RomHack h JOIN Game g ON g.id = h.gameId GROUP BY g.systemId`;
  return systems.map((s) => {
    const t = totals.find((x) => Number(x.systemId) === s.id);
    const f = files.filter((x) => x.systemId === s.id);
    return {
      ...s,
      games: Number(t?.games ?? 0),
      roms: Number(t?.roms ?? 0),
      owned: Number(owned.find((x) => Number(x.systemId) === s.id)?.n ?? 0),
      hacks: Number(hackCount.find((x) => Number(x.systemId) === s.id)?.n ?? 0),
      files: {
        matched: Number(f.find((x) => x.status === 'MATCHED')?.n ?? 0),
        hack: Number(f.find((x) => x.status === 'HACK')?.n ?? 0),
        unknown: Number(f.find((x) => x.status === 'UNKNOWN')?.n ?? 0),
        unverified: Number(f.find((x) => x.status === 'UNVERIFIED')?.n ?? 0),
      },
    };
  });
}

export interface RomPreference {
  regions?: string[];
  languages?: string[];
  raOnly?: boolean;
  ownedOnly?: boolean;
  strictRegions?: boolean;
  strictLanguages?: boolean;
  excludeFlags?: string[];
  // Cross-platform works: systems (slugs) in order of preference
  platforms?: string[];
}

type RomForPick = {
  id: number;
  name: string;
  regions: unknown;
  languages: unknown;
  flags: unknown;
  revision: string | null;
  raGameId: number | null;
  isBios: boolean;
};

const DEFAULT_EXCLUDE = ['proto', 'beta', 'demo', 'sample', 'pirate'];

/** Picks the best rom of a game by preferences. Returns null if none meets the filters. */
export function pickRom<T extends RomForPick>(roms: T[], pref: RomPreference, owned?: Set<number>): T | null {
  const cands = romCandidates(roms, pref, owned);
  if (!cands.length) return null;
  return cands.sort((a, b) => romScore(b, pref, owned) - romScore(a, pref, owned))[0];
}

/** The roms that meet the preferences' hard rules (flags, achievements, owned, strict regions and languages) */
export function romCandidates<T extends RomForPick>(roms: T[], pref: RomPreference, owned?: Set<number>): T[] {
  const exclude = pref.excludeFlags ?? DEFAULT_EXCLUDE;
  let cands = roms.filter((r) => !r.isBios && !(r.flags as string[]).some((f) => exclude.includes(f)));
  if (pref.raOnly) cands = cands.filter((r) => r.raGameId != null);
  if (pref.ownedOnly && owned) cands = cands.filter((r) => owned.has(r.id));
  const regions = pref.regions ?? [];
  if (pref.strictRegions && regions.length)
    cands = cands.filter((r) => (r.regions as string[]).some((x) => regions.includes(x) || x === 'World'));
  const langs = pref.languages ?? [];
  if (pref.strictLanguages && langs.length) cands = cands.filter((r) => (r.languages as string[]).some((x) => langs.includes(x)));
  return cands;
}

/** How well a rom fits the preferences: region and language order, owned, achievements, clean dump, newest revision */
export function romScore(r: RomForPick, pref: RomPreference = {}, owned?: Set<number>) {
  const regions = pref.regions ?? [];
  const langs = pref.languages ?? [];
  const rr = r.regions as string[];
  const ll = r.languages as string[];
  let s = 0;
  const ri = regions.findIndex((x) => rr.includes(x) || (x !== 'World' && rr.includes('World')));
  s += ri >= 0 ? (regions.length - ri) * 1000 : 0;
  const li = langs.findIndex((x) => ll.includes(x));
  s += li >= 0 ? (langs.length - li) * 100 : 0;
  if (owned?.has(r.id)) s += 50;
  if (r.raGameId) s += 20;
  if ((r.flags as string[]).length === 0) s += 10;
  // Higher revisions first
  const rev = r.revision?.match(/[\d.]+|[A-Z]$/)?.[0];
  if (rev) s += Math.min(9, isNaN(Number(rev)) ? rev.charCodeAt(0) - 64 : Number(rev));
  return s;
}

/** Picks game and rom of a work: first the preferred platform that has a valid rom. */
export function pickFromWork<R extends RomForPick, G extends { id: number; system: { slug: string }; roms: R[] }>(games: G[], pref: RomPreference, owned?: Set<number>): { game: G; rom: R } | null {
  const order = pref.platforms ?? [];
  const rank = (g: G) => (order.includes(g.system.slug) ? order.indexOf(g.system.slug) : order.length + (g.roms.some((r) => owned?.has(r.id)) ? 0 : 1));
  for (const g of [...games].sort((a, b) => rank(a) - rank(b))) {
    if (order.length && pref.strictRegions && !order.includes(g.system.slug)) continue;
    const rom = pickRom(g.roms, pref, owned);
    if (rom) return { game: g, rom };
  }
  return null;
}
