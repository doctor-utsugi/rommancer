import crypto from 'node:crypto';
import type { DatType, System } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { normalizeTitle, parseRomName } from '../../lib/romname.js';
import { raHashFromDat } from '../../lib/rahash.js';
import { parseDat, type DatFile, type DatGame, type DatRom } from './parser.js';

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
    const clean = c.replace(/\s*\((Parent-Clone|\d{8}-\d+|[^)]*Headered[^)]*|Decrypted|Encrypted|BigEndian)\)/gi, '').trim().toLowerCase();
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

/** Agrupa entradas con el mismo nombre (libretro separa .nes y .unh) y fusiona las versiones sin cabecera. */
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

export async function importDat(
  text: string,
  opts: { systemId?: number; type?: DatType; fileName?: string; force?: boolean } = {},
): Promise<ImportResult> {
  const fileSha1 = crypto.createHash('sha1').update(text).digest('hex');
  const dat = parseDat(text);
  const system = opts.systemId ? await prisma.system.findUniqueOrThrow({ where: { id: opts.systemId } }) : await detectSystem(dat, opts.fileName);
  if (!system) throw new Error(`Cannot detect system for DAT "${dat.name}"`);
  const type = opts.type ?? detectType(dat, opts.fileName);
  const name = dat.name || opts.fileName || 'DAT';

  const existing = await prisma.datSource.findUnique({ where: { systemId_type_name: { systemId: system.id, type, name } } });
  if (existing && existing.fileSha1 === fileSha1 && !opts.force) {
    return { datSourceId: existing.id, system: system.slug, type, name, games: 0, roms: existing.romCount, hacks: 0, skipped: true };
  }
  const source = existing
    ? await prisma.datSource.update({ where: { id: existing.id }, data: { fileSha1: '', version: dat.version ?? null, importedAt: new Date(), fileName: opts.fileName ?? existing.fileName } })
    : await prisma.datSource.create({ data: { systemId: system.id, type, name, version: dat.version ?? null, fileSha1: '', fileName: opts.fileName ?? null } });
  // El sha1 se fija al terminar: si la importacion falla a medias, se reintentara entera
  const done = () => prisma.datSource.update({ where: { id: source.id }, data: { fileSha1 } });

  if (type === 'HACKS') {
    const r = await importHacks(dat, system, source.id, name);
    await done();
    return r;
  }

  const merged = mergeGames(dat.games);
  // Padres antes que clones para que los clones hereden el juego del padre
  const ordered = [...merged.values()].sort((a, b) => Number(!!a.cloneOf) - Number(!!b.cloneOf));
  const isArcade = system.mediaType === 'arcade';

  // 1. Juegos
  const gameMap = new Map<string, number>();
  for (const g of await prisma.game.findMany({ where: { systemId: system.id }, select: { id: true, titleNormalized: true } }))
    gameMap.set(g.titleNormalized, g.id);

  const romTitle = (g: DatGame) => parseRomName(isArcade && g.description ? g.description : g.name).title;
  const romGameKey = new Map<string, string>();
  const newGames = new Map<string, string>();
  for (const g of ordered) {
    let key: string;
    if (g.cloneOf && romGameKey.has(g.cloneOf)) key = romGameKey.get(g.cloneOf)!;
    else {
      const title = romTitle(g);
      key = normalizeTitle(title).slice(0, 255);
      if (!gameMap.has(key) && !newGames.has(key)) newGames.set(key, title.slice(0, 255));
    }
    romGameKey.set(g.name, key);
  }
  for (const c of chunk([...newGames.entries()], 1000)) {
    await prisma.game.createMany({
      data: c.map(([titleNormalized, title]) => ({ systemId: system.id, title, titleNormalized })),
      skipDuplicates: true,
    });
  }
  if (newGames.size)
    for (const g of await prisma.game.findMany({ where: { systemId: system.id }, select: { id: true, titleNormalized: true } }))
      gameMap.set(g.titleNormalized, g.id);

  // 2. Roms
  const romMap = new Map<string, number>();
  for (const r of await prisma.rom.findMany({ where: { datSourceId: source.id }, select: { id: true, name: true } })) romMap.set(r.name, r.id);
  const partsByRom = new Map<string, PartRow[]>();
  const romRows = ordered.map((g) => {
    const p = parseRomName(g.name);
    const parts = buildParts(g.roms);
    partsByRom.set(g.name, parts);
    const first = parts[0];
    return {
      gameId: gameMap.get(romGameKey.get(g.name)!)!,
      datSourceId: source.id,
      name: g.name.slice(0, 255),
      regions: p.regions,
      languages: p.languages,
      revision: p.revision,
      flags: p.flags,
      isBios: !!g.isBios || /\[BIOS\]/.test(g.name),
      raHash: first && parts.length === 1 ? raHashFromDat(system.slug, first) : null,
    };
  });
  const toCreate = romRows.filter((r) => !romMap.has(r.name));
  for (const c of chunk(toCreate, 1000)) await prisma.rom.createMany({ data: c, skipDuplicates: true });
  const toUpdate = romRows.filter((r) => romMap.has(r.name));
  for (const r of toUpdate) {
    await prisma.rom.update({ where: { id: romMap.get(r.name)! }, data: { gameId: r.gameId, regions: r.regions, languages: r.languages, revision: r.revision, flags: r.flags, raHash: r.raHash } });
  }
  romMap.clear();
  for (const r of await prisma.rom.findMany({ where: { datSourceId: source.id }, select: { id: true, name: true } })) romMap.set(r.name, r.id);

  // Roms que ya no estan en el DAT
  const names = new Set(romRows.map((r) => r.name));
  const stale = [...romMap.entries()].filter(([n]) => !names.has(n)).map(([, id]) => id);
  for (const c of chunk(stale, 1000)) await prisma.rom.deleteMany({ where: { id: { in: c } } });

  // 3. Partes: se regeneran. Los RomFile pierden su enlace y se re-emparejan con rematch.
  await prisma.romPart.deleteMany({ where: { rom: { datSourceId: source.id } } });
  const partRows = [...partsByRom.entries()].flatMap(([romName, parts]) => {
    const romId = romMap.get(romName.slice(0, 255));
    return romId ? parts.map((p) => ({ ...p, romId, name: p.name.slice(0, 255) })) : [];
  });
  for (const c of chunk(partRows, 2000)) await prisma.romPart.createMany({ data: c });

  await prisma.datSource.update({ where: { id: source.id }, data: { romCount: romRows.length } });
  await done();
  // Limpieza de juegos vacios
  await prisma.game.deleteMany({ where: { systemId: system.id, roms: { none: {} }, hacks: { none: {} }, listItems: { none: {} } } });

  return { datSourceId: source.id, system: system.slug, type, name, games: newGames.size, roms: romRows.length, hacks: 0, skipped: false };
}

async function importHacks(dat: DatFile, system: System, datSourceId: number, name: string): Promise<ImportResult> {
  await prisma.romHack.deleteMany({ where: { datSourceId } });
  let count = 0;
  for (const g of dat.games) {
    const r = g.roms[0];
    if (!r) continue;
    const baseName = r.name.replace(/\.[^.]+$/, '');
    const baseRom = await prisma.rom.findFirst({ where: { name: baseName, datSource: { systemId: system.id } } });
    let gameId = baseRom?.gameId;
    if (!gameId) {
      const title = parseRomName(baseName).title;
      const key = normalizeTitle(title);
      const game = await prisma.game.upsert({
        where: { systemId_titleNormalized: { systemId: system.id, titleNormalized: key } },
        create: { systemId: system.id, title, titleNormalized: key },
        update: {},
      });
      gameId = game.id;
    }
    const by = g.name.match(/\[Hack by ([^\]]+)\]/);
    const ver = g.description?.match(/version \(([^)]+)\)/);
    await prisma.romHack.create({
      data: {
        gameId,
        baseRomId: baseRom?.id ?? null,
        datSourceId,
        type: /translation|\[T[+-]/i.test(g.name) ? 'TRANSLATION' : 'HACK',
        title: g.name.replace(/\s*\[Hack by [^\]]+\]/, '').slice(0, 255),
        author: by?.[1]?.slice(0, 255) ?? null,
        version: ver?.[1] ?? null,
        description: g.description ?? null,
        sourceUrl: g.patch ?? null,
        size: BigInt(r.size),
        crc32: r.crc32,
        md5: r.md5,
        sha1: r.sha1,
      },
    });
    count++;
  }
  await prisma.datSource.update({ where: { id: datSourceId }, data: { romCount: count } });
  return { datSourceId, system: system.slug, type: 'HACKS', name, games: 0, roms: 0, hacks: count, skipped: false };
}
