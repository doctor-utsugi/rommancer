// Name, sort name and description of copied games, for frontends that have no gamelist entry for them
import { prisma } from '../../lib/prisma.js';
import type { PlanFile } from './plan.js';

export interface GameMeta {
  name: string;
  sortName: string | null;
  desc: string | null;
}

const field = (s: string) => s.replace(/[\t\r\n]+/g, ' ').trim();

/** Games derived from another (hacks, uploaded randomizers) sort right after it */
export function gameMeta(f: Pick<PlanFile, 'title' | 'hack'>, game: { title: string; description: string | null; baseTitle: string | null }): GameMeta {
  const name = f.hack ? f.title : game.title;
  const base = f.hack ? game.title : game.baseTitle;
  const sortName = base && !name.toLowerCase().startsWith(base.toLowerCase()) ? `${base} ${name}` : null;
  return { name, sortName, desc: f.hack ? null : game.description };
}

/** "meta<TAB>dest<TAB>name<TAB>sortname<TAB>description" for each file of a known game */
export async function metaLines(files: PlanFile[]): Promise<string[]> {
  const ids = [...new Set(files.flatMap((f) => (f.gameId ? [f.gameId] : [])))];
  if (!ids.length) return [];
  const games = await prisma.game.findMany({ where: { id: { in: ids } }, select: { id: true, title: true, description: true, baseGame: { select: { title: true } } } });
  const byId = new Map(games.map((g) => [g.id, { title: g.title, description: g.description, baseTitle: g.baseGame?.title ?? null }]));
  return files.flatMap((f) => {
    const g = f.gameId ? byId.get(f.gameId) : undefined;
    if (!g) return [];
    const m = gameMeta(f, g);
    return [['meta', f.dest, field(m.name), field(m.sortName ?? ''), field(m.desc ?? '')].join('\t')];
  });
}
