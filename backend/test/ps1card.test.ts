import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CardError, formatPs1Card, productCodeOf, readMcs, readPs1Card, writePs1Card, type Ps1Entry } from '../src/modules/saves/ps1card.js';

const BLOCK = 0x2000;

/** A save of BLOCKS blocks as a .mcs file, its data marked with SEED */
function mcs(name: string, blocks: number, seed: number, title = 'TEST SAVE'): Ps1Entry {
  const buf = Buffer.alloc(128 + blocks * BLOCK, seed);
  buf.fill(0, 0, 128);
  buf.writeUInt32LE(0x51, 0);
  buf.writeUInt32LE(blocks * BLOCK, 4);
  buf.writeUInt16LE(0xffff, 8);
  buf.write(name, 0x0a, 'latin1');
  // Title frame: "SC", icon flag, block count, Shift-JIS title
  buf.fill(0, 128, 128 + 0x44);
  buf.write('SC', 128, 'latin1');
  buf[128 + 2] = 0x11;
  buf[128 + 3] = blocks;
  buf.write(title, 128 + 4, 'latin1');
  return readMcs(buf);
}

test('product codes come out of entry names', () => {
  assert.equal(productCodeOf('BASCUS-94163FF7-S01'), 'SCUS-94163');
  assert.equal(productCodeOf('BESLES-01370DRACULA'), 'SLES-01370');
  assert.equal(productCodeOf('HOMEBREW'), null);
});

test('a formatted card is empty and readable', () => {
  const card = readPs1Card(formatPs1Card());
  assert.equal(card.entries.length, 0);
  assert.equal(card.freeBlocks, 15);
  assert.deepEqual(card.problems, []);
});

test('entries go in, are replaced by name and leave the others where they were', () => {
  const ff1 = mcs('BASCUS-94163FF7-S01', 1, 1, 'FF7 SAVE 1');
  const ff2 = mcs('BASCUS-94163FF7-S02', 1, 2, 'FF7 SAVE 2');
  const big = mcs('BASLUS-00067DRACULA', 3, 3);
  let { card, skipped } = writePs1Card(formatPs1Card(), [ff1, ff2, big]);
  assert.deepEqual(skipped, []);
  let read = readPs1Card(card);
  // Two saves of one game stay two entries
  assert.deepEqual(read.entries.map((e) => e.name).sort(), ['BASCUS-94163FF7-S01', 'BASCUS-94163FF7-S02', 'BASLUS-00067DRACULA']);
  assert.equal(read.freeBlocks, 10);
  assert.equal(read.entries.find((e) => e.name === 'BASCUS-94163FF7-S01')!.title, 'FF7 SAVE 1');
  assert.equal(read.entries.find((e) => e.name === 'BASLUS-00067DRACULA')!.blocks, 3);
  // The same entry reads back identical (same sha1) whatever blocks it sits in
  assert.equal(read.entries.find((e) => e.name === 'BASLUS-00067DRACULA')!.sha1, big.sha1);
  const before = Buffer.from(card);
  const ff1b = mcs('BASCUS-94163FF7-S01', 1, 9, 'FF7 SAVE 1');
  ({ card, skipped } = writePs1Card(card, [ff1b]));
  read = readPs1Card(card);
  assert.equal(read.entries.length, 3);
  assert.equal(read.entries.find((e) => e.name === 'BASCUS-94163FF7-S01')!.sha1, ff1b.sha1);
  // Blocks of the entries not touched are byte for byte the same
  const s2 = before.subarray(3 * BLOCK, 4 * BLOCK);
  assert.ok(card.subarray(3 * BLOCK, 4 * BLOCK).equals(s2));
  // Taking one out frees its blocks
  ({ card } = writePs1Card(card, [], ['BASLUS-00067DRACULA']));
  assert.equal(readPs1Card(card).freeBlocks, 13);
});

test('what does not fit is left out and said', () => {
  const fill = Array.from({ length: 14 }, (_, i) => mcs(`BASLUS-0000${String(i).padStart(2, '0')}X`, 1, i + 1));
  const { card } = writePs1Card(formatPs1Card(), fill);
  const r = writePs1Card(card, [mcs('BASLUS-99999BIG', 2, 7)]);
  assert.deepEqual(r.skipped, ['BASLUS-99999BIG']);
  assert.equal(readPs1Card(r.card).entries.length, 14);
});

test('a damaged card is read where it can be but never written', () => {
  const { card } = writePs1Card(formatPs1Card(), [mcs('BASLUS-00067DRACULA', 3, 3), mcs('BASCUS-94163FF7-S01', 1, 1)]);
  const broken = Buffer.from(card);
  // The first block of the 3-block save points to a block that is free
  const dir = 128;
  broken.writeUInt16LE(14, dir + 8);
  const read = readPs1Card(broken);
  assert.ok(read.problems.length > 0);
  assert.deepEqual(
    read.entries.map((e) => e.name),
    ['BASCUS-94163FF7-S01'],
  );
  assert.throws(() => writePs1Card(broken, [mcs('BASLUS-00001X', 1, 5)]), CardError);
  assert.throws(() => readPs1Card(Buffer.alloc(100)), CardError);
});

test('a newer version that does not fit leaves the one the card has', () => {
  const { card } = writePs1Card(formatPs1Card(), [mcs('BASLUS-0000AAAA', 12, 1), mcs('BASLUS-0000XXXX', 1, 2)]);
  const xNew = mcs('BASLUS-0000XXXX', 1, 9);
  // The new save takes the free room; the newer X still fits in its own block
  const r = writePs1Card(card, [mcs('BASLUS-0000YYYY', 2, 3), xNew]);
  const read = readPs1Card(r.card);
  assert.deepEqual(read.entries.map((e) => e.name).sort(), ['BASLUS-0000AAAA', 'BASLUS-0000XXXX', 'BASLUS-0000YYYY']);
  assert.deepEqual(r.skipped, []);
  assert.equal(read.entries.find((e) => e.name === 'BASLUS-0000XXXX')!.sha1, xNew.sha1);
  // A grown version that does not fit: the old one stays
  const before = readPs1Card(r.card).entries.find((e) => e.name === 'BASLUS-0000XXXX')!.sha1;
  const big = writePs1Card(r.card, [mcs('BASLUS-0000XXXX', 3, 4)]);
  assert.deepEqual(big.skipped, ['BASLUS-0000XXXX']);
  assert.equal(readPs1Card(big.card).entries.find((e) => e.name === 'BASLUS-0000XXXX')!.sha1, before);
});
