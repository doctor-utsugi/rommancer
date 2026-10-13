/**
 * Romhack patch application: IPS, BPS (beat) and UPS. No external dependencies.
 * BPS and UPS carry crc32s of source, target and the patch itself: all three are checked.
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

/** Reader of beat's variable-length integers (BPS and UPS). */
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
      // RLE: repeat count + value
      if (pos + 3 > patch.length) throw new PatchError('Unexpected end of IPS patch');
      const count = patch.readUInt16BE(pos);
      const value = patch[pos + 2];
      pos += 3;
      grow(offset + count);
      out.fill(value, offset, offset + count);
    }
  }
  // Optional extension: final size (truncation)
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
        // Byte-by-byte: the copy may overlap what is being written
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

function varint(n: number, out: number[]) {
  for (;;) {
    const x = n % 128;
    n = Math.floor(n / 128);
    if (n === 0) {
      out.push(0x80 | x);
      return;
    }
    out.push(x);
    n--;
  }
}

/**
 * Builds a BPS patch turning `source` into `target`. Simple encoding: runs that
 * match at the same position are copied from the source (SourceRead), the rest goes literal (TargetRead).
 * Enough for hacks and translations, which change specific areas of the rom.
 */
export function createBps(source: Buffer, target: Buffer): Buffer {
  const out: number[] = [];
  const head = Buffer.from('BPS1', 'latin1');
  varint(source.length, out);
  varint(target.length, out);
  varint(0, out);
  const chunks: Buffer[] = [head, Buffer.from(out)];
  out.length = 0;
  // A short matching run does not pay off: a minimum is required to break the literal
  const MIN_RUN = 8;
  let pos = 0;
  const emit = (cmd: number, len: number, literal?: Buffer) => {
    const a: number[] = [];
    varint((len - 1) * 4 + cmd, a);
    chunks.push(Buffer.from(a));
    if (literal) chunks.push(literal);
  };
  while (pos < target.length) {
    let same = 0;
    while (pos + same < target.length && pos + same < source.length && source[pos + same] === target[pos + same]) same++;
    if (same >= MIN_RUN || (same > 0 && pos + same === target.length)) {
      emit(0, same);
      pos += same;
      continue;
    }
    // Literal until the next matching run that is long enough
    let end = pos + Math.max(same, 1);
    while (end < target.length) {
      let run = 0;
      while (run < MIN_RUN && end + run < target.length && end + run < source.length && source[end + run] === target[end + run]) run++;
      if (run >= MIN_RUN || (run > 0 && end + run === target.length)) break;
      end += Math.max(run, 1);
    }
    emit(1, end - pos, target.subarray(pos, end));
    pos = end;
  }
  const body = Buffer.concat(chunks);
  const foot = Buffer.alloc(8);
  foot.writeUInt32LE(zlib.crc32(source) >>> 0, 0);
  foot.writeUInt32LE(zlib.crc32(target) >>> 0, 4);
  const withFoot = Buffer.concat([body, foot]);
  const pc = Buffer.alloc(4);
  pc.writeUInt32LE(zlib.crc32(withFoot) >>> 0, 0);
  return Buffer.concat([withFoot, pc]);
}
