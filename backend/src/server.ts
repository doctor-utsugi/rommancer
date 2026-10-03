import fs from 'node:fs';
import { env } from './config/env.js';
import { createApp } from './app.js';
import { enqueue, startJobRunner } from './lib/jobs.js';
import { seed } from './seed/seed.js';
import { startSaveSyncCron } from './modules/saves/sync.js';

for (const d of [env.dataDir, env.mediaDir, env.savesDir, env.uploadsDir, env.datsDir, env.tmpDir]) fs.mkdirSync(d, { recursive: true });

await seed();
await startJobRunner();
startSaveSyncCron();
// Aplica la semilla (DATs, RA, scraping) si existe; lo ya importado se omite
if (env.seedOnStart && fs.existsSync(env.seedDir)) await enqueue('seed-apply', {});

createApp().listen(env.port, () => console.log(`Rommancer API listening on :${env.port}`));
