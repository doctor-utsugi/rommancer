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
  ['atari2600', 'Atari - 2600'],
  ['atari5200', 'Atari - 5200'],
  ['atari800', 'Atari - 8-bit Family'],
  ['jaguar', 'Atari - Jaguar'],
  ['atarist', 'Atari - ST'],
  ['wswan', 'Bandai - WonderSwan'],
  ['wswanc', 'Bandai - WonderSwan Color'],
  ['pcv2', 'Benesse - Pocket Challenge V2'],
  ['loopy', 'Casio - Loopy'],
  ['pv1000', 'Casio - PV-1000'],
  ['colecovision', 'Coleco - ColecoVision'],
  ['c64', 'Commodore - 64'],
  ['amiga500', 'Commodore - Amiga'],
  ['cplus4', 'Commodore - Plus-4'],
  ['c20', 'Commodore - VIC-20'],
  ['arcadia', 'Emerson - Arcadia 2001'],
  ['advision', 'Entex - Adventure Vision'],
  ['scv', 'Epoch - Super Cassette Vision'],
  ['channelf', 'Fairchild - Channel F'],
  ['supracan', 'Funtech - Super Acan'],
  ['vectrex', 'GCE - Vectrex'],
  ['gp32', 'GamePark - GP32'],
  ['gmaster', 'Hartung - Game Master'],
  ['vc4000', 'Interton - VC 4000'],
  ['o2em', 'Magnavox - Odyssey2'],
  ['videopacplus', 'Philips - Videopac+'],
  ['intellivision', 'Mattel - Intellivision'],
  ['msx1', 'Microsoft - MSX'],
  ['msx2', 'Microsoft - MSX2'],
  ['pcengine', 'NEC - PC Engine - TurboGrafx 16'],
  ['supergrafx', 'NEC - PC Engine SuperGrafx'],
  ['3ds', 'Nintendo - Nintendo 3DS'],
  ['n64dd', 'Nintendo - Nintendo 64DD'],
  ['nds-dsi', 'Nintendo - Nintendo DSi'],
  ['pokemini', 'Nintendo - Pokemon Mini'],
  ['satellaview', 'Nintendo - Satellaview'],
  ['sufami', 'Nintendo - Sufami Turbo'],
  ['virtualboy', 'Nintendo - Virtual Boy'],
  ['studio2', 'RCA - Studio II'],
  ['ngp', 'SNK - Neo Geo Pocket'],
  ['ngpc', 'SNK - Neo Geo Pocket Color'],
  ['sega32x', 'Sega - 32X'],
  ['pico', 'Sega - PICO'],
  ['sg1000', 'Sega - SG-1000'],
  ['x1', 'Sharp - X1'],
  ['x68000', 'Sharp - X68000'],
  ['zxspectrum', 'Sinclair - ZX Spectrum +3'],
  ['gamecom', 'Tiger - Game.com'],
  ['crvision', 'VTech - CreatiVision'],
  ['vsmile', 'VTech - V.Smile'],
  ['supervision', 'Watara - Supervision'],
  ['arduboy', 'Arduboy Inc - Arduboy'],
  ['psvita', 'Sony - PlayStation Vita'],
];

const REDUMP: [string, string][] = [
  ['psx', 'Sony - PlayStation'],
  ['ps2', 'Sony - PlayStation 2'],
  ['psp', 'Sony - PlayStation Portable'],
  ['gc', 'Nintendo - GameCube'],
  ['wii', 'Nintendo - Wii'],
  ['jaguarcd', 'Atari - Jaguar CD'],
  ['amigacd32', 'Commodore - CD32'],
  ['amigacdtv', 'Commodore - CDTV'],
  ['xbox', 'Microsoft - Xbox'],
  ['xbox360', 'Microsoft - Xbox 360'],
  ['pcenginecd', 'NEC - PC Engine CD - TurboGrafx-CD'],
  ['pc98', 'NEC - PC-98'],
  ['pcfx', 'NEC - PC-FX'],
  ['cdi', 'Philips - CD-i'],
  ['neogeocd', 'SNK - Neo Geo CD'],
  ['dreamcast', 'Sega - Dreamcast'],
  ['segacd', 'Sega - Mega-CD - Sega CD'],
  ['naomi', 'Sega - Naomi'],
  ['naomi2', 'Sega - Naomi 2'],
  ['saturn', 'Sega - Saturn'],
  ['ps3', 'Sony - PlayStation 3'],
  ['3do', 'The 3DO Company - 3DO'],
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
  // DAT oficial del equipo de FBNeo (incluye clones, a diferencia de la copia de libretro-database)
  {
    id: 'fbneo',
    system: 'fbneo',
    type: 'FBNEO',
    label: 'FBNeo · Arcade (oficial)',
    url: `${env.github.rawUrl}/libretro/FBNeo/master/dats/${encodeURIComponent('FinalBurn Neo (ClrMame Pro XML, Arcade only)')}.dat`,
  },
  // Los hacks al final: se enlazan con las roms base ya importadas
  ...HACKS.map(([system, n]) => ({ id: `hacks-${system}`, system, type: 'HACKS' as const, label: `Hacks · ${n}`, url: url('hacks', n) })),
];
