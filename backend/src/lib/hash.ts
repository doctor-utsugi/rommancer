import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';

export interface Hashes {
  size: number;
  crc32: string;
  md5: string;
  sha1: string;
}

export interface FileHashes extends Hashes {
  headerless?: Hashes;
}

export type HeaderType = 'nes' | 'fds' | 'snes' | 'lynx' | 'a7800' | 'none';

const hex8 = (n: number) => (n >>> 0).toString(16).padStart(8, '0');

class Hasher {
  private crc = 0;
  private md5 = crypto.createHash('md5');
  private sha1 = crypto.createHash('sha1');
  size = 0;
  update(b: Buffer) {
    if (!b.length) return;
    this.crc = zlib.crc32(b, this.crc);
    this.md5.update(b);
    this.sha1.update(b);
    this.size += b.length;
  }
  digest(): Hashes {
    return { size: this.size, crc32: hex8(this.crc), md5: this.md5.digest('hex'), sha1: this.sha1.digest('hex') };
  }
}

/**
 * Header size to skip, by system type and first bytes.
 * With headerType 'none', self-identifying headers are tried (NES, FDS, LYNX, A7800).
 */
export function detectHeader(headerType: HeaderType | string, first: Buffer, totalSize: number): number {
  const magic = (s: string, off = 0) => first.length >= off + s.length && first.toString('latin1', off, off + s.length) === s;
  if ((headerType === 'nes' || headerType === 'fds' || headerType === 'none') && (magic('NES\x1a') || magic('FDS\x1a')) && totalSize > 16)
    return 16;
  if ((headerType === 'lynx' || headerType === 'none') && magic('LYNX\0') && totalSize > 64) return 64;
  if ((headerType === 'a7800' || headerType === 'none') && magic('ATARI7800', 1) && totalSize > 128) return 128;
  // SNES copier header: 512 bytes beyond a multiple of 8 KB (same rule as rcheevos)
  if (headerType === 'snes' && totalSize % 0x2000 === 512) return 512;
  return 0;
}

/** Hashes a stream, computing the full hash and the headerless hash at once. */
export async function hashStream(stream: Readable, headerType: HeaderType | string, totalSize: number): Promise<FileHashes> {
  const full = new Hasher();
  let headerless: Hasher | null = null;
  let headerSize = -1;
  let pending: Buffer[] = [];
  let pendingLen = 0;

  const feedHeaderless = (b: Buffer, offset: number) => {
    // offset = absolute position of b within the file
    if (!headerless) return;
    const start = Math.max(0, headerSize - offset);
    if (start < b.length) headerless.update(start ? b.subarray(start) : b);
  };

  let offset = 0;
  for await (const chunk of stream) {
    const b = chunk as Buffer;
    full.update(b);
    if (headerSize < 0) {
      pending.push(b);
      pendingLen += b.length;
      if (pendingLen >= 512) {
        const first = Buffer.concat(pending);
        headerSize = detectHeader(headerType, first, totalSize);
        if (headerSize > 0) headerless = new Hasher();
        feedHeaderless(first, 0);
        offset = first.length;
        pending = [];
      }
      continue;
    }
    feedHeaderless(b, offset);
    offset += b.length;
  }
  if (headerSize < 0 && pending.length) {
    const first = Buffer.concat(pending);
    headerSize = detectHeader(headerType, first, totalSize);
    if (headerSize > 0) {
      headerless = new Hasher();
      feedHeaderless(first, 0);
    }
  }
  const res: FileHashes = full.digest();
  if (headerless) res.headerless = headerless.digest();
  return res;
}

export async function hashFile(file: string, headerType: HeaderType | string = 'none'): Promise<FileHashes> {
  const st = await fs.promises.stat(file);
  return hashStream(fs.createReadStream(file, { highWaterMark: 1 << 20 }), headerType, st.size);
}

export function md5Of(b: Buffer | string): string {
  return crypto.createHash('md5').update(b).digest('hex');
}

export async function sha1File(file: string): Promise<string> {
  const h = crypto.createHash('sha1');
  for await (const c of fs.createReadStream(file)) h.update(c as Buffer);
  return h.digest('hex');
}
