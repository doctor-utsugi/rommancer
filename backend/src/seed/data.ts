export interface SystemSeed {
  slug: string;
  name: string;
  manufacturer: string;
  datName: string;
  extensions: string[];
  headerType?: 'nes' | 'fds' | 'snes' | 'lynx' | 'a7800' | 'none';
  mediaType?: 'rom' | 'disc' | 'arcade';
  raConsoleId?: number;
  ssSystemId?: number;
  // Nombres alternativos de DAT (Redump, libretro, etc.)
  aliases?: string[];
}

export const systems: SystemSeed[] = [
  { slug: 'nes', name: 'NES / Famicom', manufacturer: 'Nintendo', datName: 'Nintendo - Nintendo Entertainment System', extensions: ['.nes', '.unf', '.unif'], headerType: 'nes', raConsoleId: 7, ssSystemId: 3 },
  { slug: 'fds', name: 'Famicom Disk System', manufacturer: 'Nintendo', datName: 'Nintendo - Family Computer Disk System', extensions: ['.fds'], headerType: 'fds', raConsoleId: 81, ssSystemId: 106 },
  { slug: 'snes', name: 'Super Nintendo', manufacturer: 'Nintendo', datName: 'Nintendo - Super Nintendo Entertainment System', extensions: ['.sfc', '.smc', '.swc', '.fig'], headerType: 'snes', raConsoleId: 3, ssSystemId: 4 },
  { slug: 'gb', name: 'Game Boy', manufacturer: 'Nintendo', datName: 'Nintendo - Game Boy', extensions: ['.gb'], raConsoleId: 4, ssSystemId: 9 },
  { slug: 'gbc', name: 'Game Boy Color', manufacturer: 'Nintendo', datName: 'Nintendo - Game Boy Color', extensions: ['.gbc'], raConsoleId: 6, ssSystemId: 10 },
  { slug: 'gba', name: 'Game Boy Advance', manufacturer: 'Nintendo', datName: 'Nintendo - Game Boy Advance', extensions: ['.gba'], raConsoleId: 5, ssSystemId: 12 },
  { slug: 'n64', name: 'Nintendo 64', manufacturer: 'Nintendo', datName: 'Nintendo - Nintendo 64', extensions: ['.z64', '.n64', '.v64'], raConsoleId: 2, ssSystemId: 14, aliases: ['Nintendo - Nintendo 64 (BigEndian)'] },
  { slug: 'nds', name: 'Nintendo DS', manufacturer: 'Nintendo', datName: 'Nintendo - Nintendo DS', extensions: ['.nds'], raConsoleId: 18, ssSystemId: 15, aliases: ['Nintendo - Nintendo DS (Decrypted)'] },
  { slug: 'gc', name: 'GameCube', manufacturer: 'Nintendo', datName: 'Nintendo - GameCube', extensions: ['.iso', '.gcm', '.rvz', '.wia', '.ciso'], mediaType: 'disc', raConsoleId: 16, ssSystemId: 13 },
  { slug: 'wii', name: 'Wii', manufacturer: 'Nintendo', datName: 'Nintendo - Wii', extensions: ['.iso', '.wbfs', '.rvz', '.wia', '.wad'], mediaType: 'disc', raConsoleId: 19, ssSystemId: 16 },
  { slug: 'sms', name: 'Master System', manufacturer: 'Sega', datName: 'Sega - Master System - Mark III', extensions: ['.sms'], raConsoleId: 11, ssSystemId: 2 },
  { slug: 'gg', name: 'Game Gear', manufacturer: 'Sega', datName: 'Sega - Game Gear', extensions: ['.gg'], raConsoleId: 15, ssSystemId: 21 },
  { slug: 'md', name: 'Mega Drive / Genesis', manufacturer: 'Sega', datName: 'Sega - Mega Drive - Genesis', extensions: ['.md', '.gen', '.bin', '.smd'], raConsoleId: 1, ssSystemId: 1 },
  { slug: 'psx', name: 'PlayStation', manufacturer: 'Sony', datName: 'Sony - PlayStation', extensions: ['.cue', '.chd', '.iso', '.pbp', '.m3u'], mediaType: 'disc', raConsoleId: 12, ssSystemId: 57 },
  { slug: 'ps2', name: 'PlayStation 2', manufacturer: 'Sony', datName: 'Sony - PlayStation 2', extensions: ['.iso', '.chd', '.cso', '.zso', '.cue'], mediaType: 'disc', raConsoleId: 21, ssSystemId: 58 },
  { slug: 'psp', name: 'PlayStation Portable', manufacturer: 'Sony', datName: 'Sony - PlayStation Portable', extensions: ['.iso', '.cso', '.zso', '.pbp', '.chd'], mediaType: 'disc', raConsoleId: 41, ssSystemId: 61 },
  { slug: 'fbneo', name: 'Arcade (FBNeo)', manufacturer: 'Arcade', datName: 'FBNeo - Arcade Games', extensions: ['.zip', '.7z'], mediaType: 'arcade', raConsoleId: 27, ssSystemId: 75, aliases: ['FinalBurn Neo - Arcade Games', 'FinalBurn Neo (ClrMame Pro XML, Arcade only)'] },
  { slug: 'lynx', name: 'Lynx', manufacturer: 'Atari', datName: 'Atari - Lynx', extensions: ['.lnx', '.lyx'], headerType: 'lynx', raConsoleId: 13, ssSystemId: 28 },
  { slug: 'a7800', name: 'Atari 7800', manufacturer: 'Atari', datName: 'Atari - 7800', extensions: ['.a78'], headerType: 'a7800', raConsoleId: 51, ssSystemId: 41 },
];

export interface EmulatorSeed {
  slug: string;
  name: string;
  core?: string;
  saveFormat?: 'raw' | 'ps1card' | 'ps1gme' | 'ps1vmp';
  saveExt: string;
  stateExt?: string;
}

// core = nombre de la carpeta que usa RetroArch con sort_savefiles_enable
export const emulators: EmulatorSeed[] = [
  { slug: 'ra-fceumm', name: 'RetroArch FCEUmm', core: 'FCEUmm', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-nestopia', name: 'RetroArch Nestopia', core: 'Nestopia', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-snes9x', name: 'RetroArch Snes9x', core: 'Snes9x', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-gambatte', name: 'RetroArch Gambatte', core: 'Gambatte', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-mgba', name: 'RetroArch mGBA', core: 'mGBA', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-gpsp', name: 'RetroArch gpSP', core: 'gpSP', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-mupen64plus', name: 'RetroArch Mupen64Plus-Next', core: 'Mupen64Plus-Next', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-melonds', name: 'RetroArch melonDS DS', core: 'melonDS DS', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-gpgx', name: 'RetroArch Genesis Plus GX', core: 'Genesis Plus GX', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-pcsx-rearmed', name: 'RetroArch PCSX-ReARMed', core: 'PCSX-ReARMed', saveFormat: 'ps1card', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-swanstation', name: 'RetroArch SwanStation', core: 'SwanStation', saveFormat: 'ps1card', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-fbneo', name: 'RetroArch FinalBurn Neo', core: 'FinalBurn Neo', saveExt: '.fs', stateExt: '.state' },
  { slug: 'ra-handy', name: 'RetroArch Handy', core: 'Handy', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-prosystem', name: 'RetroArch ProSystem', core: 'ProSystem', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-dolphin', name: 'RetroArch Dolphin', core: 'dolphin-emu', saveExt: '.gci', stateExt: '.state' },
  { slug: 'mgba', name: 'mGBA (standalone)', saveExt: '.sav', stateExt: '.ss0' },
  // The cartridge itself: flashcarts write the raw save next to the rom, no savestates
  { slug: 'gba-cart', name: 'GBA cartridge (flashcart)', saveExt: '.sav' },
  { slug: 'snes9x', name: 'Snes9x (standalone)', saveExt: '.srm', stateExt: '.000' },
  { slug: 'duckstation', name: 'DuckStation', saveFormat: 'ps1card', saveExt: '.mcd', stateExt: '.sav' },
  { slug: 'epsxe', name: 'ePSXe', saveFormat: 'ps1card', saveExt: '.mcr' },
  { slug: 'dexdrive', name: 'DexDrive', saveFormat: 'ps1gme', saveExt: '.gme' },
  { slug: 'ps3-psp-vmp', name: 'PSP/PS3 Virtual Memory Card', saveFormat: 'ps1vmp', saveExt: '.vmp' },
  { slug: 'pcsx2', name: 'PCSX2', saveExt: '.ps2', stateExt: '.p2s' },
  { slug: 'ppsspp', name: 'PPSSPP', saveExt: '.bin', stateExt: '.ppst' },
  { slug: 'melonds', name: 'melonDS (standalone)', saveExt: '.sav', stateExt: '.ml1' },
  { slug: 'drastic', name: 'DraStic', saveExt: '.dsv', stateExt: '.dst' },
];

// Emulador por defecto de cada sistema en firmwares basados en RetroArch
const raDefaults: Record<string, string> = {
  nes: 'ra-fceumm',
  fds: 'ra-fceumm',
  snes: 'ra-snes9x',
  gb: 'ra-gambatte',
  gbc: 'ra-gambatte',
  gba: 'ra-mgba',
  n64: 'ra-mupen64plus',
  nds: 'ra-melonds',
  gc: 'ra-dolphin',
  wii: 'ra-dolphin',
  sms: 'ra-gpgx',
  gg: 'ra-gpgx',
  md: 'ra-gpgx',
  psx: 'ra-pcsx-rearmed',
  ps2: 'pcsx2',
  psp: 'ppsspp',
  fbneo: 'ra-fbneo',
  lynx: 'ra-handy',
  a7800: 'ra-prosystem',
};

function map(folders: Record<string, string>, emu: Record<string, string> = {}) {
  const out: Record<string, { folder: string; emulator: string }> = {};
  for (const [slug, folder] of Object.entries(folders)) out[slug] = { folder, emulator: emu[slug] ?? raDefaults[slug] };
  return out;
}

const batoceraFolders = {
  nes: 'nes', fds: 'fds', snes: 'snes', gb: 'gb', gbc: 'gbc', gba: 'gba', n64: 'n64', nds: 'nds', gc: 'gamecube', wii: 'wii',
  sms: 'mastersystem', gg: 'gamegear', md: 'megadrive', psx: 'psx', ps2: 'ps2', psp: 'psp', fbneo: 'fbneo', lynx: 'lynx', a7800: 'atari7800',
};
const esdeFolders = { ...batoceraFolders, gc: 'gc', md: 'genesis' };
const muosFolders = {
  nes: 'Nintendo NES-Famicom', fds: 'Nintendo FDS', snes: 'Nintendo SNES-SFC', gb: 'Nintendo Game Boy', gbc: 'Nintendo Game Boy Color',
  gba: 'Nintendo Game Boy Advance', n64: 'Nintendo N64', nds: 'Nintendo DS', sms: 'Sega Master System', gg: 'Sega Game Gear',
  md: 'Sega Mega Drive - Genesis', psx: 'Sony PlayStation', psp: 'Sony PlayStation Portable', fbneo: 'Arcade', lynx: 'Atari Lynx', a7800: 'Atari 7800',
};
const onionFolders = {
  nes: 'FC', fds: 'FDS', snes: 'SFC', gb: 'GB', gbc: 'GBC', gba: 'GBA', n64: 'N64', nds: 'NDS', sms: 'MS', gg: 'GG', md: 'MD',
  psx: 'PS', fbneo: 'FBNEO', lynx: 'LYNX', a7800: 'SEVEN',
};

export interface FirmwareSeed {
  slug: string;
  name: string;
  romsRoot: string;
  savesRoot: string;
  statesRoot: string;
  biosRoot: string;
  savesLayout: 'flat' | 'system' | 'core' | 'rom' | 'rom-core' | 'rom-saves' | 'beside';
  systemMap: Record<string, { folder: string; emulator: string }>;
}

export const firmwares: FirmwareSeed[] = [
  { slug: 'rocknix', name: 'ROCKNIX', romsRoot: 'roms', savesRoot: 'roms', statesRoot: 'roms', biosRoot: 'roms/bios', savesLayout: 'rom', systemMap: map(batoceraFolders) },
  { slug: 'knulli', name: 'Knulli', romsRoot: 'roms', savesRoot: 'saves', statesRoot: 'saves', biosRoot: 'bios', savesLayout: 'system', systemMap: map(batoceraFolders) },
  { slug: 'batocera', name: 'Batocera', romsRoot: 'roms', savesRoot: 'saves', statesRoot: 'saves', biosRoot: 'bios', savesLayout: 'system', systemMap: map(batoceraFolders) },
  { slug: 'muos', name: 'muOS', romsRoot: 'ROMS', savesRoot: 'MUOS/save/file', statesRoot: 'MUOS/save/state', biosRoot: 'MUOS/bios', savesLayout: 'core', systemMap: map(muosFolders) },
  { slug: 'onion', name: 'Onion OS', romsRoot: 'Roms', savesRoot: 'Saves/CurrentProfile/saves', statesRoot: 'Saves/CurrentProfile/states', biosRoot: 'BIOS', savesLayout: 'core', systemMap: map(onionFolders) },
  { slug: 'android-esde', name: 'Android (ES-DE + RetroArch)', romsRoot: 'ROMs', savesRoot: 'RetroArch/saves', statesRoot: 'RetroArch/states', biosRoot: 'RetroArch/system', savesLayout: 'flat', systemMap: map(esdeFolders, { psx: 'duckstation', gba: 'ra-mgba', nds: 'melonds' }) },
  { slug: 'retroarch-desktop', name: 'RetroArch (Windows/Linux/macOS)', romsRoot: 'roms', savesRoot: 'saves', statesRoot: 'states', biosRoot: 'system', savesLayout: 'flat', systemMap: map(esdeFolders) },
  // SD card synced from a PC (no network on the console): TWiLight Menu++ keeps saves in a "saves" folder next to the roms
  { slug: 'nds-twilight', name: 'Nintendo DS (TWiLight Menu++ SD card)', romsRoot: 'roms', savesRoot: 'roms', statesRoot: 'roms', biosRoot: '_nds', savesLayout: 'rom-saves', systemMap: map({ nds: 'nds' }, { nds: 'melonds' }) },
  // GBA flashcarts (SuperCard, EZ-Flash...): roms anywhere on the card, each .sav next to its rom
  { slug: 'gba-flashcart', name: 'GBA flashcart (SuperCard, EZ-Flash…)', romsRoot: '', savesRoot: '', statesRoot: '', biosRoot: '', savesLayout: 'beside', systemMap: map({ gba: '' }, { gba: 'gba-cart' }) },
  { slug: 'esde-desktop', name: 'ES-DE (escritorio)', romsRoot: 'ROMs', savesRoot: 'saves', statesRoot: 'states', biosRoot: 'bios', savesLayout: 'flat', systemMap: map(esdeFolders) },
];

export const consoles = [
  { name: 'AYN Thor', manufacturer: 'AYN', formFactor: 'handheld' },
  { name: 'AYN Odin 2', manufacturer: 'AYN', formFactor: 'handheld' },
  { name: 'Retroid Pocket 5', manufacturer: 'Retroid', formFactor: 'handheld' },
  { name: 'Retroid Pocket Mini', manufacturer: 'Retroid', formFactor: 'handheld' },
  { name: 'Anbernic RG35XX', manufacturer: 'Anbernic', formFactor: 'handheld' },
  { name: 'Anbernic RG406H', manufacturer: 'Anbernic', formFactor: 'handheld' },
  { name: 'Miyoo Mini Plus', manufacturer: 'Miyoo', formFactor: 'handheld' },
  { name: 'Powkiddy RGB30', manufacturer: 'Powkiddy', formFactor: 'handheld' },
  { name: 'Steam Deck', manufacturer: 'Valve', formFactor: 'handheld' },
  { name: 'Game Boy Advance', manufacturer: 'Nintendo', formFactor: 'handheld' },
  { name: 'Game Boy Advance SP', manufacturer: 'Nintendo', formFactor: 'handheld' },
  { name: 'Nintendo DS', manufacturer: 'Nintendo', formFactor: 'handheld' },
  { name: 'Nintendo DSi', manufacturer: 'Nintendo', formFactor: 'handheld' },
  { name: 'Nintendo 3DS', manufacturer: 'Nintendo', formFactor: 'handheld' },
  { name: 'PC', manufacturer: 'Generic', formFactor: 'desktop' },
  { name: 'Other', manufacturer: 'Generic', formFactor: 'handheld' },
];
