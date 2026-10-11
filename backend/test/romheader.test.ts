import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { NeedMore, readHeader, serialKeys } from '../src/lib/romheader.js';
import { BLOCK, BlockSource } from '../src/modules/saves/probe.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

/** Runs a probe as a device would: only the blocks asked for travel; returns the code and the bytes sent */
async function probe(name: string, data: Buffer) {
  const src = new BlockSource(data.length);
  let ask = '0:16';
  for (let round = 0; round < 12; round++) {
    for (const r of ask.split(',')) {
      const [a, n] = r.split(':').map(Number);
      src.add(a, data.subarray(a * BLOCK, (a + n) * BLOCK));
    }
    try {
      return { id: await readHeader(name, src), sent: src.bytes, rounds: round + 1 };
    } catch (e) {
      if (!(e instanceof NeedMore)) throw e;
      ask = src.ask(e.ranges);
    }
  }
  throw new Error('too many rounds');
}

test('header: cartridges', async () => {
  const gba = Buffer.alloc(0x100000);
  gba.write('AGCJ', 0xac, 'latin1');
  gba[0xb2] = 0x96;
  assert.deepEqual((await probe('Guru Logic Champ (Japan).gba', gba)).id, { platform: 'gba', serial: 'AGCJ' });
  const nds = Buffer.alloc(0x40000);
  nds.write('YZZJ', 0x0c, 'latin1');
  assert.deepEqual((await probe('x.nds', nds)).id, { platform: 'nds', serial: 'YZZJ' });
  // N64 in its byte-swapped .v64 order
  const z64 = Buffer.alloc(0x1000);
  z64.writeUInt32BE(0x80371240, 0);
  z64.write('NSME', 0x3b, 'latin1');
  const v64 = Buffer.from(z64);
  for (let i = 0; i < v64.length; i += 2) [v64[i], v64[i + 1]] = [v64[i + 1], v64[i]];
  assert.deepEqual((await probe('x.v64', v64)).id, { platform: 'n64', serial: 'NSME' });
  const md = Buffer.alloc(0x80000);
  md.write('SEGA MEGA DRIVE ', 0x100, 'latin1');
  md.write('GM MK-1572 -00', 0x180, 'latin1');
  assert.deepEqual((await probe('Sonic.bin', md)).id, { platform: 'md', serial: 'MK-1572-00' });
  // 3DS: the product code of the partition the NCSD header points at, far into the file
  const cci = Buffer.alloc(0x200000);
  cci.write('NCSD', 0x100, 'latin1');
  cci.writeUInt32LE(0x100000 / 0x200, 0x120);
  cci.write('NCCH', 0x100000 + 0x100, 'latin1');
  cci.write('CTR-P-BTVJ', 0x100000 + 0x150, 'latin1');
  const r = await probe('x.3ds', cci);
  assert.deepEqual(r.id, { platform: '3ds', serial: 'CTR-P-BTVJ' });
  assert.ok(r.sent < 0x30000, `only the headers travel (${r.sent})`);
});

test('header: discs, plain, raw and inside a CHD', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdr-'));
  const chd = path.join(ROOT, 'data-test/ps1/psx/Test Game (USA).chd');
  if (fs.existsSync(chd)) {
    const r = await probe('Test Game (USA).chd', fs.readFileSync(chd));
    assert.deepEqual(r.id, { platform: 'psx', serial: 'SLUS-99999' });
    execSync(`chdman extractcd -i "${chd}" -o "${dir}/t.cue" -ob "${dir}/t.bin" -f`, { stdio: 'ignore' });
    assert.deepEqual((await probe('t.bin', fs.readFileSync(`${dir}/t.bin`))).id, { platform: 'psx', serial: 'SLUS-99999' });
  }
  const iso = path.join(ROOT, 'data-test/ps1/game.iso');
  if (fs.existsSync(iso)) assert.deepEqual((await probe('game.iso', fs.readFileSync(iso))).id, { platform: 'psx', serial: 'SLUS-99999' });
  const gc = Buffer.alloc(0x10000);
  gc.write('GZLE01', 0, 'latin1');
  gc.writeUInt32BE(0xc2339f3d, 0x1c);
  assert.deepEqual((await probe('Zelda.iso', gc)).id, { platform: 'gc', serial: 'GZLE01' });
  const sat = Buffer.alloc(0x10000);
  sat.write('SEGA SEGASATURN ', 0, 'latin1');
  sat.write('T-4305G   ', 0x20, 'latin1');
  assert.deepEqual((await probe('x.iso', sat)).id, { platform: 'saturn', serial: 'T-4305G' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('header: codes as databases write them', () => {
  assert.deepEqual(serialKeys('md', 'MK-1572-00'), serialKeys('md', 'MK-1572'));
  assert.deepEqual(serialKeys('md', 'T-48073-00'), ['T48073']);
  assert.deepEqual(serialKeys('psx', 'SLES-14107/GER'), ['SLES14107']);
  assert.deepEqual(serialKeys('gc', 'DL-DOL-GW7P-EUR'), ['GW7P']);
  assert.deepEqual(serialKeys('wii', 'RVL-RJ2P-EUR'), ['RJ2P']);
  assert.deepEqual(serialKeys('gc', 'GW7P01'), ['GW7P']);
  assert.deepEqual(serialKeys('md', '00000000-00'), []);
});
