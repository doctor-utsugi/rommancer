/**
 * Romhack patches (IPS/BPS/UPS). A romhack without a file but with a patch and a base rom in the collection is generated
 * on demand at its final destination path and registered as a scanned file.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { crc32 } from 'node:zlib';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../lib/http.js';
import { applyPatch, createBps, detectPatchFormat, patchInfo, PatchError } from '../../lib/patch.js';
import { detectHeader } from '../../lib/hash.js';
import { extractEntryStream } from '../../lib/tools.js';
import { safeFileName } from '../../lib/romname.js';
import { placeFile } from '../roms/destination.js';
import { ownedRomIds } from '../roms/service.js';

const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
const hashesOf = (b: Buffer) => ({
  size: b.length,
  crc32: hex(crc32(b)),
  md5: crypto.createHash('md5').update(b).digest('hex'),
  sha1: crypto.createHash('sha1').update(b).digest('hex'),
});

async function readStream(s: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** Content of a single-file rom held on disk. */
export async function readOwnedRom(romId: number): Promise<Buffer> {
  const part = await prisma.romPart.findFirst({ where: { romId }, include: { files: { where: { status: { in: ['MATCHED', 'UNVERIFIED'] } }, include: { romPath: true } } } });
  const f = part?.files[0];
  if (!f) throw new HttpError(409, 'Base rom not in collection');
  const abs = path.join(f.romPath.path, f.relativePath);
  return f.archiveEntry ? readStream(extractEntryStream(abs, f.archiveEntry)) : fs.promises.readFile(abs);
}

/**
 * Creates and stores a BPS patch from the romhack file and its base rom, so the romhack can be regenerated even if
 * the file is lost and the patch travels in the seed.
 */
export async function makePatch(hackId: number, userId?: number) {
  const hack = await prisma.romHack.findUniqueOrThrow({ where: { id: hackId }, include: { files: { include: { romPath: true } } } });
  if (!hack.baseRomId) throw new HttpError(409, 'Hack without base rom');
  const f = hack.files[0];
  if (!f) throw new HttpError(409, 'Hack file not in collection');
  const abs = path.join(f.romPath.path, f.relativePath);
  const target = f.archiveEntry ? await readStream(extractEntryStream(abs, f.archiveEntry)) : await fs.promises.readFile(abs);
  const source = await readOwnedRom(hack.baseRomId);
  return addPatch(hackId, createBps(source, target), { baseRomId: hack.baseRomId, userId });
}

/** Registers a patch for a romhack. Looks up the base rom by CRC (BPS/UPS) or uses the given one. */
export async function addPatch(hackId: number, patch: Buffer, opts: { baseRomId?: number; sourceUrl?: string; userId?: number } = {}) {
  const format = detectPatchFormat(patch);
  if (!format) throw new HttpError(400, 'Unknown patch format');
  const info = patchInfo(patch);
  const hack = await prisma.romHack.findUniqueOrThrow({ where: { id: hackId }, include: { game: true } });
  let baseRomId = opts.baseRomId ?? hack.baseRomId ?? null;
  if (!baseRomId && info.sourceCrc32) {
    const part = await prisma.romPart.findFirst({
      where: { OR: [{ crc32: info.sourceCrc32 }, { headerlessCrc: info.sourceCrc32 }], rom: { game: { systemId: hack.game.systemId } } },
    });
    baseRomId = part?.romId ?? null;
    // The patch may be made on the copy held (e.g. with another header): looked up by file
    if (!baseRomId) {
      const f = await prisma.romFile.findFirst({
        where: { OR: [{ crc32: info.sourceCrc32 }, { headerlessCrc: info.sourceCrc32 }], romPartId: { not: null }, systemId: hack.game.systemId },
        include: { romPart: true },
      });
      baseRomId = f?.romPart?.romId ?? null;
    }
  }
  const sha1 = crypto.createHash('sha1').update(patch).digest('hex');
  const existing = await prisma.romPatch.findUnique({ where: { sha1 } });
  if (existing) return existing;
  const rel = path.join(String(hackId), `${sha1.slice(0, 12)}.${format}`);
  await fs.promises.mkdir(path.dirname(path.join(env.patchesDir, rel)), { recursive: true });
  await fs.promises.writeFile(path.join(env.patchesDir, rel), patch);
  const p = await prisma.romPatch.create({
    data: { hackId, format, path: rel, size: patch.length, sha1, baseRomId, baseCrc32: info.sourceCrc32 ?? null, targetCrc32: info.targetCrc32 ?? null, sourceUrl: opts.sourceUrl ?? null, createdById: opts.userId ?? null },
  });
  if (baseRomId && (!hack.baseRomId || hack.baseEvidence === 'title' || !hack.baseEvidence))
    await prisma.romHack.update({ where: { id: hackId }, data: { baseRomId, baseEvidence: 'patch' } });
  // If the base is in the collection the result is computed now: its hashes recognize an already patched hack on
  // disk (also with or without another header)
  if (baseRomId && (await ownedRomIds({ romIds: [baseRomId], include: 'any' })).has(baseRomId)) {
    try {
      await setResultHashes(hackId, await patchedContent(p.id));
    } catch {
      // Base differs from the expected one: the patch is registered anyway
    }
  }
  return p;
}

export interface Patched {
  // Whole file (with the base's header if it has one) and headerless content
  file: Buffer;
  headerless: Buffer | null;
}

/** Applies a patch to its base rom. Tries the rom as is and headerless (NES, SNES...). */
export async function patchedContent(patchId: number): Promise<Patched> {
  const p = await prisma.romPatch.findUniqueOrThrow({ where: { id: patchId }, include: { hack: { include: { game: { include: { system: true } } } } } });
  if (!p.baseRomId) throw new HttpError(409, 'Patch without base rom');
  const base = await readOwnedRom(p.baseRomId);
  const patch = await fs.promises.readFile(path.join(env.patchesDir, p.path));
  const header = detectHeader(p.hack.game.system.headerType, base.subarray(0, 512), base.length);
  let last: unknown;
  try {
    const out = applyPatch(base, patch);
    return { file: out, headerless: header ? out.subarray(header) : null };
  } catch (e) {
    last = e;
    if (!(e instanceof PatchError)) throw e;
  }
  if (header) {
    try {
      // Patch made on the headerless rom: the final file keeps the base's header
      const out = applyPatch(base.subarray(header), patch);
      return { file: Buffer.concat([base.subarray(0, header), out]), headerless: out };
    } catch (e) {
      last = e;
      if (!(e instanceof PatchError)) throw e;
    }
  }
  throw new HttpError(409, `Patch does not apply: ${last instanceof Error ? last.message : last}`);
}

/** Stores the result hashes on the romhack and links the files that already have it patched. */
async function setResultHashes(hackId: number, r: Patched) {
  const h = hashesOf(r.file);
  const hl = r.headerless ? hashesOf(r.headerless).sha1 : null;
  const hack = await prisma.romHack.findUniqueOrThrow({ where: { id: hackId } });
  // If the romhack already had a hash (from a DAT) it is respected; the missing variant is added
  const data: Record<string, unknown> = { headerlessSha1: hack.headerlessSha1 ?? (hl && hl !== hack.sha1 ? hl : null) };
  if (!hack.sha1) Object.assign(data, { sha1: h.sha1, md5: h.md5, crc32: h.crc32, size: BigInt(h.size) });
  await prisma.romHack.update({ where: { id: hackId }, data });
  await relinkHack(hackId);
}

/**
 * Once a romhack's hashes are known: merges duplicate romhacks created from files (same result)
 * and links the matching unknown files.
 */
export async function relinkHack(hackId: number) {
  const hack = await prisma.romHack.findUniqueOrThrow({ where: { id: hackId } });
  const shas = [hack.sha1, hack.headerlessSha1].filter((x): x is string => !!x);
  if (!shas.length) return { merged: 0, linked: 0 };
  const dups = await prisma.romHack.findMany({
    where: { id: { not: hackId }, datSourceId: null, patches: { none: {} }, OR: [{ sha1: { in: shas } }, { headerlessSha1: { in: shas } }] },
  });
  for (const d of dups) {
    await prisma.$transaction([
      prisma.romFile.updateMany({ where: { romHackId: d.id }, data: { romHackId: hackId } }),
      prisma.$executeRaw`UPDATE IGNORE ListItem SET hackId = ${hackId}, itemKey = CONCAT('h', ${hackId}) WHERE hackId = ${d.id}`,
      prisma.$executeRaw`DELETE FROM ListItem WHERE hackId = ${d.id}`,
      prisma.romHack.delete({ where: { id: d.id } }),
    ]);
  }
  const game = await prisma.game.findUniqueOrThrow({ where: { id: hack.gameId } });
  const r = await prisma.romFile.updateMany({
    where: { status: 'UNKNOWN', OR: [{ sha1: { in: shas } }, { headerlessSha1: { in: shas } }] },
    data: { status: 'HACK', romHackId: hackId, systemId: game.systemId },
  });
  return { merged: dups.length, linked: r.count };
}

/**
 * Generates a romhack file by applying its patch and places it at its system's destination path.
 * Returns the existing file if there is one.
 */
export async function materializeHack(hackId: number, userId?: number) {
  const hack = await prisma.romHack.findUniqueOrThrow({ where: { id: hackId }, include: { files: { include: { romPath: true } }, patches: true, game: { include: { system: true } }, baseRom: { include: { parts: { take: 1 } } } } });
  if (hack.files[0]) return hack.files[0];
  const patch = hack.patches.find((p) => p.baseRomId) ?? null;
  if (!patch) return null;
  const r = await patchedContent(patch.id);
  const h = hashesOf(r.file);
  const hl = r.headerless ? hashesOf(r.headerless).sha1 : null;
  const known = [hack.sha1, hack.headerlessSha1].filter(Boolean);
  if (known.length && !known.includes(h.sha1) && !(hl && known.includes(hl))) throw new HttpError(409, 'Patched rom does not match the hack checksum');
  await setResultHashes(hackId, r);
  // A patched file may already be on disk and now linked
  const linked = await prisma.romFile.findFirst({ where: { romHackId: hackId }, include: { romPath: true } });
  if (linked) return linked;
  const out = r.file;
  const ext = path.extname(hack.baseRom?.parts[0]?.name ?? '') || '.bin';
  const { file } = await placeFile(out, {
    system: hack.game.system,
    fileName: safeFileName(hack.title + ext),
    hashes: { ...h, ...(r.headerless ? { headerless: hashesOf(r.headerless) } : {}) },
    status: 'HACK',
    romHackId: hack.id,
    uploadedById: userId ?? null,
  });
  return prisma.romFile.findUniqueOrThrow({ where: { id: file.id }, include: { romPath: true } });
}
