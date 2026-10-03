// DATs publicos de libretro-database para todos los sistemas soportados
import { env } from '../../config/env.js';

const BASE = `${env.github.rawUrl}/libretro/libretro-database/master/metadat`;

export interface DatPreset {
  id: string;
  system: string;
  type: 'NOINTRO' | 'REDUMP' | 'FBNEO' | 'HACKS';
  label: string;
  url: string;
}

const NOINTRO: [string, string][] = [
  ['nes', 'Nintendo - Nintendo Entertainment System'],
  ['fds', 'Nintendo - Family Computer Disk System'],
  ['snes', 'Nintendo - Super Nintendo Entertainment System'],
  ['gb', 'Nintendo - Game Boy'],
  ['gbc', 'Nintendo - Game Boy Color'],
  ['gba', 'Nintendo - Game Boy Advance'],
  ['n64', 'Nintendo - Nintendo 64'],
  ['nds', 'Nintendo - Nintendo DS'],
  ['sms', 'Sega - Master System - Mark III'],
  ['gg', 'Sega - Game Gear'],
  ['md', 'Sega - Mega Drive - Genesis'],
  ['lynx', 'Atari - Lynx'],
  ['a7800', 'Atari - 7800'],
];

const REDUMP: [string, string][] = [
  ['psx', 'Sony - PlayStation'],
  ['ps2', 'Sony - PlayStation 2'],
  ['psp', 'Sony - PlayStation Portable'],
  ['gc', 'Nintendo - GameCube'],
  ['wii', 'Nintendo - Wii'],
];

const HACKS: [string, string][] = [
  ['nes', 'Nintendo - Nintendo Entertainment System'],
  ['snes', 'Nintendo - Super Nintendo Entertainment System'],
  ['gb', 'Nintendo - Game Boy'],
  ['gbc', 'Nintendo - Game Boy Color'],
  ['gba', 'Nintendo - Game Boy Advance'],
  ['n64', 'Nintendo - Nintendo 64'],
  ['nds', 'Nintendo - Nintendo DS'],
  ['sms', 'Sega - Master System - Mark III'],
  ['gg', 'Sega - Game Gear'],
  ['md', 'Sega - Mega Drive - Genesis'],
  ['psx', 'Sony - PlayStation'],
  ['ps2', 'Sony - PlayStation 2'],
  ['psp', 'Sony - PlayStation Portable'],
];

const url = (dir: string, name: string) => `${BASE}/${dir}/${encodeURIComponent(name)}.dat`;

export const DAT_PRESETS: DatPreset[] = [
  ...NOINTRO.map(([system, n]) => ({ id: `nointro-${system}`, system, type: 'NOINTRO' as const, label: `No-Intro · ${n}`, url: url('no-intro', n) })),
  ...REDUMP.map(([system, n]) => ({ id: `redump-${system}`, system, type: 'REDUMP' as const, label: `Redump · ${n}`, url: url('redump', n) })),
  { id: 'fbneo', system: 'fbneo', type: 'FBNEO', label: 'FBNeo · Arcade Games', url: url('fbneo-split', 'FBNeo - Arcade Games') },
  // Los hacks al final: se enlazan con las roms base ya importadas
  ...HACKS.map(([system, n]) => ({ id: `hacks-${system}`, system, type: 'HACKS' as const, label: `Hacks · ${n}`, url: url('hacks', n) })),
];
