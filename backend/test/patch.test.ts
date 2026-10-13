import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { applyPatch, detectPatchFormat, patchInfo, PatchError } from '../src/lib/patch.js';

const hex = (b: Buffer) => (zlib.crc32(b) >>> 0).toString(16).padStart(8, '0');

function varint(n: number) {
  const out: number[] = [];
  for (;;) {
    const x = n & 0x7f;
    n = Math.floor(n / 128);
    if (n === 0) {
      out.push(0x80 | x);
      return Buffer.from(out);
    }
    out.push(x);
    n--;
  }
}

function withFooter(body: Buffer, source: Buffer, target: Buffer) {
  const f = Buffer.alloc(8);
  f.writeUInt32LE(zlib.crc32(source) >>> 0, 0);
  f.writeUInt32LE(zlib.crc32(target) >>> 0, 4);
  const all = Buffer.concat([body, f]);
  const p = Buffer.alloc(4);
  p.writeUInt32LE(zlib.crc32(all) >>> 0, 0);
  return Buffer.concat([all, p]);
}

const signed = (n: number) => varint((Math.abs(n) * 2) | (n < 0 ? 1 : 0));

test('IPS: normal record, RLE, extension and truncation', () => {
  const src = crypto.randomBytes(1000);
  const rec = (off: number, data: Buffer) => {
    const h = Buffer.alloc(5);
    h.writeUIntBE(off, 0, 3);
    h.writeUInt16BE(data.length, 3);
    return Buffer.concat([h, data]);
  };
  const rle = (off: number, count: number, v: number) => {
    const h = Buffer.alloc(8);
    h.writeUIntBE(off, 0, 3);
    h.writeUInt16BE(count, 5);
    h[7] = v;
    return h;
  };
  const patch = Buffer.concat([Buffer.from('PATCH'), rec(10, Buffer.from('hola')), rle(100, 50, 0xaa), rec(1100, Buffer.from('fin')), Buffer.from('EOF')]);
  assert.equal(detectPatchFormat(patch), 'ips');
  assert.deepEqual(patchInfo(patch), { format: 'ips' });
  const out = applyPatch(src, patch);
  const exp = Buffer.concat([src, Buffer.alloc(103)]);
  exp.write('hola', 10, 'latin1');
  exp.fill(0xaa, 100, 150);
  exp.write('fin', 1100, 'latin1');
  assert.ok(out.equals(exp));
  // Truncation after EOF
  const trunc = Buffer.alloc(3);
  trunc.writeUIntBE(500, 0, 3);
  const t = applyPatch(src, Buffer.concat([Buffer.from('PATCH'), rec(10, Buffer.from('hola')), Buffer.from('EOF'), trunc]));
  assert.equal(t.length, 500);
  assert.ok(t.subarray(14).equals(src.subarray(14, 500)));
});

test('BPS: the four actions, negative offsets, overlapping copy and checksums', () => {
  const src = crypto.randomBytes(300);
  // Target: 100 bytes of source as-is, 20 literals, 50 of source from 200, 30 from 120 (negative), 40 repeating 'ab'
  const lit = crypto.randomBytes(20);
  const target = Buffer.concat([src.subarray(0, 100), lit, src.subarray(200, 250), src.subarray(120, 150), Buffer.from('ab'.repeat(20))]);
  const act = (cmd: number, len: number) => varint(((len - 1) << 2) | cmd);
  const tgtAb = 200; // position of 'ab' (written as literals, then an overlapping TargetCopy)
  const body = Buffer.concat([
    Buffer.from('BPS1'),
    varint(src.length),
    varint(target.length),
    varint(4),
    Buffer.from('meta'),
    act(0, 100), // SourceRead
    act(1, 20), // TargetRead
    lit,
    act(2, 50), // SourceCopy +200
    signed(200),
    act(2, 30), // SourceCopy from 250 back to 120: -130
    signed(-130),
    act(1, 2),
    Buffer.from('ab'),
    act(3, 38), // TargetCopy from 200 (overlapping)
    signed(tgtAb),
  ]);
  const patch = withFooter(body, src, target);
  assert.equal(detectPatchFormat(patch), 'bps');
  const info = patchInfo(patch);
  assert.equal(info.sourceSize, 300);
  assert.equal(info.targetSize, target.length);
  assert.equal(info.sourceCrc32, hex(src));
  assert.equal(info.targetCrc32, hex(target));
  assert.ok(applyPatch(src, patch).equals(target));
  // Different source
  const other = Buffer.from(src);
  other[5] ^= 1;
  assert.throws(() => applyPatch(other, patch), (e: unknown) => e instanceof PatchError && /source checksum/.test((e as Error).message));
  // Corrupt patch
  const bad = Buffer.from(patch);
  bad[30] ^= 0xff;
  assert.throws(() => applyPatch(src, bad), PatchError);
});

test('UPS: several XOR blocks and longer target', () => {
  const src = crypto.randomBytes(200);
  const target = Buffer.concat([src, crypto.randomBytes(20)]);
  target[10] ^= 0x55;
  target[11] ^= 0x01;
  target[150] ^= 0xff;
  // Block differences: relative skip + XOR bytes up to 0
  const blocks: Buffer[] = [];
  let pos = 0;
  const diffs: number[] = [];
  for (let i = 0; i < target.length; i++) if ((i < src.length ? src[i] : 0) !== target[i]) diffs.push(i);
  let i = 0;
  while (i < diffs.length) {
    const start = diffs[i];
    const bytes: number[] = [];
    let j = start;
    while (j < target.length && (j < src.length ? src[j] : 0) !== target[j]) {
      bytes.push((j < src.length ? src[j] : 0) ^ target[j]);
      j++;
    }
    blocks.push(varint(start - pos), Buffer.from(bytes), Buffer.from([0]));
    pos = j + 1;
    while (i < diffs.length && diffs[i] < j) i++;
  }
  const patch = withFooter(Buffer.concat([Buffer.from('UPS1'), varint(src.length), varint(target.length), ...blocks]), src, target);
  assert.equal(detectPatchFormat(patch), 'ups');
  assert.equal(patchInfo(patch).targetSize, 220);
  assert.ok(applyPatch(src, patch).equals(target));
  assert.throws(() => applyPatch(crypto.randomBytes(200), patch), PatchError);
  const bad = Buffer.from(patch);
  bad[8] ^= 1;
  assert.throws(() => applyPatch(src, bad), PatchError);
});

test('BPS: a patch is generated from base and romhack, and applied back', async () => {
  const { createBps } = await import('../src/lib/patch.js');
  const base = crypto.randomBytes(256 * 1024);
  const hack = Buffer.concat([base, crypto.randomBytes(5000)]);
  for (let i = 0; i < 40; i++) crypto.randomBytes(crypto.randomInt(1, 300)).copy(hack, crypto.randomInt(0, base.length - 300));
  const p = createBps(base, hack);
  assert.ok(p.length < hack.length / 4, `parche de ${p.length} bytes`);
  assert.ok(applyPatch(base, p).equals(hack));
  // Target shorter than the source
  const short = hack.subarray(0, 1000);
  assert.ok(applyPatch(base, createBps(base, short)).equals(short));
});
