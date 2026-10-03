/**
 * Conversion de saves entre emuladores.
 * - raw: SRAM tal cual (.srm de RetroArch, .sav de mGBA/standalone). Solo cambia extension y, si se pide, el tamano.
 * - ps1card (128 KB: .mcr/.mcd/.srm), ps1gme (DexDrive, cabecera de 3904 bytes), ps1vmp (PSP/PS3, firmado).
 * Algoritmo de firma VMP portado de MemcardRex (GPL-3.0).
 */
import crypto from 'node:crypto';
import { HttpError } from '../../lib/http.js';

export type SaveFormat = 'raw' | 'ps1card' | 'ps1gme' | 'ps1vmp';

const PS1_SIZE = 0x20000;
const GME_HEADER = 3904;
const VMP_HEADER = 0x80;

const SAVE_KEY = Buffer.from('AB5ABC9FC1F49DE6A051DBAEFA518859', 'hex');
const SAVE_IV = Buffer.from('B30FFEEDB7DC5EEB133DA60D1B6B2CDC', 'hex');

function aesEcb(encrypt: boolean, data: Buffer): Buffer {
  const c = encrypt ? crypto.createCipheriv('aes-128-ecb', SAVE_KEY, null) : crypto.createDecipheriv('aes-128-ecb', SAVE_KEY, null);
  c.setAutoPadding(false);
  const padded = Buffer.alloc(Math.ceil(data.length / 16) * 16);
  data.copy(padded);
  const blocks = encrypt ? padded : padded.subarray(0, data.length - (data.length % 16));
  return Buffer.concat([c.update(blocks), c.final()]);
}

const xor16 = (dst: Buffer, src: Buffer) => {
  for (let i = 0; i < 16; i++) dst[i] ^= src[i];
};

function vmpHmac(data: Buffer, saltSeed: Buffer): Buffer {
  const buffer = Buffer.alloc(0x14);
  const salt = Buffer.alloc(0x40);
  saltSeed.copy(buffer, 0, 0, 0x14);
  aesEcb(false, buffer).copy(buffer, 0, 0, 0x10);
  buffer.copy(salt, 0, 0, 0x10);
  saltSeed.copy(buffer, 0, 0, 0x10);
  aesEcb(true, buffer).copy(buffer, 0, 0, 0x14);
  buffer.copy(salt, 0x10, 0, 0x10);
  xor16(salt, SAVE_IV);
  saltSeed.copy(buffer, 0, 0x10, 0x14);
  const temp = Buffer.from(salt.subarray(0x10, 0x24));
  xor16(temp, buffer);
  temp.copy(salt, 0x10, 0, 0x10);
  const head = Buffer.from(salt.subarray(0, 0x14));
  salt.fill(0, 0x14);
  head.copy(salt, 0);
  for (let i = 0; i < 0x40; i++) salt[i] ^= 0x36;
  const inner = crypto.createHash('sha1').update(salt).update(data).digest();
  for (let i = 0; i < 0x40; i++) salt[i] ^= 0x6a;
  return crypto.createHash('sha1').update(salt).update(inner).digest();
}

export function ps1ToRaw(buf: Buffer, fmt: SaveFormat): Buffer {
  let raw: Buffer;
  if (fmt === 'ps1gme' || buf.subarray(0, 11).toString('latin1') === '123-456-STD') raw = buf.subarray(GME_HEADER);
  else if (fmt === 'ps1vmp' || buf.subarray(0, 4).equals(Buffer.from([0, 0x50, 0x4d, 0x56]))) raw = buf.subarray(VMP_HEADER);
  else raw = buf;
  if (raw.length < PS1_SIZE) throw new HttpError(400, `Invalid PS1 memory card size ${raw.length}`);
  raw = Buffer.from(raw.subarray(0, PS1_SIZE));
  if (raw[0] !== 0x4d || raw[1] !== 0x43) throw new HttpError(400, 'Not a PS1 memory card (missing MC signature)');
  return raw;
}

export function rawToGme(raw: Buffer): Buffer {
  const h = Buffer.alloc(GME_HEADER);
  h.write('123-456-STD', 0, 'latin1');
  h[18] = 1;
  h[20] = 1;
  h[21] = 0x4d;
  for (let slot = 0; slot < 15; slot++) {
    h[22 + slot] = raw[128 + slot * 128];
    h[38 + slot] = raw[128 + slot * 128 + 8];
  }
  return Buffer.concat([h, raw]);
}

export function rawToVmp(raw: Buffer): Buffer {
  const vmp = Buffer.alloc(VMP_HEADER + PS1_SIZE);
  vmp[1] = 0x50;
  vmp[2] = 0x4d;
  vmp[3] = 0x56;
  vmp[4] = 0x80;
  raw.copy(vmp, VMP_HEADER, 0, PS1_SIZE);
  const saltSeed = crypto.createHash('sha1').update(vmp).digest();
  saltSeed.copy(vmp, 0x0c);
  vmpHmac(vmp, saltSeed).copy(vmp, 0x20);
  return vmp;
}

export function verifyVmp(vmp: Buffer): boolean {
  const copy = Buffer.from(vmp);
  const sig = Buffer.from(copy.subarray(0x20, 0x34));
  copy.fill(0, 0x20, 0x34);
  return vmpHmac(copy, copy.subarray(0x0c, 0x20)).equals(sig);
}

const isPs1 = (f: SaveFormat) => f.startsWith('ps1');

/** Convierte un save entre formatos. targetSize permite recortar/rellenar SRAM (raw). */
export function convertSave(buf: Buffer, from: SaveFormat, to: SaveFormat, targetSize?: number): Buffer {
  if (isPs1(from) !== isPs1(to)) throw new HttpError(400, `Incompatible formats ${from} -> ${to}`);
  if (isPs1(from)) {
    const raw = ps1ToRaw(buf, from);
    if (to === 'ps1gme') return rawToGme(raw);
    if (to === 'ps1vmp') return rawToVmp(raw);
    return raw;
  }
  if (targetSize && targetSize !== buf.length) {
    if (targetSize < buf.length) return Buffer.from(buf.subarray(0, targetSize));
    const out = Buffer.alloc(targetSize, 0xff);
    buf.copy(out);
    return out;
  }
  return buf;
}
