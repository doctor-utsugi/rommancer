import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Readable } from 'node:stream';
import { env } from '../config/env.js';

export function run(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

const available = new Map<string, boolean>();
export async function hasTool(bin: string): Promise<boolean> {
  if (!available.has(bin)) {
    try {
      await run(bin, ['--help']);
      available.set(bin, true);
    } catch {
      available.set(bin, false);
    }
  }
  return available.get(bin)!;
}

export interface ArchiveEntry {
  path: string;
  size: number;
  crc32: string | null;
}

export async function listArchive(file: string): Promise<ArchiveEntry[]> {
  const r = await run(env.bins.sevenZip, ['l', '-slt', '-ba', file]);
  if (r.code !== 0) throw new Error(`7zz list failed: ${r.stderr || r.stdout}`);
  const entries: ArchiveEntry[] = [];
  for (const block of r.stdout.split(/\r?\n\r?\n/)) {
    const kv: Record<string, string> = {};
    for (const line of block.split(/\r?\n/)) {
      const i = line.indexOf(' = ');
      if (i > 0) kv[line.slice(0, i)] = line.slice(i + 3);
    }
    if (!kv.Path || kv.Folder === '+' || kv.Attributes?.startsWith('D')) continue;
    entries.push({ path: kv.Path, size: Number(kv.Size ?? 0), crc32: kv.CRC ? kv.CRC.toLowerCase().padStart(8, '0') : null });
  }
  return entries;
}

export function extractEntryStream(file: string, entry: string): Readable {
  const p = spawn(env.bins.sevenZip, ['e', '-so', file, entry], { stdio: ['ignore', 'pipe', 'ignore'] });
  return p.stdout;
}

export async function extractEntryToFile(file: string, entry: string, dest: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    extractEntryStream(file, entry).pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
  });
}

export async function tmpDir(prefix: string): Promise<string> {
  const dir = path.join(env.tmpDir, `${prefix}-${crypto.randomBytes(6).toString('hex')}`);
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

export interface ChdInfo {
  sha1: string | null;
  dataSha1: string | null;
  isCd: boolean;
  isDvd: boolean;
}

export async function chdInfo(file: string): Promise<ChdInfo> {
  const r = await run(env.bins.chdman, ['info', '-i', file]);
  if (r.code !== 0) throw new Error(`chdman info failed: ${r.stderr}`);
  const get = (k: string) => r.stdout.match(new RegExp(`^${k}:\\s*([0-9a-f]{40})`, 'mi'))?.[1] ?? null;
  return {
    sha1: get('SHA1'),
    dataSha1: get('Data SHA1'),
    isCd: /CHT2|CHTR|CHCD|Metadata:\s+Tag='CHT/i.test(r.stdout),
    isDvd: /DVD/i.test(r.stdout),
  };
}

/** Extrae un CHD a cue/bin (CD) o iso (DVD) en un directorio temporal. Devuelve la ruta del cue o del iso. */
export async function extractChd(file: string, dir: string, info: ChdInfo): Promise<string> {
  if (info.isCd) {
    const cue = path.join(dir, 'disc.cue');
    const r = await run(env.bins.chdman, ['extractcd', '-i', file, '-o', cue, '-ob', path.join(dir, 'disc (Track %t).bin'), '-sb', '-f']);
    if (r.code !== 0) throw new Error(`chdman extractcd failed: ${r.stderr}`);
    return cue;
  }
  const iso = path.join(dir, 'disc.iso');
  const r = await run(env.bins.chdman, [info.isDvd ? 'extractdvd' : 'extractraw', '-i', file, '-o', iso, '-f']);
  if (r.code !== 0) throw new Error(`chdman extract failed: ${r.stderr}`);
  return iso;
}
