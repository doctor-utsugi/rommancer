/**
 * PlayStation memory card filesystem (128 KB: 16 blocks of 8 KB, block 0 holds the header and directory).
 * Every save on a card is an entry: one directory frame per block it uses, chained by "next block" pointers.
 * An entry travels as a .mcs file (its first directory frame + its data blocks), the single-save format
 * MemcardRex and DuckStation use. Layout per psx-spx and DuckStation's memory_card_image.cpp.
 */
import crypto from 'node:crypto';

export const CARD_SIZE = 0x20000;
const FRAME = 128;
const BLOCK = 0x2000;
const BLOCKS = 15;

const FIRST = 0x51;
const MIDDLE = 0x52;
const LAST = 0x53;
const FREE = 0xa0;
const NONE = 0xffff;

export class CardError extends Error {}

export interface Ps1Entry {
  /** Name in the card's directory ("BASCUS-94163FF7-S01"): region, product code and the game's own suffix */
  name: string;
  /** Product code inside the name ("SCUS-94163"), to tell its game */
  productCode: string | null;
  /** The title the game wrote for the memory card screen */
  title: string | null;
  blocks: number;
  /** The entry as a .mcs file: its directory frame (canonical) + data blocks; identical on every card */
  mcs: Buffer;
  sha1: string;
}

export interface Ps1Card {
  entries: Ps1Entry[];
  freeBlocks: number;
  /** Why the card must not be written (broken chains, stray blocks): its entries are still read when they are whole */
  problems: string[];
}

const dirOffset = (block: number) => (block + 1) * FRAME;
const blockOffset = (block: number) => (block + 1) * BLOCK;
const xor = (buf: Buffer, start: number) => {
  let c = 0;
  for (let i = 0; i < FRAME - 1; i++) c ^= buf[start + i];
  return c;
};
const seal = (buf: Buffer, start: number) => {
  buf[start + FRAME - 1] = xor(buf, start);
};

const sha1 = (b: Buffer) => crypto.createHash('sha1').update(b).digest('hex');

function readName(buf: Buffer, start: number) {
  const raw = buf.subarray(start + 0x0a, start + 0x1f);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? raw.length : end).toString('latin1');
}

/** "BASLUS-00067DRACULA" -> "SLUS-00067"; null for names that carry no product code (homebrew) */
export function productCodeOf(name: string): string | null {
  const m = /^B[A-Z]([A-Z]{4})[-_ ]?(\d{3})\.?(\d{2})/.exec(name);
  return m ? `${m[1]}-${m[2]}${m[3]}` : null;
}

let sjis: TextDecoder | null | undefined;
/** The save's title (Shift-JIS, often full-width) as plain text */
function readTitle(block: Buffer): string | null {
  if (block[0] !== 0x53 || block[1] !== 0x43) return null;
  const raw = block.subarray(4, 0x44);
  const end = raw.indexOf(0);
  const bytes = raw.subarray(0, end < 0 ? raw.length : end);
  if (sjis === undefined) {
    try {
      sjis = new TextDecoder('shift_jis');
    } catch {
      sjis = null;
    }
  }
  const text = sjis ? sjis.decode(bytes) : bytes.toString('latin1');
  const clean = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return clean || null;
}

function frameFor(name: string, state: number, size: number, next: number) {
  const f = Buffer.alloc(FRAME);
  f.writeUInt32LE(state, 0);
  f.writeUInt32LE(size, 4);
  f.writeUInt16LE(next, 8);
  if (name) f.write(name.slice(0, 20), 0x0a, 'latin1');
  seal(f, 0);
  return f;
}

function freeFrame() {
  return frameFor('', FREE, 0, NONE);
}

export function isPs1Card(buf: Buffer) {
  return buf.length === CARD_SIZE && buf[0] === 0x4d && buf[1] === 0x43;
}

/** A new, empty card, as DuckStation formats it */
export function formatPs1Card(): Buffer {
  const card = Buffer.alloc(CARD_SIZE, 0xff);
  card.fill(0, 0, FRAME);
  card[0] = 0x4d;
  card[1] = 0x43;
  seal(card, 0);
  for (let b = 0; b < BLOCKS; b++) freeFrame().copy(card, dirOffset(b));
  for (let f = 16; f < 36; f++) {
    const at = f * FRAME;
    card.fill(0, at, at + FRAME);
    card.writeUInt32LE(0xffffffff, at);
    card.writeUInt16LE(NONE, at + 8);
    seal(card, at);
  }
  card.copy(card, 63 * FRAME, 0, FRAME);
  return card;
}

/** Reads a card's directory; entries with a broken chain are left out and the card is marked unsafe */
export function readPs1Card(card: Buffer): Ps1Card {
  if (!isPs1Card(card)) throw new CardError('Not a PlayStation memory card');
  const problems: string[] = [];
  const owner = new Array<number>(BLOCKS).fill(-1);
  const entries: Ps1Entry[] = [];
  let free = 0;
  for (let b = 0; b < BLOCKS; b++) {
    const state = card[dirOffset(b)];
    if (state === FREE || (state >= 0xa1 && state <= 0xa3)) free++;
  }
  for (let b = 0; b < BLOCKS; b++) {
    const at = dirOffset(b);
    if (card.readUInt32LE(at) !== FIRST) continue;
    const name = readName(card, at);
    const chain: number[] = [];
    let cur = b;
    let ok = true;
    while (true) {
      if (cur < 0 || cur >= BLOCKS || owner[cur] !== -1 || chain.length >= BLOCKS) {
        ok = false;
        break;
      }
      const state = card.readUInt32LE(dirOffset(cur));
      if (chain.length > 0 && state !== MIDDLE && state !== LAST) {
        ok = false;
        break;
      }
      owner[cur] = b;
      chain.push(cur);
      const next = card.readUInt16LE(dirOffset(cur) + 8);
      if (next === NONE) {
        if (chain.length > 1 && state !== LAST) ok = false;
        break;
      }
      if (state === LAST) {
        ok = false;
        break;
      }
      cur = next;
    }
    const size = card.readUInt32LE(at + 4);
    if (ok && size !== 0 && size !== chain.length * BLOCK) ok = false;
    if (!ok || !name) {
      problems.push(`broken entry in block ${b + 1}${name ? ` (${name})` : ''}`);
      continue;
    }
    const data = Buffer.concat(chain.map((c) => card.subarray(blockOffset(c), blockOffset(c) + BLOCK)));
    const mcs = Buffer.concat([frameFor(name, FIRST, chain.length * BLOCK, NONE), data]);
    entries.push({ name, productCode: productCodeOf(name), title: readTitle(data), blocks: chain.length, mcs, sha1: sha1(mcs) });
  }
  for (let b = 0; b < BLOCKS; b++) {
    const state = card[dirOffset(b)];
    if ((state === MIDDLE || state === LAST) && owner[b] === -1) problems.push(`stray block ${b + 1}`);
  }
  const names = new Set<string>();
  for (const e of entries) {
    if (names.has(e.name)) problems.push(`duplicate entry ${e.name}`);
    names.add(e.name);
  }
  return { entries, freeBlocks: free, problems };
}

/** An entry from its .mcs file (also accepts a bare directory frame + data written by other tools) */
export function readMcs(mcs: Buffer): Ps1Entry {
  if (mcs.length < FRAME + BLOCK || (mcs.length - FRAME) % BLOCK !== 0) throw new CardError('Not a PlayStation single save (.mcs)');
  const blocks = (mcs.length - FRAME) / BLOCK;
  if (blocks > BLOCKS) throw new CardError('Save larger than a memory card');
  const name = readName(mcs, 0);
  if (!name) throw new CardError('Save without a name');
  const data = mcs.subarray(FRAME);
  const canonical = Buffer.concat([frameFor(name, FIRST, blocks * BLOCK, NONE), data]);
  return { name, productCode: productCodeOf(name), title: readTitle(data), blocks, mcs: canonical, sha1: sha1(canonical) };
}

/**
 * The card with entries put in (replacing those of the same name) and others taken out. Blocks of entries
 * not named stay exactly where they were. Returns the names that did not fit, which are left out.
 */
export function writePs1Card(card: Buffer, put: Ps1Entry[], remove: string[] = []): { card: Buffer; skipped: string[] } {
  const current = readPs1Card(card);
  if (current.problems.length) throw new CardError(`Card not safe to write: ${current.problems.join(', ')}`);
  const out = Buffer.from(card);
  const drop = new Set([...remove, ...put.map((e) => e.name)]);
  for (let b = 0; b < BLOCKS; b++) {
    const at = dirOffset(b);
    const state = out.readUInt32LE(at);
    if (state !== FIRST || !drop.has(readName(out, at))) continue;
    let cur = b;
    for (let n = 0; n < BLOCKS && cur !== NONE && cur < BLOCKS; n++) {
      const next = out.readUInt16LE(dirOffset(cur) + 8);
      freeFrame().copy(out, dirOffset(cur));
      cur = next;
    }
  }
  const freeList = () => Array.from({ length: BLOCKS }, (_, b) => b).filter((b) => out[dirOffset(b)] === FREE || (out[dirOffset(b)] >= 0xa1 && out[dirOffset(b)] <= 0xa3));
  const skipped: string[] = [];
  for (const e of put) {
    const free = freeList();
    if (free.length < e.blocks) {
      skipped.push(e.name);
      continue;
    }
    const use = free.slice(0, e.blocks);
    use.forEach((blk, i) => {
      const last = i === use.length - 1;
      const state = i === 0 ? FIRST : last ? LAST : MIDDLE;
      frameFor(i === 0 ? e.name : '', state, i === 0 ? e.blocks * BLOCK : 0, last ? NONE : use[i + 1]).copy(out, dirOffset(blk));
      e.mcs.copy(out, blockOffset(blk), FRAME + i * BLOCK, FRAME + (i + 1) * BLOCK);
    });
  }
  // Whatever went in must read back the same before the card leaves the server
  const check = readPs1Card(out);
  if (check.problems.length) throw new CardError(`Card came out broken: ${check.problems.join(', ')}`);
  const got = new Map(check.entries.map((e) => [e.name, e.sha1]));
  for (const e of put) if (!skipped.includes(e.name) && got.get(e.name) !== e.sha1) throw new CardError(`Entry ${e.name} did not read back`);
  return { card: out, skipped };
}
