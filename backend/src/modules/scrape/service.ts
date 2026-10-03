import fs from 'node:fs';
import path from 'node:path';
import type { MediaType } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { decrypt } from '../../lib/crypto.js';
import type { JobContext } from '../../lib/jobs.js';
import { ownedRomIds, pickRom } from '../roms/service.js';

const SS_TYPES: Record<string, MediaType> = {
  'box-2D': 'COVER',
  ss: 'SCREENSHOT',
  sstitle: 'TITLE',
  manuel: 'MANUAL',
  'video-normalized': 'VIDEO',
  wheel: 'WHEEL',
  screenmarquee: 'MARQUEE',
};

const LIBRETRO_TYPES: [string, MediaType][] = [
  ['Named_Boxarts', 'COVER'],
  ['Named_Snaps', 'SCREENSHOT'],
  ['Named_Titles', 'TITLE'],
];

const REGION_PREF = ['eu', 'sp', 'us', 'wor', 'ss', 'jp'];
const LANG_PREF = ['es', 'en', 'fr'];

export interface SsCredentials {
  devId: string;
  devPassword: string;
  user: string;
  password: string;
}

export async function ssCredentialsFor(userId: number): Promise<SsCredentials | null> {
  const u = await prisma.user.findUnique({ where: { id: userId } });
  const user = decrypt(u?.ssUser) || env.screenscraper.user;
  const password = decrypt(u?.ssPassword) || env.screenscraper.password;
  if (!env.screenscraper.devId || !user) return null;
  return { devId: env.screenscraper.devId, devPassword: env.screenscraper.devPassword, user, password };
}

async function download(url: string, dest: string): Promise<boolean> {
  const r = await fetch(url);
  if (!r.ok) return false;
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) return false;
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.writeFile(dest, buf);
  return true;
}

function pickLocalized<T extends { text: string }>(arr: (T & Record<string, string>)[] | undefined, key: 'region' | 'langue', prefs: string[]): string | null {
  if (!arr?.length) return null;
  for (const p of prefs) {
    const x = arr.find((a) => a[key] === p);
    if (x) return x.text;
  }
  return arr[0].text;
}

async function saveMedia(gameId: number, romId: number | null, type: MediaType, source: string, rel: string, region: string | null) {
  await prisma.media.deleteMany({ where: { gameId, type, source } });
  await prisma.media.create({ data: { gameId, romId, type, source, path: rel, region } });
}

interface ScrapeTarget {
  gameId: number;
  romId: number | null;
  systemSlug: string;
  datName: string;
  ssSystemId: number | null;
  romName: string;
  // Nombres alternativos para buscar en libretro-thumbnails
  altNames: string[];
  part: { name: string; size: bigint; crc32: string | null; md5: string | null; sha1: string | null } | null;
}

export async function scrapeScreenScraper(t: ScrapeTarget, creds: SsCredentials, types: MediaType[], ctx?: JobContext): Promise<number> {
  const q = new URLSearchParams({
    devid: creds.devId,
    devpassword: creds.devPassword,
    softname: 'rommancer',
    output: 'json',
    ssid: creds.user,
    sspassword: creds.password,
    romtype: 'rom',
    romnom: t.part?.name ?? t.romName,
  });
  if (t.ssSystemId) q.set('systemeid', String(t.ssSystemId));
  if (t.part) {
    q.set('romtaille', String(t.part.size));
    if (t.part.crc32) q.set('crc', t.part.crc32);
    if (t.part.md5) q.set('md5', t.part.md5);
    if (t.part.sha1) q.set('sha1', t.part.sha1);
  }
  const r = await fetch(`${env.screenscraper.baseUrl}/jeuInfos.php?${q}`);
  if (r.status === 429 || r.status === 430) throw new Error(`ScreenScraper quota/rate limit (${r.status})`);
  if (!r.ok) {
    ctx?.log(`ScreenScraper ${t.romName}: HTTP ${r.status}`);
    return 0;
  }
  const data = (await r.json()) as { response?: { jeu?: any } };
  const jeu = data.response?.jeu;
  if (!jeu) return 0;
  const genre = jeu.genres?.[0]?.noms ? pickLocalized(jeu.genres[0].noms, 'langue', LANG_PREF) : null;
  const date = pickLocalized(jeu.dates, 'region', REGION_PREF);
  await prisma.game.update({
    where: { id: t.gameId },
    data: {
      ssGameId: Number(jeu.id) || null,
      description: pickLocalized(jeu.synopsis, 'langue', LANG_PREF),
      developer: jeu.developpeur?.text?.slice(0, 128) ?? null,
      publisher: jeu.editeur?.text?.slice(0, 128) ?? null,
      players: jeu.joueurs?.text?.slice(0, 32) ?? null,
      genre: genre?.slice(0, 128) ?? null,
      releaseYear: date ? Number(String(date).slice(0, 4)) || null : null,
      scrapedAt: new Date(),
    },
  });
  let n = 0;
  for (const [ssType, type] of Object.entries(SS_TYPES)) {
    if (!types.includes(type)) continue;
    const medias = (jeu.medias ?? []).filter((m: any) => m.type === ssType);
    if (!medias.length) continue;
    const m = REGION_PREF.map((p) => medias.find((x: any) => x.region === p)).find(Boolean) ?? medias[0];
    const rel = path.join(t.systemSlug, String(t.gameId), `${type.toLowerCase()}-ss.${m.format ?? 'png'}`);
    if (await download(m.url, path.join(env.mediaDir, rel))) {
      await saveMedia(t.gameId, t.romId, type, 'screenscraper', rel, m.region ?? null);
      n++;
    }
  }
  return n;
}

export function libretroName(name: string) {
  return name.replace(/[&*/:`<>?\\|"]/g, '_');
}

export async function scrapeLibretro(t: ScrapeTarget, types: MediaType[]): Promise<number> {
  const repo = t.datName.replace(/ /g, '_');
  let n = 0;
  for (const [folder, type] of LIBRETRO_TYPES) {
    if (!types.includes(type)) continue;
    const rel = path.join(t.systemSlug, String(t.gameId), `${type.toLowerCase()}-libretro.png`);
    for (const name of [t.romName, ...t.altNames.filter((x) => x !== t.romName)].slice(0, 6)) {
      const url = `${env.libretroThumbsUrl}/${encodeURIComponent(repo)}/master/${folder}/${encodeURIComponent(libretroName(name))}.png`;
      if (await download(url, path.join(env.mediaDir, rel))) {
        await saveMedia(t.gameId, t.romId, type, 'libretro', rel, null);
        n++;
        break;
      }
    }
  }
  if (n) await prisma.game.update({ where: { id: t.gameId }, data: { scrapedAt: new Date() } });
  return n;
}

const regionRank = (regions: string[]) => {
  const order = ['USA', 'World', 'Europe', 'Japan'];
  const i = Math.min(...regions.map((r) => (order.includes(r) ? order.indexOf(r) : 9)));
  return Number.isFinite(i) ? i : 9;
};

export async function scrapeGames(
  gameIds: number[],
  opts: { userId: number; sources: ('screenscraper' | 'libretro')[]; types: MediaType[]; overwrite: boolean },
  ctx?: JobContext,
) {
  const creds = opts.sources.includes('screenscraper') ? await ssCredentialsFor(opts.userId) : null;
  if (opts.sources.includes('screenscraper') && !creds) ctx?.log('ScreenScraper credentials missing, skipping it');
  const stats = { games: gameIds.length, scraped: 0, media: 0, notFound: 0 };
  for (const [i, gameId] of gameIds.entries()) {
    const game = await prisma.game.findUniqueOrThrow({ where: { id: gameId }, include: { system: true, roms: { include: { parts: { take: 1 } } }, media: true } });
    if (!opts.overwrite && game.media.some((m) => m.type === 'COVER')) {
      await ctx?.progress(i + 1, gameIds.length, game.title);
      continue;
    }
    const owned = await ownedRomIds({ romIds: game.roms.map((r) => r.id) });
    const rom = pickRom(game.roms, { regions: ['Europe', 'USA', 'World', 'Japan'] }, owned) ?? game.roms[0];
    const t: ScrapeTarget = {
      gameId,
      romId: rom?.id ?? null,
      systemSlug: game.system.slug,
      datName: game.system.datName,
      ssSystemId: game.system.ssSystemId,
      romName: rom?.name ?? game.title,
      altNames: [...game.roms]
        .sort((a, b) => regionRank(a.regions as string[]) - regionRank(b.regions as string[]))
        .map((r) => r.name),
      part: rom?.parts[0] ?? null,
    };
    let n = 0;
    try {
      if (creds) {
        n += await scrapeScreenScraper(t, creds, opts.types, ctx);
        await new Promise((r) => setTimeout(r, 1200));
      }
      if (opts.sources.includes('libretro') && !n) n += await scrapeLibretro(t, opts.types);
    } catch (e) {
      ctx?.log(`${game.title}: ${e instanceof Error ? e.message : e}`);
      if (String(e).includes('quota')) throw e;
    }
    if (n) {
      stats.scraped++;
      stats.media += n;
    } else stats.notFound++;
    ctx?.log(`${game.title}: ${n} media`);
    await ctx?.progress(i + 1, gameIds.length, game.title);
  }
  return stats;
}
