/**
 * The kinds of memory card file, each read and written entry by entry: a PS1 card (any of its formats), a
 * GameCube card image, and a single GameCube save in its own .gci file (Dolphin's GCI folders), which is a card
 * holding one entry. Entries are stored in their single-save form (.mcs, .gci) so any kind of card can take them.
 */
import type { Emulator } from '@prisma/client';
import { convertSave, ps1ToRaw, type SaveFormat } from './convert.js';
import { formatPs1Card, readMcs, readPs1Card, writePs1Card, type Ps1Entry } from './ps1card.js';
import { readGcCard, readGci, writeGcCard, type GcEntry } from './gccard.js';

export interface CardEntry {
  /** Its full name in the card's directory: what identifies it */
  name: string;
  title: string | null;
  blocks: number;
  /** The entry as a single save (.mcs, .gci) */
  data: Buffer;
  sha1: string;
  /** The code that tells its game: PS1 product code ("SCUS-94163"), GameCube game code ("GALE") */
  code: string | null;
}

export interface ReadCard {
  entries: CardEntry[];
  freeBlocks: number | null;
  problems: string[];
}

export interface CardCodec {
  /** The user's cards are per family: entries move between every kind of card of one family */
  family: 'ps1' | 'gc';
  /** The file as the device keeps it -> the card's entries */
  read(file: Buffer): ReadCard;
  /** The file with entries put in and taken out; those that do not fit are left out and named */
  write(file: Buffer, put: CardEntry[], remove?: string[]): { file: Buffer; skipped: string[] };
  /** A new file when the device has none; null when only the emulator makes it */
  blank(): Buffer | null;
  /** An entry from its single-save form */
  entry(data: Buffer): CardEntry;
}

const fromPs1 = (e: Ps1Entry): CardEntry => ({ name: e.name, title: e.title, blocks: e.blocks, data: e.mcs, sha1: e.sha1, code: e.productCode });
const fromGc = (e: GcEntry): CardEntry => ({ name: e.name, title: e.title, blocks: e.blocks, data: e.gci, sha1: e.sha1, code: e.gameCode });

function ps1Codec(fmt: SaveFormat): CardCodec {
  return {
    family: 'ps1',
    read(file) {
      const c = readPs1Card(ps1ToRaw(file, fmt));
      return { entries: c.entries.map(fromPs1), freeBlocks: c.freeBlocks, problems: c.problems };
    },
    write(file, put, remove = []) {
      const r = writePs1Card(ps1ToRaw(file, fmt), put.map((e) => readMcs(e.data)), remove);
      return { file: convertSave(r.card, 'ps1card', fmt), skipped: r.skipped };
    },
    blank: () => convertSave(formatPs1Card(), 'ps1card', fmt),
    entry: (data) => fromPs1(readMcs(data)),
  };
}

const gcImage: CardCodec = {
  family: 'gc',
  read(file) {
    const c = readGcCard(file);
    return { entries: c.entries.map(fromGc), freeBlocks: c.freeBlocks, problems: c.problems };
  },
  write(file, put, remove = []) {
    const r = writeGcCard(file, put.map((e) => readGci(e.data)), remove);
    return { file: r.card, skipped: r.skipped };
  },
  // Card images carry the serial games sign with: only Dolphin makes them
  blank: () => null,
  entry: (data) => fromGc(readGci(data)),
};

/** One .gci file: an empty file stands for a save not written yet; putting the entry replaces the file */
const gciFile: CardCodec = {
  family: 'gc',
  read: (file) => ({ entries: file.length ? [fromGc(readGci(file))] : [], freeBlocks: null, problems: [] }),
  write(file, put) {
    const e = put[put.length - 1];
    return { file: e ? readGci(e.data).gci : file, skipped: put.slice(0, -1).map((p) => p.name) };
  },
  blank: () => Buffer.alloc(0),
  entry: (data) => fromGc(readGci(data)),
};

export function codecFor(emu: Pick<Emulator, 'saveFormat'>): CardCodec | null {
  const fmt = emu.saveFormat as SaveFormat;
  if (fmt.startsWith('ps1')) return ps1Codec(fmt);
  if (fmt === 'gcraw') return gcImage;
  if (fmt === 'gci') return gciFile;
  return null;
}
