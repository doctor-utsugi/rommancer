/**
 * Parches de romhacks (IPS/BPS/UPS). Un romhack sin fichero pero con parche y rom base en la coleccion
 * se genera bajo demanda en su ruta destino final y queda registrado como fichero escaneado.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { crc32 } from 'node:zlib';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../lib/http.js';
import { applyPatch, detectPatchFormat, patchInfo, PatchError } from '../../lib/patch.js';
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

/** Contenido de una rom de un solo fichero que se tiene en disco. */
export async function readOwnedRom(romId: number): Promise<Buffer> {
  const part = await prisma.romPart.findFirst({ where: { romId }, include: { files: { where: { status: { in: ['MATCHED', 'UNVERIFIED'] } }, include: { romPath: true } } } });
  const f = part?.files[0];
  if (!f) throw new HttpError(409, 'Base rom not in collection');
  const abs = path.join(f.romPath.path, f.relativePath);
  return f.archiveEntry ? readStream(extractEntryStream(abs, f.archiveEntry)) : fs.promises.readFile(abs);
}

/** Registra un parche para un romhack. Busca la rom base por CRC (BPS/UPS) o usa la indicada. */
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
    // El parche puede estar hecho sobre la copia que se tiene (p.ej. con otra cabecera): se busca por el fichero
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
  // Si la base esta en la coleccion se calcula ya el resultado: sus hashes permiten reconocer el hack ya
  // parcheado que haya en disco (tambien sin o con otra cabecera)
  if (baseRomId && (await ownedRomIds({ romIds: [baseRomId], include: 'any' })).has(baseRomId)) {
    try {
      await setResultHashes(hackId, await patchedContent(p.id));
    } catch {
      // Base distinta de la esperada: el parche queda registrado igualmente
    }
  }
  return p;
}

export interface Patched {
  // Fichero completo (con la cabecera de la base si la tiene) y contenido sin cabecera
  file: Buffer;
  headerless: Buffer | null;
}

/** Aplica un parche a su rom base. Prueba con la rom tal cual y sin cabecera (NES, SNES...). */
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
      // Parche hecho sobre la rom sin cabecera: el fichero final conserva la cabecera de la base
      const out = applyPatch(base.subarray(header), patch);
      return { file: Buffer.concat([base.subarray(0, header), out]), headerless: out };
    } catch (e) {
      last = e;
      if (!(e instanceof PatchError)) throw e;
    }
  }
  throw new HttpError(409, `Patch does not apply: ${last instanceof Error ? last.message : last}`);
}

/** Guarda los hashes del resultado en el romhack y enlaza los ficheros que ya lo tengan parcheado. */
async function setResultHashes(hackId: number, r: Patched) {
  const h = hashesOf(r.file);
  const hl = r.headerless ? hashesOf(r.headerless).sha1 : null;
  const hack = await prisma.romHack.findUniqueOrThrow({ where: { id: hackId } });
  // Si el romhack ya tenia hash (de un DAT) se respeta; se anade la variante que falte
  const data: Record<string, unknown> = { headerlessSha1: hack.headerlessSha1 ?? (hl && hl !== hack.sha1 ? hl : null) };
  if (!hack.sha1) Object.assign(data, { sha1: h.sha1, md5: h.md5, crc32: h.crc32, size: BigInt(h.size) });
  await prisma.romHack.update({ where: { id: hackId }, data });
  await relinkHack(hackId);
}

/**
 * Tras conocer los hashes de un romhack: fusiona los romhacks duplicados creados a partir de ficheros
 * (mismo resultado) y enlaza los ficheros desconocidos que coincidan.
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
 * Genera el fichero de un romhack aplicando su parche y lo coloca en la ruta destino de su sistema.
 * Devuelve el fichero existente si ya lo hay.
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
  // Puede que ya hubiera un fichero parcheado en disco que ahora se ha enlazado
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
