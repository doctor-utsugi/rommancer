/**
 * Random-access readers for compressed or trimmed disc images:
 *  - WBFS (Wii, including split .wbfs/.wbf1/.wbf2...) and CISO (GameCube): only keep the used
 *    blocks. They drop the update partition and the padding, so the rebuilt ISO does not
 *    match Redump: they are identified by disc id and stay unverified.
 *  - CSO v1/v2 and ZSO (PSP, PS2): keep the whole ISO; verifiable against Redump.
 * Formats per libwbfs (WBFS), Dolphin CISOBlob (CISO) and maxcso/README_CSO.md (CSO v2 and ZSO).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export interface DiscReader {
  format: 'wbfs' | 'ciso' | 'cso' | 'zso';
  isoSize: number;
  read(offset: number, size: number): Promise<Buffer>;
  hashIso(onProgress?: (done: number, total: number) => void): Promise<{ size: number; crc32: string; md5: string; sha1: string }>;
  close(): Promise<void>;
}

const HASH_STEP = 2 * 1024 * 1024;
const GC_DISC_SIZE = 1459978240;
const WII_SECTOR_SIZE = 0x8000;
const WII_SECTORS_PER_DISC = 143432 * 2;
const WII_SL_SIZE = 4699979776;
const WII_DL_SIZE = 8511160320;

/** Files read as one (split WBFS). */
class MultiFile {
  constructor(private parts: { fd: fs.promises.FileHandle; start: number; size: number }[]) {}
  static async open(files: string[]) {
    const parts = [];
    let start = 0;
    for (const f of files) {
      const fd = await fs.promises.open(f, 'r');
      const size = (await fd.stat()).size;
      parts.push({ fd, start, size });
      start += size;
    }
    return new MultiFile(parts);
  }
  get size() {
    const last = this.parts[this.parts.length - 1];
    return last ? last.start + last.size : 0;
  }
  async read(pos: number, len: number): Promise<Buffer> {
    const out = Buffer.alloc(len);
    let done = 0;
    while (done < len) {
      const p = pos + done;
      const part = this.parts.find((x) => p >= x.start && p < x.start + x.size);
      if (!part) break;
      const n = Math.min(len - done, part.start + part.size - p);
      const { bytesRead } = await part.fd.read(out, done, n, p - part.start);
      if (!bytesRead) break;
      done += bytesRead;
    }
    return out;
  }
  async close() {
    for (const p of this.parts) await p.fd.close();
  }
}

abstract class BlockReader implements DiscReader {
  abstract format: DiscReader['format'];
  abstract isoSize: number;
  protected abstract blockSize: number;
  protected abstract readBlock(index: number): Promise<Buffer | null>;
  abstract close(): Promise<void>;
  private cache: { index: number; data: Buffer | null } | null = null;

  async read(offset: number, size: number): Promise<Buffer> {
    if (offset >= this.isoSize) return Buffer.alloc(0);
    size = Math.min(size, this.isoSize - offset);
    const out = Buffer.alloc(size);
    let done = 0;
    while (done < size) {
      const pos = offset + done;
      const index = Math.floor(pos / this.blockSize);
      const inBlock = pos - index * this.blockSize;
      const n = Math.min(size - done, this.blockSize - inBlock);
      if (this.cache?.index !== index) this.cache = { index, data: await this.readBlock(index) };
      // Block not stored: zeros (already in the buffer)
      this.cache.data?.copy(out, done, inBlock, inBlock + n);
      done += n;
    }
    return out;
  }

  async hashIso(onProgress?: (done: number, total: number) => void) {
    let crc = 0;
    const md5 = crypto.createHash('md5');
    const sha1 = crypto.createHash('sha1');
    for (let pos = 0; pos < this.isoSize; pos += HASH_STEP) {
      const b = await this.read(pos, Math.min(HASH_STEP, this.isoSize - pos));
      crc = zlib.crc32(b, crc);
      md5.update(b);
      sha1.update(b);
      onProgress?.(pos + b.length, this.isoSize);
    }
    return { size: this.isoSize, crc32: (crc >>> 0).toString(16).padStart(8, '0'), md5: md5.digest('hex'), sha1: sha1.digest('hex') };
  }
}

class WbfsReader extends BlockReader {
  format = 'wbfs' as const;
  isoSize = 0;
  protected blockSize = 0;
  private table: number[] = [];
  constructor(private file: MultiFile) {
    super();
  }
  async init() {
    const h = await this.file.read(0, 12);
    if (h.toString('latin1', 0, 4) !== 'WBFS') throw new Error('Not a WBFS file');
    const hdSecSize = 1 << h[8];
    const wbfsSecShift = h[9];
    this.blockSize = 2 ** wbfsSecShift;
    const blocksPerDisc = Math.ceil((WII_SECTORS_PER_DISC * WII_SECTOR_SIZE) / this.blockSize);
    // First disc: info in the sector after the header (header copy + block table)
    const info = await this.file.read(hdSecSize, 0x100 + blocksPerDisc * 2);
    let last = -1;
    for (let i = 0; i < blocksPerDisc; i++) {
      const v = info.readUInt16BE(0x100 + i * 2);
      this.table.push(v);
      if (v) last = i;
    }
    // Rebuilt up to the last used block (the rest of the disc would be zeros)
    const used = (last + 1) * this.blockSize;
    this.isoSize = Math.min(used, used <= WII_SL_SIZE ? WII_SL_SIZE : WII_DL_SIZE);
  }
  protected async readBlock(index: number) {
    const b = this.table[index];
    if (!b) return null;
    return this.file.read(b * this.blockSize, this.blockSize);
  }
  close() {
    return this.file.close();
  }
}

class GcCisoReader extends BlockReader {
  format = 'ciso' as const;
  isoSize = 0;
  protected blockSize = 0;
  private offsets: (number | null)[] = [];
  constructor(private fd: fs.promises.FileHandle) {
    super();
  }
  async init() {
    const h = Buffer.alloc(0x8000);
    await this.fd.read(h, 0, 0x8000, 0);
    if (h.toString('latin1', 0, 4) !== 'CISO') throw new Error('Not a CISO file');
    this.blockSize = h.readUInt32LE(4);
    let pos = 0x8000;
    let last = -1;
    for (let i = 0; i < 0x8000 - 8; i++) {
      if (h[8 + i]) {
        this.offsets.push(pos);
        pos += this.blockSize;
        last = i;
      } else this.offsets.push(null);
    }
    // Size of a GameCube disc unless used blocks reach further
    this.isoSize = Math.max(GC_DISC_SIZE, (last + 1) * this.blockSize);
  }
  protected async readBlock(index: number) {
    const off = this.offsets[index];
    if (off == null) return null;
    const b = Buffer.alloc(this.blockSize);
    await this.fd.read(b, 0, this.blockSize, off);
    return b;
  }
  close() {
    return this.fd.close();
  }
}

class CsoReader extends BlockReader {
  isoSize = 0;
  protected blockSize = 0;
  private index: number[] = [];
  private version = 1;
  private align = 0;
  constructor(
    private fd: fs.promises.FileHandle,
    public format: 'cso' | 'zso',
  ) {
    super();
  }
  async init() {
    const h = Buffer.alloc(0x18);
    await this.fd.read(h, 0, 0x18, 0);
    const magic = h.toString('latin1', 0, 4);
    if (magic !== (this.format === 'zso' ? 'ZISO' : 'CISO')) throw new Error(`Not a ${this.format.toUpperCase()} file`);
    const headerSize = h.readUInt32LE(4) || 0x18;
    this.isoSize = Number(h.readBigUInt64LE(8));
    this.blockSize = h.readUInt32LE(16);
    this.version = h[20];
    this.align = h[21];
    const n = Math.ceil(this.isoSize / this.blockSize) + 1;
    const t = Buffer.alloc(n * 4);
    await this.fd.read(t, 0, t.length, Math.max(headerSize, 0x18));
    for (let i = 0; i < n; i++) this.index.push(t.readUInt32LE(i * 4));
  }
  protected async readBlock(i: number) {
    const a = this.index[i];
    const b = this.index[i + 1];
    if (a === undefined || b === undefined) return null;
    const flag = (a & 0x80000000) !== 0;
    const start = (a & 0x7fffffff) * 2 ** this.align;
    const end = (b & 0x7fffffff) * 2 ** this.align;
    const raw = Buffer.alloc(end - start);
    await this.fd.read(raw, 0, raw.length, start);
    const expected = Math.min(this.blockSize, this.isoSize - i * this.blockSize);
    let plain: boolean;
    let lz4: boolean;
    if (this.format === 'zso') {
      plain = flag;
      lz4 = !flag;
    } else if (this.version >= 2) {
      // CSO v2: stored uncompressed if it fills the whole block; the high bit means LZ4 instead of deflate
      plain = raw.length >= this.blockSize;
      lz4 = flag;
    } else {
      plain = flag;
      lz4 = false;
    }
    if (plain) return raw.subarray(0, expected);
    const out = lz4 ? lz4BlockDecompress(raw, this.blockSize) : zlib.inflateRawSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    return out.subarray(0, expected);
  }
  close() {
    return this.fd.close();
  }
}

/** LZ4 block decompressor (block format, no frame header). */
export function lz4BlockDecompress(src: Buffer, maxOut: number): Buffer {
  const out = Buffer.alloc(maxOut);
  let s = 0;
  let d = 0;
  while (s < src.length) {
    const token = src[s++];
    let lit = token >> 4;
    if (lit === 15) {
      let x: number;
      do {
        x = src[s++];
        lit += x;
      } while (x === 255 && s < src.length);
    }
    if (d + lit > maxOut || s + lit > src.length) throw new Error('LZ4: literal overflow');
    src.copy(out, d, s, s + lit);
    s += lit;
    d += lit;
    // The last sequence block ends after the literals
    if (s >= src.length) break;
    const off = src[s] | (src[s + 1] << 8);
    s += 2;
    if (!off || off > d) throw new Error('LZ4: bad offset');
    let len = token & 15;
    if (len === 15) {
      let x: number;
      do {
        x = src[s++];
        len += x;
      } while (x === 255 && s < src.length);
    }
    len += 4;
    if (d + len > maxOut) throw new Error('LZ4: match overflow');
    // Byte-by-byte copy: may overlap
    for (let k = 0; k < len; k++) out[d + k] = out[d - off + k];
    d += len;
  }
  return out.subarray(0, d);
}

async function wbfsParts(file: string) {
  const parts = [file];
  const base = file.replace(/\.wbfs$/i, '');
  for (let i = 1; i < 10; i++) {
    const p = `${base}.wbf${i}`;
    if (!fs.existsSync(p)) break;
    parts.push(p);
  }
  return parts;
}

export async function openDiscImage(file: string): Promise<DiscReader | null> {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.wbfs') {
    const r = new WbfsReader(await MultiFile.open(await wbfsParts(file)));
    try {
      await r.init();
    } catch (e) {
      await r.close();
      throw e;
    }
    return r;
  }
  if (!['.ciso', '.cso', '.zso'].includes(ext)) return null;
  const fd = await fs.promises.open(file, 'r');
  try {
    const magic = Buffer.alloc(24);
    await fd.read(magic, 0, 24, 0);
    const m = magic.toString('latin1', 0, 4);
    let r: GcCisoReader | CsoReader;
    if (m === 'ZISO') r = new CsoReader(fd, 'zso');
    // GameCube CISO and CSO share a magic: CSO has header_size 0x18 and the total size at 8..16
    else if (m === 'CISO' && magic.readUInt32LE(4) <= 0x18 && magic.readBigUInt64LE(8) > 0n) r = new CsoReader(fd, 'cso');
    else if (m === 'CISO') r = new GcCisoReader(fd);
    else {
      await fd.close();
      return null;
    }
    await r.init();
    return r;
  } catch (e) {
    await fd.close().catch(() => {});
    throw e;
  }
}

/** Identifies a GameCube/Wii disc from its header. */
export async function discId(readAt: (pos: number, len: number) => Promise<Buffer>) {
  const h = await readAt(0, 0x60);
  const id = h.toString('latin1', 0, 6).replace(/\0/g, '');
  const platform = h.readUInt32BE(0x18) === 0x5d1c9ea3 ? ('wii' as const) : h.readUInt32BE(0x1c) === 0xc2339f3d ? ('gc' as const) : null;
  const end = h.indexOf(0, 0x20);
  return {
    id,
    maker: id.slice(4, 6),
    discNumber: h[6],
    revision: h[7],
    title: h.toString('latin1', 0x20, end > 0x20 ? end : 0x60).trim(),
    platform,
  };
}

/** A CSO/ZSO read through any byte source (a header probe holding only the bytes a device sent) */
export async function openCsoOn(src: { read(pos: number, len: number): Promise<Buffer> }, format: 'cso' | 'zso') {
  const fd = {
    async read(buf: Buffer, off: number, len: number, pos: number) {
      const b = await src.read(pos, len);
      b.copy(buf, off);
      return { bytesRead: b.length, buffer: buf };
    },
    async close() {},
  } as unknown as fs.promises.FileHandle;
  const r = new CsoReader(fd, format);
  await r.init();
  return r;
}
