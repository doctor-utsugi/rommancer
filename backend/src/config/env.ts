import path from 'node:path';
// Secrets and the database URL into the environment before anything reads it
import './bootstrap.js';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

// Example values from .env.example: starting with them is refused
const EXAMPLE_SECRETS = new Set(['change-me-jwt-secret', '0'.repeat(64)]);

function secret(name: string): string {
  const v = req(name);
  if (EXAMPLE_SECRETS.has(v)) throw new Error(`${name} still has the example value; generate one with: openssl rand -hex 32`);
  return v;
}

const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// The server's settings (lib/settings.ts) once it has a database; before, the environment and the defaults
let settingsLookup: ((key: string) => string) | null = null;
export function setSettingsLookup(fn: (key: string) => string) {
  settingsLookup = fn;
}
const setting = (key: string, envName: string, fallback: string) => (settingsLookup ? settingsLookup(key) : (process.env[envName] ?? fallback));

export const env = {
  port: Number(process.env.API_PORT ?? 3000),
  jwtSecret: secret('JWT_SECRET'),
  encryptionKey: Buffer.from(secret('ENCRYPTION_KEY'), 'hex'),
  // Allowed web origins (CORS). Empty: same origin only (web served by nginx or the Vite proxy)
  get corsOrigins() {
    return list(setting('corsOrigins', 'CORS_ORIGINS', ''));
  },
  // Web address shown to sync clients for pairing (e.g. http://myserver:8080); guessed from the request if empty
  get publicUrl() {
    return setting('publicUrl', 'PUBLIC_URL', '').replace(/\/+$/, '');
  },
  dataDir,
  mediaDir: path.join(dataDir, 'media'),
  savesDir: path.join(dataDir, 'saves'),
  uploadsDir: path.join(dataDir, 'uploads'),
  datsDir: path.join(dataDir, 'dats'),
  patchesDir: path.join(dataDir, 'patches'),
  tmpDir: path.join(dataDir, 'tmp'),
  libraryDir: path.join(dataDir, 'library'),
  // Data seed (DATs, RetroAchievements, scraping) for new deployments
  seedDir: path.resolve(process.env.SEED_DIR ?? path.join(dataDir, '..', 'seed')),
  defaultLocale: process.env.DEFAULT_LOCALE ?? 'en',
  get seedOnStart() {
    return setting('seedOnStart', 'SEED_ON_START', 'true') !== 'false';
  },
  get seedAutoExport() {
    return setting('seedAutoExport', 'SEED_AUTO_EXPORT', 'true') !== 'false';
  },
  admin: {
    username: process.env.ADMIN_USERNAME ?? 'admin',
    password: process.env.ADMIN_PASSWORD ?? '',
    email: process.env.ADMIN_EMAIL ?? 'admin@localhost',
  },
  bins: {
    chdman: process.env.CHDMAN_BIN ?? 'chdman',
    sevenZip: process.env.SEVENZIP_BIN ?? '7zz',
  },
  screenscraper: {
    get devId() {
      return setting('screenscraperDevId', 'SCREENSCRAPER_DEV_ID', '');
    },
    get devPassword() {
      return setting('screenscraperDevPassword', 'SCREENSCRAPER_DEV_PASSWORD', '');
    },
    user: process.env.SCREENSCRAPER_USER ?? '',
    password: process.env.SCREENSCRAPER_PASSWORD ?? '',
    baseUrl: process.env.SCREENSCRAPER_URL ?? 'https://api.screenscraper.fr/api2',
  },
  ra: {
    apiKey: process.env.RA_API_KEY ?? '',
    baseUrl: process.env.RA_URL ?? 'https://retroachievements.org/API',
  },
  tgdb: {
    apiKey: process.env.THEGAMESDB_API_KEY ?? '',
    baseUrl: process.env.THEGAMESDB_URL ?? 'https://api.thegamesdb.net',
  },
  wikidata: {
    sparqlUrl: process.env.WIKIDATA_SPARQL_URL ?? 'https://query.wikidata.org/sparql',
  },
  github: {
    rawUrl: process.env.GITHUB_RAW_URL ?? 'https://raw.githubusercontent.com',
  },
  libretroThumbsUrl: process.env.LIBRETRO_THUMBS_URL ?? 'https://raw.githubusercontent.com/libretro-thumbnails',
  // Global sync of external sources (Sundays at 4:00 by default). Empty = disabled
  get externalSyncCron() {
    return setting('externalSyncCron', 'EXTERNAL_SYNC_CRON', '0 4 * * 0');
  },
  // Minimum interval between forced syncs of the same source and system
  get forceSyncMinMinutes() {
    return Number(setting('forceSyncMinMinutes', 'FORCE_SYNC_MIN_MINUTES', '10')) || 0;
  },
  // Identification toward external services (Wikidata policy)
  userAgent: process.env.HTTP_USER_AGENT ?? 'Rommancer/1.0 (self-hosted rom manager)',
};
