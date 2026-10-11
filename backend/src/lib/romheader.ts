/**
 * Product codes read from a rom's or a disc image's own header, so a file whose hash no database knows (a
 * compressed .chd/.cso/.rvz, a big unhashed image, a trimmed or patched cartridge) can still be told apart.
 * The bytes come from a Source that may not hold them yet: reading what is missing throws NeedMore with the byte
 * ranges to ask the device for, and the probe is run again once they arrive.
 *
 * Where each code lives:
 *  - GBA 0xAC (4 chars), NDS 0x0C (4 chars), N64 0x3B (4 chars, in any of its three byte orders)
 *  - 3DS: NCCH product code ("CTR-P-BTVJ") at 0x150 of the first partition (.3ds/.cci) or of the first content (.cia)
 *  - Mega Drive / 32X / Mega-CD: "GM T-48073 -00" at 0x180 of the cartridge or of the disc's first sector
 *  - Saturn: product number at 0x20 of the disc's first sector
 *  - PS1/PS2: the boot file named in SYSTEM.CNF (SLUS_012.34); PSP: UMD_DATA.BIN ("ULUS-10162|...")
 *  - GameCube/Wii: the disc id, first 6 bytes of the disc (also inside .rvz/.wia, .wbfs and GameCube .ciso)
 * Discs are read as ISO 9660, from 2048-byte images, raw 2352-byte CD images, .cso/.zso and .chd (through chdman).
 */
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.js';
import { run, tmpDir } from './tools.js';
import { openCsoOn } from './discimage.js';

/** Bytes the probe needs that the source does not hold yet: [start, end) */
export class NeedMore extends Error {
  constructor(public ranges: [number, number][]) {
    super('need more bytes');
  }
}

export interface Source {
  size: number;
  read(pos: number, len: number): Promise<Buffer>;
  /** Writes what it holds into a file of its size, the rest left as holes (for chdman) */
  writeSparse(file: string): Promise<void>;
  /** Length of the file's start held without gaps */
  prefix(): number;
}

export interface HeaderId {
  /** gba | nds | 3ds | n64 | md | sega32x | segacd | saturn | psx | ps2 | psp | gc | wii */
  platform: string;
  serial: string;
}

/** Database systems a platform's codes are looked up in */
export const PLATFORM_SYSTEMS: Record<string, string[]> = {
  gba: ['gba'],
  nds: ['nds', 'nds-dsi'],
  '3ds': ['3ds'],
  n64: ['n64'],
  md: ['md', 'pico'],
  sega32x: ['sega32x'],
  segacd: ['segacd'],
  saturn: ['saturn'],
  psx: ['psx'],
  ps2: ['ps2'],
  psp: ['psp'],
  gc: ['gc'],
  wii: ['wii'],
};

const CART_EXT: Record<string, string> = {
  '.gba': 'gba',
  '.nds': 'nds',
  '.dsi': 'nds',
  '.srl': 'nds',
  '.3ds': '3ds',
  '.cci': '3ds',
  '.cia': 'cia',
  '.z64': 'n64',
  '.n64': 'n64',
  '.v64': 'n64',
  '.md': 'md',
  '.gen': 'md',
  '.32x': 'md',
};
const DISC_EXT = new Set(['.iso', '.bin', '.img', '.chd', '.cso', '.zso', '.gcm', '.rvz', '.wia', '.wbfs', '.ciso']);

/** Whether a file of this name may carry a code we read */
export function probeable(file: string) {
  const ext = path.extname(file).toLowerCase();
  return ext in CART_EXT || DISC_EXT.has(ext);
}

const ascii = (b: Buffer, from: number, len: number) => b.toString('latin1', from, from + len).replace(/\0+$/, '').trim();
const code4 = (s: string) => (/^[A-Z0-9]{4}$/.test(s) ? s : null);

/** "GM T-48073 -00" → "T-48073-00": the Sega header's type and serial field */
function segaSerial(b: Buffer, at: number) {
  const s = ascii(b, at, 14).replace(/^[A-Z]{2}\s+/, '').replace(/\s+/g, '');
  return /[0-9]/.test(s) && !/^0+(-0+)?$/.test(s) ? s : null;
}

export async function readHeader(file: string, src: Source): Promise<HeaderId | null> {
  const ext = path.extname(file).toLowerCase();
  const cart = CART_EXT[ext];
  if (cart) return cartridge(cart, src);
  const head = await src.read(0, Math.min(src.size, 0x200));
  if (head.toString('latin1', 0, 8) === 'MComprHD') return chd(src);
  const magic = head.toString('latin1', 0, 4);
  if (magic === 'ZISO' || (magic === 'CISO' && head.readUInt32LE(4) <= 0x18 && head.readBigUInt64LE(8) > 0n)) {
    const cso = await openCsoOn(src, magic === 'ZISO' ? 'zso' : 'cso');
    return disc({ size: cso.isoSize, read: (p, n) => cso.read(p, n) });
  }
  // GameCube CISO: block map, then the disc from 0x8000
  if (magic === 'CISO') return nintendoDisc(await src.read(0x8000, 0x20));
  // RVZ/WIA: the disc header sits 16 bytes into the second header
  if (head.readUInt32BE(0) === 0x52565a01 || head.readUInt32BE(0) === 0x57494101) return nintendoDisc(await src.read(0x58, 0x20));
  // WBFS: the first disc's header copy is the sector after the partition header
  if (magic === 'WBFS') return nintendoDisc(await src.read(2 ** head[8], 0x20));
  // A Mega Drive cartridge with a .bin name
  if (head.toString('latin1', 0x100, 0x104) === 'SEGA' && !head.toString('latin1', 0, 16).startsWith('SEGADISCSYSTEM')) return cartridge('md', src);
  return disc(src);
}

async function cartridge(kind: string, src: Source): Promise<HeaderId | null> {
  if (kind === 'gba') {
    const h = await src.read(0, 0xc0);
    const c = code4(ascii(h, 0xac, 4));
    return h[0xb2] === 0x96 && c ? { platform: 'gba', serial: c } : null;
  }
  if (kind === 'nds') {
    const c = code4(ascii(await src.read(0, 0x20), 0x0c, 4));
    return c ? { platform: 'nds', serial: c } : null;
  }
  if (kind === 'n64') {
    const h = Buffer.from(await src.read(0, 0x40));
    const first = h.readUInt32BE(0);
    // .v64 swaps each pair of bytes, .n64 is little-endian words
    if (first === 0x37804012) for (let i = 0; i < h.length; i += 2) [h[i], h[i + 1]] = [h[i + 1], h[i]];
    else if (first === 0x40123780) for (let i = 0; i < h.length; i += 4) h.writeUInt32BE(h.readUInt32LE(i), i);
    else if (first !== 0x80371240) return null;
    const c = code4(ascii(h, 0x3b, 4));
    return c ? { platform: 'n64', serial: c } : null;
  }
  if (kind === 'md') {
    const h = await src.read(0, 0x200);
    if (h.toString('latin1', 0x100, 0x104) !== 'SEGA') return null;
    const s = segaSerial(h, 0x180);
    return s ? { platform: /32X/.test(h.toString('latin1', 0x100, 0x110)) ? 'sega32x' : 'md', serial: s } : null;
  }
  if (kind === '3ds') {
    const h = await src.read(0, 0x200);
    if (h.toString('latin1', 0x100, 0x104) !== 'NCSD') return null;
    return ncch(src, h.readUInt32LE(0x120) * 0x200);
  }
  if (kind === 'cia') {
    const h = await src.read(0, 0x20);
    const align = (n: number) => Math.ceil(n / 64) * 64;
    const tmd = align(h.readUInt32LE(0)) + align(h.readUInt32LE(8)) + align(h.readUInt32LE(0x0c));
    const found = await ncch(src, tmd + align(h.readUInt32LE(0x10)));
    if (found) return found;
    // Encrypted contents: DSiWare still names itself, its game code is the low half of the title id in the TMD
    // (after an RSA-2048 signature: 0x140 bytes, then the id at 0x4c)
    const t = await src.read(tmd, 0x200);
    if (t.readUInt32BE(0) !== 0x10004) return null;
    const high = t.readUInt32BE(0x140 + 0x4c);
    const c = code4(t.toString('latin1', 0x140 + 0x50, 0x140 + 0x54));
    return (high === 0x00048004 || high === 0x00030004) && c ? { platform: 'nds', serial: c } : null;
  }
  return null;
}

/** An NCCH partition's product code; encrypted contents (most eShop .cia files) hide it */
async function ncch(src: Source, at: number): Promise<HeaderId | null> {
  if (at <= 0 || at + 0x200 > src.size) return null;
  const h = await src.read(at, 0x200);
  if (h.toString('latin1', 0x100, 0x104) !== 'NCCH') return null;
  const s = ascii(h, 0x150, 16);
  return /^CTR-[A-Z]-[A-Z0-9]{4}$/.test(s) ? { platform: '3ds', serial: s } : null;
}

function nintendoDisc(h: Buffer): HeaderId | null {
  const id = ascii(h, 0, 6);
  if (!/^[A-Z0-9]{6}$/.test(id)) return null;
  const platform = h.readUInt32BE(0x18) === 0x5d1c9ea3 ? 'wii' : h.readUInt32BE(0x1c) === 0xc2339f3d ? 'gc' : null;
  return platform ? { platform, serial: id } : null;
}

interface Logical {
  size: number;
  read(pos: number, len: number): Promise<Buffer>;
}

const CD_SYNC = Buffer.from([0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0]);

/** A disc's 2048-byte sectors over a plain image, a raw CD image (2352) or a CHD's CD frames (2448) */
function sectorReader(img: Logical, frame: number) {
  return async (lba: number, count = 1): Promise<Buffer> => {
    if (frame === 2048) return img.read(lba * 2048, count * 2048);
    const raw = await img.read(lba * frame, count * frame);
    const out = Buffer.alloc(count * 2048);
    for (let i = 0; i < count; i++) {
      const f = raw.subarray(i * frame, (i + 1) * frame);
      // Mode 1 data at 16, mode 2 form 1 at 24; a cooked track stored in a frame starts with its data
      const at = f.subarray(0, 12).equals(CD_SYNC) ? (f[15] === 2 ? 24 : 16) : 0;
      f.copy(out, i * 2048, at, at + 2048);
    }
    return out;
  };
}

async function disc(img: Logical, frame?: number): Promise<HeaderId | null> {
  const first = await img.read(0, Math.min(img.size, 0x60));
  if (!frame) {
    const nd = first.length >= 0x20 ? nintendoDisc(first) : null;
    if (nd) return nd;
    frame = first.subarray(0, 12).equals(CD_SYNC) ? 2352 : 2048;
  }
  const sector = sectorReader(img, frame);
  const s0 = await sector(0);
  if (s0.toString('latin1', 0, 15) === 'SEGA SEGASATURN') {
    const s = ascii(s0, 0x20, 10);
    return s ? { platform: 'saturn', serial: s } : null;
  }
  if (s0.toString('latin1', 0, 14) === 'SEGADISCSYSTEM') {
    const s = segaSerial(s0, 0x180);
    return s ? { platform: 'segacd', serial: s } : null;
  }
  if ((16 + 1) * frame > img.size) return null;
  const pvd = await sector(16);
  if (pvd[0] !== 1 || pvd.toString('latin1', 1, 6) !== 'CD001') return null;
  const root = { lba: pvd.readUInt32LE(156 + 2), size: pvd.readUInt32LE(156 + 10) };
  const entries = await isoDir(sector, root);
  const cnf = entries.get('SYSTEM.CNF');
  if (cnf) {
    const text = (await sector(cnf.lba, Math.ceil(Math.min(cnf.size, 4096) / 2048))).toString('latin1', 0, Math.min(cnf.size, 4096));
    const boot2 = /^\s*BOOT2\s*=\s*(.+)$/im.exec(text)?.[1];
    const boot = boot2 ?? /^\s*BOOT\s*=\s*(.+)$/im.exec(text)?.[1];
    const m = boot && /([A-Z]{4})[_-](\d{3})\.?(\d{2})/i.exec(boot);
    return m ? { platform: boot2 ? 'ps2' : 'psx', serial: `${m[1].toUpperCase()}-${m[2]}${m[3]}` } : null;
  }
  const umd = entries.get('UMD_DATA.BIN');
  if (umd) {
    const s = (await sector(umd.lba)).toString('latin1', 0, 64).split('|')[0];
    return /^[A-Z]{4}-\d{5}$/.test(s) ? { platform: 'psp', serial: s } : null;
  }
  return null;
}

/** The files of an ISO 9660 directory, by name without its ";1" version */
async function isoDir(sector: (lba: number, n?: number) => Promise<Buffer>, dir: { lba: number; size: number }) {
  const out = new Map<string, { lba: number; size: number }>();
  const n = Math.min(Math.ceil(dir.size / 2048), 16);
  const buf = await sector(dir.lba, n);
  for (let s = 0; s < n; s++) {
    let i = s * 2048;
    const end = i + 2048;
    while (i < end && buf[i]) {
      const len = buf[i];
      const nameLen = buf[i + 32];
      const name = buf.toString('latin1', i + 33, i + 33 + nameLen).replace(/;\d+$/, '').toUpperCase();
      out.set(name, { lba: buf.readUInt32LE(i + 2), size: buf.readUInt32LE(i + 10) });
      i += len;
    }
  }
  return out;
}

/**
 * A CHD's disc through chdman: the header and the hunk map are read first, then the hunks wanted are extracted
 * from a sparse copy holding what the device sent. Hunks are stored in order, so a hunk chdman cannot decode
 * (its checksum fails on the holes) means more of the file's start is needed.
 */
async function chd(src: Source): Promise<HeaderId | null> {
  const h = await src.read(0, 124);
  if (h.readUInt32BE(12) !== 5) return null;
  const logical = Number(h.readBigUInt64BE(0x20));
  const mapOffset = Number(h.readBigUInt64BE(0x28));
  const metaOffset = Number(h.readBigUInt64BE(0x30));
  const hunk = h.readUInt32BE(0x38);
  const unit = h.readUInt32BE(0x3c);
  // A CHD made against a parent needs the parent's hunks
  if (!h.subarray(0x74, 0x7c).equals(Buffer.alloc(8)) || !hunk) return null;
  const hunks = Math.ceil(logical / hunk);
  const compressed = h.readUInt32BE(0x10) !== 0;
  const mapLen = compressed ? 16 + (await src.read(mapOffset, 4)).readUInt32BE(0) : hunks * 4;
  await src.read(mapOffset, mapLen);
  // Metadata entries: tag, flags and length, next entry
  let meta = metaOffset;
  for (let i = 0; meta && i < 64; i++) {
    const e = await src.read(meta, 16);
    await src.read(meta + 16, e.readUInt32BE(4) & 0xffffff);
    meta = Number(e.readBigUInt64BE(8));
  }
  const dir = await tmpDir('probe');
  const sparse = path.join(dir, 'disc.chd');
  const cache = new Map<number, Buffer>();
  let written = -1;
  const img: Logical = {
    size: logical,
    async read(pos, len) {
      len = Math.max(0, Math.min(len, logical - pos));
      const a = Math.floor(pos / hunk);
      const b = Math.floor((pos + Math.max(len, 1) - 1) / hunk);
      const missing = [];
      for (let i = a; i <= b; i++) if (!cache.has(i)) missing.push(i);
      if (missing.length) {
        if (written !== src.prefix()) {
          await src.writeSparse(sparse);
          written = src.prefix();
        }
        const lo = missing[0];
        const hi = missing[missing.length - 1];
        const out = path.join(dir, 'part.raw');
        const r = await run(env.bins.chdman, ['extractraw', '-i', sparse, '-o', out, '-isb', String(lo * hunk), '-ib', String((hi - lo + 1) * hunk), '-f']);
        if (r.code !== 0) {
          const grow = Math.min(src.size, Math.max(src.prefix() * 4, 1 << 20));
          if (grow <= src.prefix()) throw new Error('CHD hunks unreadable');
          throw new NeedMore([[0, grow]]);
        }
        const raw = await fs.promises.readFile(out);
        for (let i = lo; i <= hi; i++) cache.set(i, raw.subarray((i - lo) * hunk, (i - lo + 1) * hunk));
      }
      const parts = [];
      for (let i = a; i <= b; i++) parts.push(cache.get(i)!);
      const all = Buffer.concat(parts);
      return all.subarray(pos - a * hunk, pos - a * hunk + len);
    },
  };
  try {
    // CD frames hold 2352 bytes of sector and 96 of subcode; DVDs are plain 2048-byte sectors
    return await disc(img, unit === 2448 ? 2448 : unit === 2048 ? 2048 : undefined);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

/**
 * A code as databases and headers may write it, for lookups: no spaces or dashes, no Sega revision suffix
 * ("T-48073-00" and "GM T-48073 -00" are both "T48073"), only the part before a "/" ("SLES-14107/GER").
 * GameCube and Wii go by the disc id's first four letters ("DL-DOL-GW7P-EUR", "RVL-RJ2P-EUR", "GW7P01").
 */
export function serialKeys(platform: string, serial: string): string[] {
  const s = serial.split('/')[0].toUpperCase().replace(/\s+/g, '');
  if (platform === 'gc' || platform === 'wii') {
    if (/^[A-Z0-9]{6}$/.test(s)) return [s.slice(0, 4)];
    return s.split('-').filter((p) => /^[A-Z0-9]{4}$/.test(p) && p !== 'DOL' && !/^RVL/.test(p));
  }
  const k = s.replace(/-\d{2}$/, '').replace(/[^A-Z0-9]/g, '');
  return k.length >= 3 && !/^0+$/.test(k) && k !== 'NA' ? [k] : [];
}
