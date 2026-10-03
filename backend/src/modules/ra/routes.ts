import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { decrypt } from '../../lib/crypto.js';
import { badRequest } from '../../lib/http.js';
import { enqueue, registerJob } from '../../lib/jobs.js';
import { me, requireAdmin } from '../auth/middleware.js';
import { linkRaGames } from '../scanner/service.js';

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
    await prisma.raHash.deleteMany({ where: { raGameId: g.ID } });
    if (hs.length) await prisma.raHash.createMany({ data: hs.map((hash) => ({ hash, raGameId: g.ID })), skipDuplicates: true });
    hashes += hs.length;
  }
  await linkRaGames();
  return { games: games.length, hashes };
}

registerJob('ra-sync', async (ctx) => {
  const u = await prisma.user.findUnique({ where: { id: ctx.params.userId } });
  const apiKey = decrypt(u?.raApiKey) || env.ra.apiKey;
  if (!apiKey) throw new Error('RetroAchievements API key missing');
  const systems = await prisma.system.findMany({ where: { raConsoleId: { not: null }, ...(ctx.params.systemId ? { id: ctx.params.systemId } : {}) } });
  const out: Record<string, unknown> = {};
  for (const [i, s] of systems.entries()) {
    const q = new URLSearchParams({ i: String(s.raConsoleId), h: '1', f: '1', y: apiKey });
    const r = await fetch(`${env.ra.baseUrl}/API_GetGameList.php?${q}`);
    if (!r.ok) {
      ctx.log(`${s.slug}: HTTP ${r.status}`);
      continue;
    }
    const games = (await r.json()) as RaApiGame[];
    out[s.slug] = await storeRaGames(s.id, games);
    ctx.log(`${s.slug}: ${JSON.stringify(out[s.slug])}`);
    await ctx.progress(i + 1, systems.length, s.slug);
    await new Promise((r) => setTimeout(r, 500));
  }
  const { scheduleSeedExport } = await import('../seed/service.js');
  await scheduleSeedExport();
  return out;
});

raRouter.post('/sync', requireAdmin, async (req, res) => {
  const { systemId } = z.object({ systemId: z.number().int().optional() }).parse(req.body ?? {});
  res.status(202).json(await enqueue('ra-sync', { systemId, userId: me(req).id }, me(req).id));
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
