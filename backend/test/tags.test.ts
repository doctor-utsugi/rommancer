import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseRomName, hackLabel, parseRomName } from '../src/lib/romname.js';

test('tags: region, languages, revision and translation marks', () => {
  const p = parseRomName('Contra (Japan) [T+Eng1.0_MadHacker].nes');
  assert.equal(p.title, 'Contra');
  assert.deepEqual(p.regions, ['Japan']);
  assert.deepEqual(p.hack, { type: 'TRANSLATION', language: 'Eng', version: '1.0', author: 'MadHacker' });
  assert.equal(baseRomName('Contra (Japan) [T+Eng1.0_MadHacker].nes'), 'Contra (Japan)');
  const r = parseRomName('Super Mario Bros. 3 (USA) (Rev 1)');
  assert.equal(r.revision, 'Rev 1');
  const l = parseRomName('Final Fantasy (Europe) (En,Fr,De)');
  assert.deepEqual(l.languages, ['En', 'Fr', 'De']);
});

test('tags: exact base rom and the version of the hack', () => {
  assert.equal(
    hackLabel({ name: 'Gran Turismo 4 (USA) (v1.01)' }, { type: 'HACK', title: 'Gran Turismo 4 Spec II', hackName: 'Spec II', version: '1.10' }),
    'Gran Turismo 4 (USA) v1.01 + Spec II v1.10',
  );
  assert.equal(
    hackLabel({ name: 'Contra (Japan) (En,Ja)' }, { type: 'TRANSLATION', title: 'x', language: 'Eng', version: 'v1.0', author: 'MadHacker' }),
    'Contra (Japan) + T-Eng v1.0 (MadHacker)',
  );
  assert.equal(hackLabel(null, { type: 'HACK', title: 'Rogue Dawn', version: null }), 'Rogue Dawn');
});
