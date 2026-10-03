/**
 * Port a TypeScript de los algoritmos de hash de RetroAchievements (rcheevos/src/rhash, licencia MIT).
 * Los sistemas de cartucho "buffer" se resuelven a partir de los hashes ya calculados en el escaneo
 * (md5 completo o sin cabecera), el resto leyendo el fichero.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CdTrack } from './cdreader.js';
import type { FileHashes } from './hash.js';

const MAX_BUFFER = 64 * 1024 * 1024;

// Sistemas cuyo hash RA es el md5 de los datos (con o sin cabecera segun el sistema)
const BUFFER_SYSTEMS = new Set(['gb', 'gbc', 'gba', 'sms', 'gg', 'md', 'nes', 'fds', 'snes', 'lynx', 'a7800']);
const DISC_SYSTEMS = new Set(['psx', 'ps2', 'psp', 'gc', 'wii']);

/** Hash RA a partir de los hashes de escaneo, sin leer el fichero. Null si el sistema requiere el fichero. */
export function raHashFromHashes(system: string, h: FileHashes): string | null {
  if (!BUFFER_SYSTEMS.has(system)) return null;
  if (h.size > MAX_BUFFER) return null;
  if (['nes', 'fds', 'snes', 'lynx', 'a7800'].includes(system) && h.headerless) return h.headerless.md5;
  return h.md5;
}

/** Hash RA a partir de un DAT (hash de los datos sin cabecera). */
export function raHashFromDat(system: string, part: { md5: string | null; headerlessMd5: string | null; size: bigint | number }): string | null {
  if (!BUFFER_SYSTEMS.has(system) && system !== 'n64') return null;
  // No-Intro N64 esta en formato z64 (big endian), que es el que usa RA
  return part.headerlessMd5 ?? part.md5 ?? null;
}

export function raHashArcade(file: string): string {
  const base = path.basename(file, path.extname(file));
  return crypto.createHash('md5').update(base).digest('hex');
}

async function readAt(fd: fs.promises.FileHandle, pos: number, len: number): Promise<Buffer> {
  const b = Buffer.alloc(len);
  const { bytesRead } = await fd.read(b, 0, len, pos);
  return bytesRead < len ? b.subarray(0, bytesRead) : b;
}

export async function raHashN64(file: string): Promise<string | null> {
  const fd = await fs.promises.open(file, 'r');
  try {
    const first = (await readAt(fd, 0, 1))[0];
    let mode: 'z64' | 'v64' | 'n64';
    if (first === 0x80 || first === 0xe8 || first === 0x22) mode = 'z64';
    else if (first === 0x37) mode = 'v64';
    else if (first === 0x40) mode = 'n64';
    else return null;
    const size = Math.min((await fd.stat()).size, MAX_BUFFER);
    const md5 = crypto.createHash('md5');
    const chunk = 65536;
    for (let pos = 0; pos < size; pos += chunk) {
      const b = await readAt(fd, pos, Math.min(chunk, size - pos));
      if (mode === 'v64') b.swap16();
      else if (mode === 'n64') {
        const usable = b.length - (b.length % 4);
        b.subarray(0, usable).swap32();
      }
      md5.update(b);
    }
    return md5.digest('hex');
  } finally {
    await fd.close();
  }
}

export async function raHashNds(file: string): Promise<string | null> {
  const fd = await fs.promises.open(file, 'r');
  try {
    let header = await readAt(fd, 0, 512);
    if (header.length < 512) return null;
    let offset = 0;
    if (header[0] === 0x2e && header[1] === 0 && header[2] === 0 && header[3] === 0xea && header[0xb0] === 0x44 && header[0xb1] === 0x46 && header[0xb2] === 0x96 && header[0xb3] === 0) {
      offset = 512;
      header = await readAt(fd, 512, 512);
    }
    const arm9Addr = header.readUInt32LE(0x20);
    const arm9Size = header.readUInt32LE(0x2c);
    const arm7Addr = header.readUInt32LE(0x30);
    const arm7Size = header.readUInt32LE(0x3c);
    const iconAddr = header.readUInt32LE(0x68);
    if (arm9Size + arm7Size > 16 * 1024 * 1024) return null;
    const md5 = crypto.createHash('md5');
    md5.update(header.subarray(0, 0x160));
    md5.update(await readAt(fd, arm9Addr + offset, arm9Size));
    md5.update(await readAt(fd, arm7Addr + offset, arm7Size));
    const icon = Buffer.alloc(0xa00);
    (await readAt(fd, iconAddr + offset, 0xa00)).copy(icon);
    md5.update(icon);
    return md5.digest('hex');
  } finally {
    await fd.close();
  }
}

async function findPlaystationExe(track: CdTrack, bootKey: string, prefix: string) {
  const cnf = await track.findFile('SYSTEM.CNF');
  if (!cnf) return null;
  const text = (await track.readSector(cnf.sector, 2047)).toString('latin1');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(new RegExp(`^\\s*${bootKey}\\s*=\\s*(.*)$`));
    if (!m) continue;
    let v = m[1];
    if (v.startsWith(prefix)) v = v.slice(prefix.length);
    v = v.replace(/^\\+/, '');
    const exeName = v.match(/^[^\s;]*/)![0];
    const f = await track.findFile(exeName);
    return f ? { exeName, ...f } : null;
  }
  return null;
}

export async function raHashPsx(discFile: string): Promise<string | null> {
  const track = await CdTrack.open(discFile);
  try {
    let exe = await findPlaystationExe(track, 'BOOT', 'cdrom:');
    if (!exe) {
      const f = await track.findFile('PSX.EXE');
      if (f) exe = { exeName: 'PSX.EXE', ...f };
    }
    if (!exe) return null;
    const head = await track.readSector(exe.sector, 32);
    let size = exe.size;
    if (head.toString('latin1', 0, 7) === 'PS-X EX') size = head.readUInt32LE(28) + 2048;
    const md5 = crypto.createHash('md5');
    md5.update(exe.exeName);
    md5.update(await track.readFile(exe.sector, size));
    return md5.digest('hex');
  } finally {
    await track.close();
  }
}

export async function raHashPs2(discFile: string): Promise<string | null> {
  const track = await CdTrack.open(discFile);
  try {
    const exe = await findPlaystationExe(track, 'BOOT2', 'cdrom0:');
    if (!exe) return null;
    const md5 = crypto.createHash('md5');
    md5.update(exe.exeName);
    md5.update(await track.readFile(exe.sector, exe.size));
    return md5.digest('hex');
  } finally {
    await track.close();
  }
}

export async function raHashPsp(discFile: string): Promise<string | null> {
  if (discFile.toLowerCase().endsWith('.pbp')) {
    const st = await fs.promises.stat(discFile);
    const md5 = crypto.createHash('md5');
    let n = 0;
    for await (const c of fs.createReadStream(discFile, { end: Math.min(st.size, MAX_BUFFER) - 1 })) {
      md5.update(c as Buffer);
      n++;
    }
    return n ? md5.digest('hex') : null;
  }
  const track = await CdTrack.open(discFile);
  try {
    const sfo = await track.findFile('PSP_GAME\\PARAM.SFO');
    if (!sfo) return null;
    const eboot = await track.findFile('PSP_GAME\\SYSDIR\\EBOOT.BIN');
    if (!eboot) return null;
    const md5 = crypto.createHash('md5');
    md5.update(await track.readFile(sfo.sector, sfo.size));
    md5.update(await track.readFile(eboot.sector, eboot.size));
    return md5.digest('hex');
  } finally {
    await track.close();
  }
}

export type ReadAt = (pos: number, len: number) => Promise<Buffer>;

/** Cabeceras de particion + segmentos del main.dol (rc_hash_nintendo_disc_partition). shift=2 en Wii. */
async function hashNintendoPartition(md5: crypto.Hash, readAt: ReadAt, partOffset: number, shift: number) {
  const BASE = 0x2440;
  const sizes = await readAt(partOffset + BASE + 0x14, 8);
  let headerSize = BASE + 0x20 + sizes.readUInt32BE(0) + sizes.readUInt32BE(4);
  if (headerSize > 1024 * 1024) headerSize = 1024 * 1024;
  const header = await readAt(partOffset, headerSize);
  md5.update(header);
  const dolOffset = header.readUInt32BE(0x420) * 2 ** shift;
  const addr = await readAt(partOffset + dolOffset, 0xd8);
  for (let i = 0; i < 18; i++) {
    const off = addr.readUInt32BE(i * 4) * 2 ** shift;
    const size = addr.readUInt32BE(0x90 + i * 4) * 2 ** shift;
    if (size) md5.update(await readAt(partOffset + off, size));
  }
}

/** GameCube: readAt permite leer de ISO o de RVZ. */
export async function raHashGamecubeFrom(readAt: ReadAt): Promise<string | null> {
  const magic = await readAt(0x1c, 4);
  if (!magic.equals(Buffer.from([0xc2, 0x33, 0x9f, 0x3d]))) return null;
  const md5 = crypto.createHash('md5');
  await hashNintendoPartition(md5, readAt, 0, 0);
  return md5.digest('hex');
}

/** Wii (rc_hash_wii): disco (cifrado o descifrado) o WiiWare (.wad). */
export async function raHashWiiFrom(readAt: ReadAt): Promise<string | null> {
  const md5 = crypto.createHash('md5');
  const be = async (pos: number) => (await readAt(pos, 4)).readUInt32BE(0);
  if ((await readAt(0x18, 4)).equals(Buffer.from([0x5d, 0x1c, 0x9e, 0xa3]))) {
    const CLUSTER = 0x7c00;
    const encrypted = (await readAt(0x61, 1))[0] === 0;
    md5.update(await readAt(0, 0x80));
    md5.update(await readAt(0x4e000, 4));
    const info: number[] = [];
    for (let i = 0; i < 8; i++) info.push(await be(0x40000 + i * 4));
    const parts: [number, number][] = [];
    for (let j = 0; j < 8; j += 2) for (let i = 0; i < info[j]; i++) parts.push([await be(info[j + 1] * 4 + i * 8), await be(info[j + 1] * 4 + i * 8 + 4)]);
    if (!parts.length) return null;
    for (const [off4, type] of parts) {
      if (type === 1) continue; // particion de actualizacion
      const base = off4 * 4;
      const tmdSize = Math.min(await be(base + 0x2a4), CLUSTER);
      const tmdOffset = (await be(base + 0x2a8)) * 4;
      md5.update(await readAt(base + tmdOffset, tmdSize));
      const partOffset = (await be(base + 0x2b8)) * 4;
      const partSize = (await be(base + 0x2bc)) * 4;
      if (encrypted) {
        const clusters = Math.min(Math.floor(partSize / 0x8000), 1024);
        for (let c = 0; c < clusters; c++) md5.update(await readAt(partOffset + c * 0x8000 + 0x400, CLUSTER));
      } else {
        await hashNintendoPartition(md5, readAt, partOffset, 2);
      }
    }
    return md5.digest('hex');
  }
  const is = await readAt(0x04, 4);
  if (is.equals(Buffer.from([0x49, 0x73, 0, 0]))) {
    const align = (n: number, a: number) => (n + a - 1) & ~(a - 1);
    const cert = align(await be(0x08), 0x40);
    const ticket = align(await be(0x10), 0x40);
    const tmdSize = Math.min(align(await be(0x14), 0x40), MAX_BUFFER);
    const tmdStart = 0x40 + cert + ticket;
    md5.update(await readAt(tmdStart, tmdSize));
    const count = (await readAt(tmdStart + 0x1de, 2)).readUInt16BE(0);
    let contentAddr = tmdStart + tmdSize;
    for (let i = 0; i < count; i++) {
      const hi = await be(tmdStart + 0x1e4 + 8 + i * 0x24);
      const size = hi === 0 ? align(await be(tmdStart + 0x1e4 + 12 + i * 0x24), 0x10) : MAX_BUFFER;
      md5.update(await readAt(contentAddr, Math.min(size, MAX_BUFFER)));
      contentAddr = align(contentAddr + size, 0x40);
    }
    return md5.digest('hex');
  }
  return null;
}

async function withReader<T>(file: string, fn: (readAt: ReadAt) => Promise<T>): Promise<T> {
  if (/\.(rvz|wia)$/i.test(file)) {
    const { RvzReader } = await import('./rvz.js');
    const r = await RvzReader.open(file);
    try {
      return await fn((pos, len) => r.read(pos, len));
    } finally {
      await r.close();
    }
  }
  const fd = await fs.promises.open(file, 'r');
  try {
    return await fn((pos, len) => readAt(fd, pos, len));
  } finally {
    await fd.close();
  }
}

export const raHashWii = (file: string) => withReader(file, raHashWiiFrom);

export const raHashGamecube = (file: string) => withReader(file, raHashGamecubeFrom);

/** Hash RA leyendo el fichero (sistemas no-buffer). discFile: .iso/.cue/.bin ya extraido. */
export async function raHashFile(system: string, file: string): Promise<string | null> {
  try {
    switch (system) {
      case 'n64':
        return await raHashN64(file);
      case 'nds':
        return await raHashNds(file);
      case 'psx':
        return await raHashPsx(file);
      case 'ps2':
        return await raHashPs2(file);
      case 'psp':
        return await raHashPsp(file);
      case 'gc':
        return await raHashGamecube(file);
      case 'wii':
        return await raHashWii(file);
      case 'fbneo':
        return raHashArcade(file);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export const isDiscSystem = (s: string) => DISC_SYSTEMS.has(s);
export const needsFileForRa = (s: string) => !BUFFER_SYSTEMS.has(s);
