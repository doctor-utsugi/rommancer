/**
 * PlayStation 2 memory card filesystem (PCSX2's .ps2 files, AetherSX2/NetherSX2 alike): 8 MB of 512-byte pages,
 * each followed by 16 bytes of ECC in images that keep it, grouped in 1 KB clusters chained by a FAT reached through
 * an indirect FAT. Every save is a directory in the root holding plain files; an entry travels as a .psu file (its
 * directory entry, "." and "..", then each file's entry and data padded to 1 KB), the form uLaunchELF and mymc use.
 * Layout per mymc (ps2mc.py, ps2mc_dir.py, ps2mc_ecc.py).
 */
import crypto from 'node:crypto';

const MAGIC = 'Sony PS2 Memory Card Format ';
const PAGE = 512;
const CLUSTER = 1024;
const DIRENT = 512;
/** FAT entries per cluster */
const EPC = CLUSTER / 4;
const ALLOCATED = 0x80000000;
const CHAIN_END = 0xffffffff;

const DF_WRITE = 0x0002;
const DF_EXECUTE = 0x0004;
const DF_RWX = 0x0007;
const DF_FILE = 0x0010;
const DF_DIR = 0x0020;
const DF_0400 = 0x0400;
const DF_HIDDEN = 0x2000;
const DF_EXISTS = 0x8000;

export class Ps2CardError extends Error {}

export interface Ps2Entry {
  /** The save's directory name ("BASLUS-20312GTA3"): region, product code and the game's own suffix */
  name: string;
  /** Product code inside the name ("SLUS-20312"), to tell its game */
  productCode: string | null;
  /** The title the game wrote in its icon.sys */
  title: string | null;
  /** Clusters it takes on a card, its directory included */
  blocks: number;
  /** The entry as a .psu file, identical on every card */
  psu: Buffer;
  sha1: string;
}

export interface Ps2Card {
  entries: Ps2Entry[];
  freeBlocks: number;
  problems: string[];
}

interface Dirent {
  mode: number;
  length: number;
  created: Buffer;
  cluster: number;
  parent: number;
  modified: Buffer;
  attr: number;
  name: string;
}

function readDirent(b: Buffer): Dirent {
  const raw = b.subarray(0x40, 0x40 + 32);
  const end = raw.indexOf(0);
  return {
    mode: b.readUInt16LE(0),
    length: b.readUInt32LE(4),
    created: Buffer.from(b.subarray(8, 16)),
    cluster: b.readUInt32LE(0x10),
    parent: b.readUInt32LE(0x14),
    modified: Buffer.from(b.subarray(0x18, 0x20)),
    attr: b.readUInt32LE(0x20),
    name: raw.subarray(0, end < 0 ? 32 : end).toString('latin1'),
  };
}

function writeDirent(e: Dirent): Buffer {
  const b = Buffer.alloc(DIRENT);
  b.writeUInt16LE(e.mode, 0);
  b.writeUInt32LE(e.length >>> 0, 4);
  e.created.copy(b, 8);
  b.writeUInt32LE(e.cluster >>> 0, 0x10);
  b.writeUInt32LE(e.parent >>> 0, 0x14);
  e.modified.copy(b, 0x18);
  b.writeUInt32LE(e.attr >>> 0, 0x20);
  b.write(e.name.slice(0, 32), 0x40, 'latin1');
  return b;
}

const exists = (mode: number) => (mode & DF_EXISTS) !== 0;
const isDir = (mode: number) => (mode & (DF_DIR | DF_FILE | DF_EXISTS)) === (DF_DIR | DF_EXISTS);
const isFile = (mode: number) => (mode & (DF_DIR | DF_FILE | DF_EXISTS)) === (DF_FILE | DF_EXISTS);

export function productCodeOf(name: string): string | null {
  const m = /^B[AEIC]([A-Z]{4}-\d{5})/.exec(name);
  return m ? m[1] : null;
}

/** icon.sys's title: Shift-JIS at 0xC0, often full-width; its two lines joined */
function titleOf(iconSys: Buffer | undefined): string | null {
  if (!iconSys || iconSys.length < 0x100 || iconSys.subarray(0, 4).toString('latin1') !== 'PS2D') return null;
  const raw = iconSys.subarray(0xc0, 0x100);
  const end = raw.indexOf(0);
  try {
    const t = new TextDecoder('shift_jis').decode(raw.subarray(0, end < 0 ? raw.length : end)).normalize('NFKC').replace(/\s+/g, ' ').trim();
    return t || null;
  } catch {
    return null;
  }
}

// ECC: a Hamming code of 3 bytes per 128 bytes of page, 12 bytes in the page's 16 spare bytes (ps2mc_ecc.py)
const parity = (b: number) => {
  b ^= b >> 4;
  b ^= b >> 2;
  b ^= b >> 1;
  return b & 1;
};
const COLUMN_MASKS = Array.from({ length: 256 }, (_, b) => [0x55, 0x33, 0x0f, 0x00, 0xaa, 0xcc, 0xf0].reduce((m, mask, i) => m | (parity(b & mask) << i), 0));

function eccChunk(s: Buffer): number[] {
  let cp = 0x77;
  let lp0 = 0x7f;
  let lp1 = 0x7f;
  for (let i = 0; i < s.length; i++) {
    const b = s[i];
    cp ^= COLUMN_MASKS[b];
    if (parity(b)) {
      lp0 ^= ~i;
      lp1 ^= i;
    }
  }
  return [cp & 0xff, lp0 & 0x7f, lp1 & 0xff];
}

function eccPage(page: Buffer): Buffer {
  const out = Buffer.alloc(16);
  for (let i = 0; i < 4; i++) Buffer.from(eccChunk(page.subarray(i * 128, i * 128 + 128))).copy(out, i * 3);
  return out;
}

/** A card image opened for reading and changing; pages written are marked so only they get new ECC */
class Card {
  readonly raw: Buffer;
  readonly rawPage: number;
  readonly allocOffset: number;
  readonly allocEnd: number;
  readonly rootCluster: number;
  readonly ifc: number[];
  private dirty = new Set<number>();

  constructor(file: Buffer) {
    if (file.length < 0x154 || file.subarray(0, MAGIC.length).toString('latin1') !== MAGIC) throw new Ps2CardError('Not a PS2 memory card');
    if (file.readUInt16LE(0x28) !== PAGE || file.readUInt16LE(0x2a) !== 2) throw new Ps2CardError('Unsupported page or cluster size');
    const clusters = file.readUInt32LE(0x30);
    const pages = clusters * 2;
    if (file.length === pages * (PAGE + 16)) this.rawPage = PAGE + 16;
    else if (file.length === pages * PAGE) this.rawPage = PAGE;
    else throw new Ps2CardError(`Unexpected card size ${file.length}`);
    this.raw = Buffer.from(file);
    this.allocOffset = file.readUInt32LE(0x34);
    const goodBlock = Math.min(file.readUInt32LE(0x40), file.readUInt32LE(0x44));
    const perBlock = file.readUInt16LE(0x2c);
    this.allocEnd = Math.min(file.readUInt32LE(0x38), Math.floor((goodBlock * perBlock) / 2) - this.allocOffset);
    this.rootCluster = file.readUInt32LE(0x3c);
    this.ifc = Array.from({ length: 32 }, (_, i) => file.readUInt32LE(0x50 + i * 4));
  }

  private pageAt(p: number) {
    return this.raw.subarray(p * this.rawPage, p * this.rawPage + PAGE);
  }

  readCluster(abs: number): Buffer {
    return Buffer.concat([this.pageAt(abs * 2), this.pageAt(abs * 2 + 1)]);
  }

  writeCluster(abs: number, data: Buffer) {
    for (let i = 0; i < 2; i++) {
      data.copy(this.pageAt(abs * 2 + i), 0, i * PAGE, i * PAGE + PAGE);
      this.dirty.add(abs * 2 + i);
    }
  }

  private fatPlace(n: number) {
    if (n < 0 || n >= this.allocEnd) throw new Ps2CardError(`FAT index out of range (${n})`);
    const fatIndex = Math.floor(n / EPC);
    const indirect = this.ifc[Math.floor(fatIndex / EPC)];
    const fatCluster = this.readCluster(indirect).readUInt32LE((fatIndex % EPC) * 4);
    return { cluster: fatCluster, offset: (n % EPC) * 4 };
  }

  fat(n: number): number {
    const at = this.fatPlace(n);
    return this.readCluster(at.cluster).readUInt32LE(at.offset);
  }

  setFat(n: number, v: number) {
    const at = this.fatPlace(n);
    const c = this.readCluster(at.cluster);
    c.writeUInt32LE(v >>> 0, at.offset);
    this.writeCluster(at.cluster, c);
  }

  /** The allocatable clusters of a chain (relative to the allocatable area), in order */
  chain(first: number): number[] {
    const out: number[] = [];
    let c = first;
    const seen = new Set<number>();
    while (c !== CHAIN_END && c !== 0x7fffffff && out.length <= this.allocEnd) {
      if (seen.has(c)) throw new Ps2CardError('FAT loop');
      seen.add(c);
      out.push(c);
      const v = this.fat(c);
      if (!(v & ALLOCATED)) throw new Ps2CardError(`Chain through a free cluster (${c})`);
      c = v === CHAIN_END ? CHAIN_END : v & 0x7fffffff;
    }
    return out;
  }

  readChain(first: number, bytes: number): Buffer {
    if (bytes === 0) return Buffer.alloc(0);
    const clusters = this.chain(first);
    if (clusters.length * CLUSTER < bytes) throw new Ps2CardError('Chain shorter than its file');
    return Buffer.concat(clusters.slice(0, Math.ceil(bytes / CLUSTER)).map((c) => this.readCluster(c + this.allocOffset))).subarray(0, bytes);
  }

  dir(first: number, count: number): Dirent[] {
    const data = this.readChain(first, count * DIRENT);
    return Array.from({ length: count }, (_, i) => readDirent(data.subarray(i * DIRENT, (i + 1) * DIRENT)));
  }

  setDirent(dirFirst: number, index: number, e: Dirent) {
    const clusters = this.chain(dirFirst);
    const c = clusters[Math.floor(index / 2)];
    if (c === undefined) throw new Ps2CardError('Directory entry past its chain');
    const buf = this.readCluster(c + this.allocOffset);
    writeDirent(e).copy(buf, (index % 2) * DIRENT);
    this.writeCluster(c + this.allocOffset, buf);
  }

  freeClusters(): number[] {
    const out: number[] = [];
    for (let n = 0; n < this.allocEnd; n++) if (!(this.fat(n) & ALLOCATED)) out.push(n);
    return out;
  }

  /** Chains N free clusters (FAT marked), returning them; the caller checked they fit */
  take(free: number[], n: number): number[] {
    const got = free.splice(0, n);
    got.forEach((c, i) => this.setFat(c, i === got.length - 1 ? CHAIN_END : (ALLOCATED | got[i + 1]) >>> 0));
    return got;
  }

  release(first: number) {
    if (first === CHAIN_END) return;
    for (const c of this.chain(first)) this.setFat(c, 0x7fffffff);
  }

  toBuffer(): Buffer {
    if (this.rawPage > PAGE) for (const p of this.dirty) eccPage(this.pageAt(p)).copy(this.raw, p * this.rawPage + PAGE);
    return this.raw;
  }
}

const pad = (n: number) => Math.ceil(n / CLUSTER) * CLUSTER;

/** A save's .psu: its directory, "." and "..", then each file; card positions zeroed so it is the same everywhere */
function makePsu(dir: Dirent, files: { e: Dirent; data: Buffer }[]): Buffer {
  const at = { cluster: 0, parent: 0 };
  const dot = (name: string) => writeDirent({ mode: DF_RWX | DF_DIR | DF_0400 | DF_EXISTS, length: 0, created: dir.created, cluster: 0, parent: 0, modified: dir.created, attr: 0, name });
  const parts = [writeDirent({ ...dir, ...at, length: files.length + 2 }), dot('.'), dot('..')];
  for (const f of files) {
    parts.push(writeDirent({ ...f.e, ...at, length: f.data.length }), f.data, Buffer.alloc(pad(f.data.length) - f.data.length));
  }
  return Buffer.concat(parts);
}

function entryOf(dir: Dirent, files: { e: Dirent; data: Buffer }[]): Ps2Entry {
  const psu = makePsu(dir, files);
  const blocks = Math.ceil((files.length + 2) / 2) + files.reduce((n, f) => n + Math.ceil(f.data.length / CLUSTER), 0);
  return {
    name: dir.name,
    productCode: productCodeOf(dir.name),
    title: titleOf(files.find((f) => f.e.name.toLowerCase() === 'icon.sys')?.data),
    blocks,
    psu,
    sha1: crypto.createHash('sha1').update(psu).digest('hex'),
  };
}

/** A card no game has formatted yet: erased flash, every byte 0xFF (how PCSX2 and its forks make new cards) */
export function isErased(buf: Buffer) {
  if (buf.length < PAGE || !buf.subarray(0, MAGIC.length).equals(Buffer.alloc(MAGIC.length, 0xff))) return false;
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0xff) return false;
  return true;
}

const tod = (d: Date) => {
  const b = Buffer.alloc(8);
  b.writeUInt8(d.getUTCSeconds(), 1);
  b.writeUInt8(d.getUTCMinutes(), 2);
  b.writeUInt8(d.getUTCHours(), 3);
  b.writeUInt8(d.getUTCDate(), 4);
  b.writeUInt8(d.getUTCMonth() + 1, 5);
  b.writeUInt16LE(d.getUTCFullYear(), 6);
  return b;
};

/** An empty card the size of SIZE (with ECC when its pages carry spare bytes), as the PS2 formats one (mymc's format) */
export function formatPs2Card(size: number): Buffer {
  const ecc = size % (PAGE + 16) === 0 && (size / (PAGE + 16)) % 16 === 0;
  const raw = ecc ? PAGE + 16 : PAGE;
  const perBlock = 16;
  const pages = Math.floor(size / raw / perBlock) * perBlock;
  if (pages < 1024 || pages * raw !== size) throw new Ps2CardError(`Unexpected card size ${size}`);
  const clusters = pages / 2;
  const blocks = pages / perBlock;
  const good1 = blocks - 1;
  const good2 = blocks - 2;
  const firstIfc = Math.ceil(0x2000 / CLUSTER);
  let fatClusters = Math.ceil((clusters - (firstIfc + 2)) / EPC);
  let ifcCount = Math.ceil(fatClusters / EPC);
  if (ifcCount > 32) [ifcCount, fatClusters] = [32, 32 * EPC];
  const offset = firstIfc + ifcCount + fatClusters;
  const allocEnd = good2 * (perBlock / 2) - offset;

  const out = Buffer.alloc(size);
  const spare = ecc ? eccPage(Buffer.alloc(PAGE)) : null;
  if (spare) for (let p = 0; p < pages; p++) spare.copy(out, p * raw + PAGE);
  const writeCluster = (abs: number, data: Buffer) => {
    for (let i = 0; i < 2; i++) {
      const page = data.subarray(i * PAGE, i * PAGE + PAGE);
      page.copy(out, (abs * 2 + i) * raw);
      if (ecc) eccPage(page).copy(out, (abs * 2 + i) * raw + PAGE);
    }
  };
  // Indirect FAT clusters list the FAT clusters, which follow them
  const firstFat = firstIfc + ifcCount;
  for (let i = 0; i < ifcCount; i++) {
    const c = Buffer.alloc(CLUSTER, 0xff);
    for (let j = 0; j < EPC && i * EPC + j < fatClusters; j++) c.writeUInt32LE(firstFat + i * EPC + j, j * 4);
    writeCluster(firstIfc + i, c);
  }
  // Cluster 0 holds the root directory; the rest up to the end are free, those past it never allocated
  for (let f = 0; f < fatClusters; f++) {
    const c = Buffer.alloc(CLUSTER);
    for (let j = 0; j < EPC; j++) {
      const n = f * EPC + j;
      c.writeUInt32LE(n === 0 || n >= allocEnd ? CHAIN_END : 0x7fffffff, j * 4);
    }
    writeCluster(firstFat + f, c);
  }
  const now = tod(new Date());
  const root = Buffer.alloc(CLUSTER);
  writeDirent({ mode: DF_RWX | DF_DIR | DF_0400 | DF_EXISTS, length: 2, created: now, cluster: 0, parent: 0, modified: now, attr: 0, name: '.' }).copy(root, 0);
  writeDirent({ mode: DF_WRITE | DF_EXECUTE | DF_DIR | DF_0400 | DF_HIDDEN | DF_EXISTS, length: 0, created: now, cluster: 0, parent: 0, modified: now, attr: 0, name: '..' }).copy(root, DIRENT);
  writeCluster(offset, root);

  const sb = Buffer.alloc(CLUSTER);
  sb.write(MAGIC, 0, 'latin1');
  sb.write('1.2.0.0', 0x1c, 'latin1');
  sb.writeUInt16LE(PAGE, 0x28);
  sb.writeUInt16LE(2, 0x2a);
  sb.writeUInt16LE(perBlock, 0x2c);
  sb.writeUInt16LE(0xff00, 0x2e);
  sb.writeUInt32LE(clusters, 0x30);
  sb.writeUInt32LE(offset, 0x34);
  sb.writeUInt32LE(allocEnd, 0x38);
  sb.writeUInt32LE(0, 0x3c);
  sb.writeUInt32LE(good1, 0x40);
  sb.writeUInt32LE(good2, 0x44);
  for (let i = 0; i < 32; i++) sb.writeUInt32LE(i < ifcCount ? firstIfc + i : 0, 0x50 + i * 4);
  sb.fill(0xff, 0xd0, 0x150);
  sb.writeUInt8(2, 0x150);
  sb.writeUInt8(0x2b, 0x151);
  // Only the superblock's page: the cluster's second page stays erased
  sb.subarray(0, PAGE).copy(out, 0);
  if (ecc) eccPage(sb.subarray(0, PAGE)).copy(out, PAGE);
  // The last good erase block is left erased (the spare block)
  out.fill(0xff, good2 * perBlock * raw, (good2 + 1) * perBlock * raw);
  return out;
}

export function isPs2Card(buf: Buffer) {
  return buf.length > MAGIC.length && buf.subarray(0, MAGIC.length).toString('latin1') === MAGIC;
}

function rootOf(card: Card) {
  const head = card.dir(card.rootCluster, 2);
  if (head[0].name !== '.' || !isDir(head[0].mode)) throw new Ps2CardError('Root directory damaged');
  return card.dir(card.rootCluster, head[0].length);
}

export function readPs2Card(file: Buffer): Ps2Card {
  const card = new Card(isErased(file) ? formatPs2Card(file.length) : file);
  const problems: string[] = [];
  const entries: Ps2Entry[] = [];
  const root = rootOf(card);
  for (const d of root.slice(2)) {
    if (!exists(d.mode)) continue;
    if (!isDir(d.mode)) {
      problems.push(`${d.name}: a file in the root`);
      continue;
    }
    try {
      const inner = card.dir(d.cluster, d.length).slice(2);
      const files = inner.filter((e) => exists(e.mode));
      if (files.some((e) => !isFile(e.mode))) throw new Ps2CardError('it holds a folder');
      entries.push(entryOf(d, files.map((e) => ({ e, data: card.readChain(e.cluster, e.length) }))));
    } catch (e) {
      problems.push(`${d.name}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { entries, freeBlocks: card.freeClusters().length, problems };
}

function parsePsu(psu: Buffer) {
  if (psu.length < DIRENT * 3) throw new Ps2CardError('Not a .psu save');
  const dir = readDirent(psu.subarray(0, DIRENT));
  if (!isDir(dir.mode) || dir.length < 2) throw new Ps2CardError('Not a .psu save');
  const files: { e: Dirent; data: Buffer }[] = [];
  let at = DIRENT * 3;
  for (let i = 0; i < dir.length - 2; i++) {
    const e = readDirent(psu.subarray(at, at + DIRENT));
    at += DIRENT;
    if (!isFile(e.mode)) throw new Ps2CardError('A .psu entry that is not a file');
    if (at + e.length > psu.length) throw new Ps2CardError('Truncated .psu save');
    files.push({ e, data: Buffer.from(psu.subarray(at, at + e.length)) });
    at += pad(e.length);
  }
  return { dir, files };
}

export function readPsu(psu: Buffer): Ps2Entry {
  const { dir, files } = parsePsu(psu);
  return entryOf(dir, files);
}

/** Saves taken out (REMOVE, and older copies of those put in) and put in; those that do not fit are skipped */
export function writePs2Card(file: Buffer, put: Ps2Entry[], remove: string[] = []): { card: Buffer; skipped: string[] } {
  const card = new Card(isErased(file) ? formatPs2Card(file.length) : file);
  let root = rootOf(card);
  const gone = new Set([...remove, ...put.map((p) => p.name)]);
  root.forEach((d, i) => {
    if (i < 2 || !exists(d.mode) || !gone.has(d.name)) return;
    if (isDir(d.mode)) {
      for (const e of card.dir(d.cluster, d.length).slice(2)) if (exists(e.mode) && e.length) card.release(e.cluster);
      card.release(d.cluster);
    } else if (d.length) card.release(d.cluster);
    card.setDirent(card.rootCluster, i, { ...d, mode: d.mode & ~DF_EXISTS });
  });
  const free = card.freeClusters();
  const skipped: string[] = [];
  for (const p of put) {
    root = rootOf(card);
    const parsed = parsePsu(p.psu);
    let slot = root.findIndex((d, i) => i >= 2 && !exists(d.mode));
    const growRoot = slot < 0 && root.length % 2 === 0;
    const need = Math.ceil((parsed.files.length + 2) / 2) + parsed.files.reduce((n, f) => n + Math.ceil(f.data.length / CLUSTER), 0) + (growRoot ? 1 : 0);
    if (need > free.length) {
      skipped.push(p.name);
      continue;
    }
    if (slot < 0) {
      slot = root.length;
      if (growRoot) {
        const last = card.chain(card.rootCluster).pop()!;
        const [c] = card.take(free, 1);
        card.setFat(last, (ALLOCATED | c) >>> 0);
        card.writeCluster(c + card.allocOffset, Buffer.alloc(CLUSTER));
      }
      card.setDirent(card.rootCluster, 0, { ...root[0], length: root.length + 1 });
    }
    const dirClusters = card.take(free, Math.ceil((parsed.files.length + 2) / 2));
    const dirFirst = dirClusters[0];
    for (const c of dirClusters) card.writeCluster(c + card.allocOffset, Buffer.alloc(CLUSTER));
    const ents: Dirent[] = [
      { mode: DF_RWX | DF_DIR | DF_0400 | DF_EXISTS, length: 0, created: parsed.dir.created, cluster: card.rootCluster, parent: slot, modified: parsed.dir.modified, attr: 0, name: '.' },
      { mode: DF_RWX | DF_DIR | DF_0400 | DF_EXISTS, length: 0, created: parsed.dir.created, cluster: 0, parent: 0, modified: parsed.dir.modified, attr: 0, name: '..' },
    ];
    for (const f of parsed.files) {
      let first = CHAIN_END;
      if (f.data.length) {
        const cs = card.take(free, Math.ceil(f.data.length / CLUSTER));
        cs.forEach((c, i) => card.writeCluster(c + card.allocOffset, Buffer.concat([f.data.subarray(i * CLUSTER, (i + 1) * CLUSTER)], CLUSTER)));
        first = cs[0];
      }
      ents.push({ ...f.e, cluster: first, parent: 0, length: f.data.length });
    }
    ents.forEach((e, i) => card.setDirent(dirFirst, i, e));
    card.setDirent(card.rootCluster, slot, { ...parsed.dir, cluster: dirFirst, parent: 0, length: ents.length });
  }
  return { card: card.toBuffer(), skipped };
}
