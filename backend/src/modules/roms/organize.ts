import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../../lib/prisma.js';
import { safeFileName } from '../../lib/romname.js';
import { badRequest } from '../../lib/http.js';
import { pathKey } from '../scanner/service.js';

export interface MovePlan {
  from: string;
  to: string;
  fileIds: number[];
  conflict: boolean;
  /** Same-name files that travel with the rom (patches, saves, cheats) */
  companions: string[];
  /** Left alone: part of a multi-file game whose files point at each other by name */
  skipped?: string;
}

/** Formats whose files reference each other by name: renaming one breaks the set */
const MULTI_FILE = new Set(['.cue', '.gdi', '.m3u', '.ccd', '.bin', '.img', '.sub', '.toc']);
/** Files that belong to a rom by sharing its name */
const COMPANION = /\.(ips|bps|ups|xdelta|ppf|srm|sav|cht|state\d*|state\.auto)$/i;
/** Journal of an organize run, at the folder's root: lets a cut run be finished or undone */
const JOURNAL = '.rommancer-organize.json';

interface JournalEntry {
  from: string;
  to: string;
  fileIds: number[];
  done: boolean;
  /** A companion: the rom it travels with */
  of?: string;
}

/** Why a file stayed where it was, for the panel to say in the user's language */
export type OrganizeProblem = 'conflict' | 'exists' | 'taken' | 'permission' | 'full' | 'missing' | 'failed';

export interface OrganizeFailure {
  file: string;
  to: string;
  problem: OrganizeProblem;
  /** The system's own words, for the details */
  detail?: string;
  /** A companion: its rom moved and it did not, so they are now in different folders */
  companionOf?: string;
}

function failure(file: string, to: string, err: unknown, companionOf?: string): OrganizeFailure {
  const code = (err as NodeJS.ErrnoException)?.code;
  const problem: OrganizeProblem =
    err instanceof Error && err.message === 'target exists' ? 'exists'
    : err instanceof Error && err.message === 'original place is taken' ? 'taken'
    : code === 'EACCES' || code === 'EPERM' || code === 'EROFS' ? 'permission'
    : code === 'ENOSPC' || code === 'EDQUOT' ? 'full'
    : code === 'ENOENT' ? 'missing'
    : 'failed';
  return { file, to, problem, detail: err instanceof Error ? err.message : String(err), ...(companionOf ? { companionOf } : {}) };
}

/** Companions of REL: files in its folder with the same name and a companion extension */
async function companionsOf(root: string, rel: string) {
  const dir = path.join(root, path.dirname(rel));
  const stem = path.basename(rel, path.extname(rel));
  const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
  return names.filter((n) => n !== path.basename(rel) && n.startsWith(stem + '.') && COMPANION.test(n.slice(stem.length))).map((n) => path.join(path.dirname(rel), n));
}

/**
 * scheme: 'rename' (only renames within its folder), 'system' (folder = system slug),
 * or a firmware slug (folder = the one that firmware uses for the system).
 */
export async function planOrganize(romPathId: number, scheme: string): Promise<MovePlan[]> {
  const rp = await prisma.romPath.findUniqueOrThrow({ where: { id: romPathId } });
  const fw = scheme !== 'rename' && scheme !== 'system' ? await prisma.firmware.findUnique({ where: { slug: scheme } }) : null;
  if (scheme !== 'rename' && scheme !== 'system' && !fw) throw badRequest('Unknown scheme');
  const files = await prisma.romFile.findMany({
    where: { romPathId, status: { in: ['MATCHED', 'HACK'] } },
    include: { romPart: { include: { rom: { include: { game: { include: { system: true } } } } } }, romHack: { include: { game: { include: { system: true } } } } },
  });
  const byRel = new Map<string, typeof files>();
  for (const f of files) byRel.set(f.relativePath, [...(byRel.get(f.relativePath) ?? []), f]);

  const plans: MovePlan[] = [];
  const targets = new Set<string>();
  for (const [rel, rows] of byRel) {
    const first = rows[0];
    const system = first.romPart?.rom.game.system ?? first.romHack?.game.system;
    if (!system) continue;
    const ext = path.extname(rel);
    if (MULTI_FILE.has(ext.toLowerCase())) {
      plans.push({ from: rel, to: rel, fileIds: rows.map((r) => r.id), conflict: false, companions: [], skipped: 'multi-file' });
      continue;
    }
    let base: string;
    if (first.romPart) {
      const romIds = new Set(rows.map((r) => r.romPart?.romId));
      if (romIds.size !== 1) continue;
      base = first.archiveEntry ? first.romPart.rom.name + ext : first.romPart.name;
      // Containers (CHD, RVZ, WIA, CSO...) keep their extension with the rom name
      if (ext.toLowerCase() !== path.extname(first.romPart.name).toLowerCase()) base = first.romPart.rom.name + ext;
    } else {
      base = path.basename(rel);
    }
    base = safeFileName(base);
    let dir: string;
    if (scheme === 'rename') dir = path.dirname(rel);
    else if (scheme === 'system') dir = system.slug;
    else dir = (fw!.systemMap as Record<string, { folder: string }>)[system.slug]?.folder ?? system.slug;
    const to = path.normalize(path.join(dir, base));
    if (to === rel) continue;
    const conflict = targets.has(to) || (fs.existsSync(path.join(rp.path, to)) && to.toLowerCase() !== rel.toLowerCase());
    targets.add(to);
    plans.push({ from: rel, to, fileIds: rows.map((r) => r.id), conflict, companions: await companionsOf(rp.path, rel) });
  }
  return plans.sort((a, b) => a.from.localeCompare(b.from));
}

const journalPath = (root: string) => path.join(root, JOURNAL);

async function readJournal(root: string): Promise<JournalEntry[] | null> {
  const text = await fs.promises.readFile(journalPath(root), 'utf8').catch(() => null);
  return text ? (JSON.parse(text) as JournalEntry[]) : null;
}

const writeJournal = (root: string, entries: JournalEntry[]) => fs.promises.writeFile(journalPath(root), JSON.stringify(entries));

/** Points the index at a file's new place */
async function retarget(root: string, fileIds: number[], to: string) {
  const st = await fs.promises.stat(path.join(root, to));
  for (const r of await prisma.romFile.findMany({ where: { id: { in: fileIds } } })) {
    await prisma.romFile.update({ where: { id: r.id }, data: { relativePath: to, pathKey: pathKey(to, r.archiveEntry), mtimeMs: BigInt(Math.floor(st.mtimeMs)) } });
  }
}

/**
 * Finishes what a cut run left: an entry whose file is already at its target only needs the index updated.
 * Returns the entries still pending.
 */
async function reconcile(root: string): Promise<JournalEntry[]> {
  const entries = await readJournal(root);
  if (!entries) return [];
  for (const e of entries) {
    if (e.done) continue;
    const atTarget = fs.existsSync(path.join(root, e.to)) && !fs.existsSync(path.join(root, e.from));
    if (atTarget) {
      if (e.fileIds.length) await retarget(root, e.fileIds, e.to);
      e.done = true;
    }
  }
  await writeJournal(root, entries);
  return entries.filter((e) => !e.done);
}

export async function applyOrganize(romPathId: number, scheme: string) {
  const rp = await prisma.romPath.findUniqueOrThrow({ where: { id: romPathId } });
  if (rp.readOnly) throw badRequest('Path is read-only');
  await reconcile(rp.path);
  const plans = (await planOrganize(romPathId, scheme)).filter((p) => !p.skipped);
  const failed: OrganizeFailure[] = plans.filter((x) => x.conflict).map((p) => ({ file: p.from, to: p.to, problem: 'conflict' }));
  // The whole run is written down before the first move, then each move is marked as it completes
  const entries: JournalEntry[] = plans
    .filter((p) => !p.conflict)
    .flatMap((p) => [
      { from: p.from, to: p.to, fileIds: p.fileIds, done: false },
      ...p.companions.map((c) => ({ from: c, to: path.join(path.dirname(p.to), path.basename(p.to, path.extname(p.to)) + c.slice(c.lastIndexOf(path.basename(p.from, path.extname(p.from))) + path.basename(p.from, path.extname(p.from)).length)), fileIds: [], done: false, of: p.from })),
    ]);
  await writeJournal(rp.path, entries);
  let moved = 0;
  // A rom that stays keeps its companions with it
  const stayed = new Set<string>();
  for (const e of entries) {
    if (e.of && stayed.has(e.of)) continue;
    try {
      const dest = path.join(rp.path, e.to);
      if (fs.existsSync(dest)) throw new Error('target exists');
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.rename(path.join(rp.path, e.from), dest);
      if (e.fileIds.length) {
        await retarget(rp.path, e.fileIds, e.to);
        moved++;
      }
      e.done = true;
      await writeJournal(rp.path, entries);
    } catch (err) {
      if (!e.of) stayed.add(e.from);
      failed.push(failure(e.from, e.to, err, e.of));
    }
  }
  return { moved, failed, total: plans.length, companions: entries.filter((e) => !e.fileIds.length && e.done).length };
}

/** Puts back what the last run moved, newest first */
export async function undoOrganize(romPathId: number) {
  const rp = await prisma.romPath.findUniqueOrThrow({ where: { id: romPathId } });
  if (rp.readOnly) throw badRequest('Path is read-only');
  await reconcile(rp.path);
  const entries = await readJournal(rp.path);
  if (!entries) throw badRequest('Nothing to undo');
  let restored = 0;
  const failed: OrganizeFailure[] = [];
  for (const e of [...entries].reverse()) {
    if (!e.done) continue;
    try {
      const back = path.join(rp.path, e.from);
      if (fs.existsSync(back)) throw new Error('original place is taken');
      await fs.promises.mkdir(path.dirname(back), { recursive: true });
      await fs.promises.rename(path.join(rp.path, e.to), back);
      if (e.fileIds.length) await retarget(rp.path, e.fileIds, e.from);
      e.done = false;
      restored++;
    } catch (err) {
      failed.push(failure(e.to, e.from, err, e.of));
    }
  }
  if (!failed.length) await fs.promises.rm(journalPath(rp.path), { force: true });
  else await writeJournal(rp.path, entries);
  return { restored, failed };
}
