/**
 * Game media and metadata: ScreenScraper (main), TheGamesDB (fallback) and libretro-thumbnails (no account).
 * Everything downloaded is permanent and shared by all users. Responsible use: per-credential quotas read from
 * responses, one thread, pause until the next day near the limit, and "not found" remembered for 6 months.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { MediaType, System } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { decrypt } from '../../lib/crypto.js';
import type { JobContext } from '../../lib/jobs.js';
import { ownedRomIds, pickRom } from '../roms/service.js';
import { addRomEvidence } from '../grouping/service.js';
import { normalizeTitle } from '../../lib/romname.js';
import { applyMeta } from './meta.js';
import { defaultLocale, localePrefs } from '../../lib/locales.js';

export const ALL_MEDIA: MediaType[] = ['COVER', 'BOX_BACK', 'BOX_SIDE', 'BOX_3D', 'SUPPORT', 'SCREENSHOT', 'TITLE', 'FLYER', 'FANART', 'WHEEL', 'MARQUEE', 'MANUAL', 'VIDEO'];
// Heavy items (manuals and videos) are not downloaded by default unless requested
export const DEFAULT_MEDIA: MediaType[] = ['COVER', 'BOX_BACK', 'BOX_SIDE', 'BOX_3D', 'SUPPORT', 'SCREENSHOT', 'TITLE', 'FLYER', 'FANART', 'WHEEL', 'MARQUEE'];
export const LARGE_MEDIA: MediaType[] = ['MANUAL', 'VIDEO'];

const SS_TYPES: Record<string, MediaType> = {
  'box-2D': 'COVER',
  'box-2D-back': 'BOX_BACK',
  'box-2D-side': 'BOX_SIDE',
  'box-3D': 'BOX_3D',
  'support-2D': 'SUPPORT',
  ss: 'SCREENSHOT',
  sstitle: 'TITLE',
  flyer: 'FLYER',
  fanart: 'FANART',
  wheel: 'WHEEL',
  screenmarquee: 'MARQUEE',
  manuel: 'MANUAL',
  'video-normalized': 'VIDEO',
};

const LIBRETRO_TYPES: [string, MediaType][] = [
  ['Named_Boxarts', 'COVER'],
  ['Named_Snaps', 'SCREENSHOT'],
  ['Named_Titles', 'TITLE'],
];

// TheGamesDB platforms
const TGDB_PLATFORM: Record<string, number> = {
  nes: 7, fds: 4936, snes: 6, gb: 4, gbc: 41, gba: 5, n64: 3, nds: 8, gc: 2, wii: 9, sms: 35, gg: 20, md: 18, psx: 10, ps2: 11, psp: 13, fbneo: 23, lynx: 4924, a7800: 27,
};

const SS_REGION: Record<string, string> = { USA: 'us', Europe: 'eu', Japan: 'jp', World: 'wor', Spain: 'sp', France: 'fr', Germany: 'de', Italy: 'it', UK: 'uk', Australia: 'au', Korea: 'kr', Brazil: 'br', China: 'cn' };
const MISS_DAYS = 180;

export class QuotaPaused extends Error {
  constructor(public until: Date) {
    super(`quota paused until ${until.toISOString()}`);
  }
}

/** Tries a ScreenScraper account: null when it works, else why (in ScreenScraper's words when it gives them) */
export async function checkScreenScraper(user: string, password: string): Promise<string | null> {
  if (!env.screenscraper.devId) return 'this server has no ScreenScraper developer id (SCREENSCRAPER_DEV_ID)';
  const q = new URLSearchParams({ devid: env.screenscraper.devId, devpassword: env.screenscraper.devPassword, softname: 'rommancer', output: 'json', ssid: user, sspassword: password });
  try {
    const r = await fetch(`${env.screenscraper.baseUrl}/ssuserInfos.php?${q}`, { headers: { 'User-Agent': env.userAgent }, signal: AbortSignal.timeout(15_000) });
    const text = await r.text();
    const json = (() => { try { return JSON.parse(text); } catch { return null; } })();
    if (r.ok && json?.response?.ssuser?.id) return null;
    return text.trim().slice(0, 200) || `HTTP ${r.status}`;
  } catch (e) {
    return `ScreenScraper did not answer (${e instanceof Error ? e.message : e})`;
  }
}

/** Tries a TheGamesDB API key: null when it works, else why */
export async function checkTheGamesDb(apiKey: string): Promise<string | null> {
  try {
    const r = await fetch(`${env.tgdb.baseUrl}/v1/Genres?${new URLSearchParams({ apikey: apiKey })}`, { headers: { 'User-Agent': env.userAgent }, signal: AbortSignal.timeout(15_000) });
    const json = await r.json().catch(() => null);
    if (r.ok && json?.code === 200) return null;
    return json?.status ?? `HTTP ${r.status}`;
  } catch (e) {
    return `TheGamesDB did not answer (${e instanceof Error ? e.message : e})`;
  }
}

export interface Credentials {
  ss: { devId: string; devPassword: string; user: string; password: string } | null;
  tgdb: string | null;
}

/** A user's credentials: non-admins use only their own; the admin may use the global ones. */
export async function credentialsFor(userId: number): Promise<Credentials> {
  const u = await prisma.user.findUnique({ where: { id: userId } });
  const admin = u?.role === 'ADMIN';
  let ssUser = decrypt(u?.ssUser);
  let ssPass = decrypt(u?.ssPassword);
  if (!ssUser && admin) {
    ssUser = env.screenscraper.user;
    ssPass = env.screenscraper.password;
  }
  const tgdb = decrypt(u?.tgdbApiKey) || (admin ? env.tgdb.apiKey : '') || null;
  return {
    ss: env.screenscraper.devId && ssUser ? { devId: env.screenscraper.devId, devPassword: env.screenscraper.devPassword, user: ssUser, password: ssPass ?? '' } : null,
    tgdb,
  };
}

// --- Quotas ---
const today = () => new Date().toISOString().slice(0, 10);
const tomorrow = () => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(1, 0, 0, 0);
  return d;
};
const lastCall = new Map<string, number>();

async function beforeCall(key: string, minIntervalMs: number) {
  const q = await prisma.scrapeQuota.findUnique({ where: { key } });
  if (q?.pausedUntil && q.pausedUntil > new Date()) throw new QuotaPaused(q.pausedUntil);
  const wait = (lastCall.get(key) ?? 0) + Math.max(minIntervalMs, q?.maxPerMin ? 60_000 / q.maxPerMin : 0) - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall.set(key, Date.now());
}

async function recordQuota(key: string, info: { requests?: number; ko?: number; maxPerDay?: number; maxKoPerDay?: number; maxPerMin?: number }, wasKo = false) {
  const day = today();
  const q = await prisma.scrapeQuota.findUnique({ where: { key } });
  const fresh = !q || q.day !== day;
  const requests = info.requests ?? (fresh ? 1 : q!.requests + 1);
  const ko = info.ko ?? (fresh ? (wasKo ? 1 : 0) : q!.ko + (wasKo ? 1 : 0));
  const maxPerDay = info.maxPerDay ?? q?.maxPerDay ?? null;
  const maxKoPerDay = info.maxKoPerDay ?? q?.maxKoPerDay ?? null;
  // Stops at 95% of the daily limit so it is never exhausted
  const exhausted = (maxPerDay != null && requests >= maxPerDay * 0.95) || (maxKoPerDay != null && ko >= maxKoPerDay * 0.95);
  const data = { day, requests, ko, maxPerDay, maxKoPerDay, maxPerMin: info.maxPerMin ?? q?.maxPerMin ?? null, pausedUntil: exhausted ? tomorrow() : fresh ? null : q!.pausedUntil };
  await prisma.scrapeQuota.upsert({ where: { key }, create: { key, ...data }, update: data });
}

async function pause(key: string, until: Date) {
  await prisma.scrapeQuota.upsert({ where: { key }, create: { key, day: today(), pausedUntil: until }, update: { pausedUntil: until } });
  throw new QuotaPaused(until);
}

async function recentMiss(gameId: number, source: string) {
  const m = await prisma.scrapeMiss.findUnique({ where: { gameId_source: { gameId, source } } });
  return !!m && Date.now() - m.at.getTime() < MISS_DAYS * 86400_000;
}

async function recordMiss(gameId: number, source: string) {
  await prisma.scrapeMiss.upsert({ where: { gameId_source: { gameId, source } }, create: { gameId, source }, update: { at: new Date() } });
}

// --- Downloads ---
function mediaRel(system: System, gameId: number, type: MediaType, source: string, ext: string) {
  const base = LARGE_MEDIA.includes(type) ? path.join('large', system.slug) : system.slug;
  return path.join(base, String(gameId), `${type.toLowerCase()}-${source}.${ext}`);
}

async function download(url: string, dest: string): Promise<number> {
  const r = await fetch(url, { headers: { 'User-Agent': env.userAgent } });
  if (!r.ok) return 0;
  const buf = Buffer.from(await r.arrayBuffer());
  // ScreenScraper returns text (NOMEDIA, errors) instead of a file when there is none
  if (!buf.length || (buf.length < 64 && /^[A-Z ]+$/.test(buf.toString('latin1').trim()))) return 0;
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.writeFile(dest, buf);
  return buf.length;
}

async function saveMedia(gameId: number, romId: number | null, type: MediaType, source: string, rel: string, size: number, region: string | null, language: string | null = null) {
  await prisma.media.deleteMany({ where: { gameId, type, source } });
  await prisma.media.create({ data: { gameId, romId, type, source, path: rel, region, language, size } });
}

function pickLocalized(arr: { text: string; region?: string; langue?: string }[] | undefined, key: 'region' | 'langue', prefs: string[]): string | null {
  if (!arr?.length) return null;
  for (const p of prefs) {
    const x = arr.find((a) => a[key] === p);
    if (x) return x.text;
  }
  return arr[0].text;
}

interface Target {
  gameId: number;
  system: System;
  rom: { id: number; name: string; regions: string[] } | null;
  part: { name: string; size: bigint; crc32: string | null; md5: string | null; sha1: string | null } | null;
  altNames: string[];
  title: string;
  missing: MediaType[];
  regionPrefs: string[];
  langPrefs: string[];
}

async function screenscraper(t: Target, creds: NonNullable<Credentials['ss']>, ctx?: JobContext): Promise<MediaType[]> {
  const key = `ss:${creds.user}`;
  if (await recentMiss(t.gameId, 'screenscraper')) return [];
  await beforeCall(key, 1200);
  const q = new URLSearchParams({ devid: creds.devId, devpassword: creds.devPassword, softname: 'rommancer', output: 'json', ssid: creds.user, sspassword: creds.password, romtype: 'rom', romnom: t.part?.name ?? t.title });
  if (t.system.ssSystemId) q.set('systemeid', String(t.system.ssSystemId));
  if (t.part) {
    q.set('romtaille', String(t.part.size));
    if (t.part.crc32) q.set('crc', t.part.crc32);
    if (t.part.md5) q.set('md5', t.part.md5);
    if (t.part.sha1) q.set('sha1', t.part.sha1);
  }
  const r = await fetch(`${env.screenscraper.baseUrl}/jeuInfos.php?${q}`, { headers: { 'User-Agent': env.userAgent } });
  if (r.status === 429) await pause(key, new Date(Date.now() + 120_000));
  if (r.status === 430 || r.status === 431) await pause(key, tomorrow());
  if (r.status === 404) {
    await recordQuota(key, {}, true);
    await recordMiss(t.gameId, 'screenscraper');
    return [];
  }
  if (!r.ok) {
    ctx?.log(`ScreenScraper ${t.title}: HTTP ${r.status}`);
    return [];
  }
  const data = (await r.json()) as { response?: { jeu?: any; ssuser?: any } };
  const u = data.response?.ssuser;
  const n = (v: unknown) => (v == null || v === '' ? undefined : Number(v));
  await recordQuota(key, { requests: n(u?.requeststoday), ko: n(u?.requestskotoday), maxPerDay: n(u?.maxrequestsperday), maxKoPerDay: n(u?.maxrequestskoperday), maxPerMin: n(u?.maxrequestspermin) });
  const jeu = data.response?.jeu;
  if (!jeu) {
    await recordMiss(t.gameId, 'screenscraper');
    return [];
  }
  const ssId = Number(jeu.id) || null;
  if (ssId) {
    await prisma.game.update({ where: { id: t.gameId }, data: { ssGameId: ssId } });
    // Grouping evidence: all roms ScreenScraper associates with this game
    const hashes = (jeu.roms ?? []) as { romsha1?: string; rommd5?: string }[];
    const sha1s = hashes.map((x) => x.romsha1?.toLowerCase()).filter(Boolean) as string[];
    if (sha1s.length) {
      const parts = await prisma.romPart.findMany({ where: { OR: [{ sha1: { in: sha1s } }, { headerlessSha1: { in: sha1s } }], rom: { game: { systemId: t.system.id } } }, select: { romId: true } });
      await addRomEvidence(parts.map((p) => ({ romId: p.romId, systemId: t.system.id, key: `ss:${ssId}`, source: 'screenscraper' })));
    }
  }
  const genre = jeu.genres?.[0]?.noms ? pickLocalized(jeu.genres[0].noms, 'langue', t.langPrefs) : null;
  const date = pickLocalized(jeu.dates, 'region', t.regionPrefs);
  await applyMeta(t.gameId, 'screenscraper', {
    description: pickLocalized(jeu.synopsis, 'langue', t.langPrefs),
    developer: jeu.developpeur?.text,
    publisher: jeu.editeur?.text,
    players: jeu.joueurs?.text,
    genre,
    releaseYear: date ? Number(String(date).slice(0, 4)) || null : null,
  });
  await prisma.game.update({ where: { id: t.gameId }, data: { scrapedAt: new Date() } });
  const got: MediaType[] = [];
  for (const [ssType, type] of Object.entries(SS_TYPES)) {
    if (!t.missing.includes(type)) continue;
    const medias = ((jeu.medias ?? []) as { type: string; url: string; region?: string; format?: string }[]).filter((m) => m.type === ssType);
    if (!medias.length) continue;
    const m = t.regionPrefs.map((p) => medias.find((x) => x.region === p)).find(Boolean) ?? medias[0];
    const rel = mediaRel(t.system, t.gameId, type, 'ss', m.format ?? (type === 'MANUAL' ? 'pdf' : type === 'VIDEO' ? 'mp4' : 'png'));
    // File downloads do not count as API requests; they are only spaced out
    await new Promise((r) => setTimeout(r, 100));
    const size = await download(m.url, path.join(env.mediaDir, rel));
    if (size) {
      await saveMedia(t.gameId, t.rom?.id ?? null, type, 'screenscraper', rel, size, m.region ?? null, type === 'MANUAL' ? m.region ?? null : null);
      got.push(type);
    }
  }
  return got;
}

async function thegamesdb(t: Target, apiKey: string): Promise<MediaType[]> {
  const platform = TGDB_PLATFORM[t.system.slug];
  const wanted = (['BOX_BACK', 'COVER', 'FANART', 'WHEEL', 'SCREENSHOT'] as MediaType[]).filter((x) => t.missing.includes(x));
  if (!platform || !wanted.length || (await recentMiss(t.gameId, 'thegamesdb'))) return [];
  const key = `tgdb:${crypto.createHash('sha1').update(apiKey).digest('hex').slice(0, 12)}`;
  const call = async (p: string, params: Record<string, string>) => {
    await beforeCall(key, 1000);
    const r = await fetch(`${env.tgdb.baseUrl}${p}?${new URLSearchParams({ apikey: apiKey, ...params })}`, { headers: { 'User-Agent': env.userAgent } });
    if (r.status === 403 || r.status === 429) await pause(key, tomorrow());
    if (!r.ok) return null;
    const j = (await r.json()) as any;
    const remaining = Number(j.remaining_monthly_allowance ?? j.allowance_refresh_timer ?? NaN);
    await recordQuota(key, {});
    if (Number.isFinite(remaining) && remaining <= 5) await pause(key, new Date(Date.now() + 7 * 86400_000));
    return j;
  };
  let tgdbId = (await prisma.game.findUnique({ where: { id: t.gameId } }))?.tgdbGameId ?? null;
  if (!tgdbId) {
    // TheGamesDB can only search by name: an exact match of the normalized title on the platform is required
    const j = await call('/v1.1/Games/ByGameName', { name: t.title, 'filter[platform]': String(platform) });
    const games = (j?.data?.games ?? []) as { id: number; game_title: string }[];
    const names = new Set([t.title, ...t.altNames].map((x) => normalizeTitle(x)));
    const matches = games.filter((g) => names.has(normalizeTitle(g.game_title)));
    if (matches.length !== 1) {
      await recordMiss(t.gameId, 'thegamesdb');
      return [];
    }
    tgdbId = matches[0].id;
    await prisma.game.update({ where: { id: t.gameId }, data: { tgdbGameId: tgdbId } });
  }
  const j = await call('/v1/Games/Images', { games_id: String(tgdbId), 'filter[type]': 'boxart,fanart,clearlogo,screenshot' });
  const base = j?.include?.boxart?.base_url?.original ?? 'https://cdn.thegamesdb.net/images/original/';
  const images = (j?.data?.images?.[String(tgdbId)] ?? []) as { type: string; side?: string; filename: string }[];
  const got: MediaType[] = [];
  const pickType = (type: MediaType) =>
    type === 'COVER' ? images.find((i) => i.type === 'boxart' && i.side === 'front') :
    type === 'BOX_BACK' ? images.find((i) => i.type === 'boxart' && i.side === 'back') :
    type === 'FANART' ? images.find((i) => i.type === 'fanart') :
    type === 'WHEEL' ? images.find((i) => i.type === 'clearlogo') :
    images.find((i) => i.type === 'screenshot');
  for (const type of wanted) {
    const img = pickType(type);
    if (!img) continue;
    const ext = path.extname(img.filename).slice(1) || 'jpg';
    const rel = mediaRel(t.system, t.gameId, type, 'tgdb', ext);
    const size = await download(base + img.filename, path.join(env.mediaDir, rel));
    if (size) {
      await saveMedia(t.gameId, t.rom?.id ?? null, type, 'thegamesdb', rel, size, null);
      got.push(type);
    }
  }
  return got;
}

export function libretroName(name: string) {
  return name.replace(/[&*/:`<>?\\|"]/g, '_');
}

export async function libretroThumbs(t: Target): Promise<MediaType[]> {
  const repo = t.system.datName.replace(/ /g, '_');
  const got: MediaType[] = [];
  for (const [folder, type] of LIBRETRO_TYPES) {
    if (!t.missing.includes(type)) continue;
    const rel = mediaRel(t.system, t.gameId, type, 'libretro', 'png');
    for (const name of [t.rom?.name, ...t.altNames].filter((x): x is string => !!x).slice(0, 6)) {
      const url = `${env.libretroThumbsUrl}/${encodeURIComponent(repo)}/master/${folder}/${encodeURIComponent(libretroName(name))}.png`;
      const size = await download(url, path.join(env.mediaDir, rel));
      if (size) {
        await saveMedia(t.gameId, t.rom?.id ?? null, type, 'libretro', rel, size, null);
        got.push(type);
        break;
      }
    }
  }
  return got;
}

const REGION_RANK = ['USA', 'World', 'Europe', 'Japan'];
const regionRank = (regions: string[]) => Math.min(...regions.map((r) => (REGION_RANK.includes(r) ? REGION_RANK.indexOf(r) : 9)), 9);

async function buildTarget(gameId: number, types: MediaType[], locale: string, overwrite: boolean): Promise<Target | null> {
  const game = await prisma.game.findUnique({ where: { id: gameId }, include: { system: true, roms: { include: { parts: { take: 1 } } }, media: { select: { type: true } } } });
  if (!game) return null;
  const prefs = localePrefs(locale);
  const owned = await ownedRomIds({ romIds: game.roms.map((r) => r.id), include: 'any' });
  const rom = pickRom(game.roms, { regions: [...prefs.regions] }, owned) ?? game.roms[0] ?? null;
  const have = new Set(game.media.map((m) => m.type));
  const missing = overwrite ? types : types.filter((x) => !have.has(x));
  const romRegions = ((rom?.regions as string[] | undefined) ?? []).map((r) => SS_REGION[r]).filter(Boolean);
  const userRegions = prefs.ssRegions;
  return {
    gameId,
    system: game.system,
    rom: rom ? { id: rom.id, name: rom.name, regions: rom.regions as string[] } : null,
    part: rom?.parts[0] ?? null,
    altNames: [...game.roms].sort((a, b) => regionRank(a.regions as string[]) - regionRank(b.regions as string[])).map((r) => r.name),
    title: game.title,
    missing,
    regionPrefs: [...new Set([...romRegions, ...userRegions, 'wor', 'us', 'eu', 'ss', 'jp'])],
    langPrefs: [...prefs.languages],
  };
}

export interface ScrapeOptions {
  userId: number;
  sources?: ('screenscraper' | 'thegamesdb' | 'libretro')[];
  types?: MediaType[];
  overwrite?: boolean;
}

/** Scrapes a list of games. If a quota runs out, returns the pending ones and how long to wait. */
export async function scrapeGames(gameIds: number[], opts: ScrapeOptions, ctx?: JobContext) {
  const creds = await credentialsFor(opts.userId);
  const user = await prisma.user.findUnique({ where: { id: opts.userId } });
  const sources = opts.sources ?? ['screenscraper', 'thegamesdb', 'libretro'];
  const types = opts.types ?? DEFAULT_MEDIA;
  const stats = { games: gameIds.length, scraped: 0, media: 0, notFound: 0, skipped: 0, pending: [] as number[], pausedUntil: null as string | null, noCredentials: !creds.ss && !creds.tgdb };
  let ssPaused = false;
  let tgdbPaused = false;
  for (const [i, gameId] of gameIds.entries()) {
    const t = await buildTarget(gameId, types, user?.locale ?? (await defaultLocale()), !!opts.overwrite);
    if (!t || !t.missing.length) {
      stats.skipped++;
      await ctx?.progress(i + 1, gameIds.length);
      continue;
    }
    let got: MediaType[] = [];
    try {
      if (sources.includes('screenscraper') && creds.ss && !ssPaused) {
        try {
          got.push(...(await screenscraper(t, creds.ss, ctx)));
        } catch (e) {
          if (!(e instanceof QuotaPaused)) throw e;
          ssPaused = true;
          stats.pausedUntil = e.until.toISOString();
          stats.pending.push(...gameIds.slice(i));
        }
      }
      t.missing = t.missing.filter((x) => !got.includes(x));
      if (sources.includes('thegamesdb') && creds.tgdb && !tgdbPaused && t.missing.length) {
        try {
          got.push(...(await thegamesdb(t, creds.tgdb)));
        } catch (e) {
          if (!(e instanceof QuotaPaused)) throw e;
          tgdbPaused = true;
        }
      }
      t.missing = t.missing.filter((x) => !got.includes(x));
      if (sources.includes('libretro') && t.missing.length) got.push(...(await libretroThumbs(t)));
    } catch (e) {
      ctx?.log(`${t.title}: ${e instanceof Error ? e.message : e}`);
    }
    got = [...new Set(got)];
    if (got.length) {
      stats.scraped++;
      stats.media += got.length;
    } else stats.notFound++;
    ctx?.log(`${t.title}: ${got.join(', ') || '-'}`);
    await ctx?.progress(i + 1, gameIds.length, t.title);
  }
  stats.pending = [...new Set(stats.pending)];
  return stats;
}
