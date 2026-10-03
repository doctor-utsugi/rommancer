import path from 'node:path';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

const dataDir = path.resolve(process.env.DATA_DIR ?? './data');

export const env = {
  port: Number(process.env.API_PORT ?? 3000),
  jwtSecret: req('JWT_SECRET'),
  encryptionKey: Buffer.from(req('ENCRYPTION_KEY'), 'hex'),
  dataDir,
  mediaDir: path.join(dataDir, 'media'),
  savesDir: path.join(dataDir, 'saves'),
  uploadsDir: path.join(dataDir, 'uploads'),
  datsDir: path.join(dataDir, 'dats'),
  tmpDir: path.join(dataDir, 'tmp'),
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
  libretroThumbsUrl: process.env.LIBRETRO_THUMBS_URL ?? 'https://raw.githubusercontent.com/libretro-thumbnails',
  saveSyncCron: process.env.SAVE_SYNC_CRON ?? '',
};
