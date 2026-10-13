/**
 * Groups roms into games from evidence: DAT clones, Retool clone lists, the RetroAchievements or ScreenScraper game (by hash) and title.
 * A union-find joins roms with enough confidence; the title only joins roms without Parent/Clone info. Manual rules win; conflicts go to review.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { normalizeTitle, parseRomName } from '../../lib/romname.js';
import type { JobContext } from '../../lib/jobs.js';

export const CONFIDENCE = {
  manual: 100,
  'dat-clone': 90,
  retool: 80,
  ra: 60,
  screenscraper: 60,
  title: 10,
} as const;

export type EvidenceSource = keyof typeof CONFIDENCE;

// Minimum confidence to join automatically
const AUTO = 50;

export interface EvidenceInput {
  romId: number;
  systemId: number;
  key: string;
  source: EvidenceSource;
}

export async function addRomEvidence(rows: EvidenceInput[]) {
  for (let i = 0; i < rows.length; i += 2000) {
    await prisma.groupingEvidence.createMany({
      data: rows.slice(i, i + 2000).map((r) => ({ kind: 'rom-game', romId: r.romId, gameId: null, systemId: r.systemId, key: r.key.slice(0, 255), source: r.source, confidence: CONFIDENCE[r.source] })),
      skipDuplicates: true,
    });
  }
}

export async function replaceRomEvidence(systemId: number, source: EvidenceSource, rows: EvidenceInput[]) {
  await prisma.groupingEvidence.deleteMany({ where: { kind: 'rom-game', systemId, source } });
  await addRomEvidence(rows);
}

class UnionFind {
  parent = new Map<number, number>();
  find(x: number): number {
    let p = this.parent.get(x) ?? x;
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  union(a: number, b: number) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(Math.max(ra, rb), Math.min(ra, rb));
  }
}

const REGION_RANK = ['USA', 'World', 'Europe', 'Japan'];
const regionRank = (regions: string[]) => Math.min(...regions.map((r) => (REGION_RANK.includes(r) ? REGION_RANK.indexOf(r) : 9)), 9);

export interface ResolveStats {
  systems: number;
  roms: number;
  moved: number;
  gamesCreated: number;
  gamesMerged: number;
  conflicts: number;
  lowConfidence: number;
}

/** Recomputes the regional grouping of a system (or all). */
export async function resolveRomGroups(systemId?: number, ctx?: JobContext): Promise<ResolveStats> {
  const systems = await prisma.system.findMany({ where: systemId ? { id: systemId } : {}, orderBy: { sortOrder: 'asc' } });
  const stats: ResolveStats = { systems: 0, roms: 0, moved: 0, gamesCreated: 0, gamesMerged: 0, conflicts: 0, lowConfidence: 0 };
  for (const system of systems) {
    const roms = await prisma.rom.findMany({
      where: { game: { systemId: system.id }, datSource: { type: { notIn: ['USER', 'HACKS'] } } },
      select: { id: true, name: true, description: true, gameId: true, regions: true, raGameId: true, parentName: true },
    });
    if (!roms.length) continue;
    stats.systems++;
    stats.roms += roms.length;
    const byId = new Map(roms.map((r) => [r.id, r]));
    const evidence = await prisma.groupingEvidence.findMany({ where: { kind: 'rom-game', systemId: system.id }, select: { romId: true, key: true, source: true, confidence: true } });
    const rules = await prisma.groupingRule.findMany({ where: { kind: 'rom-game' } });

    // Keys per source: the DB ones plus the derived ones (RA and title)
    const groups = new Map<string, { confidence: number; source: string; roms: number[] }>();
    const add = (key: string, source: string, confidence: number, romId: number) => {
      const k = `${source}|${key}`;
      const g = groups.get(k) ?? { confidence, source, roms: [] };
      g.roms.push(romId);
      groups.set(k, g);
    };
    const hasParentInfo = new Set<number>();
    for (const e of evidence) {
      if (!e.romId || !byId.has(e.romId)) continue;
      add(e.key, e.source, e.confidence, e.romId);
      if (e.source === 'dat-clone') hasParentInfo.add(e.romId);
    }
    for (const r of roms) {
      if (r.raGameId) add(`ra:${r.raGameId}`, 'ra', CONFIDENCE.ra, r.id);
      // In arcade the title is in the description (the name is the set name)
      if (!hasParentInfo.has(r.id)) add(`t:${normalizeTitle(parseRomName(r.description ?? r.name).title)}`, 'title', CONFIDENCE.title, r.id);
    }

    const uf = new UnionFind();
    const different = rules.filter((r) => r.rule === 'different' && r.aRomId && r.bRomId).map((r) => [r.aRomId!, r.bRomId!] as const);
    const blocked = (a: number, b: number) => {
      const ra = uf.find(a);
      const rb = uf.find(b);
      return different.some(([x, y]) => {
        const fx = uf.find(x);
        const fy = uf.find(y);
        return fx !== fy && ((fx === ra && fy === rb) || (fx === rb && fy === ra));
      });
    };
    const titleOnly = new Set<number>();
    const conflicts: { romIds: number[]; key: string; source: string }[] = [];

    for (const r of rules) if (r.rule === 'same' && r.aRomId && r.bRomId && byId.has(r.aRomId) && byId.has(r.bRomId)) uf.union(r.aRomId, r.bRomId);
    const ordered = [...groups.entries()].sort((a, b) => b[1].confidence - a[1].confidence);
    for (const [key, g] of ordered) {
      if (g.roms.length < 2) continue;
      if (g.confidence < AUTO && g.source !== 'title') continue;
      for (let i = 1; i < g.roms.length; i++) {
        const a = g.roms[0];
        const b = g.roms[i];
        if (uf.find(a) === uf.find(b)) continue;
        if (blocked(a, b)) {
          if (g.confidence >= AUTO) conflicts.push({ romIds: [a, b], key, source: g.source });
          continue;
        }
        if (g.source === 'title') {
          titleOnly.add(a);
          titleOnly.add(b);
        }
        uf.union(a, b);
      }
    }

    // Components -> games
    const comps = new Map<number, number[]>();
    for (const r of roms) {
      const root = uf.find(r.id);
      const list = comps.get(root) ?? [];
      list.push(r.id);
      comps.set(root, list);
    }
    const sorted = [...comps.values()].sort((a, b) => b.length - a.length);
    const usedGames = new Set<number>();
    const moves = new Map<number, number[]>(); // target gameId -> roms
    const lowGames = new Set<number>();
    const highGames = new Set<number>();
    for (const comp of sorted) {
      const counts = new Map<number, number>();
      for (const id of comp) counts.set(byId.get(id)!.gameId, (counts.get(byId.get(id)!.gameId) ?? 0) + 1);
      const candidates = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([g]) => g);
      let target = candidates.find((g) => !usedGames.has(g));
      if (target == null) {
        const best = comp.map((id) => byId.get(id)!).sort((a, b) => regionRank(a.regions as string[]) - regionRank(b.regions as string[]))[0];
        const parent = comp.map((id) => byId.get(id)!).find((r) => !r.parentName) ?? best;
        const title = parseRomName(parent.description ?? parent.name).title.slice(0, 255);
        const g = await prisma.game.create({ data: { systemId: system.id, title, titleNormalized: normalizeTitle(title).slice(0, 255) } });
        target = g.id;
        stats.gamesCreated++;
      }
      usedGames.add(target);
      const toMove = comp.filter((id) => byId.get(id)!.gameId !== target);
      if (toMove.length) moves.set(target, [...(moves.get(target) ?? []), ...toMove]);
      // Low confidence: joined only by title and with more than one rom
      const onlyTitle = comp.length > 1 && comp.every((id) => titleOnly.has(id) && !byId.get(id)!.raGameId);
      (onlyTitle ? lowGames : highGames).add(target);
    }

    // Games left without roms after the move are merged into the target (hacks, media, saves, lists)
    const before = new Map<number, number>();
    for (const r of roms) before.set(r.gameId, (before.get(r.gameId) ?? 0) + 1);
    for (const [target, ids] of moves) {
      for (let i = 0; i < ids.length; i += 1000) await prisma.rom.updateMany({ where: { id: { in: ids.slice(i, i + 1000) } }, data: { gameId: target } });
      stats.moved += ids.length;
    }
    if (moves.size) {
      const after = await prisma.rom.groupBy({ by: ['gameId'], where: { gameId: { in: [...before.keys()] } }, _count: true });
      const remaining = new Map(after.map((a) => [a.gameId, a._count]));
      for (const [gameId] of before) {
        if ((remaining.get(gameId) ?? 0) > 0 || usedGames.has(gameId)) continue;
        // Target: the game that received most of their roms
        const dest = [...moves.entries()].map(([t, ids]) => [t, ids.filter((id) => byId.get(id)!.gameId === gameId).length] as const).sort((a, b) => b[1] - a[1])[0];
        if (!dest || !dest[1]) continue;
        await mergeGameInto(gameId, dest[0]);
        stats.gamesMerged++;
      }
    }
    if (lowGames.size) await prisma.game.updateMany({ where: { id: { in: [...lowGames] } }, data: { groupConfidence: 'low' } });
    if (highGames.size) await prisma.game.updateMany({ where: { id: { in: [...highGames] }, groupConfidence: 'low' }, data: { groupConfidence: 'high' } });
    stats.lowConfidence += lowGames.size;
    for (const c of conflicts) {
      const key = `${system.id}:${[...c.romIds].sort().join('-')}`;
      await prisma.reviewItem.upsert({
        where: { kind_key: { kind: 'conflict', key } },
        create: { kind: 'conflict', key, systemId: system.id, payload: { romIds: c.romIds, evidenceKey: c.key, source: c.source } },
        update: {},
      });
      stats.conflicts++;
    }
    ctx?.log(`${system.slug}: ${roms.length} roms, ${comps.size} groups`);
  }
  return stats;
}

/** Merges a game into another, moving everything that hangs from it. */
export async function mergeGameInto(fromId: number, intoId: number) {
  if (fromId === intoId) return;
  await prisma.$transaction([
    prisma.rom.updateMany({ where: { gameId: fromId }, data: { gameId: intoId } }),
    prisma.romHack.updateMany({ where: { gameId: fromId }, data: { gameId: intoId } }),
    prisma.media.updateMany({ where: { gameId: fromId }, data: { gameId: intoId } }),
    prisma.save.updateMany({ where: { gameId: fromId }, data: { gameId: intoId } }),
    prisma.groupingEvidence.updateMany({ where: { gameId: fromId }, data: { gameId: intoId } }),
    prisma.$executeRaw`UPDATE IGNORE ListItem SET gameId = ${intoId}, itemKey = CONCAT('g', ${intoId}) WHERE gameId = ${fromId}`,
    prisma.$executeRaw`DELETE FROM ListItem WHERE gameId = ${fromId}`,
    prisma.game.delete({ where: { id: fromId } }),
  ]);
}

/** Manual rule: these roms are (or are not) the same game. */
export async function addRomRule(rule: 'same' | 'different', romIds: number[], userId?: number) {
  const [a, ...rest] = romIds;
  for (const b of rest) {
    await prisma.groupingRule.deleteMany({
      where: { kind: 'rom-game', OR: [{ aRomId: a, bRomId: b }, { aRomId: b, bRomId: a }] },
    });
    await prisma.groupingRule.create({ data: { kind: 'rom-game', rule, aRomId: a, bRomId: b, userId: userId ?? null } });
  }
}

export type { Prisma };
