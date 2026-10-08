import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import SftpClient from 'ssh2-sftp-client';
import type { Device, Firmware } from '@prisma/client';
import { decrypt } from '../../lib/crypto.js';

export interface SinkEntry {
  name: string;
  size: number;
  mtimeMs: number;
  isDir: boolean;
}

/** Acceso a ficheros de un dispositivo (SD montada o SSH/SFTP). Rutas relativas a la raiz del dispositivo. */
export interface Sink {
  stat(rel: string): Promise<{ size: number; mtimeMs: number } | null>;
  mkdirp(rel: string): Promise<void>;
  putFile(localAbs: string, rel: string): Promise<void>;
  putStream(stream: Readable, rel: string): Promise<void>;
  putBuffer(buf: Buffer, rel: string, mtime?: Date): Promise<void>;
  getBuffer(rel: string): Promise<Buffer>;
  list(relDir: string): Promise<SinkEntry[]>;
  close(): Promise<void>;
}

class LocalSink implements Sink {
  constructor(private root: string) {}
  private abs(rel: string) {
    const p = path.resolve(this.root, rel);
    if (!p.startsWith(path.resolve(this.root))) throw new Error('Path escapes device root');
    return p;
  }
  async stat(rel: string) {
    const st = await fs.promises.stat(this.abs(rel)).catch(() => null);
    return st ? { size: st.size, mtimeMs: st.mtimeMs } : null;
  }
  async mkdirp(rel: string) {
    await fs.promises.mkdir(this.abs(rel), { recursive: true });
  }
  async putFile(localAbs: string, rel: string) {
    await this.mkdirp(path.dirname(rel));
    await fs.promises.copyFile(localAbs, this.abs(rel));
  }
  async putStream(stream: Readable, rel: string) {
    await this.mkdirp(path.dirname(rel));
    await pipeline(stream, fs.createWriteStream(this.abs(rel)));
  }
  async putBuffer(buf: Buffer, rel: string, mtime?: Date) {
    await this.mkdirp(path.dirname(rel));
    await fs.promises.writeFile(this.abs(rel), buf);
    if (mtime) await fs.promises.utimes(this.abs(rel), mtime, mtime);
  }
  async getBuffer(rel: string) {
    return fs.promises.readFile(this.abs(rel));
  }
  async list(relDir: string) {
    const dir = this.abs(relDir);
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
    const out: SinkEntry[] = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const st = await fs.promises.stat(path.join(dir, e.name)).catch(() => null);
      if (st) out.push({ name: e.name, size: st.size, mtimeMs: st.mtimeMs, isDir: st.isDirectory() });
    }
    return out;
  }
  async close() {}
}

class SftpSink implements Sink {
  constructor(
    private client: SftpClient,
    private root: string,
  ) {}
  private abs(rel: string) {
    const p = path.posix.normalize(path.posix.join(this.root, rel.split(path.sep).join('/')));
    if (!p.startsWith(path.posix.normalize(this.root))) throw new Error('Path escapes device root');
    return p;
  }
  async stat(rel: string) {
    try {
      const st = await this.client.stat(this.abs(rel));
      return { size: st.size, mtimeMs: st.modifyTime };
    } catch {
      return null;
    }
  }
  async mkdirp(rel: string) {
    const p = this.abs(rel);
    if (!(await this.client.exists(p))) await this.client.mkdir(p, true);
  }
  async putFile(localAbs: string, rel: string) {
    await this.mkdirp(path.posix.dirname(rel));
    await this.client.fastPut(localAbs, this.abs(rel));
  }
  async putStream(stream: Readable, rel: string) {
    await this.mkdirp(path.posix.dirname(rel));
    await this.client.put(stream, this.abs(rel));
  }
  async putBuffer(buf: Buffer, rel: string, mtime?: Date) {
    await this.mkdirp(path.posix.dirname(rel));
    await this.client.put(buf, this.abs(rel));
    if (mtime) {
      const sftp = (this.client as unknown as { sftp: { utimes: (p: string, a: Date, m: Date, cb: (e?: Error) => void) => void } }).sftp;
      await new Promise<void>((resolve) => sftp.utimes(this.abs(rel), mtime, mtime, () => resolve()));
    }
  }
  async getBuffer(rel: string) {
    return (await this.client.get(this.abs(rel))) as Buffer;
  }
  async list(relDir: string) {
    try {
      const items = await this.client.list(this.abs(relDir));
      return items.filter((i) => !i.name.startsWith('.')).map((i) => ({ name: i.name, size: i.size, mtimeMs: i.modifyTime, isDir: i.type === 'd' }));
    } catch {
      return [];
    }
  }
  async close() {
    await this.client.end();
  }
}

export async function openSink(device: Device): Promise<Sink> {
  if (device.connType === 'LOCAL') {
    const st = await fs.promises.stat(device.rootPath).catch(() => null);
    if (!st?.isDirectory()) throw new Error(`Device path not available: ${device.rootPath}`);
    return new LocalSink(device.rootPath);
  }
  const client = new SftpClient();
  await client.connect({
    host: device.sshHost!,
    port: device.sshPort ?? 22,
    username: device.sshUser!,
    password: decrypt(device.sshPassword) ?? undefined,
    privateKey: decrypt(device.sshKey) ?? undefined,
    readyTimeout: 10000,
  });
  return new SftpSink(client, device.rootPath);
}

export interface DeviceLayout {
  romsRoot: string;
  savesRoot: string;
  statesRoot: string;
  biosRoot: string;
  savesLayout: string;
  systemMap: Record<string, { folder: string; emulator: string }>;
}

export function layoutOf(device: Device & { firmware: Firmware }): DeviceLayout {
  const o = (device.overrides ?? {}) as Partial<DeviceLayout>;
  return {
    romsRoot: o.romsRoot ?? device.firmware.romsRoot,
    savesRoot: o.savesRoot ?? device.firmware.savesRoot,
    statesRoot: o.statesRoot ?? device.firmware.statesRoot,
    biosRoot: o.biosRoot ?? device.firmware.biosRoot,
    savesLayout: o.savesLayout ?? device.firmware.savesLayout,
    // systemMapOnly: a layout the user defined holds just its own systems, not the base firmware's too
    systemMap: (o as { systemMapOnly?: boolean }).systemMapOnly ? (o.systemMap ?? {}) : { ...(device.firmware.systemMap as DeviceLayout['systemMap']), ...(o.systemMap ?? {}) },
  };
}

/**
 * Where a system's roms go on a device: the firmware's folder for it, or a folder named after the system
 * for systems the firmware does not list (a GBA flashcart holding Game Boy games for an emulator).
 */
export const folderFor = (layout: DeviceLayout, slug: string) => layout.systemMap[slug]?.folder ?? slug;

/**
 * The user's override on top of a device's lists: systems left out, the systems there were when it was
 * last saved, and whether systems that appear in the lists later are copied without asking.
 */
export interface SystemFilter {
  newAuto: boolean;
  excluded: string[];
  known: string[];
  /** Games left out one by one (when a list does not fit on the device) */
  excludedGames: number[];
}

export function systemFilterOf(d: { systemFilter: unknown }): SystemFilter {
  const f = (d.systemFilter ?? {}) as Partial<SystemFilter>;
  return {
    newAuto: f.newAuto ?? true,
    excluded: Array.isArray(f.excluded) ? f.excluded : [],
    known: Array.isArray(f.known) ? f.known : [],
    excludedGames: Array.isArray(f.excludedGames) ? f.excludedGames : [],
  };
}

/** Whether a system's games are copied to the device */
export const copiesSystem = (f: SystemFilter, slug: string) => !f.excluded.includes(slug) && (f.newAuto || f.known.includes(slug));
