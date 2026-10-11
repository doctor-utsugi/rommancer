/**
 * GameCube memory cards. A card image (Dolphin's MemoryCardA.USA.raw) holds a header block, two directory and
 * two block allocation tables (the one with the higher update counter is in use) and then data blocks of 8 KB.
 * Every save on it is an entry: a 64-byte directory entry plus its blocks, chained through the allocation table.
 * An entry travels as a .gci file (directory entry + data), the format Dolphin keeps one file per save in when
 * a slot is a "GCI folder". Layout and rules as in Dolphin's GCMemcard.cpp and GCMemcardUtils.cpp.
 *
 * Entries are kept in a canonical form so the same save reads the same from any card: no block position, no
 * copy counter, and the card serial PSO and F-Zero GX tie their system file to (with its checksum) blanked.
 * Dolphin signs those again when it loads a .gci; written into an image they are signed for that card.
 */
import crypto from 'node:crypto';
import { CardError } from './ps1card.js';

export const GC_BLOCK = 0x2000;
const DENTRY = 0x40;
const FST_BLOCKS = 5;
const DIRLEN = 0x7f;
const MBIT_TO_BLOCKS = (1024 * 1024) / (GC_BLOCK * 8);
const CARD_MBITS = [4, 8, 16, 32, 64, 128];
const NONE = 0xffff;

export interface GcEntry {
  /** "01-GALE-SuperSmashBros0110290334": maker, game code and the file name inside the card, as Dolphin names its .gci */
  name: string;
  /** "GALE": the disc's game id without its maker, to tell its game */
  gameCode: string;
  /** The two comments the game wrote for the memory card screen */
  title: string | null;
  blocks: number;
  /** The entry as a canonical .gci file */
  gci: Buffer;
  sha1: string;
}

export interface GcCard {
  entries: GcEntry[];
  freeBlocks: number;
  /** Why the card must not be written; entries that read whole are still listed */
  problems: string[];
  shiftJis: boolean;
}

const sha1 = (b: Buffer) => crypto.createHash('sha1').update(b).digest('hex');

/** Additive and inverse checksums over big-endian 16-bit words (0xFFFF is stored as 0) */
function checksums(buf: Buffer, start: number, end: number): [number, number] {
  let sum = 0;
  let inv = 0;
  for (let i = start; i < end; i += 2) {
    const d = buf.readUInt16BE(i);
    sum = (sum + d) & 0xffff;
    inv = (inv + (d ^ 0xffff)) & 0xffff;
  }
  return [sum === 0xffff ? 0 : sum, inv === 0xffff ? 0 : inv];
}

// Checksummed areas and where the sums go, per block kind (offsets inside the block)
const HEADER_SUM = { start: 0, end: 0x1fc, at: 0x1fc };
const DIR_SUM = { start: 0, end: 0x1ffc, at: 0x1ffc };
const BAT_SUM = { start: 4, end: GC_BLOCK, at: 0 };

function sumsOk(block: Buffer, s: { start: number; end: number; at: number }) {
  const [a, b] = checksums(block, s.start, s.end);
  return block.readUInt16BE(s.at) === a && block.readUInt16BE(s.at + 2) === b;
}
function seal(block: Buffer, s: { start: number; end: number; at: number }) {
  const [a, b] = checksums(block, s.start, s.end);
  block.writeUInt16BE(a, s.at);
  block.writeUInt16BE(b, s.at + 2);
}

const dirCounter = (dir: Buffer) => dir.readInt16BE(0x1ffa);
const batCounter = (bat: Buffer) => bat.readInt16BE(4);
const batFree = (bat: Buffer) => bat.readUInt16BE(6);
/** Next block after BLOCK in the chain: 0xFFFF ends it, 0 is a free block */
const batNext = (bat: Buffer, block: number) => (block < FST_BLOCKS || block > 4091 ? 0 : bat.readUInt16BE(0x0a + (block - FST_BLOCKS) * 2));
const batSet = (bat: Buffer, block: number, next: number) => bat.writeUInt16BE(next, 0x0a + (block - FST_BLOCKS) * 2);

function cString(b: Buffer) {
  const end = b.indexOf(0);
  return (end < 0 ? b : b.subarray(0, end)).toString('latin1');
}

/** The identity of an entry: maker, game code and file name up to its first null (as the BIOS and Dolphin compare) */
export function gcEntryName(dentry: Buffer) {
  const clean = (s: string) => s.replace(/[\x00-\x1f/\\]/g, '_');
  return `${clean(cString(dentry.subarray(4, 6)))}-${clean(cString(dentry.subarray(0, 4)))}-${clean(cString(dentry.subarray(8, 0x28)))}`;
}

/** Game code region letter: which of Dolphin's per-region folders (USA, EUR, JAP) a save belongs in; null for any */
export function gcRegion(gameCode: string): 'USA' | 'EUR' | 'JAP' | null {
  const r = gameCode[3];
  if (r === 'E') return 'USA';
  if (r === 'J') return 'JAP';
  if (r && 'PDFSIXYHUVLMRA'.includes(r)) return 'EUR';
  return null;
}

let sjis: TextDecoder | null | undefined;
function decode(b: Buffer, shiftJis: boolean) {
  if (shiftJis) {
    if (sjis === undefined) {
      try {
        sjis = new TextDecoder('shift_jis');
      } catch {
        sjis = null;
      }
    }
    if (sjis) return sjis.decode(b);
  }
  return b.toString('latin1');
}

function titleOf(dentry: Buffer, data: Buffer, shiftJis: boolean) {
  const at = dentry.readUInt32BE(0x3c);
  if (at === 0xffffffff || at + 0x40 > data.length) return null;
  const parts = [data.subarray(at, at + 0x20), data.subarray(at + 0x20, at + 0x40)].map((p) => {
    const end = p.indexOf(0);
    return decode(end < 0 ? p : p.subarray(0, end), shiftJis).normalize('NFKC').replace(/\s+/g, ' ').trim();
  });
  const text = parts.filter(Boolean).join(' · ');
  return text || null;
}

/** Files signed with the card's serial: the blocks and offsets of the serial and checksum fields, per name */
function signedFile(dentry: Buffer, blocks: number): 'fzero' | 'pso' | 'pso3' | null {
  const file = cString(dentry.subarray(8, 0x28));
  if (file === 'f_zero.dat' && blocks === 4) return 'fzero';
  if (file === 'PSO_SYSTEM' && blocks >= 2) return 'pso';
  if (file === 'PSO3_SYSTEM' && blocks >= 2) return 'pso3';
  return null;
}

/** Blanks the card serial and its checksum in a signed system file (data starts after the directory entry) */
function unsign(gci: Buffer) {
  const kind = signedFile(gci, (gci.length - DENTRY) / GC_BLOCK);
  const d = (block: number, off: number) => DENTRY + block * GC_BLOCK + off;
  if (kind === 'fzero') {
    for (const [b, o] of [
      [1, 0x66],
      [3, 0x1580],
      [1, 0x60],
      [1, 0x200],
      [0, 0x00],
    ])
      gci.writeUInt16BE(0, d(b, o));
  } else if (kind) {
    gci.fill(0, d(1, 0x158), d(1, 0x160));
    gci.writeUInt32BE(0, d(1, 0x48));
  }
}

/** The two card serial words games sign with: the first 32 bytes of the header XORed in 8-byte steps */
function cardSerial(header: Buffer): [number, number] {
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < 32; i += 8) {
    s1 = (s1 ^ header.readUInt32LE(i)) >>> 0;
    s2 = (s2 ^ header.readUInt32LE(i + 4)) >>> 0;
  }
  return [s1, s2];
}

let crcTable: Uint32Array | null = null;

/** Signs a system file for the card whose header is given (Dolphin's FZEROGX_ and PSO_MakeSaveGameValid) */
function sign(dentry: Buffer, data: Buffer, header: Buffer) {
  const kind = signedFile(dentry, data.length / GC_BLOCK);
  if (!kind) return;
  const [s1, s2] = cardSerial(header);
  const at = (block: number, off: number) => block * GC_BLOCK + off;
  // The serial words as Dolphin holds them: little-endian reads of the header, swapped back to big-endian
  const be1 = Buffer.alloc(4);
  be1.writeUInt32LE(s1);
  const be2 = Buffer.alloc(4);
  be2.writeUInt32LE(s2);
  if (kind === 'fzero') {
    const w1 = be1.readUInt32BE(0);
    const w2 = be2.readUInt32BE(0);
    data.writeUInt16BE(w1 >>> 16, at(1, 0x66));
    data.writeUInt16BE(w2 >>> 16, at(3, 0x1580));
    data.writeUInt16BE(w1 & 0xffff, at(1, 0x60));
    data.writeUInt16BE(w2 & 0xffff, at(1, 0x200));
    let sum = 0xffff;
    for (let i = 2; i < 0x8000; i++) {
      sum ^= data[i];
      for (let j = 0; j < 8; j++) sum = sum & 1 ? (sum >>> 1) ^ 0x8408 : sum >>> 1;
    }
    data.writeUInt16BE(~sum & 0xffff, at(0, 0));
    return;
  }
  be1.copy(data, at(1, 0x158));
  be2.copy(data, at(1, 0x15c));
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let crc = 0xdebb20e3;
  const end = 0x164 + (kind === 'pso3' ? 0x10 : 0);
  for (let i = 0x4c; i < end; i++) crc = ((crc >>> 8) ^ crcTable[(crc ^ data[at(1, i)]) & 0xff]) >>> 0;
  data.writeUInt32BE((crc ^ 0xffffffff) >>> 0, at(1, 0x48));
}

/** An entry from its directory entry and data, in canonical form */
function entryOf(dentry: Buffer, data: Buffer, shiftJis: boolean): GcEntry {
  const gci = Buffer.concat([dentry, data]);
  gci.writeUInt16BE(NONE, 0x36);
  gci[0x35] = 0;
  gci.writeUInt16BE(data.length / GC_BLOCK, 0x38);
  unsign(gci);
  const gameCode = cString(dentry.subarray(0, 4));
  return { name: gcEntryName(dentry), gameCode, title: titleOf(dentry, data, shiftJis || gcRegion(gameCode) === 'JAP'), blocks: data.length / GC_BLOCK, gci, sha1: sha1(gci) };
}

/** A .gci file (Dolphin), or a .gcs (GameShark) or .sav (MaxDrive) export, told apart by their header size */
export function readGci(file: Buffer): GcEntry {
  const head = file.length % GC_BLOCK;
  let dentry: Buffer;
  let data: Buffer;
  if (head === DENTRY) {
    dentry = Buffer.from(file.subarray(0, DENTRY));
    data = file.subarray(DENTRY);
    if (dentry.readUInt16BE(0x38) !== data.length / GC_BLOCK) throw new CardError('GameCube save with a wrong block count');
  } else if (head === 0x150 && file.subarray(0, 6).toString('latin1') === 'GCSAVE') {
    // GameShark stores the block count as 1: the size tells it
    dentry = Buffer.from(file.subarray(0x110, 0x110 + DENTRY));
    data = file.subarray(0x150);
  } else if (head === 0xc0 && file.subarray(0, 12).toString('latin1') === 'DATELGC_SAVE') {
    // MaxDrive swaps the bytes of most fields
    dentry = Buffer.from(file.subarray(0x80, 0x80 + DENTRY));
    for (const p of [0x06, 0x2c, 0x2e, 0x30, 0x32, 0x34, 0x36, 0x38, 0x3a, 0x3c, 0x3e]) [dentry[p], dentry[p + 1]] = [dentry[p + 1], dentry[p]];
    data = file.subarray(0xc0);
    if (dentry.readUInt16BE(0x38) !== data.length / GC_BLOCK) throw new CardError('GameCube save with a wrong block count');
  } else throw new CardError('Not a GameCube save (.gci, .gcs or .sav)');
  if (!data.length || data.length / GC_BLOCK > 2043) throw new CardError('GameCube save of no or too many blocks');
  if (dentry.readUInt32BE(0) === 0xffffffff) throw new CardError('GameCube save without a game code');
  return entryOf(dentry, Buffer.from(data), false);
}

/** An entry as a GameShark .gcs or MaxDrive .sav file, for other tools */
export function gciTo(entry: GcEntry, format: 'gci' | 'gcs' | 'sav'): Buffer {
  if (format === 'gci') return entry.gci;
  const dentry = Buffer.from(entry.gci.subarray(0, DENTRY));
  const data = entry.gci.subarray(DENTRY);
  if (format === 'gcs') {
    const head = Buffer.alloc(0x150);
    head.write('GCSAVE', 0, 'latin1');
    dentry.writeUInt16BE(1, 0x38);
    dentry.copy(head, 0x110);
    return Buffer.concat([head, data]);
  }
  const head = Buffer.alloc(0xc0);
  head.write('DATELGC_SAVE', 0, 'latin1');
  for (const p of [0x06, 0x2c, 0x2e, 0x30, 0x32, 0x34, 0x36, 0x38, 0x3a, 0x3c, 0x3e]) [dentry[p], dentry[p + 1]] = [dentry[p + 1], dentry[p]];
  dentry.copy(head, 0x80);
  return Buffer.concat([head, data]);
}

export function isGcCard(buf: Buffer) {
  return buf.length >= GC_BLOCK * FST_BLOCKS && CARD_MBITS.includes((buf.length * 8) / (1024 * 1024));
}

interface Layout {
  mbits: number;
  blocks: number;
  header: Buffer;
  dir: Buffer;
  bat: Buffer;
  /** Which of the two copies is in use */
  dirAt: 1 | 2;
  batAt: 3 | 4;
  problems: string[];
}

function layoutOf(card: Buffer): Layout {
  if (!isGcCard(card)) throw new CardError('Not a GameCube memory card');
  const mbits = (card.length * 8) / (1024 * 1024);
  const blk = (i: number) => card.subarray(i * GC_BLOCK, (i + 1) * GC_BLOCK);
  const header = blk(0);
  const problems: string[] = [];
  if (!sumsOk(header, HEADER_SUM)) throw new CardError('GameCube card header is damaged');
  if (header.readUInt16BE(0x22) !== mbits) problems.push('card size does not match its header');
  const dirOk = [sumsOk(blk(1), DIR_SUM), sumsOk(blk(2), DIR_SUM)];
  const batOk = [sumsOk(blk(3), BAT_SUM), sumsOk(blk(4), BAT_SUM)];
  const broken = [...dirOk, ...batOk].filter((ok) => !ok).length;
  if (broken > 1) throw new CardError('GameCube card directory is damaged');
  // One damaged copy: the other is used, as the BIOS does, but the card is not written
  if (broken === 1) problems.push('one of the card tables is damaged');
  const dirAt: 1 | 2 = !dirOk[1] || (dirOk[0] && dirCounter(blk(1)) >= dirCounter(blk(2))) ? 1 : 2;
  const batAt: 3 | 4 = !batOk[1] || (batOk[0] && batCounter(blk(3)) >= batCounter(blk(4))) ? 3 : 4;
  return { mbits, blocks: mbits * MBIT_TO_BLOCKS, header, dir: blk(dirAt), bat: blk(batAt), dirAt, batAt, problems };
}

/** The blocks of the entry at directory slot I, following the allocation table; null when the chain is broken */
function chainOf(dir: Buffer, bat: Buffer, i: number, total: number): number[] | null {
  const d = dir.subarray(i * DENTRY, (i + 1) * DENTRY);
  const count = d.readUInt16BE(0x38);
  const chain: number[] = [];
  let cur = d.readUInt16BE(0x36);
  for (let n = 0; n < count; n++) {
    if (cur < FST_BLOCKS || cur >= total || chain.includes(cur)) return null;
    chain.push(cur);
    const next = batNext(bat, cur);
    if (next === 0) return null;
    if (next === NONE) return n === count - 1 ? chain : null;
    cur = next;
  }
  return null;
}

export function readGcCard(card: Buffer): GcCard {
  const l = layoutOf(card);
  const shiftJis = l.header.readUInt16BE(0x24) !== 0;
  const entries: GcEntry[] = [];
  const problems = [...l.problems];
  let used = 0;
  for (let b = FST_BLOCKS; b < l.blocks; b++) if (batNext(l.bat, b) !== 0) used++;
  const free = l.blocks - FST_BLOCKS - used;
  if (free !== batFree(l.bat)) problems.push('free block count does not match the table');
  const names = new Set<string>();
  for (let i = 0; i < DIRLEN; i++) {
    const d = l.dir.subarray(i * DENTRY, (i + 1) * DENTRY);
    if (d.readUInt32BE(0) === 0xffffffff) continue;
    const chain = chainOf(l.dir, l.bat, i, l.blocks);
    const name = gcEntryName(d);
    if (!chain) {
      problems.push(`broken entry ${name}`);
      continue;
    }
    if (names.has(name)) problems.push(`duplicate entry ${name}`);
    names.add(name);
    const data = Buffer.concat(chain.map((c) => card.subarray(c * GC_BLOCK, (c + 1) * GC_BLOCK)));
    entries.push(entryOf(Buffer.from(d), data, shiftJis));
  }
  return { entries, freeBlocks: batFree(l.bat), problems, shiftJis };
}

/**
 * The card with entries put in (replacing those of the same name) and others taken out. Other entries keep their
 * blocks; the updated tables go into the copies not in use, with a higher update counter, as the BIOS writes them.
 * An entry that does not fit (blocks or directory slots) is left out and the card keeps the version it has.
 */
export function writeGcCard(card: Buffer, put: GcEntry[], remove: string[] = []): { card: Buffer; skipped: string[] } {
  const current = readGcCard(card);
  if (current.problems.length) throw new CardError(`Card not safe to write: ${current.problems.join(', ')}`);
  const out = Buffer.from(card);
  const l = layoutOf(out);
  const dir = Buffer.from(l.dir);
  const bat = Buffer.from(l.bat);
  const slotOf = (name: string) => {
    for (let i = 0; i < DIRLEN; i++) if (dir.readUInt32BE(i * DENTRY) !== 0xffffffff && gcEntryName(dir.subarray(i * DENTRY, (i + 1) * DENTRY)) === name) return i;
    return -1;
  };
  const release = (i: number) => {
    const chain = chainOf(dir, bat, i, l.blocks) ?? [];
    for (const b of chain) batSet(bat, b, 0);
    bat.writeUInt16BE(batFree(bat) + chain.length, 6);
    dir.fill(0xff, i * DENTRY, (i + 1) * DENTRY);
  };
  for (const name of remove) {
    const i = slotOf(name);
    if (i >= 0) release(i);
  }
  const skipped: string[] = [];
  for (const e of put) {
    const old = slotOf(e.name);
    const oldBlocks = old >= 0 ? dir.readUInt16BE(old * DENTRY + 0x38) : 0;
    const slot = old >= 0 ? old : Array.from({ length: DIRLEN }, (_, i) => i).find((i) => dir.readUInt32BE(i * DENTRY) === 0xffffffff);
    if (slot === undefined || batFree(bat) + oldBlocks < e.blocks) {
      skipped.push(e.name);
      continue;
    }
    if (old >= 0) release(old);
    // Free blocks from just after the last one allocated, wrapping round, as Dolphin imports
    const last = bat.readUInt16BE(8);
    const order = Array.from({ length: l.blocks - FST_BLOCKS }, (_, i) => i + FST_BLOCKS).sort((a, b) => ((a - last - 1 + l.blocks) % l.blocks) - ((b - last - 1 + l.blocks) % l.blocks));
    const use = order.filter((b) => batNext(bat, b) === 0).slice(0, e.blocks);
    const dentry = Buffer.from(e.gci.subarray(0, DENTRY));
    const data = Buffer.from(e.gci.subarray(DENTRY));
    sign(dentry, data, l.header);
    use.forEach((b, i) => {
      data.copy(out, b * GC_BLOCK, i * GC_BLOCK, (i + 1) * GC_BLOCK);
      batSet(bat, b, i === use.length - 1 ? NONE : use[i + 1]);
    });
    bat.writeUInt16BE(use[use.length - 1], 8);
    bat.writeUInt16BE(batFree(bat) - e.blocks, 6);
    dentry.writeUInt16BE(use[0], 0x36);
    dentry.copy(dir, slot * DENTRY);
  }
  dir.writeInt16BE((dirCounter(dir) + 1) << 16 >> 16, 0x1ffa);
  bat.writeInt16BE((batCounter(bat) + 1) << 16 >> 16, 4);
  seal(dir, DIR_SUM);
  seal(bat, BAT_SUM);
  dir.copy(out, (l.dirAt === 1 ? 2 : 1) * GC_BLOCK);
  bat.copy(out, (l.batAt === 3 ? 4 : 3) * GC_BLOCK);
  // Whatever went in must read back the same, and every other entry must still be there unchanged
  const check = readGcCard(out);
  if (check.problems.length) throw new CardError(`Card came out broken: ${check.problems.join(', ')}`);
  const got = new Map(check.entries.map((e) => [e.name, e.sha1]));
  for (const e of put) if (!skipped.includes(e.name) && got.get(e.name) !== e.sha1) throw new CardError(`Entry ${e.name} did not read back`);
  const written = new Set([...remove, ...put.filter((e) => !skipped.includes(e.name)).map((e) => e.name)]);
  for (const e of current.entries) if (!written.has(e.name) && got.get(e.name) !== e.sha1) throw new CardError(`Entry ${e.name} changed`);
  return { card: out, skipped };
}

/** A blank card of MBITS megabits (59 blocks at 4), formatted as Dolphin does with a fixed flash id of zeros */
export function formatGcCard(mbits = 4, formatTime = 0n): Buffer {
  const card = Buffer.alloc((mbits * 1024 * 1024) / 8, 0);
  const header = card.subarray(0, GC_BLOCK);
  header.fill(0xff);
  let rand = formatTime;
  for (let i = 0; i < 12; i++) {
    // u64 arithmetic, as Dolphin's: the product wraps before the shift
    const step = (r: bigint) => ((r * 0x41c64e6dn + 0x3039n) & 0xffffffffffffffffn) >> 16n;
    rand = step(rand);
    header[i] = Number(rand & 0xffn);
    rand = step(rand) & 0x7fffn;
  }
  header.writeBigUInt64BE(formatTime, 0x0c);
  header.writeUInt32BE(0, 0x14);
  header.writeUInt32BE(0, 0x18);
  header.writeUInt32BE(0, 0x1c);
  header.writeUInt16BE(0, 0x20);
  header.writeUInt16BE(mbits, 0x22);
  header.writeUInt16BE(0, 0x24);
  seal(header, HEADER_SUM);
  const dir = Buffer.alloc(GC_BLOCK, 0xff);
  dir.writeInt16BE(0, 0x1ffa);
  seal(dir, DIR_SUM);
  const bat = Buffer.alloc(GC_BLOCK, 0);
  bat.writeUInt16BE(mbits * MBIT_TO_BLOCKS - FST_BLOCKS, 6);
  bat.writeUInt16BE(4, 8);
  seal(bat, BAT_SUM);
  dir.copy(card, GC_BLOCK);
  dir.copy(card, 2 * GC_BLOCK);
  bat.copy(card, 3 * GC_BLOCK);
  bat.copy(card, 4 * GC_BLOCK);
  card.fill(0xff, FST_BLOCKS * GC_BLOCK);
  return card;
}
