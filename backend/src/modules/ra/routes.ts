import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { badRequest } from '../../lib/http.js';
import { me, requireAdmin } from '../auth/middleware.js';
import { linkRaGames } from '../scanner/service.js';
import { forceSync } from '../sync/service.js';

export const raRouter = Router();

interface RaApiGame {
  ID: number;
  Title: string;
  NumAchievements?: number;
  ImageIcon?: string;
  Hashes?: string[];
}

export async function storeRaGames(systemId: number, games: RaApiGame[]) {
  let hashes = 0;
  for (const g of games) {
    const data = { systemId, title: g.Title.slice(0, 255), numAchievements: g.NumAchievements ?? 0, imageIcon: g.ImageIcon ?? null };
    await prisma.raGame.upsert({ where: { id: g.ID }, create: { id: g.ID, ...data }, update: data });
    const hs = [...new Set((g.Hashes ?? []).map((h) => h.toLowerCase()).filter((h) => /^[0-9a-f]{32}$/.test(h)))];
    // Permanente: los hashes que desaparecen de RetroAchievements se conservan
    if (hs.length) await prisma.raHash.createMany({ data: hs.map((hash) => ({ hash, raGameId: g.ID })), skipDuplicates: true });
    hashes += hs.length;
  }
  await linkRaGames();
  return { games: games.length, hashes };
}

// Sincronizacion bajo demanda (por sistema): pasa por la sincronizacion global con sus protecciones
raRouter.post('/sync', requireAdmin, async (req, res) => {
  const { systemId } = z.object({ systemId: z.number().int().optional() }).parse(req.body ?? {});
  const system = systemId ? await prisma.system.findUniqueOrThrow({ where: { id: systemId } }) : null;
  res.status(202).json(await forceSync(['retroachievements'], system?.slug, me(req).id));
});

// Importacion offline de una respuesta de API_GetGameList guardada en JSON
raRouter.post('/import', requireAdmin, async (req, res) => {
  const body = z
    .object({
      system: z.string(),
      games: z.array(z.object({ ID: z.number().int(), Title: z.string(), NumAchievements: z.number().int().optional(), ImageIcon: z.string().optional(), Hashes: z.array(z.string()).optional() })),
    })
    .parse(req.body);
  const system = await prisma.system.findUnique({ where: { slug: body.system } });
  if (!system) throw badRequest('Unknown system');
  res.json(await storeRaGames(system.id, body.games));
});

raRouter.get('/status', async (_req, res) => {
  const rows = await prisma.$queryRaw<{ slug: string; games: bigint; hashes: bigint; roms: bigint }[]>`
    SELECT s.slug,
      (SELECT COUNT(*) FROM RaGame g WHERE g.systemId = s.id) AS games,
      (SELECT COUNT(*) FROM RaHash h JOIN RaGame g ON g.id = h.raGameId WHERE g.systemId = s.id) AS hashes,
      (SELECT COUNT(*) FROM Rom r JOIN Game g ON g.id = r.gameId WHERE g.systemId = s.id AND r.raGameId IS NOT NULL) AS roms
    FROM \`System\` s WHERE s.raConsoleId IS NOT NULL ORDER BY s.sortOrder`;
  res.json(rows.map((r) => ({ slug: r.slug, games: Number(r.games), hashes: Number(r.hashes), roms: Number(r.roms) })));
});
