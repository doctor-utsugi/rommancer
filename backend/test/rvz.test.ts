/**
 * Verifies the RVZ reader with synthetic images: a GameCube ISO and a Wii ISO are built
 * (with an encrypted partition and a hash tree computed independently here), packed
 * into RVZ with a minimal encoder, and the reader must rebuild the ISO exactly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { RvzReader } from '../src/lib/rvz.js';
import { buildRvz, makeGcRvz, sha1, u32, type EncGroup } from './helpers/rvz-encoder.js';
import { raHashGamecubeFrom } from '../src/lib/rahash.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rvz-'));

async function readAll(file: string) {
  const r = await RvzReader.open(file);
  try {
    return { iso: await r.read(0, r.isoSize), hashes: await r.hashIso(), reader: r, ra: r.discType === 1 ? await raHashGamecubeFrom((p, l) => r.read(p, l)) : null };
  } finally {
    await r.close();
  }
}

test('RVZ GameCube: compressed and empty groups and LFG fill packing', async () => {
  const { iso, rvz } = makeGcRvz();
  const dir = tmp();
  const file = path.join(dir, 'gc.rvz');
  fs.writeFileSync(file, rvz);
  const { iso: out, hashes, ra } = await readAll(file);
  assert.ok(out.equals(iso), 'ISO reconstruida identica');
  assert.equal(hashes.sha1, crypto.createHash('sha1').update(iso).digest('hex'));
  assert.equal(hashes.crc32, (zlib.crc32(iso) >>> 0).toString(16).padStart(8, '0'));
  const expectedRa = await raHashGamecubeFrom(async (p, l) => iso.subarray(p, p + l));
  assert.equal(ra, expectedRa);
  fs.rmSync(dir, { recursive: true });
});

/** Independent implementation of the Wii partition format (wiibrew.org/wiki/Wii_disc). */
function encryptWiiGroup(plain: Buffer, key: Buffer, tamper?: (hashBlocks: Buffer[]) => void): Buffer {
  const blocks = 64;
  const h0 = Array.from({ length: blocks }, (_, b) => Buffer.concat(Array.from({ length: 31 }, (_, j) => sha1(plain.subarray(b * 0x7c00 + j * 0x400, b * 0x7c00 + (j + 1) * 0x400)))));
  const h1 = Array.from({ length: 8 }, (_, s) => Buffer.concat(Array.from({ length: 8 }, (_, k) => sha1(h0[s * 8 + k]))));
  const h2 = Buffer.concat(h1.map((x) => sha1(x)));
  const headers = Array.from({ length: blocks }, (_, b) => {
    const h = Buffer.alloc(0x400);
    h0[b].copy(h, 0);
    h1[Math.floor(b / 8)].copy(h, 0x280);
    h2.copy(h, 0x340);
    return h;
  });
  tamper?.(headers);
  const out: Buffer[] = [];
  for (let b = 0; b < blocks; b++) {
    const c1 = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16)).setAutoPadding(false);
    const eh = Buffer.concat([c1.update(headers[b]), c1.final()]);
    const c2 = crypto.createCipheriv('aes-128-cbc', key, eh.subarray(0x3d0, 0x3e0)).setAutoPadding(false);
    out.push(eh, c2.update(plain.subarray(b * 0x7c00, (b + 1) * 0x7c00)), c2.final());
  }
  return Buffer.concat(out);
}

test('RVZ Wii: encrypted partition, hash tree and hash exceptions', async () => {
  const key = crypto.randomBytes(16);
  const firstSector = 2;
  const sectors0 = 64;
  const sectors1 = 36;
  const total = sectors0 + sectors1;
  const plain = Buffer.alloc(128 * 0x7c00);
  crypto.randomBytes(total * 0x7c00).copy(plain);
  plain.fill(0, 80 * 0x7c00, total * 0x7c00);
  // Exception: the original disc has a different H0 in block 3, entry 5
  const badHash = crypto.randomBytes(20);
  const exceptionOffset = 3 * 0x400 + 5 * 20;
  const enc0 = encryptWiiGroup(plain.subarray(0, 64 * 0x7c00), key, (h) => badHash.copy(h[3], 5 * 20));
  const enc1 = encryptWiiGroup(plain.subarray(64 * 0x7c00, 128 * 0x7c00), key);

  const isoSize = (firstSector + total) * 0x8000 + 0x10000;
  const iso = Buffer.alloc(isoSize);
  crypto.randomBytes(firstSector * 0x8000).copy(iso);
  enc0.copy(iso, firstSector * 0x8000);
  enc1.copy(iso, (firstSector + 64) * 0x8000, 0, sectors1 * 0x8000);
  crypto.randomBytes(0x10000).copy(iso, (firstSector + total) * 0x8000);

  const chunk = 0x200000;
  const dataChunk = 0x1f0000;
  const exc0 = Buffer.concat([Buffer.from([0, 1]), Buffer.from([exceptionOffset >> 8, exceptionOffset & 0xff]), badHash]);
  const exc1 = Buffer.from([0, 0]);
  const tailStart = (firstSector + total) * 0x8000;
  const groups: EncGroup[] = [
    { data: zlib.zstdCompressSync(iso.subarray(0, firstSector * 0x8000)), compressed: true, packedSize: 0 },
    { data: zlib.zstdCompressSync(Buffer.concat([exc0, plain.subarray(0, dataChunk)])), compressed: true, packedSize: 0 },
    // uncompressed: exception list aligned to 4 bytes
    { data: Buffer.concat([exc1, Buffer.alloc(2), plain.subarray(dataChunk, dataChunk + sectors1 * 0x7c00)]), compressed: false, packedSize: 0 },
    { data: zlib.zstdCompressSync(iso.subarray(tailStart)), compressed: true, packedSize: 0 },
  ];
  const rvz = buildRvz({
    discType: 2,
    chunkSize: chunk,
    isoSize,
    discHeader: iso.subarray(0, 0x80),
    partitions: [{ key, pd: [[firstSector, sectors0, 1, 1], [firstSector + sectors0, sectors1, 2, 1]] }],
    raws: [
      [0x80, firstSector * 0x8000 - 0x80, 0, 1],
      [tailStart, 0x10000, 3, 1],
    ],
    groups,
  });
  const dir = tmp();
  const file = path.join(dir, 'wii.rvz');
  fs.writeFileSync(file, rvz);
  const { iso: out, hashes } = await readAll(file);
  assert.equal(out.length, iso.length);
  for (let s = 0; s < iso.length / 0x8000; s++) {
    if (!out.subarray(s * 0x8000, (s + 1) * 0x8000).equals(iso.subarray(s * 0x8000, (s + 1) * 0x8000))) assert.fail(`Sector ${s} distinto`);
  }
  assert.equal(hashes.sha1, crypto.createHash('sha1').update(iso).digest('hex'));
  fs.rmSync(dir, { recursive: true });
});

const MELEE = path.resolve(import.meta.dirname, '../../roms/gc/Super Smash Bros. Melee (Europe) (En,Fr,De,Es,It).rvz');

test('RVZ real: Super Smash Bros. Melee (Europe) matches Redump', { skip: !fs.existsSync(MELEE) }, async () => {
  const r = await RvzReader.open(MELEE);
  try {
    const h = await r.hashIso();
    assert.equal(h.size, 1459978240);
    assert.equal(h.crc32, '0fd01424');
    assert.equal(h.md5, '5e118fc2d85350b7b092d0192bfb0f1a');
    assert.equal(h.sha1, 'd0a925866379c546ceb739eeb780d011383cb07c');
  } finally {
    await r.close();
  }
});
