/**
 * Aplicacion de parches de romhacks: IPS, BPS (beat) y UPS. Sin dependencias externas.
 * BPS y UPS llevan crc32 de origen, destino y del propio parche: se validan los tres.
 */
import zlib from 'node:zlib';

export type PatchFormat = 'ips' | 'bps' | 'ups';

export interface PatchInfo {
  format: PatchFormat;
  sourceSize?: number;
  targetSize?: number;
  sourceCrc32?: string;
  targetCrc32?: string;
  patchCrc32?: string;
}

export class PatchError extends Error {}

const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
const crc = (b: Buffer) => hex(zlib.crc32(b));

export function detectPatchFormat(patch: Buffer): PatchFormat | null {
  const m = patch.toString('latin1', 0, 5);
  if (m === 'PATCH') return 'ips';
  if (m.startsWith('BPS1')) return 'bps';
  if (m.startsWith('UPS1')) return 'ups';
  return null;
}

/** Lector de enteros de longitud variable de beat (BPS) y UPS. */
class Reader {
  pos: number;
  constructor(
    private buf: Buffer,
    start: number,
    private end: number,
  ) {
    this.pos = start;
  }
  byte() {
    if (this.pos >= this.end) throw new PatchError('Unexpected end of patch');
    return this.buf[this.pos++];
  }
  varint() {
    let data = 0;
    let shift = 1;
    for (;;) {
      const x = this.byte();
      data += (x & 0x7f) * shift;
      if (x & 0x80) break;
      shift *= 128;
      data += shift;
    }
    return data;
  }
}

function footer(patch: Buffer) {
  if (patch.length < 16) throw new PatchError('Patch too short');
  const n = patch.length;
  return { source: hex(patch.readUInt32LE(n - 12)), target: hex(patch.readUInt32LE(n - 8)), patch: hex(patch.readUInt32LE(n - 4)) };
}

export function patchInfo(patch: Buffer): PatchInfo {
  const format = detectPatchFormat(patch);
  if (!format) throw new PatchError('Unknown patch format');
  if (format === 'ips') return { format };
  const r = new Reader(patch, 4, patch.length - 12);
  const sourceSize = r.varint();
  const targetSize = r.varint();
  const f = footer(patch);
  return { format, sourceSize, targetSize, sourceCrc32: f.source, targetCrc32: f.target, patchCrc32: f.patch };
}

function checkPatchCrc(patch: Buffer) {
  const f = footer(patch);
  if (crc(patch.subarray(0, patch.length - 4)) !== f.patch) throw new PatchError('patch checksum mismatch');
  return f;
}

function applyIps(source: Buffer, patch: Buffer): Buffer {
  let out = Buffer.from(source);
  let pos = 5;
  const grow = (size: number) => {
    if (size > out.length) {
      const b = Buffer.alloc(size);
      out.copy(b);
      out = b;
    }
  };
  for (;;) {
    if (pos + 3 > patch.length) throw new PatchError('Unexpected end of IPS patch');
    if (patch.toString('latin1', pos, pos + 3) === 'EOF') {
      pos += 3;
      break;
    }
    if (pos + 5 > patch.length) throw new PatchError('Unexpected end of IPS patch');
    const offset = patch.readUIntBE(pos, 3);
    const size = patch.readUInt16BE(pos + 3);
    pos += 5;
    if (size) {
      if (pos + size > patch.length) throw new PatchError('Unexpected end of IPS patch');
      grow(offset + size);
      patch.copy(out, offset, pos, pos + size);
      pos += size;
    } else {
      // RLE: repeticiones + valor
      if (pos + 3 > patch.length) throw new PatchError('Unexpected end of IPS patch');
      const count = patch.readUInt16BE(pos);
      const value = patch[pos + 2];
      pos += 3;
      grow(offset + count);
      out.fill(value, offset, offset + count);
    }
  }
  // Extension opcional: tamano final (truncado)
  if (pos + 3 <= patch.length) {
    const size = patch.readUIntBE(pos, 3);
    if (size < out.length) out = out.subarray(0, size);
    else grow(size);
  }
  return out;
}

function applyBps(source: Buffer, patch: Buffer): Buffer {
  const f = checkPatchCrc(patch);
  const r = new Reader(patch, 4, patch.length - 12);
  const sourceSize = r.varint();
  const targetSize = r.varint();
  const metaSize = r.varint();
  r.pos += metaSize;
  if (source.length !== sourceSize || crc(source) !== f.source) throw new PatchError('source checksum mismatch');
  const out = Buffer.alloc(targetSize);
  let outPos = 0;
  let srcRel = 0;
  let tgtRel = 0;
  const end = patch.length - 12;
  while (r.pos < end) {
    const data = r.varint();
    const cmd = data & 3;
    const len = Math.floor(data / 4) + 1;
    if (outPos + len > targetSize) throw new PatchError('BPS writes past target');
    if (cmd === 0) {
      source.copy(out, outPos, outPos, outPos + len);
    } else if (cmd === 1) {
      if (r.pos + len > end) throw new PatchError('Unexpected end of BPS patch');
      patch.copy(out, outPos, r.pos, r.pos + len);
      r.pos += len;
    } else {
      const d = r.varint();
      const delta = (d & 1 ? -1 : 1) * Math.floor(d / 2);
      if (cmd === 2) {
        srcRel += delta;
        if (srcRel < 0 || srcRel + len > source.length) throw new PatchError('BPS source copy out of range');
        source.copy(out, outPos, srcRel, srcRel + len);
        srcRel += len;
      } else {
        tgtRel += delta;
        if (tgtRel < 0 || tgtRel >= outPos + len) throw new PatchError('BPS target copy out of range');
        // Byte a byte: la copia puede solaparse con lo que se esta escribiendo
        for (let i = 0; i < len; i++) out[outPos + i] = out[tgtRel++];
      }
    }
    outPos += len;
  }
  if (crc(out) !== f.target) throw new PatchError('target checksum mismatch');
  return out;
}

function applyUps(source: Buffer, patch: Buffer): Buffer {
  const f = checkPatchCrc(patch);
  const r = new Reader(patch, 4, patch.length - 12);
  const inputSize = r.varint();
  const outputSize = r.varint();
  if (source.length !== inputSize || crc(source) !== f.source) throw new PatchError('source checksum mismatch');
  const out = Buffer.alloc(outputSize);
  source.copy(out, 0, 0, Math.min(source.length, outputSize));
  let pos = 0;
  const end = patch.length - 12;
  while (r.pos < end) {
    pos += r.varint();
    for (;;) {
      const x = r.byte();
      if (x === 0) {
        pos++;
        break;
      }
      if (pos < outputSize) out[pos] = (pos < source.length ? source[pos] : 0) ^ x;
      pos++;
    }
  }
  if (crc(out) !== f.target) throw new PatchError('target checksum mismatch');
  return out;
}

export function applyPatch(source: Buffer, patch: Buffer): Buffer {
  const format = detectPatchFormat(patch);
  if (format === 'ips') return applyIps(source, patch);
  if (format === 'bps') return applyBps(source, patch);
  if (format === 'ups') return applyUps(source, patch);
  throw new PatchError('Unknown patch format');
}
