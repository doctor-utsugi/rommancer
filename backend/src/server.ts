import fs from 'node:fs';
import { env } from './config/env.js';
import { createApp } from './app.js';
import { enqueue, startJobRunner } from './lib/jobs.js';
import { seed } from './seed/seed.js';
import { convertLegacyItems } from './modules/lists/service.js';
import { startLocalDeviceWatcher } from './modules/saves/sync.js';
import { startSshSweep } from './modules/devices/ssh.js';
import { startHealthWatch } from './modules/storage/health.js';
import { startExternalSyncCron } from './modules/sync/service.js';
import { migrateWholeCards } from './modules/saves/cards.js';
import { catalog } from './modules/browse/catalog.js';

for (const d of [env.dataDir, env.mediaDir, env.savesDir, env.uploadsDir, env.datsDir, env.tmpDir, env.patchesDir]) fs.mkdirSync(d, { recursive: true });

await seed();
// Lists hold roms now: game and work items saved before are turned into their best rom
console.log('list items', await convertLegacyItems());
// PS1 cards kept whole as one save: their entries become saves of their own
await migrateWholeCards().catch((e) => console.error('memory cards', e));
await startJobRunner();
startExternalSyncCron();
startLocalDeviceWatcher();
startSshSweep();
startHealthWatch();
// Applies the seed (DATs, RA, scraping) if present; anything already imported is skipped
if (env.seedOnStart && fs.existsSync(env.seedDir)) await enqueue('seed-apply', {});

createApp().listen(env.port, () => console.log(`Rommancer API listening on :${env.port}`));
// Built now, so the first console that browses does not wait for it
void catalog().catch((e) => console.error('browse catalog', e));
