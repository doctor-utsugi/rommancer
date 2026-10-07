import path from 'node:path';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

// Valores de ejemplo de .env.example: no se permite arrancar con ellos
const EXAMPLE_SECRETS = new Set(['change-me-jwt-secret', '0'.repeat(64)]);

function secret(name: string): string {
  const v = req(name);
  if (EXAMPLE_SECRETS.has(v)) throw new Error(`${name} still has the example value; generate one with: openssl rand -hex 32`);
  return v;
}

const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export const env = {
  port: Number(process.env.API_PORT ?? 3000),
  jwtSecret: secret('JWT_SECRET'),
  encryptionKey: Buffer.from(secret('ENCRYPTION_KEY'), 'hex'),
  // Origenes web permitidos (CORS). Vacio: solo el mismo origen (la web servida por nginx o el proxy de Vite)
  corsOrigins: list(process.env.CORS_ORIGINS),
  // Web address shown to sync clients for pairing (e.g. http://myserver:8080); guessed from the request if empty
  publicUrl: (process.env.PUBLIC_URL ?? '').replace(/\/+$/, ''),
  dataDir,
  mediaDir: path.join(dataDir, 'media'),
  savesDir: path.join(dataDir, 'saves'),
  uploadsDir: path.join(dataDir, 'uploads'),
  datsDir: path.join(dataDir, 'dats'),
  patchesDir: path.join(dataDir, 'patches'),
  tmpDir: path.join(dataDir, 'tmp'),
  libraryDir: path.join(dataDir, 'library'),
  // Semilla de datos (DATs, RetroAchievements, scraping) para nuevos despliegues
  seedDir: path.resolve(process.env.SEED_DIR ?? path.join(dataDir, '..', 'seed')),
  seedOnStart: process.env.SEED_ON_START !== 'false',
  seedAutoExport: process.env.SEED_AUTO_EXPORT !== 'false',
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
    devId: process.env.SCREENSCRAPER_DEV_ID ?? '',
    devPassword: process.env.SCREENSCRAPER_DEV_PASSWORD ?? '',
    user: process.env.SCREENSCRAPER_USER ?? '',
    password: process.env.SCREENSCRAPER_PASSWORD ?? '',
    baseUrl: process.env.SCREENSCRAPER_URL ?? 'https://api.screenscraper.fr/api2',
  },
  ra: {
    user: process.env.RA_USERNAME ?? '',
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
  // Sincronizacion global de fuentes externas (por defecto domingos a las 4:00). Vacio = desactivada
  externalSyncCron: process.env.EXTERNAL_SYNC_CRON ?? '0 4 * * 0',
  // Intervalo minimo entre sincronizaciones forzadas de la misma fuente y sistema
  forceSyncMinMinutes: Number(process.env.FORCE_SYNC_MIN_MINUTES ?? 10),
  // Identificacion ante servicios externos (politica de Wikidata)
  userAgent: process.env.HTTP_USER_AGENT ?? 'Rommancer/1.0 (self-hosted rom manager)',
};
