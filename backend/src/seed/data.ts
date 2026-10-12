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
  // More cartridge (No-Intro) and disc (Redump) systems from libretro-database; RetroAchievements ids from rcheevos
  { slug: 'atari2600', name: 'Atari 2600', manufacturer: 'Atari', datName: 'Atari - 2600', extensions: ['.a26', '.bin'], raConsoleId: 25 },
  { slug: 'atari5200', name: 'Atari 5200', manufacturer: 'Atari', datName: 'Atari - 5200', extensions: ['.a52', '.bin'], raConsoleId: 50 },
  { slug: 'atari800', name: 'Atari 8-bit', manufacturer: 'Atari', datName: 'Atari - 8-bit Family', extensions: ['.atr', '.xex', '.xfd', '.car', '.atx'] },
  { slug: 'jaguar', name: 'Jaguar', manufacturer: 'Atari', datName: 'Atari - Jaguar', extensions: ['.j64', '.jag'], raConsoleId: 17 },
  { slug: 'atarist', name: 'Atari ST', manufacturer: 'Atari', datName: 'Atari - ST', extensions: ['.st', '.msa', '.stx'], raConsoleId: 36 },
  { slug: 'wswan', name: 'WonderSwan', manufacturer: 'Bandai', datName: 'Bandai - WonderSwan', extensions: ['.ws'], raConsoleId: 53 },
  { slug: 'wswanc', name: 'WonderSwan Color', manufacturer: 'Bandai', datName: 'Bandai - WonderSwan Color', extensions: ['.wsc'], raConsoleId: 53 },
  { slug: 'pcv2', name: 'Pocket Challenge V2', manufacturer: 'Benesse', datName: 'Benesse - Pocket Challenge V2', extensions: ['.pc2'] },
  { slug: 'loopy', name: 'Casio Loopy', manufacturer: 'Casio', datName: 'Casio - Loopy', extensions: ['.bin'] },
  { slug: 'pv1000', name: 'Casio PV-1000', manufacturer: 'Casio', datName: 'Casio - PV-1000', extensions: ['.bin'] },
  { slug: 'colecovision', name: 'ColecoVision', manufacturer: 'Coleco', datName: 'Coleco - ColecoVision', extensions: ['.col'], raConsoleId: 44 },
  { slug: 'c64', name: 'Commodore 64', manufacturer: 'Commodore', datName: 'Commodore - 64', extensions: ['.crt', '.d64', '.t64', '.prg', '.tap', '.g64'], raConsoleId: 30 },
  { slug: 'amiga500', name: 'Amiga', manufacturer: 'Commodore', datName: 'Commodore - Amiga', extensions: ['.adf', '.ipf', '.hdf', '.lha', '.dms'], raConsoleId: 35 },
  { slug: 'cplus4', name: 'Commodore Plus/4', manufacturer: 'Commodore', datName: 'Commodore - Plus-4', extensions: ['.prg', '.d64', '.tap'] },
  { slug: 'c20', name: 'Commodore VIC-20', manufacturer: 'Commodore', datName: 'Commodore - VIC-20', extensions: ['.20', '.40', '.60', '.a0', '.b0', '.crt', '.prg'], raConsoleId: 34 },
  { slug: 'arcadia', name: 'Arcadia 2001', manufacturer: 'Emerson', datName: 'Emerson - Arcadia 2001', extensions: ['.bin'], raConsoleId: 73 },
  { slug: 'advision', name: 'Adventure Vision', manufacturer: 'Entex', datName: 'Entex - Adventure Vision', extensions: ['.bin'] },
  { slug: 'scv', name: 'Super Cassette Vision', manufacturer: 'Epoch', datName: 'Epoch - Super Cassette Vision', extensions: ['.bin', '.0'], raConsoleId: 55 },
  { slug: 'channelf', name: 'Channel F', manufacturer: 'Fairchild', datName: 'Fairchild - Channel F', extensions: ['.chf', '.bin'], raConsoleId: 57 },
  { slug: 'supracan', name: 'Super Acan', manufacturer: 'Funtech', datName: 'Funtech - Super Acan', extensions: ['.bin'] },
  { slug: 'vectrex', name: 'Vectrex', manufacturer: 'GCE', datName: 'GCE - Vectrex', extensions: ['.vec', '.gam', '.bin'], raConsoleId: 46 },
  { slug: 'gp32', name: 'GP32', manufacturer: 'GamePark', datName: 'GamePark - GP32', extensions: ['.gxb', '.fxe'] },
  { slug: 'gmaster', name: 'Game Master', manufacturer: 'Hartung', datName: 'Hartung - Game Master', extensions: ['.bin'] },
  { slug: 'vc4000', name: 'VC 4000', manufacturer: 'Interton', datName: 'Interton - VC 4000', extensions: ['.bin'], raConsoleId: 74 },
  { slug: 'o2em', name: 'Odyssey2 / Videopac', manufacturer: 'Magnavox', datName: 'Magnavox - Odyssey2', extensions: ['.bin'], raConsoleId: 23 },
  { slug: 'videopacplus', name: 'Videopac+', manufacturer: 'Philips', datName: 'Philips - Videopac+', extensions: ['.bin'] },
  { slug: 'intellivision', name: 'Intellivision', manufacturer: 'Mattel', datName: 'Mattel - Intellivision', extensions: ['.int', '.bin', '.rom'], raConsoleId: 45 },
  { slug: 'msx1', name: 'MSX', manufacturer: 'Microsoft', datName: 'Microsoft - MSX', extensions: ['.rom', '.mx1', '.dsk', '.cas'], raConsoleId: 29 },
  { slug: 'msx2', name: 'MSX2', manufacturer: 'Microsoft', datName: 'Microsoft - MSX2', extensions: ['.mx2', '.rom', '.dsk'], raConsoleId: 29 },
  { slug: 'pcengine', name: 'PC Engine / TurboGrafx-16', manufacturer: 'NEC', datName: 'NEC - PC Engine - TurboGrafx 16', extensions: ['.pce'], raConsoleId: 8 },
  { slug: 'supergrafx', name: 'PC Engine SuperGrafx', manufacturer: 'NEC', datName: 'NEC - PC Engine SuperGrafx', extensions: ['.sgx'], raConsoleId: 8 },
  { slug: '3ds', name: 'Nintendo 3DS', manufacturer: 'Nintendo', datName: 'Nintendo - Nintendo 3DS', extensions: ['.3ds', '.cia', '.cci'], raConsoleId: 62 },
  { slug: 'n64dd', name: 'Nintendo 64DD', manufacturer: 'Nintendo', datName: 'Nintendo - Nintendo 64DD', extensions: ['.ndd'] },
  { slug: 'nds-dsi', name: 'Nintendo DSi', manufacturer: 'Nintendo', datName: 'Nintendo - Nintendo DSi', extensions: ['.dsi'], raConsoleId: 78 },
  { slug: 'pokemini', name: 'Pokemon Mini', manufacturer: 'Nintendo', datName: 'Nintendo - Pokemon Mini', extensions: ['.min'], raConsoleId: 24 },
  { slug: 'satellaview', name: 'Satellaview', manufacturer: 'Nintendo', datName: 'Nintendo - Satellaview', extensions: ['.bs'] },
  { slug: 'sufami', name: 'Sufami Turbo', manufacturer: 'Nintendo', datName: 'Nintendo - Sufami Turbo', extensions: ['.st'] },
  { slug: 'virtualboy', name: 'Virtual Boy', manufacturer: 'Nintendo', datName: 'Nintendo - Virtual Boy', extensions: ['.vb', '.vboy'], raConsoleId: 28 },
  { slug: 'studio2', name: 'RCA Studio II', manufacturer: 'RCA', datName: 'RCA - Studio II', extensions: ['.st2', '.bin'] },
  { slug: 'ngp', name: 'Neo Geo Pocket', manufacturer: 'SNK', datName: 'SNK - Neo Geo Pocket', extensions: ['.ngp'], raConsoleId: 14 },
  { slug: 'ngpc', name: 'Neo Geo Pocket Color', manufacturer: 'SNK', datName: 'SNK - Neo Geo Pocket Color', extensions: ['.ngc', '.ngpc'], raConsoleId: 14 },
  { slug: 'sega32x', name: 'Sega 32X', manufacturer: 'Sega', datName: 'Sega - 32X', extensions: ['.32x'], raConsoleId: 10 },
  { slug: 'pico', name: 'Sega Pico', manufacturer: 'Sega', datName: 'Sega - PICO', extensions: ['.md', '.bin'], raConsoleId: 68 },
  { slug: 'sg1000', name: 'SG-1000', manufacturer: 'Sega', datName: 'Sega - SG-1000', extensions: ['.sg'], raConsoleId: 33 },
  { slug: 'x1', name: 'Sharp X1', manufacturer: 'Sharp', datName: 'Sharp - X1', extensions: ['.2d', '.d88', '.88d', '.hdm'], raConsoleId: 64 },
  { slug: 'x68000', name: 'Sharp X68000', manufacturer: 'Sharp', datName: 'Sharp - X68000', extensions: ['.dim', '.xdf', '.hdf', '.d88'], raConsoleId: 52 },
  { slug: 'zxspectrum', name: 'ZX Spectrum', manufacturer: 'Sinclair', datName: 'Sinclair - ZX Spectrum +3', extensions: ['.tzx', '.z80', '.tap', '.dsk', '.sna'], raConsoleId: 59 },
  { slug: 'gamecom', name: 'Game.com', manufacturer: 'Tiger', datName: 'Tiger - Game.com', extensions: ['.tgc', '.bin'] },
  { slug: 'crvision', name: 'CreatiVision', manufacturer: 'VTech', datName: 'VTech - CreatiVision', extensions: ['.bin', '.rom'] },
  { slug: 'vsmile', name: 'V.Smile', manufacturer: 'VTech', datName: 'VTech - V.Smile', extensions: ['.bin'] },
  { slug: 'supervision', name: 'Supervision', manufacturer: 'Watara', datName: 'Watara - Supervision', extensions: ['.sv'], raConsoleId: 63 },
  { slug: 'arduboy', name: 'Arduboy', manufacturer: 'Arduboy', datName: 'Arduboy Inc - Arduboy', extensions: ['.hex', '.arduboy'], raConsoleId: 71 },
  { slug: 'psvita', name: 'PlayStation Vita', manufacturer: 'Sony', datName: 'Sony - PlayStation Vita', extensions: ['.vpk'] },
  { slug: 'jaguarcd', name: 'Jaguar CD', manufacturer: 'Atari', datName: 'Atari - Jaguar CD', extensions: ['.cue', '.chd', '.iso'], mediaType: 'disc', raConsoleId: 77 },
  { slug: 'amigacd32', name: 'Amiga CD32', manufacturer: 'Commodore', datName: 'Commodore - CD32', extensions: ['.cue', '.chd', '.iso'], mediaType: 'disc' },
  { slug: 'amigacdtv', name: 'Commodore CDTV', manufacturer: 'Commodore', datName: 'Commodore - CDTV', extensions: ['.cue', '.chd', '.iso'], mediaType: 'disc' },
  { slug: 'xbox', name: 'Xbox', manufacturer: 'Microsoft', datName: 'Microsoft - Xbox', extensions: ['.iso', '.xiso'], mediaType: 'disc', raConsoleId: 22 },
  { slug: 'xbox360', name: 'Xbox 360', manufacturer: 'Microsoft', datName: 'Microsoft - Xbox 360', extensions: ['.iso', '.xex'], mediaType: 'disc' },
  { slug: 'pcenginecd', name: 'PC Engine CD / TurboGrafx-CD', manufacturer: 'NEC', datName: 'NEC - PC Engine CD - TurboGrafx-CD', extensions: ['.cue', '.chd', '.iso'], mediaType: 'disc', raConsoleId: 76 },
  { slug: 'pc98', name: 'PC-98', manufacturer: 'NEC', datName: 'NEC - PC-98', extensions: ['.cue', '.chd', '.iso'], mediaType: 'disc', raConsoleId: 48 },
  { slug: 'pcfx', name: 'PC-FX', manufacturer: 'NEC', datName: 'NEC - PC-FX', extensions: ['.cue', '.chd', '.iso'], mediaType: 'disc', raConsoleId: 49 },
  { slug: 'cdi', name: 'CD-i', manufacturer: 'Philips', datName: 'Philips - CD-i', extensions: ['.cue', '.chd', '.iso'], mediaType: 'disc', raConsoleId: 42 },
  { slug: 'neogeocd', name: 'Neo Geo CD', manufacturer: 'SNK', datName: 'SNK - Neo Geo CD', extensions: ['.cue', '.chd', '.iso'], mediaType: 'disc', raConsoleId: 56 },
  { slug: 'dreamcast', name: 'Dreamcast', manufacturer: 'Sega', datName: 'Sega - Dreamcast', extensions: ['.gdi', '.cdi', '.chd', '.cue'], mediaType: 'disc', raConsoleId: 40 },
  { slug: 'segacd', name: 'Mega-CD / Sega CD', manufacturer: 'Sega', datName: 'Sega - Mega-CD - Sega CD', extensions: ['.cue', '.chd', '.iso'], mediaType: 'disc', raConsoleId: 9 },
  { slug: 'naomi', name: 'Naomi', manufacturer: 'Sega', datName: 'Sega - Naomi', extensions: ['.zip', '.chd'], mediaType: 'disc' },
  { slug: 'naomi2', name: 'Naomi 2', manufacturer: 'Sega', datName: 'Sega - Naomi 2', extensions: ['.zip', '.chd'], mediaType: 'disc' },
  { slug: 'saturn', name: 'Saturn', manufacturer: 'Sega', datName: 'Sega - Saturn', extensions: ['.cue', '.chd', '.iso'], mediaType: 'disc', raConsoleId: 39 },
  { slug: 'ps3', name: 'PlayStation 3', manufacturer: 'Sony', datName: 'Sony - PlayStation 3', extensions: ['.iso', '.pkg'], mediaType: 'disc', raConsoleId: 82 },
  { slug: '3do', name: '3DO', manufacturer: 'The 3DO Company', datName: 'The 3DO Company - 3DO', extensions: ['.cue', '.chd', '.iso'], mediaType: 'disc', raConsoleId: 43 },
];

export interface EmulatorSeed {
  slug: string;
  name: string;
  core?: string;
  saveFormat?: 'raw' | 'ps1card' | 'ps1gme' | 'ps1vmp' | 'gcraw' | 'gci';
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
  { slug: 'ra-beetle-psx', name: 'RetroArch Beetle PSX', core: 'Beetle PSX', saveFormat: 'ps1card', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-fbneo', name: 'RetroArch FinalBurn Neo', core: 'FinalBurn Neo', saveExt: '.fs', stateExt: '.state' },
  { slug: 'ra-handy', name: 'RetroArch Handy', core: 'Handy', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-prosystem', name: 'RetroArch ProSystem', core: 'ProSystem', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-dolphin', name: 'RetroArch Dolphin', core: 'dolphin-emu', saveExt: '.gci', stateExt: '.state' },
  { slug: 'ra-stella', name: 'RetroArch Stella', core: 'Stella', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-a5200', name: 'RetroArch a5200', core: 'a5200', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-atari800', name: 'RetroArch Atari800', core: 'Atari800', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-virtualjaguar', name: 'RetroArch Virtual Jaguar', core: 'Virtual Jaguar', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-hatari', name: 'RetroArch Hatari', core: 'Hatari', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-beetle-wswan', name: 'RetroArch Beetle Cygne', core: 'Beetle Cygne', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-gearcoleco', name: 'RetroArch Gearcoleco', core: 'Gearcoleco', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-vice-x64', name: 'RetroArch VICE x64', core: 'VICE x64', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-puae', name: 'RetroArch PUAE', core: 'PUAE', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-freechaf', name: 'RetroArch FreeChaF', core: 'FreeChaF', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-vecx', name: 'RetroArch vecx', core: 'vecx', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-o2em', name: 'RetroArch O2EM', core: 'O2EM', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-freeintv', name: 'RetroArch FreeIntv', core: 'FreeIntv', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-bluemsx', name: 'RetroArch blueMSX', core: 'blueMSX', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-beetle-pce', name: 'RetroArch Beetle PCE Fast', core: 'Beetle PCE Fast', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-beetle-sgx', name: 'RetroArch Beetle SuperGrafx', core: 'Beetle SuperGrafx', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-pokemini', name: 'RetroArch PokeMini', core: 'PokeMini', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-beetle-vb', name: 'RetroArch Beetle VB', core: 'Beetle VB', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-beetle-ngp', name: 'RetroArch Beetle NeoPop', core: 'Beetle NeoPop', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-picodrive', name: 'RetroArch PicoDrive', core: 'PicoDrive', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-px68k', name: 'RetroArch PX68k', core: 'PX68k', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-fuse', name: 'RetroArch Fuse', core: 'Fuse', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-potator', name: 'RetroArch Potator', core: 'Potator', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-arduous', name: 'RetroArch Arduous', core: 'Arduous', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-beetle-pcfx', name: 'RetroArch Beetle PC-FX', core: 'Beetle PC-FX', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-same-cdi', name: 'RetroArch SAME CDi', core: 'SAME CDi', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-neocd', name: 'RetroArch NeoCD', core: 'NeoCD', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-beetle-saturn', name: 'RetroArch Beetle Saturn', core: 'Beetle Saturn', saveExt: '.srm', stateExt: '.state' },
  { slug: 'ra-opera', name: 'RetroArch Opera', core: 'Opera', saveExt: '.srm', stateExt: '.state' },
  { slug: 'mgba', name: 'mGBA (standalone)', saveExt: '.sav', stateExt: '.ss0' },
  // The cartridge itself: flashcarts write the raw save next to the rom, no savestates
  { slug: 'gba-cart', name: 'GBA cartridge (flashcart)', saveExt: '.sav' },
  { slug: 'snes9x', name: 'Snes9x (standalone)', saveExt: '.srm', stateExt: '.000' },
  { slug: 'duckstation', name: 'DuckStation', saveFormat: 'ps1card', saveExt: '.mcd', stateExt: '.sav' },
  // Dolphin's GameCube memory cards, standalone or as the RetroArch core: one .gci per save in a "GCI folder"
  // (GC/<USA|EUR|JAP>/Card A, the default) or a card image (GC/MemoryCardA.USA.raw)
  { slug: 'dolphin-gci', name: 'Dolphin (GCI folder)', saveFormat: 'gci', saveExt: '.gci' },
  { slug: 'dolphin-raw', name: 'Dolphin (memory card image)', saveFormat: 'gcraw', saveExt: '.raw' },
  { slug: 'epsxe', name: 'ePSXe', saveFormat: 'ps1card', saveExt: '.mcr' },
  { slug: 'dexdrive', name: 'DexDrive', saveFormat: 'ps1gme', saveExt: '.gme' },
  { slug: 'ps3-psp-vmp', name: 'PSP/PS3 Virtual Memory Card', saveFormat: 'ps1vmp', saveExt: '.vmp' },
  { slug: 'pcsx2', name: 'PCSX2', saveExt: '.ps2', stateExt: '.p2s' },
  { slug: 'ppsspp', name: 'PPSSPP', saveExt: '.bin', stateExt: '.ppst' },
  { slug: 'melonds', name: 'melonDS (standalone)', saveExt: '.sav', stateExt: '.ml1' },
  { slug: 'drastic', name: 'DraStic', saveExt: '.dsv', stateExt: '.dst' },
  // NextUI/MinUI (minarch): "<rom with its extension>.sav" and states ".st0".."st7", ".st9" the auto-resume one.
  // No core here: the slug after "minui-" names minarch's states folder (<tag>-<core>)
  ...(
    [
      ['fceumm', 'FCEUmm'], ['snes9x', 'Snes9x'], ['gambatte', 'Gambatte'], ['gpsp', 'gpSP'], ['mgba', 'mGBA'], ['picodrive', 'PicoDrive'],
      ['pcsx_rearmed', 'PCSX-ReARMed'], ['mednafen_pce_fast', 'Beetle PCE Fast'], ['pokemini', 'PokeMini'], ['mednafen_vb', 'Beetle VB'],
      ['race', 'RACE'], ['handy', 'Handy'], ['stella2014', 'Stella 2014'], ['a5200', 'a5200'], ['prosystem', 'ProSystem'], ['bluemsx', 'blueMSX'], ['gearcoleco', 'Gearcoleco'],
    ] as const
  ).map(([core, name]): EmulatorSeed => ({ slug: `minui-${core}`, name: `NextUI ${name}`, saveFormat: core === 'pcsx_rearmed' ? 'ps1card' : 'raw', saveExt: '.sav', stateExt: '.st' })),
];

// Emulador por defecto de cada sistema en firmwares basados en RetroArch
export const raDefaults: Record<string, string> = {
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
  'atari2600': 'ra-stella',
  'atari5200': 'ra-a5200',
  'atari800': 'ra-atari800',
  'jaguar': 'ra-virtualjaguar',
  'atarist': 'ra-hatari',
  'wswan': 'ra-beetle-wswan',
  'wswanc': 'ra-beetle-wswan',
  'colecovision': 'ra-gearcoleco',
  'c64': 'ra-vice-x64',
  'amiga500': 'ra-puae',
  'channelf': 'ra-freechaf',
  'vectrex': 'ra-vecx',
  'o2em': 'ra-o2em',
  'videopacplus': 'ra-o2em',
  'intellivision': 'ra-freeintv',
  'msx1': 'ra-bluemsx',
  'msx2': 'ra-bluemsx',
  'pcengine': 'ra-beetle-pce',
  'supergrafx': 'ra-beetle-sgx',
  'n64dd': 'ra-mupen64plus',
  'nds-dsi': 'ra-melonds',
  'pokemini': 'ra-pokemini',
  'satellaview': 'ra-snes9x',
  'sufami': 'ra-snes9x',
  'virtualboy': 'ra-beetle-vb',
  'ngp': 'ra-beetle-ngp',
  'ngpc': 'ra-beetle-ngp',
  'sega32x': 'ra-picodrive',
  'pico': 'ra-picodrive',
  'sg1000': 'ra-gpgx',
  'x68000': 'ra-px68k',
  'zxspectrum': 'ra-fuse',
  'supervision': 'ra-potator',
  'arduboy': 'ra-arduous',
  'amigacd32': 'ra-puae',
  'amigacdtv': 'ra-puae',
  'pcenginecd': 'ra-beetle-pce',
  'pcfx': 'ra-beetle-pcfx',
  'cdi': 'ra-same-cdi',
  'neogeocd': 'ra-neocd',
  'segacd': 'ra-gpgx',
  'saturn': 'ra-beetle-saturn',
  '3do': 'ra-opera',
};

function map(folders: Record<string, string>, emu: Record<string, string> = {}) {
  const out: Record<string, { folder: string; emulator: string }> = {};
  for (const [slug, folder] of Object.entries(folders)) out[slug] = { folder, emulator: emu[slug] ?? raDefaults[slug] };
  return out;
}

const batoceraFolders = {
  nes: 'nes', fds: 'fds', snes: 'snes', gb: 'gb', gbc: 'gbc', gba: 'gba', n64: 'n64', nds: 'nds', gc: 'gamecube', wii: 'wii',
  sms: 'mastersystem', gg: 'gamegear', md: 'megadrive', psx: 'psx', ps2: 'ps2', psp: 'psp', fbneo: 'fbneo', lynx: 'lynx', a7800: 'atari7800',
  // Knulli/Batocera use these names as folders: the new systems' slugs follow them
  'atari2600': 'atari2600', 'atari5200': 'atari5200', 'atari800': 'atari800', 'jaguar': 'jaguar', 'atarist': 'atarist', 'wswan': 'wswan', 'wswanc': 'wswanc', 'pcv2': 'pcv2', 'loopy': 'loopy', 'pv1000': 'pv1000', 'colecovision': 'colecovision', 'c64': 'c64', 'amiga500': 'amiga500', 'cplus4': 'cplus4', 'c20': 'c20', 'arcadia': 'arcadia', 'advision': 'advision', 'scv': 'scv', 'channelf': 'channelf', 'supracan': 'supracan', 'vectrex': 'vectrex', 'gp32': 'gp32', 'gmaster': 'gmaster', 'vc4000': 'vc4000', 'o2em': 'o2em', 'videopacplus': 'videopacplus', 'intellivision': 'intellivision', 'msx1': 'msx1', 'msx2': 'msx2', 'pcengine': 'pcengine', 'supergrafx': 'supergrafx', '3ds': '3ds', 'n64dd': 'n64dd', 'pokemini': 'pokemini', 'satellaview': 'satellaview', 'sufami': 'sufami', 'virtualboy': 'virtualboy', 'studio2': 'studio2', 'ngp': 'ngp', 'ngpc': 'ngpc', 'sega32x': 'sega32x', 'pico': 'pico', 'sg1000': 'sg1000', 'x1': 'x1', 'x68000': 'x68000', 'zxspectrum': 'zxspectrum', 'gamecom': 'gamecom', 'crvision': 'crvision', 'vsmile': 'vsmile', 'supervision': 'supervision', 'arduboy': 'arduboy', 'psvita': 'psvita', 'jaguarcd': 'jaguarcd', 'amigacd32': 'amigacd32', 'amigacdtv': 'amigacdtv', 'xbox': 'xbox', 'xbox360': 'xbox360', 'pcenginecd': 'pcenginecd', 'pc98': 'pc98', 'pcfx': 'pcfx', 'cdi': 'cdi', 'neogeocd': 'neogeocd', 'dreamcast': 'dreamcast', 'segacd': 'segacd', 'naomi': 'naomi', 'naomi2': 'naomi2', 'saturn': 'saturn', 'ps3': 'ps3', '3do': '3do',
};
const esdeFolders = { ...batoceraFolders, gc: 'gc', md: 'genesis' };
const muosFolders = {
  nes: 'Nintendo NES-Famicom', fds: 'Nintendo FDS', snes: 'Nintendo SNES-SFC', gb: 'Nintendo Game Boy', gbc: 'Nintendo Game Boy Color',
  gba: 'Nintendo Game Boy Advance', n64: 'Nintendo N64', nds: 'Nintendo DS', sms: 'Sega Master System', gg: 'Sega Game Gear',
  md: 'Sega Mega Drive - Genesis', psx: 'Sony PlayStation', psp: 'Sony PlayStation Portable', fbneo: 'Arcade', lynx: 'Atari Lynx', a7800: 'Atari 7800',
};
// ArkOS/dArkOS: es_systems.cfg folders under /roms (or /roms2 with the second card)
const arkosFolders = {
  nes: 'nes', fds: 'fds', snes: 'snes', gb: 'gb', gbc: 'gbc', gba: 'gba', n64: 'n64', nds: 'nds', gc: 'gc', sms: 'mastersystem', gg: 'gamegear', md: 'megadrive',
  psx: 'psx', psp: 'psp', fbneo: 'arcade', lynx: 'atarilynx', a7800: 'atari7800', atari2600: 'atari2600', atari5200: 'atari5200', atari800: 'atari800', jaguar: 'atarijaguar',
  atarist: 'atarist', wswan: 'wonderswan', wswanc: 'wonderswancolor', colecovision: 'coleco', c64: 'c64', amiga500: 'amiga', advision: 'advision', scv: 'scv', channelf: 'channelf',
  vectrex: 'vectrex', o2em: 'odyssey2', intellivision: 'intellivision', msx1: 'msx', msx2: 'msx2', pcengine: 'pcengine', supergrafx: 'supergrafx', n64dd: 'n64dd',
  pokemini: 'pokemonmini', satellaview: 'satellaview', sufami: 'sufami', virtualboy: 'virtualboy', ngp: 'ngp', ngpc: 'ngpc', sega32x: 'sega32x', sg1000: 'sg-1000', x1: 'x1',
  x68000: 'x68000', zxspectrum: 'zxspectrum', supervision: 'supervision', arduboy: 'arduboy', amigacd32: 'amigacd32', pcenginecd: 'pcenginecd', pc98: 'pc98', pcfx: 'pcfx',
  cdi: 'cdimono1', neogeocd: 'neogeocd', dreamcast: 'dreamcast', segacd: 'segacd', naomi: 'naomi', saturn: 'saturn', '3do': '3do',
};
// NextUI: "<name> (<TAG>)" folders; the tag picks the emulator pak and names the Saves/Bios folders
const nextuiSystems: Record<string, [string, string]> = {
  nes: ['Nintendo Entertainment System (FC)', 'fceumm'], fds: ['Famicom Disk System (FDS)', 'fceumm'], snes: ['Super Nintendo Entertainment System (SFC)', 'snes9x'],
  gb: ['Game Boy (GB)', 'gambatte'], gbc: ['Game Boy Color (GBC)', 'gambatte'], gba: ['Game Boy Advance (GBA)', 'gpsp'], md: ['Sega Genesis (MD)', 'picodrive'],
  psx: ['Sony PlayStation (PS)', 'pcsx_rearmed'], sms: ['Sega Master System (SMS)', 'picodrive'], gg: ['Sega Game Gear (GG)', 'picodrive'], sega32x: ['Sega 32X (32X)', 'picodrive'],
  segacd: ['Sega CD (SEGACD)', 'picodrive'], sg1000: ['Sega SG-1000 (SG1000)', 'picodrive'], pcengine: ['TurboGrafx-16 (PCE)', 'mednafen_pce_fast'],
  pokemini: ['Pok\u00e9mon mini (PKM)', 'pokemini'], virtualboy: ['Virtual Boy (VB)', 'mednafen_vb'], ngp: ['Neo Geo Pocket (NGP)', 'race'], ngpc: ['Neo Geo Pocket Color (NGPC)', 'race'],
  lynx: ['Atari Lynx (LYNX)', 'handy'], atari2600: ['Atari 2600 (A2600)', 'stella2014'], atari5200: ['Atari 5200 (A5200)', 'a5200'], a7800: ['Atari 7800 (A7800)', 'prosystem'],
  msx1: ['Microsoft MSX (MSX)', 'bluemsx'], colecovision: ['Colecovision (COLECO)', 'gearcoleco'],
};
const nextuiMap = Object.fromEntries(Object.entries(nextuiSystems).map(([slug, [folder, core]]) => [slug, { folder, emulator: `minui-${core}` }]));
// Onion: the rom folders its Package Manager's emulators read ("rompath" of App/PackageManager/data/*/*/Emu/*/config.json).
// One folder may serve two systems (NGP holds both Neo Geo Pockets, WS both WonderSwans, MSX both MSX)
const onionFolders = {
  nes: 'FC', fds: 'FDS', snes: 'SFC', gb: 'GB', gbc: 'GBC', gba: 'GBA', n64: 'N64', nds: 'NDS', sms: 'MS', gg: 'GG', md: 'MD',
  psx: 'PS', fbneo: 'FBNEO', lynx: 'LYNX', a7800: 'SEVENTYEIGHTHUNDRED', atari2600: 'ATARI', atari5200: 'FIFTYTWOHUNDRED', atari800: 'EIGHTHUNDRED',
  jaguar: 'JAGUAR', atarist: 'ATARIST', wswan: 'WS', wswanc: 'WS', colecovision: 'COLECO', c64: 'COMMODORE', amiga500: 'AMIGA', amigacd32: 'AMIGACD',
  channelf: 'FAIRCHILD', vectrex: 'VECTREX', o2em: 'ODYSSEY', intellivision: 'INTELLIVISION', msx1: 'MSX', msx2: 'MSX', pcengine: 'PCE', supergrafx: 'SGFX',
  pokemini: 'POKE', satellaview: 'SATELLAVIEW', sufami: 'SUFAMI', virtualboy: 'VB', ngp: 'NGP', ngpc: 'NGP', sega32x: 'THIRTYTWOX', sg1000: 'SEGASGONE',
  x68000: 'X68000', zxspectrum: 'ZXS', supervision: 'SUPERVISION', arduboy: 'ARDUBOY', segacd: 'SEGACD', pcenginecd: 'PCECD', pc98: 'PCNINETYEIGHT', pcfx: 'PCFX',
  neogeocd: 'NEOCD', '3do': 'PANASONIC', videopacplus: 'VIDEOPAC',
};

export interface FirmwareSeed {
  slug: string;
  name: string;
  romsRoot: string;
  savesRoot: string;
  statesRoot: string;
  biosRoot: string;
  savesLayout: 'flat' | 'system' | 'core' | 'rom' | 'rom-core' | 'rom-saves' | 'beside' | 'minui';
  systemMap: Record<string, { folder: string; emulator: string }>;
}

export const firmwares: FirmwareSeed[] = [
  { slug: 'rocknix', name: 'ROCKNIX', romsRoot: 'roms', savesRoot: 'roms', statesRoot: 'roms', biosRoot: 'roms/bios', savesLayout: 'rom', systemMap: map(batoceraFolders) },
  { slug: 'knulli', name: 'Knulli', romsRoot: 'roms', savesRoot: 'saves', statesRoot: 'saves', biosRoot: 'bios', savesLayout: 'system', systemMap: map(batoceraFolders) },
  { slug: 'batocera', name: 'Batocera', romsRoot: 'roms', savesRoot: 'saves', statesRoot: 'saves', biosRoot: 'bios', savesLayout: 'system', systemMap: map(batoceraFolders) },
  { slug: 'muos', name: 'muOS', romsRoot: 'ROMS', savesRoot: 'MUOS/save/file', statesRoot: 'MUOS/save/state', biosRoot: 'MUOS/bios', savesLayout: 'core', systemMap: map(muosFolders) },
  // The card's EASYROMS partition is mounted at /roms; RetroArch keeps saves and states next to each rom
  { slug: 'arkos', name: 'ArkOS / dArkOS', romsRoot: '', savesRoot: '', statesRoot: '', biosRoot: 'bios', savesLayout: 'rom', systemMap: map(arkosFolders) },
  { slug: 'nextui', name: 'NextUI', romsRoot: 'Roms', savesRoot: 'Saves', statesRoot: '.userdata/shared', biosRoot: 'Bios', savesLayout: 'minui', systemMap: nextuiMap },
  { slug: 'onion', name: 'Onion OS', romsRoot: 'Roms', savesRoot: 'Saves/CurrentProfile/saves', statesRoot: 'Saves/CurrentProfile/states', biosRoot: 'BIOS', savesLayout: 'core', systemMap: map(onionFolders) },
  { slug: 'android-esde', name: 'Android (ES-DE + RetroArch)', romsRoot: 'ROMs', savesRoot: 'RetroArch/saves', statesRoot: 'RetroArch/states', biosRoot: 'RetroArch/system', savesLayout: 'flat', systemMap: map(esdeFolders, { psx: 'duckstation', gba: 'ra-mgba', nds: 'melonds' }) },
  { slug: 'retroarch-desktop', name: 'RetroArch (Windows/Linux/macOS)', romsRoot: 'roms', savesRoot: 'saves', statesRoot: 'states', biosRoot: 'system', savesLayout: 'flat', systemMap: map(esdeFolders) },
  // SD card synced from a PC (no network on the console): TWiLight Menu++ keeps saves in a "saves" folder next to the roms
  { slug: 'nds-twilight', name: 'Nintendo DS (TWiLight Menu++ SD card)', romsRoot: 'roms', savesRoot: 'roms', statesRoot: 'roms', biosRoot: '_nds', savesLayout: 'rom-saves', systemMap: map({ nds: 'nds' }, { nds: 'melonds' }) },
  // GBA flashcarts (SuperCard, EZ-Flash...): roms anywhere on the card, each .sav next to its rom
  { slug: 'gba-flashcart', name: 'GBA flashcart (SuperCard, EZ-Flash…)', romsRoot: '', savesRoot: '', statesRoot: '', biosRoot: '', savesLayout: 'beside', systemMap: map({ gba: '' }, { gba: 'gba-cart' }) },
  { slug: 'esde-desktop', name: 'ES-DE (escritorio)', romsRoot: 'ROMs', savesRoot: 'saves', statesRoot: 'states', biosRoot: 'bios', savesLayout: 'flat', systemMap: map(esdeFolders) },
];

// wifiBands: what the WiFi chip can use (none | 2.4 | dual); left out when not known. Clients report their own.
export const consoles: { name: string; manufacturer: string; formFactor: string; wifiBands?: string }[] = [
  { name: 'AYN Thor', manufacturer: 'AYN', formFactor: 'handheld', wifiBands: 'dual' },
  { name: 'AYN Odin 2', manufacturer: 'AYN', formFactor: 'handheld', wifiBands: 'dual' },
  { name: 'Retroid Pocket 5', manufacturer: 'Retroid', formFactor: 'handheld', wifiBands: 'dual' },
  { name: 'Retroid Pocket 4 Pro', manufacturer: 'Retroid', formFactor: 'handheld', wifiBands: 'dual' },
  { name: 'Retroid Pocket Mini', manufacturer: 'Retroid', formFactor: 'handheld', wifiBands: 'dual' },
  { name: 'Anbernic RG35XX', manufacturer: 'Anbernic', formFactor: 'handheld', wifiBands: 'none' },
  { name: 'Anbernic RG35XX Plus', manufacturer: 'Anbernic', formFactor: 'handheld', wifiBands: 'dual' },
  { name: 'Anbernic RG35XX H', manufacturer: 'Anbernic', formFactor: 'handheld', wifiBands: 'dual' },
  { name: 'Anbernic RG35XX SP', manufacturer: 'Anbernic', formFactor: 'handheld', wifiBands: 'dual' },
  { name: 'Anbernic RG40XX V', manufacturer: 'Anbernic', formFactor: 'handheld', wifiBands: 'dual' },
  { name: 'Anbernic RG40XX H', manufacturer: 'Anbernic', formFactor: 'handheld', wifiBands: 'dual' },
  { name: 'Anbernic RG28XX', manufacturer: 'Anbernic', formFactor: 'handheld', wifiBands: 'none' },
  { name: 'Anbernic RG353V', manufacturer: 'Anbernic', formFactor: 'handheld', wifiBands: 'dual' },
  { name: 'Anbernic RG406H', manufacturer: 'Anbernic', formFactor: 'handheld', wifiBands: 'dual' },
  { name: 'Anbernic RG556', manufacturer: 'Anbernic', formFactor: 'handheld', wifiBands: 'dual' },
  { name: 'Miyoo Mini', manufacturer: 'Miyoo', formFactor: 'handheld', wifiBands: 'none' },
  { name: 'Miyoo Mini Plus', manufacturer: 'Miyoo', formFactor: 'handheld', wifiBands: '2.4' },
  { name: 'Miyoo Flip', manufacturer: 'Miyoo', formFactor: 'handheld', wifiBands: 'dual' },
  { name: 'TrimUI Smart Pro', manufacturer: 'TrimUI', formFactor: 'handheld' },
  { name: 'TrimUI Brick', manufacturer: 'TrimUI', formFactor: 'handheld' },
  { name: 'R36S', manufacturer: 'Generic', formFactor: 'handheld', wifiBands: 'none' },
  { name: 'Powkiddy RGB30', manufacturer: 'Powkiddy', formFactor: 'handheld' },
  { name: 'Steam Deck', manufacturer: 'Valve', formFactor: 'handheld', wifiBands: 'dual' },
  { name: 'Game Boy Advance', manufacturer: 'Nintendo', formFactor: 'handheld', wifiBands: 'none' },
  { name: 'Game Boy Advance SP', manufacturer: 'Nintendo', formFactor: 'handheld', wifiBands: 'none' },
  { name: 'Nintendo DS', manufacturer: 'Nintendo', formFactor: 'handheld', wifiBands: 'none' },
  { name: 'Nintendo DSi', manufacturer: 'Nintendo', formFactor: 'handheld' },
  { name: 'Nintendo 3DS', manufacturer: 'Nintendo', formFactor: 'handheld' },
  { name: 'PC', manufacturer: 'Generic', formFactor: 'desktop' },
  { name: 'Other', manufacturer: 'Generic', formFactor: 'handheld' },
];
