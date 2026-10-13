import crypto from 'node:crypto';
import type { DatType, Prisma, System } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { normalizeTitle, parseRomName } from '../../lib/romname.js';
import { raHashFromDat } from '../../lib/rahash.js';
import { parseDat, type DatFile, type DatGame, type DatRom } from './parser.js';
import { replaceRomEvidence, resolveRomGroups, type EvidenceInput } from '../grouping/service.js';

export interface ImportResult {
  datSourceId: number;
  system: string;
  type: DatType;
  name: string;
  games: number;
  roms: number;
  hacks: number;
  skipped: boolean;
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export async function detectSystem(dat: DatFile, fileName?: string): Promise<System | null> {
  const systems = await prisma.system.findMany();
  const candidates = [dat.name, dat.description, fileName?.replace(/\.(dat|xml)$/i, '')].filter(Boolean) as string[];
  for (const c of candidates) {
    // No parenthesized suffixes: (Parent-Clone), (Headered), (Decrypted), (LNX), (20261002-002752)...
    const clean = c.replace(/(\s*\([^)]*\))+\s*$/g, '').trim().toLowerCase();
    for (const s of systems) {
      const names = [s.datName, ...((s.datAliases as string[] | null) ?? [])].map((n) => n.toLowerCase());
      if (names.some((n) => clean === n || clean.startsWith(n + ' ') || clean.startsWith(n + ' ('))) return s;
    }
  }
  for (const c of candidates) {
    const l = c.toLowerCase();
    if (l.includes('fbneo') || l.includes('finalburn')) return systems.find((s) => s.slug === 'fbneo') ?? null;
    // "NES hacks", "SNES hacks"...
    const first = l.split(/[\s_-]+/)[0];
    const bySlug = systems.find((s) => s.slug === first);
    if (bySlug) return bySlug;
  }
  return null;
}

function detectType(dat: DatFile, fileName?: string): DatType {
  const s = `${dat.name} ${dat.description ?? ''} ${fileName ?? ''}`.toLowerCase();
  if (s.includes('hack') || dat.games.some((g) => /\[Hack by /.test(g.name))) return 'HACKS';
  if (s.includes('fbneo') || s.includes('finalburn')) return 'FBNEO';
  if (s.includes('mame')) return 'MAME';
  if (s.includes('redump') || /playstation|gamecube|wii|saturn|dreamcast|mega-cd|sega cd/.test(s)) return 'REDUMP';
  return 'NOINTRO';
}

/** Groups entries with the same name (libretro splits .nes and .unh) and merges the headerless versions. */
function mergeGames(games: DatGame[]): Map<string, DatGame> {
  const map = new Map<string, DatGame>();
  for (const g of games) {
    const existing = map.get(g.name);
    if (existing) existing.roms.push(...g.roms);
    else map.set(g.name, { ...g, roms: [...g.roms] });
  }
  return map;
}

interface PartRow {
  name: string;
  size: bigint;
  crc32: string | null;
  md5: string | null;
  sha1: string | null;
  headerlessSize: bigint | null;
  headerlessCrc: string | null;
  headerlessMd5: string | null;
  headerlessSha1: string | null;
}

function buildParts(roms: DatRom[]): PartRow[] {
  const unh = roms.filter((r) => /\.unh$/i.test(r.name));
  const main = roms.filter((r) => !/\.unh$/i.test(r.name));
  return main.map((r) => {
    const base = r.name.replace(/\.[^.]+$/, '');
    const u = unh.find((x) => x.name.replace(/\.unh$/i, '') === base);
    return {
      name: r.name,
      size: BigInt(r.size),
      crc32: r.crc32,
      md5: r.md5,
      sha1: r.sha1,
      headerlessSize: u ? BigInt(u.size) : null,
      headerlessCrc: u?.crc32 ?? null,
      headerlessMd5: u?.md5 ?? null,
      headerlessSha1: u?.sha1 ?? null,
    };
  });
}

export interface ImportOptions {
  systemId?: number;
  type?: DatType;
  fileName?: string;
  force?: boolean;
  // Main source (official No-Intro) versus copies (libretro)
  priority?: number;
  // Recompute groupings when done (default yes)
  resolve?: boolean;
}

/**
 * Imports a DAT. Data is permanent: nothing is deleted; roms that vanish from the source are marked withdrawn.
 * A rom with the same name in the same system is the same rom even from another source: it is updated, not duplicated.
 */
export async function importDat(text: string, opts: ImportOptions = {}): Promise<ImportResult> {
  const fileSha1 = crypto.createHash('sha1').update(text).digest('hex');
  const dat = parseDat(text);
  const system = opts.systemId ? await prisma.system.findUniqueOrThrow({ where: { id: opts.systemId } }) : await detectSystem(dat, opts.fileName);
  if (!system) throw new Error(`Cannot detect system for DAT "${dat.name}"`);
  const type = opts.type ?? detectType(dat, opts.fileName);
  const name = dat.name || opts.fileName || 'DAT';
  const priority = opts.priority ?? 0;

  const existing = await prisma.datSource.findUnique({ where: { systemId_type_name: { systemId: system.id, type, name } } });
  if (existing && existing.fileSha1 === fileSha1 && !opts.force) {
    return { datSourceId: existing.id, system: system.slug, type, name, games: 0, roms: existing.romCount, hacks: 0, skipped: true };
  }
  // Single-file-per-set arcade DAT (whole-zip hash, like libretro-database): it describes the same games as the
  // official DAT under other names and does not verify content. Not used.
  if (system.mediaType === 'arcade' && dat.games.length && dat.games.every((g) => g.roms.length === 1 && /\.(zip|7z)$/i.test(g.roms[0].name))) {
    return { datSourceId: existing?.id ?? 0, system: system.slug, type, name, games: 0, roms: 0, hacks: 0, skipped: true };
  }
  const source = existing
    ? await prisma.datSource.update({ where: { id: existing.id }, data: { fileSha1: '', version: dat.version ?? null, importedAt: new Date(), fileName: opts.fileName ?? existing.fileName, priority } })
    : await prisma.datSource.create({ data: { systemId: system.id, type, name, version: dat.version ?? null, fileSha1: '', fileName: opts.fileName ?? null, priority } });
  // The sha1 is set at the end: if the import fails midway, it is retried whole
  const done = () => prisma.datSource.update({ where: { id: source.id }, data: { fileSha1 } });

  if (type === 'HACKS') {
    const r = await importHacks(dat, system, source.id, name);
    await done();
    return r;
  }

  const merged = [...mergeGames(dat.games).values()];
  const isArcade = system.mediaType === 'arcade';
  const now = new Date();

  // System's already known roms (from any source), by name
  type Known = { id: number; gameId: number; datSourceId: number; priority: number; fields: Record<string, unknown> };
  const known = new Map<string, Known>();
  for (const r of await prisma.rom.findMany({
    where: { game: { systemId: system.id } },
    select: { id: true, name: true, gameId: true, datSourceId: true, regions: true, languages: true, revision: true, flags: true, isBios: true, raHash: true, serial: true, parentName: true, description: true, removedFromSource: true, datSource: { select: { priority: true } } },
  })) {
    const { id, name, gameId, datSourceId, datSource, ...fields } = r;
    known.set(name, { id, gameId, datSourceId, priority: datSource.priority, fields });
  }

  // Provisional game by title for new roms; the grouping resolver decides later
  const gameByTitle = new Map<string, number>();
  for (const g of await prisma.game.findMany({ where: { systemId: system.id }, select: { id: true, titleNormalized: true }, orderBy: { id: 'asc' } }))
    if (!gameByTitle.has(g.titleNormalized)) gameByTitle.set(g.titleNormalized, g.id);
  const romTitle = (g: DatGame) => parseRomName(isArcade && g.description ? g.description : g.name).title.slice(0, 255);
  const newTitles = new Map<string, string>();
  for (const g of merged) {
    if (known.has(g.name.slice(0, 255))) continue;
    const t = romTitle(g);
    const k = normalizeTitle(t).slice(0, 255);
    if (!gameByTitle.has(k) && !newTitles.has(k)) newTitles.set(k, t);
  }
  for (const c of chunk([...newTitles.entries()], 1000)) {
    await prisma.game.createMany({ data: c.map(([titleNormalized, title]) => ({ systemId: system.id, title, titleNormalized })) });
  }
  if (newTitles.size)
    for (const g of await prisma.game.findMany({ where: { systemId: system.id, titleNormalized: { in: [...newTitles.keys()] } }, select: { id: true, titleNormalized: true }, orderBy: { id: 'asc' } }))
      if (!gameByTitle.has(g.titleNormalized)) gameByTitle.set(g.titleNormalized, g.id);

  let updated = 0;
  const partsByName = new Map<string, PartRow[]>();
  const toInsert: Prisma.RomCreateManyInput[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  // The database compares names without case, accents or trailing spaces: two DAT entries that only differ
  // there (or past 255 characters) are one row, so only the first is kept
  const collate = (n: string) => n.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trimEnd();
  const taken = new Set<string>();
  for (const g of merged) {
    const romName = g.name.slice(0, 255);
    if (taken.has(collate(romName))) continue;
    taken.add(collate(romName));
    const p = parseRomName(g.name);
    const parts = buildParts(g.roms);
    const first = parts[0];
    const fields: Record<string, unknown> = {
      regions: p.regions,
      languages: p.languages,
      revision: p.revision,
      flags: p.flags,
      isBios: !!g.isBios || /\[BIOS\]/.test(g.name),
      raHash: first && parts.length === 1 ? raHashFromDat(system.slug, first) : null,
      serial: g.serial?.slice(0, 64) ?? null,
      parentName: g.cloneOf?.slice(0, 255) ?? null,
      description: isArcade && g.description ? g.description.slice(0, 255) : null,
      removedFromSource: false,
    };
    partsByName.set(romName, parts);
    const k = known.get(romName);
    if (k) {
      // Only changed values are written; a source of equal or higher priority becomes the rom owner
      const data: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(fields)) {
        if ((key === 'serial' || key === 'raHash' || key === 'parentName' || key === 'description') && v == null) continue;
        if (!same(k.fields[key], v)) data[key] = v;
      }
      if (priority >= k.priority && k.datSourceId !== source.id) data.datSourceId = source.id;
      if (Object.keys(data).length) {
        await prisma.rom.update({ where: { id: k.id }, data });
        updated++;
      }
    } else {
      toInsert.push({ ...(fields as object), name: romName, datSourceId: source.id, gameId: gameByTitle.get(normalizeTitle(romTitle(g)).slice(0, 255))! } as Prisma.RomCreateManyInput);
    }
  }
  for (const c of chunk(toInsert, 1000)) await prisma.rom.createMany({ data: c, skipDuplicates: true });
  const created = toInsert.length;
  if (created) {
    const names = toInsert.map((r) => r.name);
    for (const c of chunk(names, 2000))
      for (const r of await prisma.rom.findMany({ where: { name: { in: c }, game: { systemId: system.id } }, select: { id: true, name: true, gameId: true } }))
        known.set(r.name, { id: r.id, gameId: r.gameId, datSourceId: source.id, priority, fields: {} });
  }
  // Last-checked date of every rom present in the source
  const presentIds = merged.map((g) => known.get(g.name.slice(0, 255))?.id).filter((x): x is number => !!x);
  for (const c of chunk(presentIds, 5000)) await prisma.rom.updateMany({ where: { id: { in: c } }, data: { checkedAt: now } });
  const partsByRom = new Map<number, PartRow[]>();
  for (const [name, parts] of partsByName) {
    const k = known.get(name);
    if (k) partsByRom.set(k.id, parts);
  }

  // Parts: updated by name without deleting (scanned files stay linked)
  const existingParts = await prisma.romPart.findMany({ where: { romId: { in: [...partsByRom.keys()] } } });
  const partIndex = new Map(existingParts.map((p) => [`${p.romId}|${p.name}`, p]));
  const toCreate: (PartRow & { romId: number })[] = [];
  for (const [romId, parts] of partsByRom) {
    for (const p of parts) {
      const row = { ...p, name: p.name.slice(0, 255) };
      const ex = partIndex.get(`${romId}|${row.name}`);
      if (!ex) toCreate.push({ ...row, romId });
      else if (ex.sha1 !== row.sha1 || ex.crc32 !== row.crc32 || ex.md5 !== row.md5 || ex.size !== row.size || (row.headerlessSha1 && ex.headerlessSha1 !== row.headerlessSha1)) {
        await prisma.romPart.update({
          where: { id: ex.id },
          data: {
            size: row.size,
            crc32: row.crc32 ?? ex.crc32,
            md5: row.md5 ?? ex.md5,
            sha1: row.sha1 ?? ex.sha1,
            headerlessSize: row.headerlessSize ?? ex.headerlessSize,
            headerlessCrc: row.headerlessCrc ?? ex.headerlessCrc,
            headerlessMd5: row.headerlessMd5 ?? ex.headerlessMd5,
            headerlessSha1: row.headerlessSha1 ?? ex.headerlessSha1,
          },
        });
      }
    }
  }
  for (const c of chunk(toCreate, 2000)) await prisma.romPart.createMany({ data: c });

  // Withdrawn from the source: kept, marked
  const names = new Set(merged.map((g) => g.name.slice(0, 255)));
  const owned = await prisma.rom.findMany({ where: { datSourceId: source.id }, select: { id: true, name: true } });
  const removed = owned.filter((r) => !names.has(r.name)).map((r) => r.id);
  for (const c of chunk(removed, 1000)) await prisma.rom.updateMany({ where: { id: { in: c } }, data: { removedFromSource: true } });

  // Parent/Clone evidence: the key is the parent (or the rom itself if it is a parent)
  const pcSource = 'dat-clone';
  const hasCloneInfo = merged.some((g) => g.cloneOf);
  if (hasCloneInfo) {
    const ev: EvidenceInput[] = [];
    for (const g of merged) {
      const romId = known.get(g.name.slice(0, 255))?.id;
      if (romId) ev.push({ romId, systemId: system.id, key: `pc:${g.cloneOf ?? g.name}`, source: pcSource });
    }
    await replaceRomEvidence(system.id, pcSource, ev);
  }

  await prisma.datSource.update({ where: { id: source.id }, data: { romCount: merged.length } });
  await done();
  if (opts.resolve !== false) await resolveRomGroups(system.id);

  return { datSourceId: source.id, system: system.slug, type, name, games: newTitles.size, roms: merged.length, hacks: 0, skipped: false, created, updated, removed: removed.length } as ImportResult;
}

async function importHacks(dat: DatFile, system: System, datSourceId: number, name: string): Promise<ImportResult> {
  const known = new Map((await prisma.romHack.findMany({ where: { datSourceId }, select: { id: true, title: true } })).map((h) => [h.title, h.id]));
  const seen = new Set<number>();
  let count = 0;
  for (const g of dat.games) {
    const r = g.roms[0];
    if (!r) continue;
    const baseName = r.name.replace(/\.[^.]+$/, '');
    const baseRom = await prisma.rom.findFirst({ where: { name: baseName, game: { systemId: system.id } } });
    let gameId = baseRom?.gameId;
    if (!gameId) {
      const title = parseRomName(baseName).title;
      const key = normalizeTitle(title);
      const game = (await prisma.game.findFirst({ where: { systemId: system.id, titleNormalized: key }, orderBy: { id: 'asc' } })) ??
        (await prisma.game.create({ data: { systemId: system.id, title, titleNormalized: key } }));
      gameId = game.id;
    }
    const by = g.name.match(/\[Hack by ([^\]]+)\]/);
    const ver = g.description?.match(/version \(([^)]+)\)/);
    const title = g.name.replace(/\s*\[Hack by [^\]]+\]/, '').slice(0, 255);
    // Short hack name: what follows the base game title ("Metroid - Rogue Dawn" -> "Rogue Dawn")
    const baseTitle = parseRomName(baseName).title;
    const hackName = title.startsWith(baseTitle + ' - ') ? title.slice(baseTitle.length + 3) : title;
    const data = {
      gameId,
      baseRomId: baseRom?.id ?? null,
      datSourceId,
      type: /translation|\[T[+-]/i.test(g.name) ? ('TRANSLATION' as const) : ('HACK' as const),
      title,
      hackName: hackName.slice(0, 255),
      author: by?.[1]?.slice(0, 255) ?? null,
      version: ver?.[1] ?? null,
      description: g.description ?? null,
      sourceUrl: g.patch ?? null,
      size: BigInt(r.size),
      crc32: r.crc32,
      md5: r.md5,
      sha1: r.sha1,
      baseEvidence: 'dat',
      removedFromSource: false,
    };
    const id = known.get(title);
    if (id) {
      await prisma.romHack.update({ where: { id }, data });
      seen.add(id);
    } else {
      const h = await prisma.romHack.create({ data });
      known.set(title, h.id);
      seen.add(h.id);
    }
    count++;
  }
  const gone = [...known.values()].filter((id) => !seen.has(id));
  if (gone.length) await prisma.romHack.updateMany({ where: { id: { in: gone } }, data: { removedFromSource: true } });
  await prisma.datSource.update({ where: { id: datSourceId }, data: { romCount: count } });
  return { datSourceId, system: system.slug, type: 'HACKS', name, games: 0, roms: 0, hacks: count, skipped: false };
}
