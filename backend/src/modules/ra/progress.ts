/** Each user's RetroAchievements progress, read with their own Web API key (free, from their RA settings page). */
import { prisma } from '../../lib/prisma.js';
import { decrypt } from '../../lib/crypto.js';
import { env } from '../../config/env.js';
import { badRequest, HttpError } from '../../lib/http.js';

/** Read again when older than this, the next time the user looks */
const STALE_MS = 6 * 3600_000;
const running = new Map<number, Promise<void>>();

async function raGet<T>(endpoint: string, params: Record<string, string>): Promise<T> {
  const r = await fetch(`${env.ra.baseUrl}/${endpoint}?${new URLSearchParams(params)}`, { headers: { 'User-Agent': env.userAgent }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
  if (!r) throw new HttpError(502, 'RetroAchievements could not be reached');
  if (r.status === 401 || r.status === 403) throw badRequest('RetroAchievements did not accept the user or the Web API key');
  if (!r.ok) throw new HttpError(502, `RetroAchievements answered ${r.status}`);
  return (await r.json()) as T;
}

/** Whether RetroAchievements accepts this user and Web API key (throws a 400 when not) */
export async function checkKey(user: string, key: string) {
  const p = await raGet<{ User?: string }>('API_GetUserProfile.php', { u: user, y: key });
  if (!p?.User) throw badRequest('RetroAchievements does not know that user');
}

interface Completion {
  Total: number;
  Results: { GameID: number; MaxPossible: number; NumAwarded: number; NumAwardedHardcore: number; MostRecentAwardedDate?: string | null }[];
}

/** Reads the user's progress; a read already under way is waited for instead of starting another */
export function refreshProgress(userId: number): Promise<void> {
  const current = running.get(userId);
  if (current) return current;
  const p = readProgress(userId).finally(() => running.delete(userId));
  running.set(userId, p);
  return p;
}

async function readProgress(userId: number) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const user = decrypt(u.raUser);
  const key = decrypt(u.raApiKey);
  if (!user || !key) throw badRequest('Set your RetroAchievements user and Web API key first');
  const profile = await raGet<{ User?: string; UserPic?: string; TotalPoints?: number; TotalSoftcorePoints?: number; TotalTruePoints?: number; MemberSince?: string }>('API_GetUserProfile.php', { u: user, y: key });
  const rows: Completion['Results'] = [];
  for (let offset = 0; offset < 20_000; offset += 500) {
    const page = await raGet<Completion>('API_GetUserCompletionProgress.php', { u: user, y: key, c: '500', o: String(offset) });
    rows.push(...(page.Results ?? []));
    if (!page.Results?.length || rows.length >= page.Total) break;
  }
  await prisma.$transaction([
    prisma.raUserProgress.deleteMany({ where: { userId } }),
    prisma.raUserProgress.createMany({
      data: rows.map((g) => ({
        userId,
        raGameId: g.GameID,
        awarded: g.NumAwarded ?? 0,
        awardedHardcore: g.NumAwardedHardcore ?? 0,
        total: g.MaxPossible ?? 0,
        lastAt: g.MostRecentAwardedDate ? new Date(g.MostRecentAwardedDate) : null,
      })),
      skipDuplicates: true,
    }),
    prisma.user.update({
      where: { id: userId },
      data: {
        raProgressAt: new Date(),
        raProfile: {
          user: profile.User ?? user,
          pic: profile.UserPic ? `https://media.retroachievements.org${profile.UserPic}` : null,
          points: profile.TotalPoints ?? 0,
          softcorePoints: profile.TotalSoftcorePoints ?? 0,
          truePoints: profile.TotalTruePoints ?? 0,
          memberSince: profile.MemberSince ?? null,
          games: rows.length,
          achievements: rows.reduce((n, g) => n + (g.NumAwarded ?? 0), 0),
          mastered: rows.filter((g) => g.MaxPossible > 0 && g.NumAwardedHardcore >= g.MaxPossible).length,
        },
      },
    }),
  ]);
}

/** The user's summary; an old one is read again in the background */
export async function progressSummary(userId: number) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { raUser: true, raApiKey: true, raProfile: true, raProgressAt: true } });
  const configured = !!(u.raUser && u.raApiKey);
  if (configured && (!u.raProgressAt || Date.now() - u.raProgressAt.getTime() > STALE_MS)) void refreshProgress(userId).catch(() => {});
  return { configured, profile: u.raProfile, at: u.raProgressAt, refreshing: running.has(userId) };
}

export async function progressFor(userId: number, raGameIds: number[]) {
  if (!raGameIds.length) return new Map<number, { awarded: number; awardedHardcore: number; total: number }>();
  const rows = await prisma.raUserProgress.findMany({ where: { userId, raGameId: { in: raGameIds } } });
  return new Map(rows.map((r) => [r.raGameId, r]));
}
