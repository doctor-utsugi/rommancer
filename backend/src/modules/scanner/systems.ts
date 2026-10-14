import path from 'node:path';
import type { System } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

export const ARCHIVE_EXTS = new Set(['.zip', '.7z']);
export const EXTRA_EXTS = ['.zip', '.7z', '.chd', '.rvz', '.wia', '.bin', '.img', '.iso', '.cue'];

const EXTRA_FOLDERS: Record<string, string[]> = {
  nes: ['fc', 'famicom', 'nintendo', 'nes'],
  snes: ['sfc', 'superfamicom', 'supernintendo', 'snes'],
  md: ['genesis', 'megadrive', 'md', 'mega drive'],
  sms: ['mastersystem', 'ms', 'sms'],
  gg: ['gamegear', 'gg'],
  psx: ['ps1', 'ps', 'playstation', 'psx'],
  ps2: ['ps2', 'playstation2'],
  psp: ['psp'],
  // ES-DE's folder
  '3ds': ['3ds', 'n3ds'],
  gc: ['gc', 'gamecube', 'ngc'],
  wii: ['wii'],
  fbneo: ['fbneo', 'fba', 'arcade', 'fbn', 'cps1', 'cps2', 'cps3', 'neogeo'],
  n64: ['n64'],
  nds: ['nds', 'ds'],
};

/** A folder name as systems are looked up by it: case, spaces and punctuation aside ("Game Boy Advance" = "GameBoyAdvance") */
export const folderKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

export function systemForFolder(idx: SystemIndex, name: string) {
  return idx.byFolder.get(folderKey(name));
}

export interface SystemIndex {
  bySlug: Map<string, System>;
  byId: Map<number, System>;
  byFolder: Map<string, System>;
  byExt: Map<string, System>;
  allExts: Set<string>;
}

let cache: { at: number; idx: SystemIndex } | null = null;

export async function systemIndex(): Promise<SystemIndex> {
  if (cache && Date.now() - cache.at < 30_000) return cache.idx;
  const systems = await prisma.system.findMany();
  const firmwares = await prisma.firmware.findMany();
  const idx: SystemIndex = { bySlug: new Map(), byId: new Map(), byFolder: new Map(), byExt: new Map(), allExts: new Set(EXTRA_EXTS) };
  const extCount = new Map<string, number>();
  for (const s of systems) {
    idx.bySlug.set(s.slug, s);
    idx.byId.set(s.id, s);
    // Its slug, its databases' name with and without the maker ("Nintendo - Game Boy"), its name with and without it
    const dat = s.datName.split(' - ');
    for (const n of [s.slug, s.datName, dat.slice(1).join(' '), s.name, `${s.manufacturer} ${s.name}`, ...(EXTRA_FOLDERS[s.slug] ?? [])]) {
      const k = folderKey(n);
      if (k && !idx.byFolder.has(k)) idx.byFolder.set(k, s);
    }
    for (const e of s.extensions as string[]) {
      idx.allExts.add(e);
      extCount.set(e, (extCount.get(e) ?? 0) + 1);
    }
  }
  for (const fw of firmwares) {
    for (const [slug, v] of Object.entries(fw.systemMap as Record<string, { folder: string }>)) {
      const s = idx.bySlug.get(slug);
      if (s && v.folder) idx.byFolder.set(folderKey(v.folder), s);
    }
  }
  // Only unambiguous extensions can infer the system
  for (const s of systems)
    for (const e of s.extensions as string[]) if (extCount.get(e) === 1 && !EXTRA_EXTS.includes(e)) idx.byExt.set(e, s);
  cache = { at: Date.now(), idx };
  return idx;
}

export function guessSystem(idx: SystemIndex, relPath: string, forced: System | null, entryName?: string): System | null {
  if (forced) return forced;
  const dirs = path.dirname(relPath).split(/[\\/]/).reverse();
  for (const d of dirs) {
    const s = systemForFolder(idx, d);
    if (s) return s;
  }
  const ext = path.extname(entryName ?? relPath).toLowerCase();
  return idx.byExt.get(ext) ?? null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Frontend platform names (LaunchBox's) that the DAT names do not spell out
const PLATFORM_NAMES: Record<string, string> = {
  sonypsp: 'psp',
  sonypspminis: 'psp',
  atari800: 'atari800',
  nintendofamicomdisksystem: 'fds',
  commodoreamigacd32: 'amigacd32',
  '3dointeractivemultiplayer': '3do',
  sinclairzxspectrum: 'zxspectrum',
  arcade: 'fbneo',
  snkneogeoaes: 'fbneo',
  snkneogeomvs: 'fbneo',
  necpc9801: 'pc98',
  bandaiwonderswan: 'wswan',
  bandaiwonderswancolor: 'wswanc',
};

/**
 * A system from a frontend's platform name ("Nintendo Game Boy Advance", "Sega Genesis", "NEC TurboGrafx-16"): a
 * part of its DAT name, alone or after the maker, or its own name; null when none matches
 */
export async function systemForPlatform(name: string): Promise<string | null> {
  const n = norm(name);
  if (!n) return null;
  if (PLATFORM_NAMES[n]) return PLATFORM_NAMES[n];
  const idx = await systemIndex();
  for (const s of idx.bySlug.values()) {
    const [maker, ...parts] = s.datName.split(' - ');
    const names = [s.datName, s.name, s.slug, parts.join(' '), ...parts, ...((s.datAliases as string[] | null) ?? [])];
    if (names.some((x) => norm(x) === n || norm(maker + x) === n)) return s.slug;
  }
  // Frontends that name platforms by their rom folders (ES-DE's "snes", "psx", "gc")
  return systemForFolder(idx, name)?.slug ?? null;
}
