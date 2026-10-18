/**
 * The API only grows: consoles keep clients from older versions, and a server that went back after a failed update
 * meets clients from the newer one. Every route in fixtures/api-routes.txt must still answer. New routes are added to
 * it with UPDATE_API_SNAPSHOT=1; a route leaves it only by hand, once no released client uses it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { apiRoutes } from './api-surface.js';

const FILE = path.join(import.meta.dirname, 'fixtures/api-routes.txt');

test('api: no route that clients may use has gone', async () => {
  const now = await apiRoutes();
  const kept = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')) : [];
  const gone = kept.filter((r) => !now.includes(r));
  assert.deepEqual(gone, [], `routes removed or renamed (a client of an older or newer version still calls them):\n  ${gone.join('\n  ')}`);
  const added = now.filter((r) => !kept.includes(r));
  if (process.env.UPDATE_API_SNAPSHOT) {
    const header = '# Every route the API answers (test/api-surface.test.ts). Routes are added with UPDATE_API_SNAPSHOT=1, never removed.\n';
    fs.writeFileSync(FILE, header + [...kept, ...added].sort().join('\n') + '\n');
  } else {
    assert.deepEqual(added, [], `new routes: add them to the list with UPDATE_API_SNAPSHOT=1 npx tsx --test test/api-surface.test.ts`);
  }
});
