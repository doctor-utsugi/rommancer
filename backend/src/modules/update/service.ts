/**
 * Updating Rommancer from the web app. The server can't replace its own containers: rommancer.sh update does it on the
 * host. The two talk through UPDATE_DIR (mounted at /update): the API writes "request" there, a watcher that
 * rommancer.sh service on installs runs the update, and the update writes its progress to status.json and update.log.
 * Which versions exist and what each changed come from the project's GitHub releases, checked once a day.
 */
import fs from 'node:fs';
import path from 'node:path';
import { compareVersions, localChangelog, VERSION, type ChangelogEntry } from '../../lib/version.js';
import { prisma } from '../../lib/prisma.js';
import { serverSetting } from '../../lib/settings.js';

export const REPO = process.env.ROMMANCER_REPO || 'doctor-utsugi/rommancer';
const DIR = process.env.UPDATE_DIR ?? '';
const CHECK_MS = 24 * 3600_000;
const CACHE_KEY = 'update.releases';

export interface Release extends ChangelogEntry {
  url: string;
}

interface Cached {
  checkedAt: string;
  releases: Release[];
  error?: string;
}

/** A release's notes are its changelog entry, then a line "---" and how to install it */
function notesOf(body: string) {
  return body.split(/\r?\n---\r?\n/)[0].trim();
}

/** The published releases, newest first, from GitHub */
async function fetchReleases(): Promise<Release[]> {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=50`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `rommancer/${VERSION}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  const list = (await r.json()) as { tag_name: string; body: string | null; published_at: string | null; draft: boolean; prerelease: boolean; html_url: string }[];
  return list
    .filter((x) => !x.draft && !x.prerelease && /^v?\d+\.\d+\.\d+$/.test(x.tag_name))
    .map((x) => ({ version: x.tag_name.replace(/^v/, ''), date: x.published_at?.slice(0, 10) ?? null, notes: notesOf(x.body ?? ''), url: x.html_url }))
    .sort((a, b) => compareVersions(b.version, a.version));
}

async function cached(): Promise<Cached | null> {
  const row = await prisma.setting.findUnique({ where: { key: CACHE_KEY } });
  try {
    return row ? (JSON.parse(row.value) as Cached) : null;
  } catch {
    return null;
  }
}

/** Asks GitHub which releases exist and keeps the answer; a failure is kept too, with the last list that worked */
export async function checkReleases(): Promise<Cached> {
  const before = await cached();
  let value: Cached;
  try {
    value = { checkedAt: new Date().toISOString(), releases: await fetchReleases() };
  } catch (e) {
    value = { checkedAt: new Date().toISOString(), releases: before?.releases ?? [], error: e instanceof Error ? e.message : String(e) };
  }
  const json = JSON.stringify(value);
  await prisma.setting.upsert({ where: { key: CACHE_KEY }, create: { key: CACHE_KEY, value: json }, update: { value: json } });
  return value;
}

export const checksEnabled = () => serverSetting('updateCheck') !== 'false';

/** The update's progress as rommancer.sh update leaves it */
function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, 'status.json'), 'utf8')) as { state: string; step: string; from: string; to: string; at: string };
  } catch {
    return null;
  }
}

/**
 * The update under way, for every page of the web app (which shows only the update while it runs): asked for and
 * not started yet, or running. Null otherwise.
 */
export function updateInProgress(): { step: string; from: string; to: string; at: string | null } | null {
  if (!DIR) return null;
  const status = readStatus();
  // at: when the step began, for the web's progress bar
  if (status?.state === 'running') return { step: status.step, from: status.from, to: status.to, at: status.at };
  try {
    const request = JSON.parse(fs.readFileSync(path.join(DIR, 'request'), 'utf8')) as { to?: string; at?: string };
    // The installer's request for another roms folder is no update
    return request.to ? { step: 'queued', from: VERSION, to: request.to, at: request.at ?? null } : null;
  } catch {
    return null;
  }
}

/** The end of the update's log, for when something went wrong */
export function readLog(lines = 200) {
  try {
    return fs.readFileSync(path.join(DIR, 'update.log'), 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/** How this server can be updated: by the button (a watcher runs requests), or only with the command */
function updater(): 'watcher' | 'command' | 'none' {
  if (!DIR || !fs.existsSync(DIR)) return 'none';
  return fs.existsSync(path.join(DIR, 'watcher')) ? 'watcher' : 'command';
}

export async function updateState() {
  const c = await cached();
  const releases = c?.releases ?? [];
  const latest = releases[0]?.version ?? null;
  const dev = VERSION === 'dev';
  // What changed since this version: the releases' notes, or this server's own changelog when GitHub was not reached
  const newer = dev ? [] : releases.filter((r) => compareVersions(r.version, VERSION) > 0);
  const current = releases.find((r) => r.version === VERSION) ?? localChangelog().find((e) => e.version === VERSION) ?? null;
  return {
    version: VERSION,
    latest,
    available: !dev && !!latest && compareVersions(latest, VERSION) > 0,
    newer,
    current,
    checkedAt: c?.checkedAt ?? null,
    checkError: c?.error ?? null,
    checks: checksEnabled(),
    updater: updater(),
    requested: !!DIR && fs.existsSync(path.join(DIR, 'request')),
    status: readStatus(),
    repo: REPO,
  };
}

/** Leaves a request for the host's watcher: update to this version */
export function requestUpdate(to: string, by: string) {
  if (updater() !== 'watcher') throw new Error('No watcher runs updates on this server');
  fs.writeFileSync(path.join(DIR, 'request.new'), `${JSON.stringify({ to, by, at: new Date().toISOString() })}\n`);
  fs.renameSync(path.join(DIR, 'request.new'), path.join(DIR, 'request'));
}

let timer: NodeJS.Timeout | null = null;

/** Checks for new releases once a day, the first time a minute after starting */
export function startUpdateChecks() {
  const run = async () => {
    if (!checksEnabled() || VERSION === 'dev') return;
    const c = await cached();
    if (c && Date.now() - new Date(c.checkedAt).getTime() < CHECK_MS) return;
    await checkReleases();
  };
  setTimeout(() => void run().catch((e) => console.error('update check', e)), 60_000).unref();
  timer = setInterval(() => void run().catch((e) => console.error('update check', e)), 3600_000);
  timer.unref();
}
