/**
 * Header probes: files of a device that no hash or name identified are read by their own header (product codes,
 * see lib/romheader.ts). The /sync reply asks for each with "probe<TAB>path<TAB>blocks"; the client posts those
 * 4 KiB blocks of the file to /agent/probe and gets back "need<TAB>blocks" until the server has what it needs,
 * then "id<TAB>platform<TAB>serial" or "none". The answer is kept per path and size, so a file is read only once.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { prisma } from '../../lib/prisma.js';
import { NeedMore, PLATFORM_SYSTEMS, probeable, readHeader, serialKeys, type Source } from '../../lib/romheader.js';

export const BLOCK = 4096;
/** Blocks asked for at once at least, so a header and what follows it come in one go */
const MIN_ASK = 16;
const MAX_ROUNDS = 12;
const MAX_BYTES = 48 * 1024 * 1024;

export class BlockSource implements Source {
  blocks = new Map<number, Buffer>();
  bytes = 0;
  rounds = 0;
  at = Date.now();
  constructor(public size: number) {}

  add(start: number, data: Buffer) {
    for (let i = 0; i * BLOCK < data.length; i++) {
      const b = start + i;
      if (b * BLOCK >= this.size || this.blocks.has(b)) continue;
      this.blocks.set(b, data.subarray(i * BLOCK, Math.min((i + 1) * BLOCK, data.length)));
    }
    this.bytes += data.length;
  }

  async read(pos: number, len: number) {
    len = Math.max(0, Math.min(len, this.size - pos));
    if (!len) return Buffer.alloc(0);
    const a = Math.floor(pos / BLOCK);
    const b = Math.floor((pos + len - 1) / BLOCK);
    const missing: [number, number][] = [];
    for (let i = a; i <= b; i++) if (!this.whole(i)) missing.push([i * BLOCK, (i + 1) * BLOCK]);
    if (missing.length) throw new NeedMore(missing);
    const parts = [];
    for (let i = a; i <= b; i++) parts.push(this.blocks.get(i)!);
    const all = Buffer.concat(parts);
    return all.subarray(pos - a * BLOCK, pos - a * BLOCK + len);
  }

  /** A block counts once it holds all its bytes (the file's last one may be short) */
  private whole(i: number) {
    const b = this.blocks.get(i);
    return !!b && b.length >= Math.min(BLOCK, this.size - i * BLOCK);
  }

  prefix() {
    let i = 0;
    while (this.whole(i)) i++;
    return Math.min(this.size, i * BLOCK);
  }

  async writeSparse(file: string) {
    const fd = await fs.promises.open(file, 'w');
    try {
      await fd.truncate(this.size);
      for (const [i, b] of this.blocks) await fd.write(b, 0, b.length, i * BLOCK);
    } finally {
      await fd.close();
    }
  }

  /** Byte ranges as "start:count" block ranges, each at least MIN_ASK blocks, only blocks not held */
  ask(ranges: [number, number][]) {
    const last = Math.ceil(this.size / BLOCK);
    const want = new Set<number>();
    for (const [s, e] of ranges) {
      const a = Math.floor(s / BLOCK);
      const b = Math.max(Math.ceil(e / BLOCK), a + MIN_ASK);
      for (let i = a; i < Math.min(b, last); i++) if (!this.whole(i)) want.add(i);
    }
    const sorted = [...want].sort((x, y) => x - y);
    const out: [number, number][] = [];
    for (const i of sorted) {
      const top = out[out.length - 1];
      if (top && top[0] + top[1] === i) top[1]++;
      else out.push([i, 1]);
    }
    return out.map(([a, n]) => `${a}:${n}`).join(',');
  }
}

const sessions = new Map<string, BlockSource>();
const pathHash = (p: string) => crypto.createHash('sha1').update(p).digest('hex');

/** The blocks first asked for: the file's start */
export const FIRST_ASK = `0:${MIN_ASK}`;

/**
 * One round of a probe. "X-Ranges" names the blocks in the body ("start:count,..."), in that order.
 * Returns the reply line.
 */
export async function probeRound(device: { id: number; userId: number }, file: string, size: number, ranges: string, body: Buffer) {
  const key = `${device.id}\t${file}`;
  for (const [k, s] of sessions) if (Date.now() - s.at > 10 * 60_000) sessions.delete(k);
  let src = sessions.get(key);
  if (!src || src.size !== size) sessions.set(key, (src = new BlockSource(size)));
  src.at = Date.now();
  src.rounds++;
  let off = 0;
  for (const r of ranges.split(',')) {
    const m = /^(\d+):(\d+)$/.exec(r.trim());
    if (!m) continue;
    const n = Math.min(Number(m[2]) * BLOCK, Math.max(0, size - Number(m[1]) * BLOCK));
    src.add(Number(m[1]), body.subarray(off, off + n));
    off += n;
  }
  let id: Awaited<ReturnType<typeof readHeader>> = null;
  try {
    id = await readHeader(file, src);
  } catch (e) {
    if (e instanceof NeedMore && src.rounds < MAX_ROUNDS && src.bytes < MAX_BYTES) {
      const ask = src.ask(e.ranges);
      if (ask) return `need\t${ask}`;
    }
  }
  sessions.delete(key);
  await storeProbe(device, file, size, id);
  return id ? `id\t${id.platform}\t${id.serial}` : 'none';
}

async function storeProbe(device: { id: number; userId: number }, file: string, size: number, id: { platform: string; serial: string } | null) {
  const ph = pathHash(file);
  const data = { size: BigInt(size), platform: id?.platform ?? null, serial: id?.serial.slice(0, 64) ?? null, at: new Date() };
  await prisma.deviceProbe.upsert({ where: { deviceId_pathHash: { deviceId: device.id, pathHash: ph } }, create: { deviceId: device.id, pathHash: ph, ...data }, update: data });
  // The device's inventory row learns its game now, not at the next sync
  const row = await prisma.deviceRom.findUnique({ where: { deviceId_pathHash: { deviceId: device.id, pathHash: ph } } });
  if (row && !row.gameId && id) await prisma.deviceRom.update({ where: { id: row.id }, data: probeFields(await serialMatch(id.platform, id.serial, file, !!row.sha1), id.serial) });
}

/** The inventory fields a header code gives a file */
export function probeFields(hit: SerialHit | null, serial: string | null) {
  return { serial: serial?.slice(0, 64) ?? null, romId: hit && !hit.fan ? hit.romId : null, gameId: hit && !hit.fan ? hit.gameId : null, baseGameId: hit?.fan ? hit.gameId : null };
}

/** Roms with a code by system: code key → the roms holding it; kept ten minutes */
type Coded = { romId: number; gameId: number; names: string[] };
const serialCache = new Map<string, { at: number; index: Map<string, Coded[]> }>();
async function serialIndex(platform: string) {
  const hit = serialCache.get(platform);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.index;
  const roms = await prisma.rom.findMany({
    where: { serial: { not: null }, game: { system: { slug: { in: PLATFORM_SYSTEMS[platform] ?? [] } } } },
    select: { id: true, name: true, serial: true, gameId: true, game: { select: { title: true } } },
  });
  const index = new Map<string, Coded[]>();
  for (const r of roms) for (const k of serialKeys(platform, r.serial!)) index.set(k, [...(index.get(k) ?? []), { romId: r.id, gameId: r.gameId, names: [r.name, r.game.title] }]);
  serialCache.set(platform, { at: Date.now(), index });
  return index;
}

/** Fan translations and hacks: "[T+Spa]", "[T-En by ...]", "(Hack)", "(English v1.04)" */
export const FAN_WORK = /\[T[+-]|\bhack\b|\((english|spanish|french|german|italian|portuguese) v[\d.]+\)/i;

/** A title compared loosely: no regions or tags, no articles, only letters and digits */
export function normTitle(name: string) {
  return name
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/,\s*(the|a|an)\b/g, ' ')
    .replace(/^\s*(the|a|an)\s+/, '')
    .normalize('NFD')
    .replace(/[^a-z0-9]/g, '');
}

/** How alike two loose titles are, 0 to 1; one inside the other counts as alike */
function likeness(a: string, b: string) {
  if (!a || !b) return 0;
  if (a.includes(b) || b.includes(a)) return 1;
  const d: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return 1 - d[b.length] / Math.max(a.length, b.length);
}

export type SerialHit = { romId: number | null; gameId: number; fan: boolean };

/**
 * The game a header code belongs to. Several games may share a code (revisions, bundles): the one whose title is
 * closest to the file's name. The file is that game's hack or translation (linked to it, not counted as it) when
 * its name says so, or when it is a hashed cartridge whose name is nothing like the game's ("Pokemon Radical Red"
 * with FireRed's code); a compressed disc never hashes like its dump, so only its name can tell.
 */
export async function serialMatch(platform: string, serial: string, file: string, hashed: boolean): Promise<SerialHit | null> {
  const index = await serialIndex(platform);
  const found = serialKeys(platform, serial).flatMap((k) => index.get(k) ?? []);
  if (!found.length) return null;
  const name = path.posix.basename(file).replace(/\.[^.]+$/, '');
  const mine = normTitle(name);
  let best = found[0];
  let score = -1;
  for (const c of found) {
    const s = Math.max(...c.names.map((n) => likeness(mine, normTitle(n))));
    if (s > score) [best, score] = [c, s];
  }
  // A compressed image's hash is never the dump's, whatever it holds
  if (/\.(chd|cso|zso|rvz|wia|wbfs|ciso|gcz)$/i.test(file)) hashed = false;
  const mentionsCode = serialKeys(platform, serial).some((k) => name.toUpperCase().replace(/[^A-Z0-9]/g, '').includes(k));
  const fan = FAN_WORK.test(name) || (hashed && score < 0.6 && !mentionsCode);
  const sameGame = found.filter((c) => c.gameId === best.gameId);
  return { romId: sameGame.length === 1 || score === 1 ? best.romId : null, gameId: best.gameId, fan };
}

/** Earlier probes of a device's files, by path hash, still valid for files of the same size */
export async function probesOf(deviceId: number) {
  const rows = await prisma.deviceProbe.findMany({ where: { deviceId } });
  return new Map(rows.map((r) => [r.pathHash, r]));
}

/** Files of an inventory worth a header probe: not identified, a format with a code, not probed at this size */
export function wantsProbe(r: { path: string; size: number }, probed: Map<string, { size: bigint }>, ph: string) {
  if (!probeable(r.path) || !r.size) return false;
  const p = probed.get(ph);
  return !p || Number(p.size) !== r.size;
}
