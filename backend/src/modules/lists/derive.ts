/** Sublists: the same games in the version the filters ask for; games without it follow the user's decisions,
 * kept with the sublist so a refresh repeats them. */
import { prisma } from '../../lib/prisma.js';
import { ownedRomIds, pickFromWork, pickRom, romScore, type RomPreference } from '../roms/service.js';

export interface DeriveFilters extends RomPreference {
  /** Leave out roms nobody verified against a DAT (hand uploads) */
  verifiedOnly?: boolean;
}

export type RestRule = { mode: 'skip' } | { mode: 'like'; romId: number };

export interface DerivedSpec {
  v: 2;
  filters: DeriveFilters;
  /** Game id -> rom id to take, or null to leave the game out */
  perGame: Record<string, number | null>;
  /** Games without the version and without their own decision */
  rest: RestRule;
}

/** Sublists made before decisions existed kept only their preferences */
export function specOf(stored: unknown): DerivedSpec {
  const s = (stored ?? {}) as Partial<DerivedSpec> & RomPreference;
  if (s.v === 2) return { v: 2, filters: s.filters ?? {}, perGame: s.perGame ?? {}, rest: s.rest ?? { mode: 'skip' } };
  return { v: 2, filters: s as DeriveFilters, perGame: {}, rest: { mode: 'skip' } };
}

const romSelect = { id: true, name: true, regions: true, languages: true, flags: true, revision: true, raGameId: true, isBios: true, gameId: true, datSource: { select: { type: true } } } as const;

/** The games of a list in its order (from its roms), and its romhacks and unknown files, which have no versions to choose from */
async function sourceOf(listId: number) {
  const items = await prisma.listItem.findMany({
    where: { listId },
    orderBy: { position: 'asc' },
    include: { rom: { select: { gameId: true } }, hack: { select: { id: true } } },
  });
  const order: { gameId?: number; hackId?: number; unknownId?: number }[] = [];
  const seen = new Set<number>();
  for (const i of items) {
    if (i.hack) order.push({ hackId: i.hack.id });
    else if (i.unknownId) order.push({ unknownId: i.unknownId });
    else if (i.rom && !seen.has(i.rom.gameId)) {
      seen.add(i.rom.gameId);
      order.push({ gameId: i.rom.gameId });
    }
  }
  const games = await prisma.game.findMany({
    where: { id: { in: [...seen] } },
    select: { id: true, title: true, workId: true, system: { select: { slug: true, name: true } }, roms: { select: romSelect } },
  });
  // The same work on other systems, for sublists that prefer platforms
  const workIds = [...new Set(games.flatMap((g) => (g.workId ? [g.workId] : [])))];
  const siblings = workIds.length
    ? await prisma.game.findMany({ where: { workId: { in: workIds } }, select: { id: true, workId: true, system: { select: { slug: true, name: true } }, roms: { select: romSelect } } })
    : [];
  const owned = await ownedRomIds({ romIds: [...games, ...siblings].flatMap((g) => g.roms.map((r) => r.id)), include: 'any' });
  return { order, games: new Map(games.map((g) => [g.id, g])), siblings, owned };
}

type Source = Awaited<ReturnType<typeof sourceOf>>;
type SourceRom = Source['games'] extends Map<number, infer G> ? (G extends { roms: (infer R)[] } ? R : never) : never;

/** With platforms asked for, the version may come from the same work on another system */
function matchGame(src: Source, g: Source['games'] extends Map<number, infer G> ? G : never, f: DeriveFilters): SourceRom | null {
  if (f.platforms?.length && g.workId) {
    const games = src.siblings.filter((x) => x.workId === g.workId).map((x) => ({ ...x, roms: f.verifiedOnly ? x.roms.filter((r) => r.datSource.type !== 'USER') : x.roms }));
    return (pickFromWork(games, f, src.owned)?.rom as SourceRom | undefined) ?? null;
  }
  return match(g.roms, f, src.owned);
}

function match(roms: SourceRom[], f: DeriveFilters, owned: Set<number>) {
  const usable = f.verifiedOnly ? roms.filter((r) => r.datSource.type !== 'USER') : roms;
  return pickRom(usable, f, owned);
}

/** The version most like LIKE (its regions and languages), or any acceptable one */
function likeOf(roms: SourceRom[], like: { regions: unknown; languages: unknown }, f: DeriveFilters, owned: Set<number>) {
  const base = { excludeFlags: f.excludeFlags, verifiedOnly: f.verifiedOnly };
  return match(roms, { ...base, regions: like.regions as string[], languages: like.languages as string[], strictRegions: true }, owned) ?? match(roms, base, owned);
}

const view = (r: SourceRom, owned: Set<number>) => ({
  id: r.id,
  name: r.name,
  regions: r.regions as string[],
  languages: r.languages as string[],
  flags: r.flags as string[],
  revision: r.revision,
  ra: r.raGameId != null,
  owned: owned.has(r.id),
  verified: r.datSource.type !== 'USER',
});

/** What a sublist with these filters would hold: the games with the version, and those without it with their versions */
export async function previewDerive(listId: number, filters: DeriveFilters) {
  const src = await sourceOf(listId);
  const matched: { gameId: number; title: string; rom: ReturnType<typeof view> }[] = [];
  const missing: { gameId: number; title: string; system: string; versions: ReturnType<typeof view>[] }[] = [];
  for (const o of src.order) {
    if (!o.gameId) continue;
    const g = src.games.get(o.gameId)!;
    const pick = matchGame(src, g, filters);
    if (pick) matched.push({ gameId: g.id, title: g.title, rom: view(pick, src.owned) });
    else {
      // Best first, by the usual preference (owned, achievements, clean dumps, newest revision)
      const ranked = g.roms.filter((r) => !r.isBios).sort((a, b) => romScore(b, {}, src.owned) - romScore(a, {}, src.owned));
      missing.push({ gameId: g.id, title: g.title, system: g.system.name, versions: ranked.map((r) => view(r, src.owned)) });
    }
  }
  return { matched, missing, hacks: src.order.filter((o) => o.hackId).length, unknown: src.order.filter((o) => o.unknownId).length };
}

/** The items of a sublist: its filters, then the decisions for the games without the version */
export async function resolveDerive(listId: number, spec: DerivedSpec) {
  const src = await sourceOf(listId);
  const like = spec.rest.mode === 'like' ? await prisma.rom.findUnique({ where: { id: spec.rest.romId }, select: { regions: true, languages: true } }) : null;
  const items: { romId?: number; hackId?: number; unknownId?: number }[] = [];
  const skipped: string[] = [];
  for (const o of src.order) {
    if (o.hackId || o.unknownId) {
      items.push(o.hackId ? { hackId: o.hackId } : { unknownId: o.unknownId });
      continue;
    }
    const g = src.games.get(o.gameId!)!;
    let rom: SourceRom | null = matchGame(src, g, spec.filters);
    if (!rom) {
      const d = spec.perGame[String(g.id)];
      if (d === null) rom = null;
      else if (d !== undefined) rom = g.roms.find((r) => r.id === d) ?? null;
      else if (like) rom = likeOf(g.roms, like, spec.filters, src.owned);
    }
    if (rom) items.push({ romId: rom.id });
    else skipped.push(g.title);
  }
  return { items, skipped };
}
