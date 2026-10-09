import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adapterFor, setIniSection } from '../src/modules/devconfig/adapters.js';

const want = { ra: { username: 'raplayer', password: 'secret', token: 'TOK' }, wifi: [], managed: [] };

test('ini sections: keys changed in place, missing ones and the section added', () => {
  assert.equal(setIniSection('[General]\nA = 1\n[Achievements]\nAchievementsEnable = False\n[Other]\nB = 2\n', 'Achievements', { AchievementsEnable: 'True', AchievementsUserName: 'x' }), '[General]\nA = 1\n[Achievements]\nAchievementsEnable = True\nAchievementsUserName = x\n[Other]\nB = 2\n');
  assert.equal(setIniSection('[General]\nA = 1\n', 'Achievements', { AchievementsEnable: 'True' }), '[General]\nA = 1\n[Achievements]\nAchievementsEnable = True\n');
});

test('android: RetroArch and PPSSPP get the login; Android/data left unread asks for Shizuku', () => {
  const a = adapterFor('android-esde')!;
  const files = new Map<string, string | null>([
    ['RetroArch/retroarch.cfg', 'cheevos_enable = "false"\n'],
    ['PSP/SYSTEM/ppsspp.ini', '[Achievements]\nAchievementsEnable = False\n'],
    ['PSP/SYSTEM/ppsspp_retroachievements.dat', null],
  ]);
  const out = a.apply(want, files, () => true);
  assert.match(out.writes.get('RetroArch/retroarch.cfg')!, /cheevos_token = "TOK"/);
  assert.match(out.writes.get('PSP/SYSTEM/ppsspp.ini')!, /AchievementsUserName = raplayer/);
  assert.equal(out.writes.get('PSP/SYSTEM/ppsspp_retroachievements.dat'), 'TOK');
  assert.deepEqual(out.notes, ['needShizuku']);
  // With Shizuku the app reads Android/data too: RetroArch's own config there gets it as well
  for (const f of a.settingsFiles) if (!files.has(f)) files.set(f, null);
  files.set('Android/data/com.retroarch.aarch64/files/retroarch.cfg', 'video_smooth = "false"\n');
  const full = a.apply(want, files, () => true);
  assert.match(full.writes.get('Android/data/com.retroarch.aarch64/files/retroarch.cfg')!, /cheevos_username = "raplayer"/);
  assert.deepEqual(full.notes, []);
});
