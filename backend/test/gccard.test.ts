import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CardError } from '../src/modules/saves/ps1card.js';
import { formatGcCard, gciTo, gcRegion, readGcCard, readGci, writeGcCard, type GcEntry } from '../src/modules/saves/gccard.js';

const BLOCK = 0x2000;

/** A save of BLOCKS blocks as a .gci, its data marked with SEED */
function gci(game: string, file: string, blocks: number, seed: number, comment = 'Test Game', maker = '01'): GcEntry {
  const d = Buffer.alloc(0x40, 0xff);
  d.write(game, 0, 'latin1');
  d.write(maker, 4, 'latin1');
  d[7] = 0;
  d.fill(0, 8, 0x28);
  d.write(file, 8, 'latin1');
  d.writeUInt32BE(1000, 0x28);
  d.writeUInt16BE(0x1234, 0x36);
  d[0x35] = 3;
  d.writeUInt16BE(blocks, 0x38);
  d.writeUInt32BE(0, 0x3c);
  const data = Buffer.alloc(blocks * BLOCK, seed);
  data.fill(0, 0, 0x40);
  data.write(comment, 0, 'latin1');
  data.write(`slot ${seed}`, 0x20, 'latin1');
  return readGci(Buffer.concat([d, data]));
}

test('gc: a formatted card is empty and readable', () => {
  const card = readGcCard(formatGcCard(4, 123456789n));
  assert.equal(card.entries.length, 0);
  assert.equal(card.freeBlocks, 59);
  assert.deepEqual(card.problems, []);
  assert.equal(readGcCard(formatGcCard(16)).freeBlocks, 251);
});

test('gc: entries keyed by maker, game code and file name; several per game', () => {
  const save = gci('GZLE', 'gczelda', 2, 1, 'Zelda');
  const ghost = gci('GFZE', 'f_zero_ghost', 3, 2);
  const zelda2 = gci('GZLE', 'gczelda2', 1, 3);
  assert.equal(save.name, '01-GZLE-gczelda');
  assert.equal(save.title, 'Zelda · slot 1');
  // Block position and copy counter are not part of the save
  assert.equal(save.gci.readUInt16BE(0x36), 0xffff);
  assert.equal(save.gci[0x35], 0);
  let { card, skipped } = writeGcCard(formatGcCard(), [save, ghost, zelda2]);
  assert.deepEqual(skipped, []);
  let read = readGcCard(card);
  assert.deepEqual(read.entries.map((e) => e.name).sort(), ['01-GFZE-f_zero_ghost', '01-GZLE-gczelda', '01-GZLE-gczelda2']);
  assert.equal(read.freeBlocks, 59 - 6);
  // The same entry reads back identical whatever blocks it sits in
  assert.equal(read.entries.find((e) => e.name === save.name)!.sha1, save.sha1);

  // Replacing one leaves the blocks of the others as they were
  const before = Buffer.from(card);
  const ghostAt = readGcCard(card).entries.find((e) => e.name === ghost.name)!;
  const save2 = gci('GZLE', 'gczelda', 2, 9, 'Zelda');
  ({ card, skipped } = writeGcCard(card, [save2]));
  read = readGcCard(card);
  assert.equal(read.entries.length, 3);
  assert.equal(read.entries.find((e) => e.name === save.name)!.sha1, save2.sha1);
  assert.equal(read.entries.find((e) => e.name === ghost.name)!.sha1, ghostAt.sha1);
  assert.ok(card.subarray(5 * BLOCK + 2 * BLOCK, 5 * BLOCK + 5 * BLOCK).equals(before.subarray(5 * BLOCK + 2 * BLOCK, 5 * BLOCK + 5 * BLOCK)));
  // The tables in use moved to the other copy; the previous copy is still whole
  const counter = (b: Buffer, i: number) => b.readInt16BE(i * BLOCK + 0x1ffa);
  const activeBefore = counter(before, 1) >= counter(before, 2) ? 1 : 2;
  const activeNow = counter(card, 1) >= counter(card, 2) ? 1 : 2;
  assert.notEqual(activeNow, activeBefore);
  assert.ok(card.subarray(activeBefore * BLOCK, (activeBefore + 1) * BLOCK).equals(before.subarray(activeBefore * BLOCK, (activeBefore + 1) * BLOCK)));

  // Taking one out frees its blocks
  ({ card } = writeGcCard(card, [], [ghost.name]));
  assert.equal(readGcCard(card).freeBlocks, 59 - 3);
  assert.deepEqual(readGcCard(card).problems, []);
});

test('gc: what does not fit is left out and the card keeps its version', () => {
  const { card } = writeGcCard(formatGcCard(), [gci('GAAE', 'big', 50, 1), gci('GBBE', 'small', 2, 2)]);
  const old = readGcCard(card).entries.find((e) => e.name === '01-GBBE-small')!.sha1;
  // 7 free: a new 8-block save does not fit, a grown version of "small" (2 + 7 = 9) does not either
  const r = writeGcCard(card, [gci('GCCE', 'new', 8, 3), gci('GBBE', 'small', 10, 4)]);
  assert.deepEqual(r.skipped.sort(), ['01-GBBE-small', '01-GCCE-new']);
  assert.equal(readGcCard(r.card).entries.find((e) => e.name === '01-GBBE-small')!.sha1, old);
  // Its own blocks count as room: 7 free + 2 = 9
  const grown = gci('GBBE', 'small', 9, 5);
  const ok = writeGcCard(card, [grown]);
  assert.deepEqual(ok.skipped, []);
  assert.equal(readGcCard(ok.card).freeBlocks, 0);
  assert.equal(readGcCard(ok.card).entries.find((e) => e.name === grown.name)!.sha1, grown.sha1);
});

test('gc: a card with a damaged table is read from the other copy but never written', () => {
  const { card } = writeGcCard(formatGcCard(), [gci('GZLE', 'gczelda', 2, 1)]);
  // Damage the copy not in use (the first write went to copy 2)
  const broken = Buffer.from(card);
  broken[BLOCK + 10] ^= 0xff;
  const read = readGcCard(broken);
  assert.equal(read.entries.length, 1);
  assert.ok(read.problems.length > 0);
  assert.throws(() => writeGcCard(broken, [gci('GAAE', 'x', 1, 1)]), CardError);
  // Both copies of the directory damaged: unreadable
  broken[2 * BLOCK + 10] ^= 0xff;
  assert.throws(() => readGcCard(broken), CardError);
  assert.throws(() => readGcCard(Buffer.alloc(1000)), CardError);
});

test('gc: .gcs and .sav exports read back as the same save', () => {
  const e = gci('GZLE', 'gczelda', 3, 7, 'Zelda');
  for (const f of ['gcs', 'sav'] as const) {
    const back = readGci(gciTo(e, f));
    assert.equal(back.sha1, e.sha1, f);
    assert.equal(back.name, e.name);
  }
  assert.throws(() => readGci(Buffer.alloc(BLOCK + 3)), CardError);
});

test('gc: PSO and F-Zero GX system files are signed for each card and read the same from any', () => {
  for (const [code, file, blocks] of [
    ['GPOE', 'PSO_SYSTEM', 3],
    ['GPSE', 'PSO3_SYSTEM', 2],
    ['GFZE', 'f_zero.dat', 4],
  ] as const) {
    const e = gci(code, file, blocks, 0x5a);
    const a = writeGcCard(formatGcCard(4, 111n), [e]).card;
    const b = writeGcCard(formatGcCard(4, 999999n), [e]).card;
    // Signed with each card's serial: the bytes differ
    assert.ok(!a.equals(b), file);
    const ea = readGcCard(a).entries[0];
    const eb = readGcCard(b).entries[0];
    assert.equal(ea.sha1, e.sha1, file);
    assert.equal(eb.sha1, e.sha1, file);
    // And the signature is valid: recomputed as the game checks it
    const data = a.subarray(5 * BLOCK, (5 + blocks) * BLOCK);
    if (file === 'f_zero.dat') {
      let sum = 0xffff;
      for (let i = 2; i < 0x8000; i++) {
        sum ^= data[i];
        for (let j = 0; j < 8; j++) sum = sum & 1 ? (sum >>> 1) ^ 0x8408 : sum >>> 1;
      }
      assert.equal(data.readUInt16BE(0), ~sum & 0xffff);
    } else {
      let crc = 0xdebb20e3;
      for (let i = 0x4c; i < 0x164 + (file === 'PSO3_SYSTEM' ? 0x10 : 0); i++) {
        crc ^= data[BLOCK + i];
        for (let j = 0; j < 8; j++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
        crc >>>= 0;
      }
      assert.equal(data.readUInt32BE(BLOCK + 0x48), (crc ^ 0xffffffff) >>> 0);
    }
  }
});

test('gc: game code region', () => {
  assert.equal(gcRegion('GZLE'), 'USA');
  assert.equal(gcRegion('GZLP'), 'EUR');
  assert.equal(gcRegion('GZLJ'), 'JAP');
  assert.equal(gcRegion('GZL'), null);
});
