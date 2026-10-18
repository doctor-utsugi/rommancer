import fs from 'node:fs';
import path from 'node:path';

// The repository's root, or /app in the image: VERSION and CHANGELOG.md live there
const ROOT = path.resolve(import.meta.dirname, '../../..');

/**
 * The version this server runs: VERSION, written by deploy/release.sh. A build from a git checkout says "dev",
 * which is never offered updates.
 */
export const VERSION = (() => {
  try {
    return fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim() || 'dev';
  } catch {
    return 'dev';
  }
})();

/**
 * What the sync clients may count on from this server. A client can be newer than its server (an app installed from
 * elsewhere, a server not updated yet): before using something the server gained later, it reads GET /api/v1/version
 * and checks the feature's name here. A server without that route (before 1.98) has protocol 0 and no features.
 * PROTOCOL only goes up, and only when something every client must know about changes; a new route or field is a
 * new feature name instead. Nothing here is ever taken away.
 */
export const PROTOCOL = 1;
export const FEATURES: string[] = ['version'];

export interface ChangelogEntry {
  version: string;
  date: string | null;
  /** The entry's Markdown, without its heading */
  notes: string;
}

/** CHANGELOG.md's entries, newest first: each "## VERSION (DATE)" heading and what follows it */
export function parseChangelog(text: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  for (const part of text.split(/^## /m).slice(1)) {
    const nl = part.indexOf('\n');
    const head = (nl < 0 ? part : part.slice(0, nl)).trim();
    const m = /^v?(\d+\.\d+\.\d+)\s*(?:\((\d{4}-\d{2}-\d{2})\))?/.exec(head);
    if (!m) continue;
    entries.push({ version: m[1], date: m[2] ?? null, notes: nl < 0 ? '' : part.slice(nl + 1).trim() });
  }
  return entries;
}

/** The changelog this server shipped with */
export function localChangelog(): ChangelogEntry[] {
  try {
    return parseChangelog(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'));
  } catch {
    return [];
  }
}

/** Compares two x.y.z versions: negative when a is older than b. "dev" or anything unparsed sorts last */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => (/^v?(\d+)\.(\d+)\.(\d+)/.exec(v) ?? []).slice(1).map(Number);
  const [x, y] = [parse(a), parse(b)];
  if (!x.length || !y.length) return x.length ? -1 : y.length ? 1 : 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
