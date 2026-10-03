import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { discId, lz4BlockDecompress, openDiscImage } from '../src/lib/discimage.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rommancer-disc-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const sha1 = (b: Buffer) => crypto.createHash('sha1').update(b).digest('hex');

// Disco con cabecera de GameCube o Wii, datos aleatorios y zonas a cero
function makeIso(size: number, platform: 'gc' | 'wii', blockSize: number, emptyBlocks: number[] = []) {
  const iso = crypto.randomBytes(size);
  for (const b of emptyBlocks) iso.fill(0, b * blockSize, (b + 1) * blockSize);
  iso.write('RMCE01', 0, 'latin1');
  iso[6] = 0;
  iso[7] = 1;
  iso.fill(0, 0x18, 0x60);
  if (platform === 'wii') iso.writeUInt32BE(0x5d1c9ea3, 0x18);
  else iso.writeUInt32BE(0xc2339f3d, 0x1c);
  iso.write('Test Disc', 0x20, 'latin1');
  return iso;
}

async function checkReader(file: string, expected: Buffer, format: string) {
  const r = await openDiscImage(file);
  assert.ok(r);
  try {
    assert.equal(r.format, format);
    for (let i = 0; i < 50; i++) {
      const off = crypto.randomInt(0, expected.length - 1);
      const len = crypto.randomInt(1, Math.min(300000, expected.length - off) + 1);
      assert.ok((await r.read(off, len)).equals(expected.subarray(off, off + len)), `${format} read ${off}+${len}`);
    }
    const h = await r.hashIso();
    assert.equal(h.size, expected.length);
    assert.equal(h.sha1, sha1(expected));
    assert.equal(h.crc32, (zlib.crc32(expected) >>> 0).toString(16).padStart(8, '0'));
    return r;
  } finally {
    await r.close();
  }
}

test('WBFS de un disco Wii, tambien partido en .wbfs + .wbf1', async () => {
  const blockShift = 21; // bloques de 2 MiB
  const block = 1 << blockShift;
  const nBlocks = 5;
  const iso = makeIso(nBlocks * block, 'wii', block, [2]);
  const hdSec = 512;
  const perDisc = Math.ceil((143432 * 2 * 0x8000) / block);
  const head = Buffer.alloc(hdSec);
  head.write('WBFS', 0, 'latin1');
  head[8] = 9;
  head[9] = blockShift;
  head[12] = 1;
  const info = Buffer.alloc(0x100 + perDisc * 2);
  iso.copy(info, 0, 0, 0x100);
  // Bloques almacenados a partir del bloque 1 del fichero (el 0 contiene las cabeceras)
  const stored: Buffer[] = [];
  let next = 1;
  for (let i = 0; i < nBlocks; i++) {
    if (i === 2) continue;
    info.writeUInt16BE(next++, 0x100 + i * 2);
    stored.push(iso.subarray(i * block, (i + 1) * block));
  }
  const meta = Buffer.concat([head, info]);
  const file = Buffer.concat([meta, Buffer.alloc(block - meta.length), ...stored]);
  fs.writeFileSync(path.join(dir, 'game.wbfs'), file);
  await checkReader(path.join(dir, 'game.wbfs'), iso, 'wbfs');
  const r = await openDiscImage(path.join(dir, 'game.wbfs'));
  const d = await discId((p, l) => r!.read(p, l));
  await r!.close();
  assert.deepEqual(d, { id: 'RMCE01', maker: '01', discNumber: 0, revision: 1, title: 'Test Disc', platform: 'wii' });

  const cut = 3 * block + 12345;
  fs.mkdirSync(path.join(dir, 'split'));
  fs.writeFileSync(path.join(dir, 'split', 'game.wbfs'), file.subarray(0, cut));
  fs.writeFileSync(path.join(dir, 'split', 'game.wbf1'), file.subarray(cut));
  await checkReader(path.join(dir, 'split', 'game.wbfs'), iso, 'wbfs');
});

test('CISO de GameCube con bloques ausentes', async () => {
  const block = 0x200000;
  const iso = makeIso(6 * block, 'gc', block, [1, 4]);
  const map = Buffer.alloc(0x8000 - 8);
  const data: Buffer[] = [];
  for (let i = 0; i < 6; i++) {
    if (i === 1 || i === 4) continue;
    map[i] = 1;
    data.push(iso.subarray(i * block, (i + 1) * block));
  }
  const head = Buffer.alloc(8);
  head.write('CISO', 0, 'latin1');
  head.writeUInt32LE(block, 4);
  fs.writeFileSync(path.join(dir, 'game.ciso'), Buffer.concat([head, map, ...data]));
  // La ISO reconstruida tiene el tamano de un disco de GameCube (relleno con ceros)
  const r = await openDiscImage(path.join(dir, 'game.ciso'));
  assert.ok(r);
  assert.equal(r.format, 'ciso');
  assert.equal(r.isoSize, 1459978240);
  for (const off of [0, 5, block - 3, block + 7, 2 * block + 100, 4 * block + 1, 6 * block - 100]) {
    assert.ok((await r.read(off, 64)).equals(iso.subarray(off, off + 64)), `ciso ${off}`);
  }
  assert.ok((await r.read(7 * block, 1000)).equals(Buffer.alloc(1000)));
  assert.equal((await discId((p, l) => r.read(p, l))).platform, 'gc');
  await r.close();
});

// Compresor LZ4 trivial: literales y una coincidencia repetida
function lz4Compress(src: Buffer) {
  const out: number[] = [];
  const half = Math.floor(src.length / 2);
  // Si la segunda mitad repite la primera, se codifica como un match
  if (src.subarray(0, half).equals(src.subarray(half, half * 2)) && half >= 4) {
    const lit = src.subarray(0, half);
    const pushLen = (n: number) => {
      while (n >= 255) {
        out.push(255);
        n -= 255;
      }
      out.push(n);
    };
    const matchLen = half - 4;
    out.push((Math.min(lit.length, 15) << 4) | Math.min(matchLen, 15));
    if (lit.length >= 15) pushLen(lit.length - 15);
    out.push(...lit);
    out.push(half & 0xff, half >> 8);
    if (matchLen >= 15) pushLen(matchLen - 15);
    const rest = src.subarray(half * 2);
    out.push(Math.min(rest.length, 15) << 4);
    if (rest.length >= 15) pushLen(rest.length - 15);
    out.push(...rest);
    return Buffer.from(out);
  }
  const pushLen = (n: number) => {
    while (n >= 255) {
      out.push(255);
      n -= 255;
    }
    out.push(n);
  };
  out.push(Math.min(src.length, 15) << 4);
  if (src.length >= 15) pushLen(src.length - 15);
  out.push(...src);
  return Buffer.from(out);
}

test('LZ4 de bloque con match solapado', () => {
  const a = crypto.randomBytes(1000);
  const src = Buffer.concat([a, a, Buffer.from('fin')]);
  assert.ok(lz4BlockDecompress(lz4Compress(src), 4096).equals(src));
  // Match con offset 1 (repeticion de un byte)
  const rle = Buffer.from([0x1f, 0x41, 0x01, 0x00, 0x05, 0x10, 0x42]);
  assert.equal(lz4BlockDecompress(rle, 100).toString('latin1'), 'A'.repeat(1 + 4 + 15 + 5) + 'B');
});

function makeCsoLike(iso: Buffer, block: number, magic: 'CISO' | 'ZISO', compress: (b: Buffer, i: number) => { data: Buffer; flag: boolean }) {
  const n = Math.ceil(iso.length / block);
  const head = Buffer.alloc(0x18);
  head.write(magic, 0, 'latin1');
  head.writeUInt32LE(0x18, 4);
  head.writeBigUInt64LE(BigInt(iso.length), 8);
  head.writeUInt32LE(block, 16);
  head[20] = 1;
  head[21] = 0;
  const index = Buffer.alloc((n + 1) * 4);
  const blocks: Buffer[] = [];
  let pos = 0x18 + index.length;
  for (let i = 0; i < n; i++) {
    const { data, flag } = compress(iso.subarray(i * block, (i + 1) * block), i);
    index.writeUInt32LE((pos | (flag ? 0x80000000 : 0)) >>> 0, i * 4);
    blocks.push(data);
    pos += data.length;
  }
  index.writeUInt32LE(pos, n * 4);
  return Buffer.concat([head, index, ...blocks]);
}

test('CSO v1 (deflate y sin comprimir) y ZSO (LZ4)', async () => {
  const block = 2048;
  const a = crypto.randomBytes(block / 2);
  const parts: Buffer[] = [];
  for (let i = 0; i < 40; i++) parts.push(i % 3 === 0 ? Buffer.alloc(block, i) : i % 3 === 1 ? Buffer.concat([a, a]) : crypto.randomBytes(block));
  parts.push(crypto.randomBytes(700)); // ultimo bloque incompleto
  const iso = Buffer.concat(parts);
  const cso = makeCsoLike(iso, block, 'CISO', (b, i) => (i % 3 === 2 ? { data: b, flag: true } : { data: zlib.deflateRawSync(b), flag: false }));
  fs.writeFileSync(path.join(dir, 'game.cso'), cso);
  await checkReader(path.join(dir, 'game.cso'), iso, 'cso');
  const zso = makeCsoLike(iso, block, 'ZISO', (b, i) => (i % 3 === 2 ? { data: b, flag: true } : { data: lz4Compress(b), flag: false }));
  fs.writeFileSync(path.join(dir, 'game.zso'), zso);
  await checkReader(path.join(dir, 'game.zso'), iso, 'zso');
});
