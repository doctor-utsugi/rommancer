/**
 * Lector de imagenes RVZ/WIA (GameCube y Wii) que reconstruye la ISO original byte a byte,
 * incluido el cifrado y el arbol de hashes de las particiones Wii, para poder verificarla
 * contra Redump sin dolphin-tool.
 *
 * Port a TypeScript de Dolphin (https://github.com/dolphin-emu/dolphin):
 *   Source/Core/DiscIO/WIABlob.cpp, WIACompression.cpp, VolumeWii.cpp  (GPL-2.0-or-later)
 *   Source/Core/DiscIO/LaggedFibonacciGenerator.cpp                    (CC0-1.0)
 *   docs/WiaAndRvz.md
 * Compresiones soportadas: NONE y Zstandard (RVZ), NONE y PURGE (WIA). bzip2/LZMA no.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';

const RVZ_MAGIC = 0x52565a01;
const WIA_MAGIC = 0x57494101;

const BLOCK_HEADER_SIZE = 0x400;
const BLOCK_DATA_SIZE = 0x7c00;
const BLOCK_TOTAL_SIZE = 0x8000;
const BLOCKS_PER_GROUP = 64;
const GROUP_DATA_SIZE = BLOCK_DATA_SIZE * BLOCKS_PER_GROUP;
const GROUP_TOTAL_SIZE = BLOCK_TOTAL_SIZE * BLOCKS_PER_GROUP;

enum Compression {
  None = 0,
  Purge = 1,
  Bzip2 = 2,
  LZMA = 3,
  LZMA2 = 4,
  Zstd = 5,
}

// --- Generador de Fibonacci retardado (relleno pseudoaleatorio de los discos) ---
const LFG_K = 521;
const LFG_J = 32;
const SEED_WORDS = 17;

class LaggedFibonacci {
  // Palabras ya transformadas: los bytes de salida son la representacion big endian de cada palabra
  private buf = new Uint32Array(LFG_K);
  private pos = 0;

  setSeed(seed: Buffer) {
    this.pos = 0;
    for (let i = 0; i < SEED_WORDS; i++) this.buf[i] = seed.readUInt32BE(i * 4);
    for (let i = SEED_WORDS; i < LFG_K; i++) this.buf[i] = ((this.buf[i - 17] << 23) ^ (this.buf[i - 16] >>> 9) ^ this.buf[i - 1]) >>> 0;
    // El algoritmo original desplaza 18 en lugar de 16 al emitir: se aplica aqui una vez
    for (let i = 0; i < LFG_K; i++) {
      const x = this.buf[i];
      this.buf[i] = ((x & 0xff00ffff) | ((x >>> 2) & 0x00ff0000)) >>> 0;
    }
    for (let i = 0; i < 4; i++) this.step();
  }

  private step() {
    const b = this.buf;
    for (let i = 0; i < LFG_J; i++) b[i] ^= b[i + LFG_K - LFG_J];
    for (let i = LFG_J; i < LFG_K; i++) b[i] ^= b[i - LFG_J];
  }

  forward(bytes: number) {
    this.pos += bytes;
    while (this.pos >= LFG_K * 4) {
      this.step();
      this.pos -= LFG_K * 4;
    }
  }

  getBytes(n: number, out: Buffer, outOff: number) {
    for (let i = 0; i < n; i++) {
      const w = this.buf[this.pos >>> 2];
      out[outOff + i] = (w >>> (24 - 8 * (this.pos & 3))) & 0xff;
      if (++this.pos === LFG_K * 4) {
        this.step();
        this.pos = 0;
      }
    }
  }
}

/** Decodifica el empaquetado RVZ (datos literales y tramos de relleno regenerados con el LFG). */
export function rvzUnpack(packed: Buffer, outSize: number, dataOffset: number): Buffer {
  const out = Buffer.alloc(outSize);
  const lfg = new LaggedFibonacci();
  let i = 0;
  let o = 0;
  let offset = dataOffset;
  while (o < outSize && i < packed.length) {
    const size = packed.readUInt32BE(i);
    i += 4;
    const len = Math.min(size & 0x7fffffff, outSize - o);
    if (size & 0x80000000) {
      lfg.setSeed(packed.subarray(i, i + SEED_WORDS * 4));
      i += SEED_WORDS * 4;
      lfg.forward(offset % BLOCK_TOTAL_SIZE);
      lfg.getBytes(len, out, o);
    } else {
      packed.copy(out, o, i, i + len);
      i += len;
    }
    o += len;
    offset += len;
  }
  return out;
}

/** Utilidad para pruebas: genera relleno LFG a partir de una semilla. */
export function lfgBytes(seed: Buffer, size: number, offset: number): Buffer {
  const lfg = new LaggedFibonacci();
  lfg.setSeed(seed);
  lfg.forward(offset % BLOCK_TOTAL_SIZE);
  const out = Buffer.alloc(size);
  lfg.getBytes(size, out, 0);
  return out;
}

interface HashException {
  offset: number;
  hash: Buffer;
}

interface Group {
  offset: number;
  size: number;
  compressed: boolean;
  packedSize: number;
}

interface PartitionData {
  firstSector: number;
  sectors: number;
  groupIndex: number;
  groups: number;
}

interface Partition {
  key: Buffer;
  data: [PartitionData, PartitionData];
}

interface RawData {
  offset: number;
  size: number;
  groupIndex: number;
  groups: number;
}

type DataEntry = { end: number; partition: number; pd: number } | { end: number; raw: number };

interface ChunkData {
  data: Buffer;
  exceptions: HashException[][];
}

export class RvzReader {
  isoSize = 0;
  discType = 0;
  isRvz = true;
  private compression = Compression.None;
  private chunkSize = 0;
  private discHeader = Buffer.alloc(0x80);
  private partitions: Partition[] = [];
  private raws: RawData[] = [];
  private groups: Group[] = [];
  private entries: DataEntry[] = [];
  private chunkCache = new Map<string, ChunkData>();
  private encCache: { key: string; data: Buffer } | null = null;

  private constructor(private fd: fs.promises.FileHandle) {}

  static async open(file: string): Promise<RvzReader> {
    const fd = await fs.promises.open(file, 'r');
    const r = new RvzReader(fd);
    try {
      await r.init();
    } catch (e) {
      await fd.close();
      throw e;
    }
    return r;
  }

  async close() {
    await this.fd.close();
  }

  private async pread(pos: number, len: number): Promise<Buffer> {
    const b = Buffer.alloc(len);
    let done = 0;
    while (done < len) {
      const { bytesRead } = await this.fd.read(b, done, len - done, pos + done);
      if (!bytesRead) throw new Error('Unexpected end of RVZ file');
      done += bytesRead;
    }
    return b;
  }

  private decompress(buf: Buffer, compression: Compression, outSize: number): Buffer {
    switch (compression) {
      case Compression.None:
        return buf;
      case Compression.Zstd:
        return zlib.zstdDecompressSync(buf);
      case Compression.Purge:
        return purgeDecompress(buf, outSize);
      default:
        throw new Error(`Unsupported WIA/RVZ compression ${Compression[compression]}`);
    }
  }

  private async init() {
    const h1 = await this.pread(0, 0x48);
    const magic = h1.readUInt32BE(0);
    if (magic !== RVZ_MAGIC && magic !== WIA_MAGIC) throw new Error('Not a RVZ/WIA file');
    this.isRvz = magic === RVZ_MAGIC;
    if (!crypto.createHash('sha1').update(h1.subarray(0, 0x34)).digest().equals(h1.subarray(0x34, 0x48))) throw new Error('Bad RVZ header hash');
    const h2Size = h1.readUInt32BE(0x0c);
    this.isoSize = Number(h1.readBigUInt64BE(0x24));
    const h2 = await this.pread(0x48, h2Size);
    if (!crypto.createHash('sha1').update(h2).digest().equals(h1.subarray(0x10, 0x24))) throw new Error('Bad RVZ header 2 hash');
    this.discType = h2.readUInt32BE(0);
    this.compression = h2.readUInt32BE(4);
    this.chunkSize = h2.readUInt32BE(12);
    h2.copy(this.discHeader, 0, 16, 0x90);
    const nPart = h2.readUInt32BE(0x90);
    const partSize = h2.readUInt32BE(0x94);
    const partOff = Number(h2.readBigUInt64BE(0x98));
    const nRaw = h2.readUInt32BE(0xb4);
    const rawOff = Number(h2.readBigUInt64BE(0xb8));
    const rawSize = h2.readUInt32BE(0xc0);
    const nGroups = h2.readUInt32BE(0xc4);
    const groupOff = Number(h2.readBigUInt64BE(0xc8));
    const groupSize = h2.readUInt32BE(0xd0);
    if (this.compression === Compression.Zstd && !this.isRvz) throw new Error('Zstd in WIA');

    const parts = nPart ? await this.pread(partOff, nPart * partSize) : Buffer.alloc(0);
    for (let i = 0; i < nPart; i++) {
      const p = Buffer.alloc(0x30);
      parts.copy(p, 0, i * partSize, i * partSize + Math.min(partSize, 0x30));
      const pd = (o: number): PartitionData => ({ firstSector: p.readUInt32BE(o), sectors: p.readUInt32BE(o + 4), groupIndex: p.readUInt32BE(o + 8), groups: p.readUInt32BE(o + 12) });
      const part: Partition = { key: p.subarray(0, 16), data: [pd(0x10), pd(0x20)] };
      this.partitions.push(part);
      part.data.forEach((d, j) => {
        if (d.sectors) this.entries.push({ end: (d.firstSector + d.sectors) * BLOCK_TOTAL_SIZE, partition: i, pd: j });
      });
    }

    const rawBuf = this.decompress(await this.pread(rawOff, rawSize), this.compression, nRaw * 0x18);
    for (let i = 0; i < nRaw; i++) {
      const o = i * 0x18;
      const r = { offset: Number(rawBuf.readBigUInt64BE(o)), size: Number(rawBuf.readBigUInt64BE(o + 8)), groupIndex: rawBuf.readUInt32BE(o + 16), groups: rawBuf.readUInt32BE(o + 20) };
      this.raws.push(r);
      if (r.size) this.entries.push({ end: r.offset + r.size, raw: i });
    }

    const entrySize = this.isRvz ? 12 : 8;
    const gBuf = this.decompress(await this.pread(groupOff, groupSize), this.compression, nGroups * entrySize);
    for (let i = 0; i < nGroups; i++) {
      const o = i * entrySize;
      let size = gBuf.readUInt32BE(o + 4);
      let compressed = this.compression !== Compression.None;
      if (this.isRvz) {
        compressed = (size & 0x80000000) !== 0 && this.compression !== Compression.None;
        size &= 0x7fffffff;
      }
      this.groups.push({ offset: gBuf.readUInt32BE(o) * 4, size, compressed, packedSize: this.isRvz ? gBuf.readUInt32BE(o + 8) : 0 });
    }
    this.entries.sort((a, b) => a.end - b.end);
  }

  /** Lee y descomprime un grupo. outSize: datos esperados; exceptionLists: listas de excepciones de hash delante. */
  private async readChunk(groupIdx: number, outSize: number, exceptionLists: number, dataOffset: number): Promise<ChunkData> {
    const key = `${groupIdx}:${outSize}`;
    const cached = this.chunkCache.get(key);
    if (cached) return cached;
    const g = this.groups[groupIdx];
    if (!g) throw new Error(`Missing group ${groupIdx}`);
    let result: ChunkData;
    if (g.size === 0) {
      result = { data: Buffer.alloc(outSize), exceptions: Array.from({ length: exceptionLists }, () => []) };
    } else {
      let buf = await this.pread(g.offset, g.size);
      const compression = this.isRvz ? (g.compressed ? this.compression : Compression.None) : this.compression;
      const compressedExceptions = compression > Compression.Purge;
      const exceptions: HashException[][] = [];
      const parseLists = (b: Buffer, align: boolean) => {
        let p = 0;
        for (let l = 0; l < exceptionLists; l++) {
          const n = b.readUInt16BE(p);
          p += 2;
          const list: HashException[] = [];
          for (let k = 0; k < n; k++) {
            list.push({ offset: b.readUInt16BE(p), hash: Buffer.from(b.subarray(p + 2, p + 22)) });
            p += 22;
          }
          exceptions.push(list);
        }
        if (align && exceptionLists) p = (p + 3) & ~3;
        return p;
      };
      if (!compressedExceptions) {
        const used = parseLists(buf, true);
        buf = buf.subarray(used);
      }
      const expected = g.packedSize || outSize;
      let data = compressedExceptions ? this.decompress(buf, compression, expected) : compression === Compression.Purge ? purgeDecompress(buf, expected) : buf;
      if (compressedExceptions) data = data.subarray(parseLists(data, false));
      if (g.packedSize) data = rvzUnpack(data, outSize, dataOffset);
      if (data.length < outSize) throw new Error(`Group ${groupIdx} too short (${data.length} < ${outSize})`);
      result = { data: data.subarray(0, outSize), exceptions };
    }
    if (this.chunkCache.size > 4) this.chunkCache.delete(this.chunkCache.keys().next().value!);
    this.chunkCache.set(key, result);
    return result;
  }

  /** Lectura generica sobre una zona dividida en grupos (datos crudos o datos descifrados de particion). */
  private async readFromGroups(
    offset: number,
    size: number,
    out: Buffer,
    outOff: number,
    chunkSize: number,
    sectorSize: number,
    dataOffset: number,
    dataSize: number,
    groupIndex: number,
    groups: number,
    exceptionLists: number,
    exceptionsOut?: HashException[],
  ): Promise<number> {
    if (dataOffset + dataSize <= offset || offset < dataOffset) return 0;
    const skipped = dataOffset % sectorSize;
    dataOffset -= skipped;
    dataSize += skipped;
    let read = 0;
    let lastGroup = -1;
    for (let i = Math.floor((offset - dataOffset) / chunkSize); i < groups && size > 0; i++) {
      const groupStart = i * chunkSize;
      const thisChunk = Math.min(chunkSize, dataSize - groupStart);
      const inGroup = offset - groupStart - dataOffset;
      const n = Math.min(thisChunk - inGroup, size);
      const chunk = await this.readChunk(groupIndex + i, thisChunk, exceptionLists, groupStart);
      chunk.data.copy(out, outOff + read, inGroup, inGroup + n);
      if (exceptionsOut && lastGroup !== groupIndex + i) {
        const listIdx = Math.floor(inGroup / GROUP_DATA_SIZE);
        const extra = Math.floor((groupStart % GROUP_DATA_SIZE) / BLOCK_DATA_SIZE) * BLOCK_HEADER_SIZE;
        for (const e of chunk.exceptions[listIdx] ?? []) exceptionsOut.push({ offset: e.offset + extra, hash: e.hash });
        lastGroup = groupIndex + i;
      }
      offset += n;
      size -= n;
      read += n;
    }
    return read;
  }

  /** Datos descifrados (sin hashes) de una particion Wii. */
  private async readWiiDecrypted(p: Partition, offset: number, size: number, out: Buffer, exceptionsOut: HashException[]) {
    const first = p.data[0].firstSector;
    const chunk = (this.chunkSize * BLOCK_DATA_SIZE) / BLOCK_TOTAL_SIZE;
    const lists = Math.max(1, Math.floor(chunk / GROUP_DATA_SIZE));
    let done = 0;
    for (const d of p.data) {
      if (size - done <= 0) break;
      const dataOffset = (d.firstSector - first) * BLOCK_DATA_SIZE;
      const dataSize = d.sectors * BLOCK_DATA_SIZE;
      const n = await this.readFromGroups(offset + done, size - done, out, done, chunk, BLOCK_DATA_SIZE, dataOffset, dataSize, d.groupIndex, d.groups, lists, exceptionsOut);
      done += n;
    }
    if (done !== size) throw new Error('Wii partition read out of range');
  }

  /** Reconstruye un grupo cifrado de 2 MiB (64 bloques) de una particion Wii. */
  private async encryptedGroup(pi: number, groupNo: number): Promise<Buffer> {
    const key = `${pi}:${groupNo}`;
    if (this.encCache?.key === key) return this.encCache.data;
    const p = this.partitions[pi];
    const first = p.data[0].firstSector;
    const totalSectors = p.data[1].sectors ? p.data[1].firstSector - first + p.data[1].sectors : p.data[0].sectors;
    const decSize = totalSectors * BLOCK_DATA_SIZE;
    const decOffset = groupNo * GROUP_DATA_SIZE;
    const plain = Buffer.alloc(GROUP_DATA_SIZE);
    const readable = Math.max(0, Math.min(GROUP_DATA_SIZE, Math.floor((decSize - decOffset) / BLOCK_DATA_SIZE) * BLOCK_DATA_SIZE));
    const exceptions: HashException[] = [];
    if (readable) await this.readWiiDecrypted(p, decOffset, readable, plain, exceptions);

    // Arbol de hashes H0/H1/H2 (VolumeWii::HashGroup)
    const hashes = Buffer.alloc(GROUP_HEADER_SIZE_TOTAL);
    const sha1 = (b: Buffer) => crypto.createHash('sha1').update(b).digest();
    for (let b = 0; b < BLOCKS_PER_GROUP; b++) {
      const hb = b * BLOCK_HEADER_SIZE;
      for (let j = 0; j < 31; j++) sha1(plain.subarray(b * BLOCK_DATA_SIZE + j * 0x400, b * BLOCK_DATA_SIZE + (j + 1) * 0x400)).copy(hashes, hb + j * 20);
    }
    for (let b = 0; b < BLOCKS_PER_GROUP; b++) {
      const h1Base = b & ~7;
      sha1(hashes.subarray(b * BLOCK_HEADER_SIZE, b * BLOCK_HEADER_SIZE + 31 * 20)).copy(hashes, h1Base * BLOCK_HEADER_SIZE + 0x280 + (b - h1Base) * 20);
    }
    for (let s = 0; s < 8; s++) {
      const base = s * 8 * BLOCK_HEADER_SIZE;
      for (let j = 1; j < 8; j++) hashes.copy(hashes, base + j * BLOCK_HEADER_SIZE + 0x280, base + 0x280, base + 0x280 + 160);
      sha1(hashes.subarray(base + 0x280, base + 0x280 + 160)).copy(hashes, 0x340 + s * 20);
    }
    for (let b = 1; b < BLOCKS_PER_GROUP; b++) hashes.copy(hashes, b * BLOCK_HEADER_SIZE + 0x340, 0x340, 0x340 + 160);
    for (const e of exceptions) {
      const block = Math.floor(e.offset / BLOCK_HEADER_SIZE);
      const inBlock = e.offset % BLOCK_HEADER_SIZE;
      if (block >= BLOCKS_PER_GROUP || inBlock + 20 > BLOCK_HEADER_SIZE) throw new Error('Bad hash exception');
      e.hash.copy(hashes, block * BLOCK_HEADER_SIZE + inBlock);
    }

    // Cifrado AES-128-CBC: cabecera con IV cero, datos con IV = cabecera cifrada [0x3D0, 0x3E0)
    const out = Buffer.alloc(GROUP_TOTAL_SIZE);
    const aes = (iv: Buffer, data: Buffer) => {
      const c = crypto.createCipheriv('aes-128-cbc', p.key, iv);
      c.setAutoPadding(false);
      return Buffer.concat([c.update(data), c.final()]);
    };
    const zeroIv = Buffer.alloc(16);
    for (let b = 0; b < BLOCKS_PER_GROUP; b++) {
      const o = b * BLOCK_TOTAL_SIZE;
      const encHeader = aes(zeroIv, hashes.subarray(b * BLOCK_HEADER_SIZE, (b + 1) * BLOCK_HEADER_SIZE));
      encHeader.copy(out, o);
      aes(encHeader.subarray(0x3d0, 0x3e0), plain.subarray(b * BLOCK_DATA_SIZE, (b + 1) * BLOCK_DATA_SIZE)).copy(out, o + BLOCK_HEADER_SIZE);
    }
    this.encCache = { key, data: out };
    return out;
  }

  /** Lee bytes de la ISO reconstruida. */
  async read(offset: number, size: number): Promise<Buffer> {
    if (offset + size > this.isoSize) size = Math.max(0, this.isoSize - offset);
    const out = Buffer.alloc(size);
    let done = 0;
    if (offset < 0x80) {
      const n = Math.min(0x80 - offset, size);
      this.discHeader.copy(out, 0, offset, offset + n);
      done += n;
    }
    while (done < size) {
      const pos = offset + done;
      const entry = this.entries.find((e) => e.end > pos);
      if (!entry) throw new Error(`Offset ${pos} not covered by RVZ data`);
      if ('raw' in entry) {
        const r = this.raws[entry.raw];
        const n = await this.readFromGroups(pos, size - done, out, done, this.chunkSize, BLOCK_TOTAL_SIZE, r.offset, r.size, r.groupIndex, r.groups, 0);
        if (!n) throw new Error(`Offset ${pos} not covered by RVZ raw data`);
        done += n;
      } else {
        const p = this.partitions[entry.partition];
        const partStart = p.data[0].firstSector * BLOCK_TOTAL_SIZE;
        const rel = pos - partStart;
        const groupNo = Math.floor(rel / GROUP_TOTAL_SIZE);
        const inGroup = rel % GROUP_TOTAL_SIZE;
        const n = Math.min(GROUP_TOTAL_SIZE - inGroup, size - done, entry.end - pos);
        (await this.encryptedGroup(entry.partition, groupNo)).copy(out, done, inGroup, inGroup + n);
        done += n;
      }
    }
    return out;
  }

  /** Hashes de la ISO completa (CRC32, MD5, SHA1), leida en bloques de 2 MiB. */
  async hashIso(onProgress?: (done: number, total: number) => void) {
    let crc = 0;
    const md5 = crypto.createHash('md5');
    const sha1 = crypto.createHash('sha1');
    const step = GROUP_TOTAL_SIZE;
    for (let pos = 0; pos < this.isoSize; pos += step) {
      const b = await this.read(pos, Math.min(step, this.isoSize - pos));
      crc = zlib.crc32(b, crc);
      md5.update(b);
      sha1.update(b);
      onProgress?.(pos + b.length, this.isoSize);
    }
    return { size: this.isoSize, crc32: (crc >>> 0).toString(16).padStart(8, '0'), md5: md5.digest('hex'), sha1: sha1.digest('hex') };
  }
}

const GROUP_HEADER_SIZE_TOTAL = BLOCK_HEADER_SIZE * BLOCKS_PER_GROUP;

/** PURGE (solo WIA): segmentos {offset, size, datos} + SHA-1 final; el resto son ceros. */
function purgeDecompress(buf: Buffer, outSize: number): Buffer {
  const out = Buffer.alloc(outSize);
  let p = 0;
  const end = buf.length - 20;
  while (p + 8 <= end) {
    const off = buf.readUInt32BE(p);
    const size = buf.readUInt32BE(p + 4);
    p += 8;
    buf.copy(out, off, p, p + size);
    p += size;
  }
  return out;
}
