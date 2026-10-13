/**
 * Identifies romhacks by content, not by name. A hack or translation keeps most bytes of its base rom, so a fingerprint of
 * 1 KiB blocks of the unknown file is compared with those of the roms held for the same system. Without the base, the
 * header game code (GBA, NDS, N64, Mega Drive) is matched against DAT serials. The file name never links on its own:
 * it only produces suggestions for the review queue.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import type { RomFile, RomPath, System } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { detectHeader } from '../../lib/hash.js';
import { extractEntryStream } from '../../lib/tools.js';
import { normalizeTitle, parseRomName } from '../../lib/romname.js';
import type { JobContext } from '../../lib/jobs.js';
import { ownedRomIds } from '../roms/service.js';

const CHUNK = 1024;
// Content sampling: only blocks whose crc is a multiple of 8 (same in all files)
const SAMPLE_MOD = 8;
const MAX_SIZE = 64 * 1024 * 1024;
export const CART_SYSTEMS = new Set(['nes', 'fds', 'snes', 'gb', 'gbc', 'gba', 'n64', 'nds', 'sms', 'gg', 'md', 'lynx', 'a7800']);

// Similarity thresholds (fraction of the base rom that is kept)
export const MIN_SCORE = 0.5;
// Above this the exact base rom is accepted; below it only the game (e.g. a translation of the
// Japanese version when only the American one is held)
export const EXACT_SCORE = 0.85;
const MARGIN = 0.05;
const SUGGEST_SCORE = 0.2;

export function sampleChunks(buf: Buffer): Uint32Array {
  const out = new Set<number>();
  for (let i = 0; i + CHUNK <= buf.length; i += CHUNK) {
    const c = buf.subarray(i, i + CHUNK);
    // Padding (all 00 or FF) appears in any rom: does not count
    if (c[0] === c[CHUNK - 1] && c.every((b) => b === c[0])) continue;
    const crc = zlib.crc32(c) >>> 0;
    if (crc % SAMPLE_MOD === 0) out.add(crc);
  }
  return Uint32Array.from([...out].sort((a, b) => a - b));
}

async function readStream(s: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** Content of a scanned file, without copier/emulator header. */
async function fileContent(f: RomFile & { romPath: RomPath }, system: System): Promise<Buffer | null> {
  if (Number(f.size) > MAX_SIZE) return null;
  const abs = path.join(f.romPath.path, f.relativePath);
  const buf = f.archiveEntry ? await readStream(extractEntryStream(abs, f.archiveEntry)) : await fs.promises.readFile(abs);
  const header = detectHeader(system.headerType, buf.subarray(0, 512), buf.length);
  return header ? buf.subarray(header) : buf;
}

/** Internal game code in the rom header, comparable to the DAT serial. */
export function headerCode(slug: string, buf: Buffer): string | null {
  const ascii = (a: number, b: number) => (buf.length >= b ? buf.toString('latin1', a, b) : '');
  let code = '';
  if (slug === 'gba') code = ascii(0xac, 0xb0);
  else if (slug === 'nds') code = ascii(0x0c, 0x10);
  else if (slug === 'n64' && buf.length > 0x40 && buf.readUInt32BE(0) === 0x80371240) code = ascii(0x3b, 0x3f);
  else if (slug === 'md') {
    // "GM T-48073-00": type + serial
    const m = ascii(0x180, 0x18e).match(/^[A-Z]{2} ([A-Z0-9-]{4,})/);
    return m ? m[1].replace(/-+$/, '') : null;
  }
  return /^[A-Z0-9]{4}$/.test(code) ? code : null;
}

interface Signature {
  romId: number;
  gameId: number;
  name: string;
  sample: Uint32Array;
}

/** Fingerprints of the cartridge roms held in the system (computed once and stored). */
async function systemSignatures(system: System, ctx?: JobContext): Promise<Signature[]> {
  const owned = [...(await ownedRomIds({ systemId: system.id, include: 'any' }))];
  if (!owned.length) return [];
  const roms = await prisma.rom.findMany({ where: { id: { in: owned } }, select: { id: true, gameId: true, name: true, parts: { select: { id: true } } } });
  const single = roms.filter((r) => r.parts.length === 1);
  const stored = new Map((await prisma.romSignature.findMany({ where: { romId: { in: single.map((r) => r.id) } } })).map((s) => [s.romId, s]));
  const out: Signature[] = [];
  for (const r of single) {
    let sig = stored.get(r.id);
    if (!sig) {
      const f = await prisma.romFile.findFirst({ where: { romPartId: r.parts[0].id, status: { in: ['MATCHED', 'UNVERIFIED'] } }, include: { romPath: true } });
      if (!f?.sha1) continue;
      const content = await fileContent(f, system).catch(() => null);
      if (!content) continue;
      const sample = sampleChunks(content);
      sig = await prisma.romSignature.upsert({
        where: { romId: r.id },
        create: { romId: r.id, fileSha1: f.sha1, chunks: Math.floor(content.length / CHUNK), sample: new Uint8Array(sample.buffer as ArrayBuffer) },
        update: { fileSha1: f.sha1, chunks: Math.floor(content.length / CHUNK), sample: new Uint8Array(sample.buffer as ArrayBuffer) },
      });
      ctx?.log(`Fingerprint of ${r.name}`);
    }
    // 4-byte aligned copy
    out.push({ romId: r.id, gameId: r.gameId, name: r.name, sample: new Uint32Array(Uint8Array.from(sig.sample).buffer) });
  }
  return out;
}

export type { Signature };

export interface Candidate {
  romId: number;
  gameId: number;
  name: string;
  score: number;
}

export type SignatureIndex = Map<number, number[]>;

export function buildIndex(sigs: Signature[]): SignatureIndex {
  const index: SignatureIndex = new Map();
  sigs.forEach((s, i) => s.sample.forEach((c) => (index.get(c) ?? index.set(c, []).get(c)!).push(i)));
  return index;
}

/** Base roms ordered by the fraction of their content the file keeps. */
export function rankBases(sample: Uint32Array, sigs: Signature[], index = buildIndex(sigs)): Candidate[] {
  const hits = new Map<number, number>();
  for (const c of sample) for (const i of index.get(c) ?? []) hits.set(i, (hits.get(i) ?? 0) + 1);
  return [...hits.entries()]
    .map(([i, n]) => ({ romId: sigs[i].romId, gameId: sigs[i].gameId, name: sigs[i].name, score: sigs[i].sample.length ? n / sigs[i].sample.length : 0 }))
    .sort((a, b) => b.score - a.score);
}

export type Decision = { base: { romId: number | null; gameId: number }; evidence: 'content' | 'header' } | { review: true; candidates: Candidate[]; codeRoms: { romId: number; gameId: number; name: string }[] } | null;

export function decide(ranked: Candidate[], codeRoms: { romId: number; gameId: number; name: string }[], hasHackTags: boolean): Decision {
  const best = ranked[0];
  if (best && best.score >= MIN_SCORE) {
    const rival = ranked.find((c) => c.gameId !== best.gameId && c.score >= best.score - MARGIN);
    if (!rival) return { base: { romId: best.score >= EXACT_SCORE ? best.romId : null, gameId: best.gameId }, evidence: 'content' };
    return { review: true, candidates: ranked.slice(0, 5), codeRoms };
  }
  const games = new Set(codeRoms.map((r) => r.gameId));
  if (games.size === 1) {
    // Several revisions with the same code: the exact base stays unset unless there is only one
    const preferred = codeRoms.find((r) => ranked.some((c) => c.romId === r.romId)) ?? (codeRoms.length === 1 ? codeRoms[0] : null);
    return { base: { romId: preferred?.romId ?? null, gameId: codeRoms[0].gameId }, evidence: 'header' };
  }
  if (hasHackTags || games.size > 1 || (best && best.score >= SUGGEST_SCORE)) return { review: true, candidates: ranked.slice(0, 5), codeRoms };
  return null;
}

/** Creates (or reuses) the romhack of a file and links it. */
export async function linkFileAsHack(fileId: number, base: { romId: number | null; gameId: number }, evidence: string) {
  const f = await prisma.romFile.findUniqueOrThrow({ where: { id: fileId } });
  const game = await prisma.game.findUniqueOrThrow({ where: { id: base.gameId } });
  const name = path.basename(f.archiveEntry ?? f.relativePath).replace(/\.[^.]+$/, '');
  const p = parseRomName(name);
  const shas = [f.sha1, f.headerlessSha1].filter((x): x is string => !!x);
  let hack = shas.length ? await prisma.romHack.findFirst({ where: { OR: [{ sha1: { in: shas } }, { headerlessSha1: { in: shas } }] } }) : null;
  if (hack) {
    // Only a weak (title) link is corrected; DAT, patch and manual ones are respected
    if (hack.baseEvidence === 'title' || !hack.baseEvidence)
      hack = await prisma.romHack.update({ where: { id: hack.id }, data: { gameId: game.id, baseRomId: base.romId, baseEvidence: evidence } });
  } else {
    hack = await prisma.romHack.create({
      data: {
        gameId: game.id,
        baseRomId: base.romId,
        baseEvidence: evidence,
        // Without hack marks in the name it may be an altered dump: recorded as "other"
        type: p.hack?.type ?? 'OTHER',
        title: name.slice(0, 255),
        author: p.hack?.author?.slice(0, 255) ?? null,
        version: p.hack?.version ?? null,
        language: p.hack?.language ?? null,
        size: f.size,
        crc32: f.crc32,
        md5: f.md5,
        sha1: f.sha1,
        headerlessSha1: f.headerlessSha1 ?? null,
      },
    });
  }
  await prisma.romFile.update({ where: { id: f.id }, data: { status: 'HACK', romHackId: hack.id, systemId: game.systemId, hackCheckedAt: new Date() } });
  await prisma.reviewItem.updateMany({ where: { kind: 'hack', key: `file:${f.id}`, status: 'open' }, data: { status: 'auto', resolvedAt: new Date() } });
  return hack;
}

/** Suggestions by title: informative only, for review. */
async function titleSuggestions(systemId: number, name: string) {
  const segs = parseRomName(name).title.split(' - ');
  const titles = segs.map((_, i) => segs.slice(0, segs.length - i).join(' - '));
  const games = await prisma.game.findMany({ where: { systemId, titleNormalized: { in: titles.map((x) => normalizeTitle(x)) } }, select: { id: true, title: true }, take: 5 });
  return games;
}

export interface IdentifyStats {
  checked: number;
  linked: number;
  review: number;
  relinked: number;
}

/**
 * Evaluates unknown files of cartridge systems (and romhacks linked only by title).
 * Each file is evaluated once; `recheck` repeats all.
 */
export async function identifyHacks(opts: { romPathId?: number; fileIds?: number[]; recheck?: boolean } = {}, ctx?: JobContext): Promise<IdentifyStats> {
  const stats: IdentifyStats = { checked: 0, linked: 0, review: 0, relinked: 0 };
  const systems = (await prisma.system.findMany()).filter((s) => CART_SYSTEMS.has(s.slug));
  const files = await prisma.romFile.findMany({
    where: {
      systemId: { in: systems.map((s) => s.id) },
      sha1: { not: null },
      ...(opts.fileIds ? { id: { in: opts.fileIds } } : {}),
      ...(opts.romPathId ? { romPathId: opts.romPathId } : {}),
      OR: [
        { status: 'UNKNOWN', ...(opts.recheck ? {} : { hackCheckedAt: null }) },
        { status: 'HACK', romHack: { baseEvidence: 'title' }, ...(opts.recheck ? {} : { hackCheckedAt: null }) },
      ],
    },
    include: { romPath: true, romHack: true },
  });
  if (!files.length) return stats;
  const sigCache = new Map<number, { sigs: Signature[]; index: SignatureIndex }>();
  const serialCache = new Map<number, { romId: number; gameId: number; name: string; serial: string }[]>();
  for (const f of files) {
    const system = systems.find((s) => s.id === f.systemId)!;
    stats.checked++;
    let content: Buffer | null = null;
    try {
      content = await fileContent(f, system);
    } catch (e) {
      ctx?.log(`Cannot read ${f.relativePath}: ${e instanceof Error ? e.message : e}`);
    }
    if (!content) {
      await prisma.romFile.update({ where: { id: f.id }, data: { hackCheckedAt: new Date() } });
      continue;
    }
    if (!sigCache.has(system.id)) {
      const sigs = await systemSignatures(system, ctx);
      sigCache.set(system.id, { sigs, index: buildIndex(sigs) });
    }
    const { sigs, index } = sigCache.get(system.id)!;
    const ranked = rankBases(sampleChunks(content), sigs, index);
    const code = headerCode(system.slug, content);
    let codeRoms: { romId: number; gameId: number; name: string }[] = [];
    if (code) {
      if (!serialCache.has(system.id))
        serialCache.set(
          system.id,
          (await prisma.rom.findMany({ where: { game: { systemId: system.id }, serial: { not: null } }, select: { id: true, gameId: true, name: true, serial: true } })).map((r) => ({ romId: r.id, gameId: r.gameId, name: r.name, serial: r.serial! })),
        );
      codeRoms = serialCache.get(system.id)!.filter((r) => r.serial === code || r.serial.includes(code)).map(({ romId, gameId, name }) => ({ romId, gameId, name }));
    }
    const fileName = path.basename(f.archiveEntry ?? f.relativePath);
    const d = decide(ranked, codeRoms, !!parseRomName(fileName).hack);
    if (d && 'base' in d) {
      await linkFileAsHack(f.id, d.base, d.evidence);
      if (f.status === 'HACK') stats.relinked++;
      else stats.linked++;
      continue;
    }
    if (d && 'review' in d) {
      const payload = {
        fileId: f.id,
        name: fileName,
        candidates: d.candidates.map((c) => ({ romId: c.romId, gameId: c.gameId, name: c.name, score: Math.round(c.score * 100) / 100 })),
        codeRoms: d.codeRoms.slice(0, 10),
        titleSuggestions: await titleSuggestions(system.id, fileName),
        currentHackId: f.romHackId,
      };
      await prisma.reviewItem.upsert({
        where: { kind_key: { kind: 'hack', key: `file:${f.id}` } },
        create: { kind: 'hack', key: `file:${f.id}`, systemId: system.id, payload },
        update: { payload, status: 'open' },
      });
      stats.review++;
    }
    await prisma.romFile.update({ where: { id: f.id }, data: { hackCheckedAt: new Date() } });
  }
  ctx?.log(`romhacks: ${JSON.stringify(stats)}`);
  return stats;
}

export const sha1Of = (b: Buffer) => crypto.createHash('sha1').update(b).digest('hex');
