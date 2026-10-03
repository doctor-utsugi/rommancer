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
  if (baseRomId && !hack.baseRomId) await prisma.romHack.update({ where: { id: hackId }, data: { baseRomId } });
  // Si la base esta en la coleccion se calcula ya el resultado: sus hashes permiten reconocer el hack al escanear
  if (baseRomId && !hack.sha1 && (await ownedRomIds({ romIds: [baseRomId], include: 'any' })).has(baseRomId)) {
    try {
      const out = await patchedContent(p.id);
      const h = hashesOf(out);
      await prisma.romHack.update({ where: { id: hackId }, data: { sha1: h.sha1, md5: h.md5, crc32: h.crc32, size: BigInt(h.size) } });
    } catch {
      // Base distinta de la esperada: el parche queda registrado igualmente
    }
  }
  return p;
}

/** Aplica un parche a su rom base. Prueba con la rom tal cual y sin cabecera (NES, SNES...). */
export async function patchedContent(patchId: number): Promise<Buffer> {
  const p = await prisma.romPatch.findUniqueOrThrow({ where: { id: patchId }, include: { hack: { include: { game: { include: { system: true } } } } } });
  if (!p.baseRomId) throw new HttpError(409, 'Patch without base rom');
  const base = await readOwnedRom(p.baseRomId);
  const patch = await fs.promises.readFile(path.join(env.patchesDir, p.path));
  const header = detectHeader(p.hack.game.system.headerType, base.subarray(0, 512), base.length);
  const candidates = header ? [base, base.subarray(header)] : [base];
  let last: unknown;
  for (const c of candidates) {
    try {
      return applyPatch(c, patch);
    } catch (e) {
      last = e;
      if (!(e instanceof PatchError)) throw e;
    }
  }
  throw new HttpError(409, `Patch does not apply: ${last instanceof Error ? last.message : last}`);
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
  const out = await patchedContent(patch.id);
  const h = hashesOf(out);
  if (hack.sha1 && hack.sha1 !== h.sha1) throw new HttpError(409, 'Patched rom does not match the hack checksum');
  if (!hack.sha1) await prisma.romHack.update({ where: { id: hackId }, data: { sha1: h.sha1, md5: h.md5, crc32: h.crc32, size: BigInt(h.size) } });
  const ext = path.extname(hack.baseRom?.parts[0]?.name ?? '') || '.bin';
  const { file } = await placeFile(out, {
    system: hack.game.system,
    fileName: safeFileName(hack.title + ext),
    hashes: h,
    status: 'HACK',
    romHackId: hack.id,
    uploadedById: userId ?? null,
  });
  return prisma.romFile.findUniqueOrThrow({ where: { id: file.id }, include: { romPath: true } });
}
