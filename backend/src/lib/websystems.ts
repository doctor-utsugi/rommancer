/** EmulatorJS systems for ours: the cartridge ones its cores play well in a browser */
export const WEB_SYSTEMS: Record<string, string> = {
  nes: 'nes', fds: 'nes', snes: 'snes', gb: 'gb', gbc: 'gb', gba: 'gba', md: 'segaMD', sms: 'segaMS', gg: 'segaGG', sega32x: 'sega32x',
  pcengine: 'pce', ngp: 'ngp', ngpc: 'ngp', wswan: 'ws', wswanc: 'ws', lynx: 'lynx', a7800: 'atari7800', atari2600: 'atari2600',
  virtualboy: 'vb', colecovision: 'coleco',
};
