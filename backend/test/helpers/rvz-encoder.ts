// Codificador RVZ minimo para pruebas
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { lfgBytes } from '../../src/lib/rvz.js';

export const sha1 = (b: Buffer) => crypto.createHash('sha1').update(b).digest();
export const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const u64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};

export interface EncGroup {
  data: Buffer; // datos tal como se guardan (comprimidos o no)
  compressed: boolean;
  packedSize: number;
  empty?: boolean;
}

/** Codificador RVZ minimo para pruebas (compresion Zstandard). */
export function buildRvz(opts: {
  discType: number;
  chunkSize: number;
  isoSize: number;
  discHeader: Buffer;
  partitions: { key: Buffer; pd: [number, number, number, number][] }[];
  raws: [number, number, number, number][];
  groups: EncGroup[];
}): Buffer {
  const parts = Buffer.concat(
    opts.partitions.map((p) => Buffer.concat([p.key, ...p.pd.flatMap((d) => d.map(u32))])),
  );
  const raws = zlib.zstdCompressSync(Buffer.concat(opts.raws.map(([o, s, gi, n]) => Buffer.concat([u64(o), u64(s), u32(gi), u32(n)]))));
  const dataStart = 0x48 + 0xdc;
  const partOff = dataStart;
  const rawOff = partOff + parts.length;
  let pos = (rawOff + raws.length + 3) & ~3;
  const blobs: Buffer[] = [];
  const entries: Buffer[] = [];
  const groupTableOff = pos;
  // la tabla de grupos se coloca despues de los datos: se calcula primero el tamano de los datos
  let dataPos = 0;
  const groupData: { off: number; g: EncGroup }[] = [];
  for (const g of opts.groups) {
    groupData.push({ off: dataPos, g });
    dataPos += (g.data.length + 3) & ~3;
  }
  const groupsBlobStart = groupTableOff;
  for (const { off, g } of groupData) {
    const size = g.empty ? 0 : g.data.length | (g.compressed ? 0x80000000 : 0);
    entries.push(Buffer.concat([u32((groupsBlobStart + off) / 4), u32(size), u32(g.packedSize)]));
    const padded = Buffer.alloc((g.data.length + 3) & ~3);
    g.data.copy(padded);
    blobs.push(g.empty ? Buffer.alloc(0) : padded);
  }
  const groupsData = Buffer.concat(blobs);
  const groupTable = zlib.zstdCompressSync(Buffer.concat(entries));
  const groupTableRealOff = groupsBlobStart + groupsData.length;
  pos = groupTableRealOff + groupTable.length;

  const h2 = Buffer.alloc(0xdc);
  h2.writeUInt32BE(opts.discType, 0);
  h2.writeUInt32BE(5, 4);
  h2.writeInt32BE(5, 8);
  h2.writeUInt32BE(opts.chunkSize, 12);
  opts.discHeader.copy(h2, 16, 0, 0x80);
  h2.writeUInt32BE(opts.partitions.length, 0x90);
  h2.writeUInt32BE(0x30, 0x94);
  h2.writeBigUInt64BE(BigInt(partOff), 0x98);
  sha1(parts).copy(h2, 0xa0);
  h2.writeUInt32BE(opts.raws.length, 0xb4);
  h2.writeBigUInt64BE(BigInt(rawOff), 0xb8);
  h2.writeUInt32BE(raws.length, 0xc0);
  h2.writeUInt32BE(opts.groups.length, 0xc4);
  h2.writeBigUInt64BE(BigInt(groupTableRealOff), 0xc8);
  h2.writeUInt32BE(groupTable.length, 0xd0);

  const h1 = Buffer.alloc(0x48);
  h1.write('RVZ\x01', 0, 'latin1');
  h1.writeUInt32BE(0x01000000, 4);
  h1.writeUInt32BE(0x00030000, 8);
  h1.writeUInt32BE(0xdc, 12);
  sha1(h2).copy(h1, 0x10);
  h1.writeBigUInt64BE(BigInt(opts.isoSize), 0x24);
  h1.writeBigUInt64BE(BigInt(pos), 0x2c);
  sha1(h1.subarray(0, 0x34)).copy(h1, 0x34);

  const file = Buffer.alloc(pos);
  h1.copy(file, 0);
  h2.copy(file, 0x48);
  parts.copy(file, partOff);
  raws.copy(file, rawOff);
  groupsData.copy(file, groupsBlobStart);
  groupTable.copy(file, groupTableRealOff);
  return file;
}


/** ISO GameCube sintetica (con cabecera, apploader y main.dol) y su RVZ. */
export function makeGcRvz() {
  const chunk = 0x20000;
  const iso = Buffer.alloc(8 * chunk);
  crypto.randomBytes(0x40000).copy(iso, 0);
  // Cabecera GameCube con apploader y main.dol para el hash de RetroAchievements
  iso.writeUInt32BE(0xc2339f3d, 0x1c);
  iso.writeUInt32BE(0x1000, 0x2440 + 0x14);
  iso.writeUInt32BE(0x100, 0x2440 + 0x18);
  iso.writeUInt32BE(0x30000, 0x420);
  iso.fill(0, 0x30000, 0x300d8);
  iso.writeUInt32BE(0x31000, 0x30000);
  iso.writeUInt32BE(0x2000, 0x30090);
  // [0x40000, 0x80000): ceros -> grupos vacios
  iso.fill(0, 0x40000, 0x80000);
  // [0x80000, 0xC0000): relleno pseudoaleatorio, un grupo entero y otro con literal + relleno
  const seedA = crypto.randomBytes(68);
  const seedB = crypto.randomBytes(68);
  lfgBytes(seedA, chunk, 0).copy(iso, 0x80000);
  const literal = crypto.randomBytes(0x100);
  literal.copy(iso, 0xa0000);
  lfgBytes(seedB, chunk - 0x100, 0x100).copy(iso, 0xa0100);
  crypto.randomBytes(0x40000).copy(iso, 0xc0000);

  const groups: EncGroup[] = [];
  for (let g = 0; g < 8; g++) {
    const start = g * chunk;
    const data = iso.subarray(start, start + chunk);
    if (g === 2 || g === 3) groups.push({ data: Buffer.alloc(0), compressed: false, packedSize: 0, empty: true });
    else if (g === 4) {
      const packed = Buffer.concat([u32(chunk | 0x80000000), seedA]);
      groups.push({ data: zlib.zstdCompressSync(packed), compressed: true, packedSize: packed.length });
    } else if (g === 5) {
      const packed = Buffer.concat([u32(0x100), literal, u32((chunk - 0x100) | 0x80000000), seedB]);
      // empaquetado sin comprimir
      groups.push({ data: packed, compressed: false, packedSize: packed.length });
    } else if (g === 7) groups.push({ data: Buffer.from(data), compressed: false, packedSize: 0 });
    else groups.push({ data: zlib.zstdCompressSync(data), compressed: true, packedSize: 0 });
  }
  const rvz = buildRvz({ discType: 1, chunkSize: chunk, isoSize: iso.length, discHeader: iso.subarray(0, 0x80), partitions: [], raws: [[0x80, iso.length - 0x80, 0, 8]], groups });
  return { iso, rvz, seedA, seedB };
}
