import fs from 'node:fs';
import path from 'node:path';

/**
 * Lector de sectores de datos (2048 bytes) de la primera pista de un disco.
 * Soporta .iso (2048), .bin raw (2352, modo 1 y modo 2) y .cue (usa el primer fichero de la pista 1).
 */
export class CdTrack {
  private constructor(
    private fd: fs.promises.FileHandle,
    private sectorSize: number,
    private dataOffset: number,
    private firstSector: number,
  ) {}

  static async open(file: string): Promise<CdTrack> {
    let target = file;
    let pregap = 0;
    if (path.extname(file).toLowerCase() === '.cue') {
      const parsed = await parseCue(file);
      const t1 = parsed.tracks[0];
      if (!t1) throw new Error('Cue without tracks');
      target = t1.file;
      pregap = t1.index1;
    }
    const fd = await fs.promises.open(target, 'r');
    const head = Buffer.alloc(16);
    await fd.read(head, 0, 16, 0);
    const sync = head.subarray(0, 12).equals(Buffer.from([0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0]));
    if (sync) {
      const mode = head[15];
      return new CdTrack(fd, 2352, mode === 2 ? 24 : 16, pregap);
    }
    return new CdTrack(fd, 2048, 0, pregap);
  }

  firstTrackSector() {
    return this.firstSector;
  }

  async readSector(sector: number, length = 2048): Promise<Buffer> {
    const buf = Buffer.alloc(Math.min(length, 2048));
    const { bytesRead } = await this.fd.read(buf, 0, buf.length, sector * this.sectorSize + this.dataOffset);
    return buf.subarray(0, bytesRead);
  }

  async close() {
    await this.fd.close();
  }

  /** Busca un fichero en el sistema ISO9660. path con separador '\\'. Devuelve sector y tamano. */
  async findFile(filePath: string): Promise<{ sector: number; size: number } | null> {
    let p = filePath.replace(/^\\+/, '');
    let sector: number;
    let numSectors = 1;
    const slash = p.lastIndexOf('\\');
    if (slash >= 0) {
      const dir = await this.findFile(p.slice(0, slash));
      if (!dir) return null;
      sector = dir.sector;
      numSectors = Math.max(1, Math.ceil(dir.size / 2048));
      p = p.slice(slash + 1);
    } else {
      const pvd = await this.readSector(this.firstSector + 16, 256);
      sector = pvd[158] | (pvd[159] << 8) | (pvd[160] << 16);
      const blockSize = pvd[128] | (pvd[129] << 8);
      const len = pvd.readUInt32LE(166);
      numSectors = blockSize ? Math.max(1, Math.floor(len / blockSize)) : 1;
    }
    const target = p.toUpperCase();
    for (let s = 0; s < numSectors; s++) {
      const buf = await this.readSector(sector + s);
      let off = 0;
      while (off < buf.length && buf[off]) {
        const recLen = buf[off];
        const nameLen = buf[off + 32];
        const name = buf.toString('latin1', off + 33, off + 33 + nameLen).toUpperCase();
        const bare = name.split(';')[0];
        if (bare === target || name === target) {
          return { sector: buf[off + 2] | (buf[off + 3] << 8) | (buf[off + 4] << 16), size: buf.readUInt32LE(off + 10) };
        }
        off += recLen;
      }
    }
    return null;
  }

  async readFile(sector: number, size: number, max = 64 * 1024 * 1024): Promise<Buffer> {
    const total = Math.min(size, max);
    const out: Buffer[] = [];
    let remaining = total;
    let s = sector;
    while (remaining > 0) {
      const b = await this.readSector(s++, Math.min(2048, remaining));
      if (!b.length) break;
      out.push(b);
      remaining -= b.length;
    }
    return Buffer.concat(out);
  }
}

export interface CueTrack {
  number: number;
  file: string;
  mode: string;
  index1: number;
}

export async function parseCue(cueFile: string): Promise<{ files: string[]; tracks: CueTrack[] }> {
  const text = await fs.promises.readFile(cueFile, 'utf8');
  const dir = path.dirname(cueFile);
  const files: string[] = [];
  const tracks: CueTrack[] = [];
  let currentFile = '';
  let current: CueTrack | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m = line.match(/^FILE\s+"(.+)"\s+\S+$/i) ?? line.match(/^FILE\s+(\S+)\s+\S+$/i);
    if (m) {
      currentFile = path.join(dir, m[1]);
      files.push(currentFile);
      continue;
    }
    m = line.match(/^TRACK\s+(\d+)\s+(\S+)/i);
    if (m) {
      current = { number: Number(m[1]), file: currentFile, mode: m[2], index1: 0 };
      tracks.push(current);
      continue;
    }
    m = line.match(/^INDEX\s+01\s+(\d+):(\d+):(\d+)/i);
    if (m && current) current.index1 = (Number(m[1]) * 60 + Number(m[2])) * 75 + Number(m[3]);
  }
  return { files, tracks };
}
