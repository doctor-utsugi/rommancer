import { prisma } from '../../lib/prisma.js';

// Prioridad de fuentes de metadatos: una fuente nunca pisa a otra de mayor prioridad ni borra valores
const PRIORITY: Record<string, number> = { manual: 100, screenscraper: 50, thegamesdb: 40, libretro: 30, wikidata: 20 };

export type MetaField = 'title' | 'releaseYear' | 'developer' | 'publisher' | 'genre' | 'players' | 'description';

/** Rellena metadatos de un juego respetando la prioridad de fuentes. Devuelve los campos cambiados. */
export async function applyMeta(gameId: number, source: string, values: Partial<Record<MetaField, string | number | null | undefined>>) {
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game) return [];
  const sources = { ...((game.metaSources as Record<string, string> | null) ?? {}) };
  const data: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(values) as [MetaField, string | number | null | undefined][]) {
    if (value == null || value === '') continue;
    const current = game[field];
    const currentSource = sources[field];
    const allowed = current == null || current === '' || (PRIORITY[source] ?? 0) >= (PRIORITY[currentSource ?? ''] ?? 0);
    if (!allowed || current === value) continue;
    data[field] = typeof value === 'string' ? value.slice(0, field === 'description' ? 65000 : field === 'title' ? 255 : field === 'players' ? 32 : 128) : value;
    sources[field] = source;
  }
  if (!Object.keys(data).length) return [];
  await prisma.game.update({ where: { id: gameId }, data: { ...data, metaSources: sources } });
  return Object.keys(data);
}
