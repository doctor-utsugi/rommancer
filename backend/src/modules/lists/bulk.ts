/** Whole systems into a list at once: every game of the chosen systems in the version the filters ask for. */
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { ownedRomIds, pickRom, romCandidates } from '../roms/service.js';

export const bulkSchema = z.object({
  systemIds: z.array(z.number().int()).min(1).max(100),
  regions: z.array(z.string().max(32)).max(50).optional(),
  languages: z.array(z.string().max(8)).max(30).optional(),
  raOnly: z.boolean().optional(),
  ownedOnly: z.boolean().optional(),
  verifiedOnly: z.boolean().optional(),
  excludeFlags: z.array(z.string().max(32)).max(30).optional(),
  // best: one version per game, the one that fits best; all: every version that meets the filters
  mode: z.enum(['best', 'all']).default('best'),
});
export type BulkSpec = z.infer<typeof bulkSchema>;

/** The roms such a pick takes, and how many per system */
export async function bulkRoms(spec: BulkSpec) {
  const pref = {
    regions: spec.regions,
    strictRegions: !!spec.regions?.length,
    languages: spec.languages,
    strictLanguages: !!spec.languages?.length,
    raOnly: spec.raOnly,
    ownedOnly: spec.ownedOnly,
    excludeFlags: spec.excludeFlags,
  };
  const games = await prisma.game.findMany({
    where: { systemId: { in: spec.systemIds } },
    orderBy: [{ systemId: 'asc' }, { title: 'asc' }],
    select: {
      id: true,
      systemId: true,
      roms: { select: { id: true, name: true, regions: true, languages: true, flags: true, revision: true, raGameId: true, isBios: true, datSource: { select: { type: true } } } },
    },
  });
  const owned = spec.ownedOnly || spec.mode === 'best' ? await ownedRomIds({ include: 'any' }) : undefined;
  const romIds: number[] = [];
  const per = new Map<number, { systemId: number; games: number; roms: number }>(spec.systemIds.map((id) => [id, { systemId: id, games: 0, roms: 0 }]));
  for (const g of games) {
    const usable = spec.verifiedOnly ? g.roms.filter((r) => r.datSource.type !== 'USER') : g.roms;
    const take = spec.mode === 'best' ? [pickRom(usable, pref, owned)].filter((r) => !!r) : romCandidates(usable, pref, owned);
    if (!take.length) continue;
    const p = per.get(g.systemId)!;
    p.games++;
    p.roms += take.length;
    for (const r of take) romIds.push(r!.id);
  }
  return { romIds, games: [...per.values()].reduce((n, p) => n + p.games, 0), perSystem: [...per.values()] };
}
