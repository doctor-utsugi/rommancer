/**
 * Memory cards: a card file on a device is a container, the saves inside it (entries) are what syncs.
 *
 * Each entry is a Save of kind ENTRY in one of the user's memory cards, keyed by its full name in the card's
 * directory ("BASCUS-94163FF7-S01"), never by its game: one game often writes several entries.
 * Per card file and entry the server keeps the version last synced and the entry's sha1 there (CardEntryBase),
 * so a game's per-game card on two consoles, or the same entry in two card files of one console, sync apart.
 *
 * Reading: the device sends the whole file, the server takes its entries out (upload, adopt or conflict, as for
 * any save) and keeps an image of the card. Writing: the server builds the card from the image it last read,
 * with entries put in or replaced and every other entry left in its blocks, and the device swaps it in only
 * while no emulator runs and the file is still the one the server read ("cget" lines). Entries sent count as
 * synced once the device is seen holding them: an emulator that had the old card in memory and wrote it back
 * leaves the old entry, which is then sent again instead of being taken for a newer save.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Prisma, type Device, type DeviceCard, type Emulator, type Save } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { codecFor, type CardEntry, type ReadCard } from './cardcodec.js';
import { gcRegion } from './gccard.js';
import { setBase, sha1 } from './core.js';
import { readVersion, storeVersion } from './service.js';

export const cardFamily = (emu: Pick<Emulator, 'saveFormat'>) => codecFor(emu)?.family ?? null;
export const isCardEmulator = (emu: Pick<Emulator, 'saveFormat'>) => cardFamily(emu) !== null;

/** Card files every game shares, by name, and the emulator that writes them */
const SHARED_CARDS: [RegExp, string][] = [
  [/^pcsx-card[12]\.mcd$/i, 'ra-pcsx-rearmed'],
  [/^duckstation_shared_card_[1-8]\.mcd$/i, 'ra-swanstation'],
  [/^shared_card_[1-8]\.mcd$/i, 'duckstation'],
  [/^mednafen_psx_libretro_shared\.\d\.mcr$/i, 'ra-beetle-psx'],
];
/** Per-game cards named after the disc's serial (PCSX-ReARMed "serial", SwanStation and DuckStation "PerGame") */
const SERIAL_CARD = /^([A-Z]{4}-\d{5})_[1-8]\.mcd$/i;

/** Dolphin's GameCube card images, one per slot and region (MemoryCardA.USA.raw, MemoryCardA.USA.251.raw) */
const GC_IMAGE = /^MemoryCard[AB]\.(USA|EUR|JAP)(?:\.\d+)?\.raw$/i;

/** A card file found by its name alone (not named after a rom): shared, or kept for the game of a serial */
export function namedCard(fileName: string): { shared: boolean; serial: string | null; emulator: string } | null {
  for (const [re, emulator] of SHARED_CARDS) if (re.test(fileName)) return { shared: true, serial: null, emulator };
  if (GC_IMAGE.test(fileName)) return { shared: true, serial: null, emulator: 'dolphin-raw' };
  const m = SERIAL_CARD.exec(fileName);
  return m ? { shared: false, serial: m[1].toUpperCase(), emulator: 'ra-pcsx-rearmed' } : null;
}

const KEEP_SNAPSHOTS = 30;

interface OfferEntry {
  saveId: number;
  versionId: number;
  name: string;
  entrySha1: string;
}

/** The entries of the last card sent, leaving out saves deleted since */
async function offerOf(dc: DeviceCard) {
  const offer = Array.isArray(dc.offer) ? (dc.offer as unknown as OfferEntry[]) : [];
  if (!offer.length) return offer;
  const alive = new Set((await prisma.save.findMany({ where: { id: { in: offer.map((o) => o.saveId) } }, select: { id: true } })).map((s) => s.id));
  return offer.filter((o) => alive.has(o.saveId));
}

/** The user's card a device's card files mount until another is chosen */
export async function mainCard(userId: number, family: string) {
  return prisma.memoryCard.upsert({ where: { userId_family_name: { userId, family, name: 'Main' } }, create: { userId, family, name: 'Main' }, update: {} });
}

/**
 * The game an entry belongs to, by the code in its name (PS1 product code, GameCube game code, matched against the
 * discs' serials: "SLUS-00067", "DL-DOL-GALE-USA"); the card's own game when the code finds none
 */
export async function gameForEntry(code: string | null, fallback: number | null, family: string = 'ps1') {
  if (!code) return { gameId: fallback, romId: null };
  const roms = await prisma.rom.findMany({
    where:
      family === 'gc'
        ? { game: { system: { slug: 'gc' } }, serial: { startsWith: `DL-DOL-${code}-` } }
        : { game: { system: { slug: 'psx' } }, OR: [{ serial: code }, { serial: { startsWith: `${code}-` } }] },
    select: { id: true, gameId: true },
    take: 20,
  });
  const hit = roms.find((r) => r.gameId === fallback) ?? roms[0];
  return hit ? { gameId: hit.gameId, romId: hit.id } : { gameId: fallback, romId: null };
}

/** Game of a per-game card named after a serial */
export async function gameForSerial(serial: string) {
  return (await gameForEntry(serial, null)).gameId;
}

export async function findDeviceCard(deviceId: number, rel: string) {
  return prisma.deviceCard.findUnique({ where: { deviceId_path: { deviceId, path: rel } } });
}

export async function deviceCard(device: Device, rel: string, emu: Emulator, opts: { shared: boolean; gameId: number | null }) {
  const found = await findDeviceCard(device.id, rel);
  if (found) {
    if (!found.shared && opts.gameId && found.gameId !== opts.gameId) return prisma.deviceCard.update({ where: { id: found.id }, data: { gameId: opts.gameId } });
    return found;
  }
  const card = await mainCard(device.userId, cardFamily(emu) ?? 'ps1');
  return prisma.deviceCard.upsert({
    where: { deviceId_path: { deviceId: device.id, path: rel } },
    create: { deviceId: device.id, path: rel, emulatorId: emu.id, shared: opts.shared, gameId: opts.gameId, cardId: card.id },
    update: {},
  });
}

async function snapshot(dc: DeviceCard, userId: number, buf: Buffer, kind: 'seen' | 'sent') {
  const s = sha1(buf);
  const known = await prisma.cardSnapshot.findFirst({ where: { deviceCardId: dc.id, sha1: s } });
  if (known) return known;
  const row = await prisma.cardSnapshot.create({ data: { deviceCardId: dc.id, sha1: s, path: '', size: buf.length, kind } });
  const rel = path.join(String(userId), 'cards', String(dc.id), `${row.id}-${s.slice(0, 8)}.bin`);
  await fs.promises.mkdir(path.dirname(path.join(env.savesDir, rel)), { recursive: true });
  await fs.promises.writeFile(path.join(env.savesDir, rel), buf);
  await prisma.cardSnapshot.update({ where: { id: row.id }, data: { path: rel } });
  // The images the device and the server are working from are never dropped
  const old = await prisma.cardSnapshot.findMany({ where: { deviceCardId: dc.id }, orderBy: { id: 'desc' }, skip: KEEP_SNAPSHOTS });
  for (const o of old) {
    if (o.sha1 === dc.lastSha1 || o.sha1 === dc.offerSha1 || o.sha1 === s) continue;
    await fs.promises.rm(path.join(env.savesDir, o.path), { force: true });
    await prisma.cardSnapshot.delete({ where: { id: o.id } });
  }
  return row;
}

export async function readSnapshot(snapshotPath: string) {
  return fs.promises.readFile(path.join(env.savesDir, snapshotPath));
}

async function imageOf(dc: DeviceCard, sha: string) {
  const snap = await prisma.cardSnapshot.findFirst({ where: { deviceCardId: dc.id, sha1: sha }, orderBy: { id: 'desc' } });
  return snap ? readSnapshot(snap.path).catch(() => null) : null;
}

async function setCardBase(dc: DeviceCard, deviceId: number, saveId: number, versionId: number | null, entrySha1: string | null) {
  await prisma.cardEntryBase.upsert({
    where: { deviceCardId_saveId: { deviceCardId: dc.id, saveId } },
    create: { deviceCardId: dc.id, saveId, versionId, entrySha1 },
    update: { versionId, entrySha1, syncedAt: new Date() },
  });
  // What the web app shows per console
  if (entrySha1) await setBase(saveId, deviceId, versionId, entrySha1);
}

const keyOf = (s: Save) => ({ userId: s.userId, emulatorId: s.emulatorId, kind: s.kind, slot: s.slot, baseName: s.baseName });

/** Entries sent with the card the device now holds: synced */
export async function commitOffer(dc: DeviceCard, deviceId: number) {
  for (const o of await offerOf(dc)) await setCardBase(dc, deviceId, o.saveId, o.versionId, o.entrySha1);
  return prisma.deviceCard.update({ where: { id: dc.id }, data: { lastSha1: dc.offerSha1, offerSha1: null, offer: Prisma.DbNull } });
}

/** The card file is gone from the device (a new SD card, a reinstall): its entries are written again from scratch */
export async function forgetDeviceCard(dc: DeviceCard) {
  await prisma.cardEntryBase.deleteMany({ where: { deviceCardId: dc.id } });
  return prisma.deviceCard.update({ where: { id: dc.id }, data: { lastSha1: null, offerSha1: null, offer: Prisma.DbNull } });
}

function parseCard(buf: Buffer, emu: Emulator): ReadCard {
  const codec = codecFor(emu);
  if (!codec) throw new Error(`${emu.slug} keeps no memory card`);
  return codec.read(buf);
}

/**
 * The base of an entry this card file has never been synced with: the version of the save the card holds (a
 * console behind), or, for an entry taken out of a whole card saved before cards were read entry by entry, the
 * version split from it when this device was in step with that card (so what changed since is the device's).
 */
async function firstBase(device: Device, dc: DeviceCard, save: Save, entrySha1: string) {
  const versions = await prisma.saveVersion.findMany({ where: { saveId: save.id }, select: { id: true, sha1: true, note: true }, orderBy: { id: 'asc' } });
  const held = versions.find((v) => v.sha1 === entrySha1);
  if (held) return { deviceCardId: dc.id, saveId: save.id, versionId: held.id, entrySha1, syncedAt: new Date() };
  const split = versions.find((v) => v.note?.startsWith('from '));
  if (!split) return undefined;
  const whole = await prisma.save.findFirst({ where: { userId: save.userId, kind: 'SAVE', supersededAt: { not: null }, baseName: split.note!.slice(5) } });
  const was = whole ? await prisma.saveDeviceState.findUnique({ where: { saveId_deviceId: { saveId: whole.id, deviceId: device.id } } }) : null;
  if (!whole || !was || was.versionId !== whole.currentVersionId) return undefined;
  const splitSha = (await prisma.saveVersion.findUnique({ where: { id: split.id }, select: { sha1: true } }))!.sha1;
  return { deviceCardId: dc.id, saveId: save.id, versionId: split.id, entrySha1: splitSha, syncedAt: new Date() };
}

/** Reads a card file the device sent: every entry is uploaded, adopted or kept as a conflict, as any save */
export async function observeCard(device: Device, dc: DeviceCard, emu: Emulator, buf: Buffer) {
  const result = { uploaded: 0, conflicts: 0, removed: 0, problems: [] as string[] };
  const deviceSha1 = sha1(buf);
  await snapshot(dc, device.userId, buf, 'seen');
  let card: ReadCard;
  try {
    card = parseCard(buf, emu);
  } catch (e) {
    const msg = `Unreadable card: ${e instanceof Error ? e.message : e}`.slice(0, 512);
    await prisma.deviceCard.update({ where: { id: dc.id }, data: { lastSha1: deviceSha1, offerSha1: null, offer: Prisma.DbNull, warning: msg } });
    result.problems.push(msg);
    return result;
  }
  const present = new Map(card.entries.map((e) => [e.name, e]));
  // A per-game card named after no rom (a title): its game is the one all its saves belong to
  if (!dc.shared && !dc.gameId && card.entries.length) {
    const games = new Set<number | null>();
    for (const e of card.entries) games.add((await gameForEntry(e.code, null, cardFamily(emu) ?? 'ps1')).gameId);
    const [only] = [...games];
    if (games.size === 1 && only) dc = await prisma.deviceCard.update({ where: { id: dc.id }, data: { gameId: only } });
  }
  for (const o of await offerOf(dc)) if (present.get(o.name)?.sha1 === o.entrySha1) await setCardBase(dc, device.id, o.saveId, o.versionId, o.entrySha1);
  const bases = new Map((await prisma.cardEntryBase.findMany({ where: { deviceCardId: dc.id } })).map((b) => [b.saveId, b]));
  const saves = await prisma.save.findMany({ where: { cardId: dc.cardId, baseName: { in: [...present.keys()] } } });
  const byName = new Map(saves.map((s) => [s.baseName, s]));
  const open = new Set((await prisma.saveConflict.findMany({ where: { deviceId: device.id, resolvedAt: null, saveId: { in: saves.map((s) => s.id) } } })).map((c) => c.saveId));
  for (const e of card.entries) {
    const save = byName.get(e.name);
    if (!save) {
      const ident = await gameForEntry(e.code, dc.gameId, cardFamily(emu) ?? 'ps1');
      const r = await storeVersion({ userId: device.userId, emulatorId: emu.id, kind: 'ENTRY', slot: dc.cardId, baseName: e.name }, e.data, new Date(), {
        sourceDeviceId: device.id,
        gameId: ident.gameId,
        romId: ident.romId,
        cardId: dc.cardId,
        label: e.title,
      });
      await setCardBase(dc, device.id, r.save.id, r.version.id, e.sha1);
      result.uploaded++;
      continue;
    }
    if (open.has(save.id)) continue;
    let base = bases.get(save.id);
    if (!base) {
      base = await firstBase(device, dc, save, e.sha1);
      if (base) await setCardBase(dc, device.id, save.id, base.versionId, base.entrySha1);
    }
    if (base && base.entrySha1 === e.sha1) continue;
    // An older version back on the card (an emulator wrote out the card it had in memory) is not a new save:
    // it becomes the base so the current one is sent again
    if (base?.versionId) {
      const older = await prisma.saveVersion.findFirst({ where: { saveId: save.id, sha1: e.sha1, id: { lt: base.versionId } }, orderBy: { id: 'desc' }, select: { id: true } });
      if (older) {
        await setCardBase(dc, device.id, save.id, older.id, e.sha1);
        continue;
      }
    }
    const serverChanged = !base || save.currentVersionId !== base.versionId;
    if (!serverChanged || !save.currentVersionId) {
      const r = await storeVersion(keyOf(save), e.data, new Date(), { sourceDeviceId: device.id, label: e.title });
      await setCardBase(dc, device.id, save.id, r.version.id, e.sha1);
      result.uploaded++;
      continue;
    }
    const current = await prisma.saveVersion.findUnique({ where: { id: save.currentVersionId }, select: { id: true, sha1: true } });
    if (current?.sha1 === e.sha1) {
      await setCardBase(dc, device.id, save.id, current.id, e.sha1);
      continue;
    }
    // Both sides changed: both versions are kept, the card keeps its own until the user picks one
    const r = await storeVersion(keyOf(save), e.data, new Date(), { sourceDeviceId: device.id, note: 'conflict', makeCurrent: false, force: true });
    await prisma.saveConflict.create({ data: { saveId: save.id, deviceId: device.id, deviceVersionId: r.version.id, serverVersionId: save.currentVersionId } });
    await setCardBase(dc, device.id, save.id, base?.versionId ?? null, e.sha1);
    result.conflicts++;
  }
  // Entries the device took out of this card stay out until they change somewhere else
  const gone = [...bases.values()].filter((b) => b.entrySha1 !== null);
  if (gone.length) {
    const names = new Map((await prisma.save.findMany({ where: { id: { in: gone.map((b) => b.saveId) } }, select: { id: true, baseName: true } })).map((s) => [s.id, s.baseName]));
    for (const b of gone) {
      if (present.has(names.get(b.saveId) ?? '')) continue;
      await prisma.cardEntryBase.update({ where: { deviceCardId_saveId: { deviceCardId: dc.id, saveId: b.saveId } }, data: { entrySha1: null, syncedAt: new Date() } });
      result.removed++;
    }
  }
  result.problems = card.problems;
  await prisma.deviceCard.update({
    where: { id: dc.id },
    data: {
      lastSha1: deviceSha1,
      offerSha1: null,
      offer: Prisma.DbNull,
      freeBlocks: card.freeBlocks,
      warning: card.problems.length ? `Damaged card, nothing is written to it: ${card.problems.join(', ')}`.slice(0, 512) : null,
    },
  });
  return result;
}

/**
 * A GameCube card file by its path: a Dolphin card image, or one save of a GCI folder (GC/<region>/Card A, the
 * default; GC/<region> when the folder is set in Dolphin.ini, as ROCKNIX does). Region as Dolphin's folders name it.
 */
export function gcCardFile(p: string): { kind: 'raw' | 'gci'; region: 'USA' | 'EUR' | 'JAP'; folder: string } | null {
  const parts = p.split('/');
  const name = parts[parts.length - 1] ?? '';
  const folder = parts.slice(0, -1).join('/');
  const img = GC_IMAGE.exec(name);
  if (img) return { kind: 'raw', region: img[1].toUpperCase() as 'USA' | 'EUR' | 'JAP', folder };
  if (!/\.gci$/i.test(name) || !parts.includes('GC')) return null;
  let at = parts.length - 2;
  if (/^Card [AB]$/i.test(parts[at] ?? '')) at--;
  const reg = (parts[at] ?? '').toUpperCase();
  if (!['USA', 'EUR', 'JAP', 'JPN'].includes(reg)) return null;
  return { kind: 'gci', region: reg === 'JPN' ? 'JAP' : (reg as 'USA' | 'EUR' | 'JAP'), folder };
}

/** The region a GameCube entry belongs to, by the game code in its name ("01-GALE-…"); null for any */
export const gcEntryRegion = (name: string) => gcRegion(name.split('-')[1] ?? '');

/**
 * Saves of the user's card that belong in a card file: its game's, or (shared cards) those of games without a card
 * of their own on the device. A GameCube image takes its region's; a .gci file holds the one save it was made for.
 */
async function wantedSaves(dc: DeviceCard) {
  const tracked = (await prisma.cardEntryBase.findMany({ where: { deviceCardId: dc.id }, select: { saveId: true } })).map((b) => b.saveId);
  const emu = await prisma.emulator.findUnique({ where: { id: dc.emulatorId } });
  let scope: Prisma.SaveWhereInput | null = null;
  if (emu?.saveFormat === 'gci') scope = null;
  else if (dc.shared) {
    // PS1 per-game cards keep their game's saves out of shared ones (GameCube has none)
    const own = await prisma.deviceCard.findMany({ where: { deviceId: dc.deviceId, shared: false, gameId: { not: null }, emulator: { saveFormat: { startsWith: 'ps1' } } }, select: { gameId: true } });
    const games = [...new Set(own.map((c) => c.gameId!))];
    scope = games.length ? { OR: [{ gameId: null }, { gameId: { notIn: games } }] } : {};
  } else if (dc.gameId) scope = { gameId: dc.gameId };
  // An empty scope (every save) would be dropped from an OR by Prisma: it then stands alone
  const which: Prisma.SaveWhereInput = scope && !Object.keys(scope).length ? {} : { OR: [{ id: { in: tracked } }, ...(scope ? [scope] : [])] };
  const saves = await prisma.save.findMany({
    where: { cardId: dc.cardId, kind: 'ENTRY', currentVersionId: { not: null }, ...which },
    orderBy: { updatedAt: 'desc' },
  });
  const region = emu?.saveFormat === 'gcraw' ? gcCardFile(dc.path)?.region : null;
  return region ? saves.filter((s) => tracked.includes(s.id) || (gcEntryRegion(s.baseName) ?? region) === region) : saves;
}

/** A .gci file name for an entry, as Dolphin names them, with what FAT and exFAT refuse replaced */
export const gciFileName = (entryName: string) => `${entryName.replace(/["*:<>?|\\/\x00-\x1f]/g, '_')}.gci`;

/**
 * The .gci files of a device's GCI folders. A file the device took out (Dolphin renames it to .gci.deleted) stays
 * out until its save changes elsewhere; a folder found empty that held saves is new (a reinstall, another card)
 * and gets them all back. Saves of the folder's region it lacks get a file of their own: NEW lists those to make.
 */
export async function gciFolderState(device: Device, emu: Emulator, folder: string, relOf: (abs: string) => string, present: Map<string, string>) {
  const inFolder = [...present.keys()].filter((p) => path.posix.dirname(p) === folder && gcCardFile(p)?.kind === 'gci');
  const rel = relOf(folder);
  const cards = await prisma.deviceCard.findMany({ where: { deviceId: device.id, emulatorId: emu.id, path: { startsWith: `${rel}/` } }, include: { bases: true } });
  const mine = cards.filter((c) => path.posix.dirname(c.path) === rel);
  const wiped = !inFolder.length && mine.some((c) => c.lastSha1);
  for (const c of mine) {
    if (inFolder.some((p) => relOf(p) === c.path)) continue;
    if (wiped) await prisma.cardEntryBase.updateMany({ where: { deviceCardId: c.id }, data: { versionId: null, entrySha1: null } });
    else if (c.lastSha1) await prisma.cardEntryBase.updateMany({ where: { deviceCardId: c.id }, data: { entrySha1: null } });
    if (c.lastSha1 || c.offerSha1) await prisma.deviceCard.update({ where: { id: c.id }, data: { lastSha1: null, offerSha1: null, offer: Prisma.DbNull } });
  }
  const absent = mine.filter((c) => !inFolder.some((p) => relOf(p) === c.path));
  // Files not read yet may hold any save: new files wait until they are
  const unread = inFolder.some((p) => mine.find((c) => c.path === relOf(p))?.lastSha1 !== present.get(p));
  if (unread) return { absent, made: [] as DeviceCard[] };
  const region = gcCardFile(`${folder}/x.gci`)?.region;
  const card = await mainCard(device.userId, 'gc');
  const held = new Set(mine.flatMap((c) => c.bases.map((b) => b.saveId)));
  const missing = (await prisma.save.findMany({ where: { cardId: card.id, kind: 'ENTRY', currentVersionId: { not: null } } })).filter(
    (s) => !held.has(s.id) && (gcEntryRegion(s.baseName) ?? region) === region,
  );
  const taken = new Set([...inFolder.map(relOf), ...cards.map((c) => c.path)]);
  const made: DeviceCard[] = [];
  for (const s of missing) {
    let file = `${rel}/${gciFileName(s.baseName)}`;
    for (let n = 0; taken.has(file) && n < 10; n++) file = file.replace(/0*\.gci$/, (m) => `0${m}`);
    if (taken.has(file)) continue;
    taken.add(file);
    const dc = await prisma.deviceCard.create({ data: { deviceId: device.id, path: file, emulatorId: emu.id, shared: false, gameId: s.gameId, cardId: card.id } });
    // Made for this save: the file holds it once written
    await prisma.cardEntryBase.create({ data: { deviceCardId: dc.id, saveId: s.id, versionId: null, entrySha1: null } });
    made.push(dc);
  }
  return { absent, made };
}

/** Saves of the user's card waiting to reach a per-game card file the device does not have yet */
export async function hasWantedSaves(userId: number, gameId: number) {
  return (await prisma.save.count({ where: { userId, kind: 'ENTRY', gameId, currentVersionId: { not: null }, card: { name: 'Main' } } })) > 0;
}

/**
 * The card to send to a device: the image of its file the server last read (or a new card when it has none)
 * with the server's newer entries put in. Null when nothing has to change. Entries whose content the card
 * already holds are only marked synced.
 */
export async function prepareCard(device: Device, dc: DeviceCard, emu: Emulator, deviceSha1: string | null) {
  const saves = await wantedSaves(dc);
  if (!saves.length) return null;
  const bases = new Map((await prisma.cardEntryBase.findMany({ where: { deviceCardId: dc.id } })).map((b) => [b.saveId, b]));
  const open = new Set((await prisma.saveConflict.findMany({ where: { deviceId: device.id, resolvedAt: null, saveId: { in: saves.map((s) => s.id) } } })).map((c) => c.saveId));
  // Cheap check first: every save already where it should be
  const pending = saves.filter((s) => !open.has(s.id) && bases.get(s.id)?.versionId !== s.currentVersionId);
  if (!pending.length) return null;
  const codec = codecFor(emu);
  if (!codec) return null;
  const raw = deviceSha1 ? await imageOf(dc, deviceSha1) : codec.blank();
  if (!raw) return null;
  let card: ReadCard;
  try {
    card = codec.read(raw);
  } catch {
    return null;
  }
  if (card.problems.length) return null;
  const present = new Map(card.entries.map((e) => [e.name, e]));
  const put: { save: Save; entry: CardEntry }[] = [];
  for (const s of pending) {
    const b = bases.get(s.id);
    const p = present.get(s.baseName);
    // On the card but not as last synced: the device changed it, it goes up first
    if (p && (!b || b.entrySha1 !== p.sha1)) continue;
    // Taken out on the device (or listed but not on this image): left alone
    if (!p && b && (b.entrySha1 !== null || b.versionId === s.currentVersionId)) continue;
    const v = await prisma.saveVersion.findUnique({ where: { id: s.currentVersionId! }, select: { id: true, sha1: true } });
    if (!v) continue;
    if (p && v.sha1 === p.sha1) {
      await setCardBase(dc, device.id, s.id, v.id, p.sha1);
      continue;
    }
    try {
      put.push({ save: s, entry: codec.entry(await readVersion(v.id)) });
    } catch {
      /* a version that is not an entry is left out */
    }
  }
  if (!put.length) return null;
  const { file, skipped } = codec.write(raw, put.map((p) => p.entry));
  const sent = put.filter((p) => !skipped.includes(p.entry.name));
  const warning = skipped.length
    ? `Card full, not written: ${put
        .filter((p) => skipped.includes(p.entry.name))
        .map((p) => p.save.label ?? p.save.baseName)
        .join(', ')}`.slice(0, 512)
    : null;
  if (warning !== dc.warning) await prisma.deviceCard.update({ where: { id: dc.id }, data: { warning } });
  if (!sent.length) return null;
  const offer: OfferEntry[] = sent.map((p) => ({ saveId: p.save.id, versionId: p.save.currentVersionId!, name: p.entry.name, entrySha1: p.entry.sha1 }));
  return { file, sha1: sha1(file), offer, freeBlocks: codec.read(file).freeBlocks };
}

/** Keeps what was sent: it counts as synced when the device is next seen with it */
export async function recordOffer(device: Device, dc: DeviceCard, prepared: NonNullable<Awaited<ReturnType<typeof prepareCard>>>) {
  const updated = await prisma.deviceCard.update({
    where: { id: dc.id },
    data: { offerSha1: prepared.sha1, offer: prepared.offer as unknown as Prisma.InputJsonValue },
  });
  await snapshot(updated, device.userId, prepared.file, 'sent');
  return updated;
}

/**
 * What a card file on a device needs: "put" (the device's file changed, the server reads it), "cget" (the
 * server has entries for it) or nothing. A card the device holds as it was sent is taken as synced first.
 */
export async function cardAction(device: Device, dc: DeviceCard, emu: Emulator, deviceSha1: string | null): Promise<'put' | 'cget' | null> {
  if (deviceSha1 && dc.offerSha1 === deviceSha1) dc = await commitOffer(dc, device.id);
  if (deviceSha1 && deviceSha1 !== dc.lastSha1) return 'put';
  if (!deviceSha1 && (dc.lastSha1 || dc.offerSha1)) dc = await forgetDeviceCard(dc);
  // Only per-game cards are created; a shared card is the emulator's to make
  if (!deviceSha1 && dc.shared) return null;
  return (await prepareCard(device, dc, emu, deviceSha1)) ? 'cget' : null;
}

/**
 * A PS1 card kept whole as one save (from before cards were read entry by entry, or uploaded in the web app):
 * its entries go into the user's card and the whole save is kept, marked as superseded, with its history.
 * An entry already in the user's card is left as it is (it came from a newer read of some card), unless
 * REPLACE (a card the user uploads by hand), which makes each of its entries the current version.
 */
export async function splitWholeCard(s: Save & { emulator: Emulator }, replace = false) {
  if (s.kind !== 'SAVE' || (s.supersededAt && !replace) || !s.currentVersionId || !isCardEmulator(s.emulator)) return 0;
  let entries: CardEntry[];
  try {
    entries = parseCard(await readVersion(s.currentVersionId), s.emulator).entries;
  } catch {
    return 0;
  }
  // An empty card (or a file that only looks like one) stays as it was
  if (!entries.length) return 0;
  const card = await mainCard(s.userId, cardFamily(s.emulator)!);
  const version = await prisma.saveVersion.findUnique({ where: { id: s.currentVersionId }, select: { sourceDeviceId: true, fileMtime: true } });
  let n = 0;
  for (const e of entries) {
    const existing = await prisma.save.findFirst({ where: { cardId: card.id, baseName: e.name } });
    if (existing && !replace) continue;
    const ident = await gameForEntry(e.code, s.gameId, card.family);
    await storeVersion(existing ? keyOf(existing) : { userId: s.userId, emulatorId: s.emulatorId, kind: 'ENTRY', slot: card.id, baseName: e.name }, e.data, version?.fileMtime ?? new Date(), {
      sourceDeviceId: version?.sourceDeviceId ?? undefined,
      gameId: ident.gameId,
      romId: ident.romId,
      cardId: card.id,
      label: e.title,
      note: `from ${s.baseName}`.slice(0, 255),
    });
    n++;
  }
  await prisma.save.update({ where: { id: s.id }, data: { supersededAt: new Date() } });
  return n;
}

/** Whole PS1 cards saved before cards were read entry by entry, newest first (the newest copy of an entry wins) */
export async function migrateWholeCards() {
  const old = await prisma.save.findMany({
    where: { kind: 'SAVE', supersededAt: null, currentVersionId: { not: null }, emulator: { saveFormat: { startsWith: 'ps1' } } },
    include: { emulator: true },
    orderBy: { updatedAt: 'desc' },
  });
  for (const s of old) await splitWholeCard(s);
}

/**
 * A conflict on an entry was settled: the card files of that device holding it take the chosen version as their
 * base (the device's when kept) and are read again, since entries changed while the conflict was open were skipped.
 */
export async function settleEntryConflict(saveId: number, deviceId: number, keptDeviceVersion: number | null) {
  const cards = await prisma.cardEntryBase.findMany({ where: { saveId, deviceCard: { deviceId } } });
  for (const b of cards) {
    if (keptDeviceVersion) await prisma.cardEntryBase.update({ where: { deviceCardId_saveId: { deviceCardId: b.deviceCardId, saveId } }, data: { versionId: keptDeviceVersion } });
    await prisma.deviceCard.update({ where: { id: b.deviceCardId }, data: { lastSha1: null } });
  }
}
