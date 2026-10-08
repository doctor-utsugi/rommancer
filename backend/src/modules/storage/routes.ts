/**
 * What the setup wizard needs: the disks the server can see (inside a container only its mounts), a folder
 * browser, and a quick survey of what a folder holds (systems by folder name or extension, and the
 * subfolders nothing could be told about) before scanning it for real.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { badRequest } from '../../lib/http.js';
import { guessSystem, systemIndex } from '../scanner/systems.js';
import { diskSpace } from './health.js';

export const storageRouter = Router();

const inContainer = () => fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');

/** Mounts from /proc/self/mountinfo that may hold roms (not the system's own pseudo filesystems) */
async function mounts() {
  const text = await fs.promises.readFile('/proc/self/mountinfo', 'utf8').catch(() => '');
  const skip = /^(proc|sysfs|tmpfs|devtmpfs|devpts|cgroup2?|mqueue|overlay|securityfs|debugfs|tracefs|pstore|bpf|autofs|hugetlbfs|configfs|fusectl|binfmt_misc|nsfs|ramfs|rpc_pipefs|squashfs|efivarfs)$/;
  const out: { mountPoint: string; source: string; root: string; fsType: string; free: number; total: number }[] = [];
  for (const line of text.split('\n')) {
    const [left, right] = line.split(' - ');
    if (!left || !right) continue;
    const f = left.split(' ');
    const [fsType, source] = right.split(' ');
    const mountPoint = f[4]?.replace(/\\040/g, ' ');
    if (!mountPoint || skip.test(fsType) || /^\/(proc|sys|dev|run|boot|etc)(\/|$)/.test(mountPoint)) continue;
    if (inContainer() && mountPoint === '/') continue;
    const space = await diskSpace(mountPoint);
    out.push({ mountPoint, source, root: f[3]?.replace(/\\040/g, ' ') ?? '/', fsType, free: space?.free ?? 0, total: space?.total ?? 0 });
  }
  return out;
}

storageRouter.get('/env', async (_req, res) => {
  res.json({ inContainer: inContainer(), mounts: await mounts(), paths: await prisma.romPath.count() });
});

// Subfolders of a folder, to pick sources and destinations without typing paths
storageRouter.get('/browse', async (req, res) => {
  const p = path.resolve(z.string().default('/').parse(req.query.path));
  const entries = await fs.promises.readdir(p, { withFileTypes: true }).catch(() => null);
  if (!entries) throw badRequest(`Cannot read ${p}`);
  res.json({
    path: p,
    parent: p === '/' ? null : path.dirname(p),
    dirs: entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort((a, b) => a.localeCompare(b)),
    space: await diskSpace(p),
  });
});

const SURVEY_MAX = 200_000;

/**
 * What a folder holds, without hashing: rom-like files grouped by the system their folder or extension
 * suggests, and the folders where nothing could be told, so the user can say which system they are.
 */
storageRouter.get('/survey', async (req, res) => {
  const root = path.resolve(z.string().parse(req.query.path));
  const overrides = z.record(z.string(), z.string()).default({}).parse(req.query.overrides ? JSON.parse(String(req.query.overrides)) : {});
  const idx = await systemIndex();
  const bySystem = new Map<string, { files: number; bytes: number; folders: Set<string> }>();
  const unknown = new Map<string, { files: number; bytes: number; exts: Set<string> }>();
  let seen = 0;
  let truncated = false;
  async function rec(dir: string) {
    if (truncated) return;
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await rec(full);
        continue;
      }
      if (!e.isFile() || !idx.allExts.has(path.extname(e.name).toLowerCase())) continue;
      if (++seen > SURVEY_MAX) {
        truncated = true;
        return;
      }
      const rel = path.relative(root, full);
      const folder = path.dirname(rel);
      const top = folder.split(path.sep)[0] ?? '.';
      const size = (await fs.promises.stat(full).catch(() => null))?.size ?? 0;
      const forced = overrides[top.toLowerCase()] ? idx.bySlug.get(overrides[top.toLowerCase()]) ?? null : null;
      const sys = guessSystem(idx, rel, forced)
      if (sys) {
        const s = bySystem.get(sys.slug) ?? { files: 0, bytes: 0, folders: new Set<string>() };
        s.files++;
        s.bytes += size;
        if (s.folders.size < 20) s.folders.add(folder === '.' ? '/' : folder);
        bySystem.set(sys.slug, s);
      } else {
        const u = unknown.get(top) ?? { files: 0, bytes: 0, exts: new Set<string>() };
        u.files++;
        u.bytes += size;
        u.exts.add(path.extname(e.name).toLowerCase());
        unknown.set(top, u);
      }
    }
  }
  await rec(root);
  res.json({
    path: root,
    files: Math.min(seen, SURVEY_MAX),
    truncated,
    systems: [...bySystem].map(([slug, v]) => ({ slug, name: idx.bySlug.get(slug)?.name ?? slug, files: v.files, bytes: v.bytes, folders: [...v.folders] })).sort((a, b) => b.bytes - a.bytes),
    unknown: [...unknown].map(([folder, v]) => ({ folder, files: v.files, bytes: v.bytes, exts: [...v.exts].slice(0, 6) })).sort((a, b) => b.files - a.files),
  });
});
