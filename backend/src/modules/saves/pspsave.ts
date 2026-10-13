/**
 * PSP saves: a folder per save under SAVEDATA, named by the game's product code and a suffix of the game's
 * ("ULUS10336DATA00"), holding PARAM.SFO, the game's files and its icons. A folder travels as a tar of it (its files
 * under "<folder>/", sorted, with no dates or owners). A device tells a folder by its manifest, a line "<path>\t<sha1>"
 * per file sorted by path, hashed: any tar of the same files has the same one, so clients need no exact tar.
 */
import crypto from 'node:crypto';

const BLOCK = 512;

export class PspSaveError extends Error {}

export interface PspEntry {
  /** The folder's name */
  name: string;
  /** Product code from the name, as the DATs write it ("ULUS-10336") */
  productCode: string | null;
  /** The save's title from PARAM.SFO */
  title: string | null;
  /** Size in KB */
  blocks: number;
  /** The folder as a canonical tar */
  tar: Buffer;
  sha1: string;
}

export function productCodeOf(name: string): string | null {
  const m = /^([A-Z]{4})(\d{5})/.exec(name);
  return m ? `${m[1]}-${m[2]}` : null;
}

const octal = (n: number, len: number) => n.toString(8).padStart(len - 1, '0') + '\0';

function header(name: string, size: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(0o644, 8), 100, 'latin1');
  h.write(octal(0, 8), 108, 'latin1');
  h.write(octal(0, 8), 116, 'latin1');
  h.write(octal(size, 12), 124, 'latin1');
  h.write(octal(0, 12), 136, 'latin1');
  h.fill(0x20, 148, 156);
  h.write('0', 156, 'latin1');
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + ' ', 148, 'latin1');
  return h;
}

/** The canonical tar of a folder's files (paths inside it, "/" separated) */
export function packPspFolder(name: string, files: { path: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const full = `${name}/${f.path}`;
    if (Buffer.byteLength(full) > 100) throw new PspSaveError(`Path too long: ${full}`);
    parts.push(header(full, f.data.length), f.data, Buffer.alloc((BLOCK - (f.data.length % BLOCK)) % BLOCK));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

/** The files of a tar of one folder (any tar: directories and other entries are skipped) */
function unpack(tar: Buffer) {
  const files: { path: string; data: Buffer }[] = [];
  let at = 0;
  while (at + BLOCK <= tar.length) {
    const h = tar.subarray(at, at + BLOCK);
    if (h.every((b) => b === 0)) break;
    const field = (o: number, l: number) => {
      const raw = h.subarray(o, o + l);
      const end = raw.indexOf(0);
      return raw.subarray(0, end < 0 ? l : end).toString('utf8');
    };
    let name = field(0, 100);
    const prefix = h.subarray(257, 262).toString('latin1') === 'ustar' ? field(345, 155) : '';
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(field(124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new PspSaveError('Bad tar header');
    const type = String.fromCharCode(h[156]);
    at += BLOCK;
    if (at + size > tar.length) throw new PspSaveError('Truncated tar');
    if (type === '0' || type === '\0') files.push({ path: name.replace(/^\.\//, ''), data: Buffer.from(tar.subarray(at, at + size)) });
    at += Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}

/** PARAM.SFO's string value for KEY */
function sfoValue(sfo: Buffer | undefined, key: string): string | null {
  if (!sfo || sfo.length < 20 || sfo.readUInt32BE(0) !== 0x00505346) return null;
  const keys = sfo.readUInt32LE(8);
  const data = sfo.readUInt32LE(12);
  const count = sfo.readUInt32LE(16);
  for (let i = 0; i < count && 20 + i * 16 + 16 <= sfo.length; i++) {
    const e = 20 + i * 16;
    const k = sfo.subarray(keys + sfo.readUInt16LE(e), keys + sfo.readUInt16LE(e) + 64);
    if (k.subarray(0, Math.max(0, k.indexOf(0))).toString('latin1') !== key) continue;
    const v = sfo.subarray(data + sfo.readUInt32LE(e + 12), data + sfo.readUInt32LE(e + 12) + sfo.readUInt32LE(e + 4));
    const end = v.indexOf(0);
    return v.subarray(0, end < 0 ? v.length : end).toString('utf8').replace(/\s+/g, ' ').trim() || null;
  }
  return null;
}

const sha1 = (b: Buffer | string) => crypto.createHash('sha1').update(b).digest('hex');

/** The hash a device reports for a save folder holding FILES (paths inside the folder) */
export function manifestHash(files: { path: string; data: Buffer }[]) {
  const lines = files.map((f) => `${f.path}\t${sha1(f.data)}\n`);
  return sha1(lines.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).join(''));
}

/** The manifest hash of a save folder's tar ("-" style empty folder for an empty file) */
export function folderHash(tar: Buffer) {
  if (!tar.length) return sha1(tar);
  const name = readPspFolder(tar).name;
  return manifestHash(unpack(tar).map((f) => ({ path: f.path.slice(name.length + 1), data: f.data })));
}

/** A save folder from its tar; the folder is the tar's single top-level directory */
export function readPspFolder(tar: Buffer): PspEntry {
  const files = unpack(tar);
  const tops = new Set(files.map((f) => f.path.split('/')[0]));
  if (tops.size !== 1 || files.some((f) => !f.path.includes('/'))) throw new PspSaveError('Not one save folder');
  const name = [...tops][0];
  const inner = files.map((f) => ({ path: f.path.slice(name.length + 1), data: f.data }));
  const canonical = packPspFolder(name, inner);
  const sfo = inner.find((f) => f.path.toUpperCase() === 'PARAM.SFO')?.data;
  return {
    name,
    productCode: productCodeOf(name),
    title: sfoValue(sfo, 'TITLE') ?? sfoValue(sfo, 'SAVEDATA_TITLE'),
    blocks: Math.ceil(inner.reduce((n, f) => n + f.data.length, 0) / 1024),
    tar: canonical,
    sha1: sha1(canonical),
  };
}
