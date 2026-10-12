import crypto from 'node:crypto';

/** Where each firmware keeps the managed settings and what a backup copies (paths relative to the device root,
 * absolute outside it). Nothing is reloaded live, so a sync over WiFi is never cut short. */

export interface DesiredSettings {
  ra: { username: string; password: string | null; token: string | null } | null;
  /** Networks this device can use, in priority order */
  wifi: { ssid: string; password: string | null; hidden: boolean }[];
  /** Every network Rommancer manages for the user (or wrote before): others found on the device are theirs and stay */
  managed: string[];
  /** RetroArch saves a screenshot with each savestate, which Rommancer keeps with the state */
  stateThumbs?: boolean;
  /** RetroArch listens for commands on localhost, so the console client can show sync messages during a game */
  raMessages?: boolean;
}

export interface Applied {
  writes: Map<string, string>;
  /** Unix modes for written files that need one ("600": NetworkManager ignores readable keyfiles) */
  modes?: Record<string, string>;
  /** Rommancer's own files (named rommancer-*) that are no longer wanted */
  deletes?: string[];
  /** Settings that could not be applied here, as "code" or "code:detail" (the web app words them) */
  notes: string[];
}

/** A note for the web app: a code it translates, and what it is about */
export const note = (code: string, detail?: string) => (detail ? `${code}:${detail}` : code);

export interface Adapter {
  /** Files (or folders, ending in "/") copied by a backup */
  backup: string[];
  settingsFiles: string[];
  /** Writes RetroArch's savestate screenshots setting (Batocera and Knulli already turn it on at each launch) */
  stateThumbs?: boolean;
  /** Writes RetroArch's network commands setting (sync messages shown during a game) */
  raMessages?: boolean;
  /** REACH: whether the channel at work reaches a path (the card does not reach internal memory) */
  apply(want: DesiredSettings, files: Map<string, string | null>, reach: (path: string) => boolean): Applied;
}

/** Lines "key=value" (batocera.conf, system.cfg): changes the given keys in place, appends new ones, drops null ones */
export function setKeys(text: string, set: Record<string, string | null>, sep = '='): string {
  const left = new Map(Object.entries(set));
  const lines = text.split('\n').flatMap((line) => {
    const m = /^\s*#?\s*([A-Za-z0-9_.\-[\]]+)\s*=/.exec(line);
    // Commented-out defaults stay; only live keys are replaced
    if (!m || line.trimStart().startsWith('#') || !left.has(m[1])) return [line];
    const v = left.get(m[1]);
    left.delete(m[1]);
    return v === null || v === undefined ? [] : [`${m[1]}${sep}${v}`];
  });
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [k, v] of left) if (v !== null && v !== undefined) lines.push(`${k}${sep}${v}`);
  return lines.join('\n') + '\n';
}

/** retroarch.cfg lines: key = "value" */
export function setRetroArch(text: string, set: Record<string, string>): string {
  const left = new Map(Object.entries(set));
  const lines = text.split('\n').map((line) => {
    const m = /^\s*([A-Za-z0-9_]+)\s*=/.exec(line);
    if (!m || !left.has(m[1])) return line;
    const v = left.get(m[1])!;
    left.delete(m[1]);
    return `${m[1]} = "${v}"`;
  });
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [k, v] of left) lines.push(`${k} = "${v}"`);
  return lines.join('\n') + '\n';
}

const raQuote = (s: string) => s.replace(/"/g, '');

/** batocera.conf escapes these with a backslash (its init script strips them) */
const batoEscape = (s: string) => s.replace(/([#;$])/g, '\\$1');
const batoUnescape = (s: string) => s.replace(/\\([#;$])/g, '$1');

function keyOf(text: string, key: string): string | null {
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z0-9_.\-]+)\s*=(.*)$/.exec(line);
    if (m && m[1] === key) return m[2];
  }
  return null;
}

/** Batocera and Knulli: everything in one conf file (Knulli renamed batocera.conf to knulli.conf; the first found is used).
 * RetroArch's cheevos_* are generated from it at each launch */
const batocera = (confs: string[], backup: string[]): Adapter => ({
  backup: [...confs, ...backup],
  settingsFiles: confs,
  raMessages: true,
  apply(want, files) {
    const notes: string[] = [];
    const writes = new Map<string, string>();
    const conf = confs.find((c) => typeof files.get(c) === 'string');
    if (!conf) return { writes, notes: [note('missing', confs[0])] };
    const text = files.get(conf)!;
    const set: Record<string, string | null> = {};
    // Copied into RetroArch's config at each launch, like every global.retroarch.* key
    if (want.raMessages) set['global.retroarch.network_cmd_enable'] = 'true';
    if (want.ra) {
      set['global.retroachievements'] = '1';
      set['global.retroachievements.username'] = want.ra.username;
      // Knulli and Batocera up to v41 log in with the password; v42+ use the token (and log in for one if missing)
      if (want.ra.password) set['global.retroachievements.password'] = want.ra.password;
      if (want.ra.token) set['global.retroachievements.token'] = want.ra.token;
      if (!want.ra.password) notes.push(note('raNoPassword'));
    }
    if (want.wifi.length || want.managed.length) {
      const ours = want.wifi.filter((w) => !w.hidden);
      // A network keeps the slot it is in, so a working setup is never reshuffled: ours get their password
      // updated there, those set up on the device stay (its way back), ours missing take the free slots
      const slots = ['wifi', 'wifi2', 'wifi3'];
      const placed: (DesiredSettings['wifi'][number] | null)[] = slots.map((slot) => {
        const raw = keyOf(text, `${slot}.ssid`);
        const ss = raw ? batoUnescape(raw) : null;
        if (!ss) return null;
        const mine = ours.find((w) => w.ssid === ss);
        if (mine) return mine;
        if (want.managed.includes(ss)) return null;
        return { ssid: ss, password: batoUnescape(keyOf(text, `${slot}.key`) ?? ''), hidden: false };
      });
      // The same network twice keeps its first slot
      placed.forEach((w, i) => {
        if (w && placed.findIndex((o) => o?.ssid === w.ssid) < i) placed[i] = null;
      });
      const missing = ours.filter((w) => !placed.some((o) => o?.ssid === w.ssid));
      // With every slot taken by the device's own networks, the last one makes room for ours
      if (missing.length && !placed.includes(null) && !placed.some((o) => o && ours.includes(o))) placed[slots.length - 1] = null;
      for (let i = 0; i < placed.length && missing.length; i++) if (!placed[i]) placed[i] = missing.shift()!;
      if (missing.length) notes.push(note('wifiFull', missing.map((w) => w.ssid).join(', ')));
      slots.forEach((slot, i) => {
        const w = placed[i];
        set[`${slot}.ssid`] = w ? batoEscape(w.ssid) : null;
        set[`${slot}.key`] = w ? batoEscape(w.password ?? '') : null;
      });
      const hidden = want.wifi.find((w) => w.hidden);
      const ownHidden = keyOf(text, 'wifi.hidden.ssid');
      if (hidden || (ownHidden && want.managed.includes(batoUnescape(ownHidden)))) {
        set['wifi.hidden.ssid'] = hidden ? batoEscape(hidden.ssid) : null;
        set['wifi.hidden.key'] = hidden ? batoEscape(hidden.password ?? '') : null;
      }
      if (placed.some(Boolean) || hidden) set['wifi.enabled'] = '1';
    }
    if (Object.keys(set).length) {
      const next = setKeys(text, set);
      if (next !== text) writes.set(conf, next);
    }
    return { writes, notes };
  },
});

/** wpa_supplicant.conf: the user's networks are added or updated by name; managed ones no longer wanted go, the others stay */
export function setWpaNetworks(text: string, nets: DesiredSettings['wifi'], managed: string[] = []): string {
  const blocks: string[] = [];
  const head: string[] = [];
  const re = /network\s*=\s*\{[\s\S]*?\n\s*\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    head.push(text.slice(last, m.index));
    blocks.push(m[0]);
    last = m.index + m[0].length;
  }
  const preamble = (head.join('') + text.slice(last)).replace(/\n{3,}/g, '\n\n').trimEnd();
  const ssidOf = (b: string) => /\n\s*ssid\s*=\s*"(.*)"/.exec(b)?.[1] ?? null;
  const ours = new Set([...nets.map((n) => n.ssid), ...managed]);
  const kept = blocks.filter((b) => !ours.has(ssidOf(b) ?? '')).map((b) => b.replace(/\n\s*priority\s*=\s*\d+/, ''));
  const q = (s: string) => s.replace(/(["\\])/g, '\\$1');
  const made = nets.map((n, i) =>
    [
      'network={',
      `\tssid="${q(n.ssid)}"`,
      n.password ? `\tpsk="${q(n.password)}"` : '\tkey_mgmt=NONE',
      ...(n.hidden ? ['\tscan_ssid=1'] : []),
      // Higher wins in wpa_supplicant: the user's first network gets the highest
      `\tpriority=${nets.length - i + 1}`,
      '}',
    ].join('\n'),
  );
  return [preamble, ...made, ...kept].filter(Boolean).join('\n\n') + '\n';
}

/** Onion (Miyoo Mini): RetroArch's config is on the card; WiFi lives in internal flash (/appconfigs) */
const onion: Adapter = {
  backup: ['RetroArch/.retroarch/retroarch.cfg', 'RetroArch/.retroarch/config/', '.tmp_update/config/', 'Saves/CurrentProfile/config/', '/appconfigs/system.json', '/appconfigs/wpa_supplicant.conf'],
  settingsFiles: ['RetroArch/.retroarch/retroarch.cfg', '/appconfigs/wpa_supplicant.conf'],
  stateThumbs: true,
  apply(want, files) {
    const notes: string[] = [];
    const writes = new Map<string, string>();
    const cfg = 'RetroArch/.retroarch/retroarch.cfg';
    const keys = raSettings(want);
    if (Object.keys(keys).length) {
      const text = files.get(cfg);
      if (text == null) {
        if (want.ra) notes.push(note('missing', cfg));
      } else {
        const next = setRetroArch(text, keys);
        if (next !== text) writes.set(cfg, next);
      }
    }
    if (want.wifi.length || want.managed.length) {
      const wpa = '/appconfigs/wpa_supplicant.conf';
      const text = files.get(wpa);
      if (text === undefined) notes.push(note('wifiInternal'));
      else if (text === null) notes.push(note('missing', wpa));
      else {
        const next = setWpaNetworks(text, want.wifi, want.managed);
        if (next !== text) writes.set(wpa, next);
      }
    }
    return { writes, notes };
  },
};

/** The WPA key wpa_supplicant derives from a passphrase, so the passphrase itself is not left on the card */
export const wpaPsk = (ssid: string, pass: string) => crypto.pbkdf2Sync(pass, ssid, 4096, 32, 'sha1').toString('hex');

/** A file name of Rommancer's own for a network: readable, and unique per SSID */
const netFile = (ssid: string) => `rommancer-${ssid.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'wifi'}-${crypto.createHash('sha1').update(ssid).digest('hex').slice(0, 6)}`;

/** One file per network in a folder: Rommancer's files are written or removed, the others stay */
function networkFiles(dir: string, ext: string, want: DesiredSettings, files: Map<string, string | null>, render: (w: DesiredSettings['wifi'][number], i: number) => string): Pick<Applied, 'writes' | 'deletes'> {
  const writes = new Map<string, string>();
  const keep = new Set<string>();
  want.wifi.forEach((w, i) => {
    const f = `${dir}${netFile(w.ssid)}.${ext}`;
    keep.add(f);
    const text = render(w, i);
    if (files.get(f) !== text) writes.set(f, text);
  });
  const deletes = [...files.keys()].filter((f) => f.startsWith(`${dir}rommancer-`) && !keep.has(f) && files.get(f) !== null);
  return { writes, deletes };
}

const raKeys = (ra: NonNullable<DesiredSettings['ra']>): Record<string, string> => ({
  cheevos_enable: 'true',
  cheevos_username: raQuote(ra.username),
  // With a token RetroArch does not need the password (and would replace it with a token anyway)
  ...(ra.token ? { cheevos_token: raQuote(ra.token), cheevos_password: '' } : { cheevos_password: raQuote(ra.password ?? '') }),
});

/** Everything Rommancer keeps set in a retroarch.cfg */
function raSettings(want: DesiredSettings): Record<string, string> {
  return {
    ...(want.ra ? raKeys(want.ra) : {}),
    ...(want.stateThumbs ? { savestate_thumbnail_enable: 'true' } : {}),
    ...(want.raMessages ? { network_cmd_enable: 'true' } : {}),
  };
}

/** muOS: RetroArch's config and the cheevos file it appends at each launch (internal), WiFi profiles on the card */
const MUOS_RA = '/opt/muos/share/info/config/retroarch.cfg';
const MUOS_CHEEVOS = '/opt/muos/share/info/config/retroarch.cheevos.cfg';
const MUOS_NET = 'MUOS/network/';
const muos: Adapter = {
  backup: [MUOS_NET, MUOS_RA, MUOS_CHEEVOS],
  settingsFiles: [MUOS_RA, MUOS_CHEEVOS, MUOS_NET],
  stateThumbs: true,
  raMessages: true,
  apply(want, files, reach) {
    const notes: string[] = [];
    const writes = new Map<string, string>();
    if (want.ra && !reach(MUOS_RA)) notes.push(note('raInternal'));
    if (reach(MUOS_RA)) {
      const cfg = files.get(MUOS_RA);
      const keys = raSettings(want);
      if (cfg != null && Object.keys(keys).length) {
        const next = setRetroArch(cfg, keys);
        if (next !== cfg) writes.set(MUOS_RA, next);
      }
      if (want.ra) {
        const ch = files.get(MUOS_CHEEVOS) ?? '';
        const nextCh = setRetroArch(ch, raKeys(want.ra));
        if (nextCh !== ch) writes.set(MUOS_CHEEVOS, nextCh);
      }
    }
    // Lower priority wins in muOS (1 to 9); "pass" may be the 64-hex key, which it uses as is
    const net = networkFiles(MUOS_NET, 'ini', want, files, (w, i) =>
      ['[network]', `ssid=${w.ssid}`, `pass=${w.password ? wpaPsk(w.ssid, w.password) : ''}`, 'type=dhcp', `priority=${Math.min(9, i + 1)}`, 'autoconnect=1', ''].join('\n'),
    );
    for (const [f, t] of net.writes) writes.set(f, t);
    return { writes, notes, deletes: net.deletes };
  },
};

/** NetworkManager keyfiles, one per network, mode 600 (NetworkManager ignores readable ones) */
function nmKeyfiles(dir: string, want: DesiredSettings, files: Map<string, string | null>): Pick<Applied, 'writes' | 'deletes' | 'modes'> {
  const uuid = (ssid: string) => {
    const h = crypto.createHash('sha1').update(`rommancer:${ssid}`).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  // Higher autoconnect-priority wins in NetworkManager
  const net = networkFiles(dir, 'nmconnection', want, files, (w, i) =>
    [
      '[connection]', `id=${w.ssid}`, `uuid=${uuid(w.ssid)}`, 'type=wifi', 'autoconnect=true', `autoconnect-priority=${(want.wifi.length - i) * 10}`, '',
      '[wifi]', 'mode=infrastructure', `ssid=${w.ssid}`, ...(w.hidden ? ['hidden=true'] : []), '',
      ...(w.password ? ['[wifi-security]', 'key-mgmt=wpa-psk', `psk=${wpaPsk(w.ssid, w.password)}`, ''] : []),
      '[ipv4]', 'method=auto', '', '[ipv6]', 'method=auto', '',
    ].join('\n'),
  );
  return { writes: net.writes, deletes: net.deletes, modes: Object.fromEntries([...net.writes.keys()].map((f) => [f, '600'])) };
}

/** ROCKNIX: RetroAchievements in system.cfg (RetroArch's config is rebuilt from it at each launch), WiFi as NetworkManager keyfiles */
const ROCKNIX_CFG = '.config/system/configs/system.cfg';
const ROCKNIX_NM = '/storage/.config/NetworkManager/system-connections/';
const rocknix: Adapter = {
  backup: [ROCKNIX_CFG, ROCKNIX_NM],
  settingsFiles: [ROCKNIX_CFG, ROCKNIX_NM],
  apply(want, files, reach) {
    const notes: string[] = [];
    const writes = new Map<string, string>();
    const modes: Record<string, string> = {};
    if (want.ra) {
      const text = files.get(ROCKNIX_CFG);
      if (text == null) notes.push(note('missing', ROCKNIX_CFG));
      else {
        if (!want.ra.password) notes.push(note('raNoPassword'));
        const next = setKeys(text, {
          'global.retroachievements': '1',
          'global.retroachievements.username': want.ra.username,
          ...(want.ra.password ? { 'global.retroachievements.password': want.ra.password } : {}),
        });
        if (next !== text) writes.set(ROCKNIX_CFG, next);
      }
    }
    let deletes: string[] = [];
    if (want.wifi.length || want.managed.length) {
      if (!reach(ROCKNIX_NM)) notes.push(note('wifiInternal'));
      else {
        const net = nmKeyfiles(ROCKNIX_NM, want, files);
        for (const [f, t] of net.writes) writes.set(f, t);
        Object.assign(modes, net.modes);
        deletes = net.deletes ?? [];
      }
    }
    return { writes, notes, modes, deletes };
  },
};

/** "key = value" lines inside one [section] of an ini file (PPSSPP), creating the section or keys when missing */
export function setIniSection(text: string, section: string, set: Record<string, string>): string {
  const lines = text.split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  let start = lines.findIndex((l) => l.trim() === `[${section}]`);
  if (start < 0) {
    lines.push(`[${section}]`);
    start = lines.length - 1;
  }
  let end = lines.findIndex((l, i) => i > start && /^\s*\[.*\]\s*$/.test(l));
  if (end < 0) end = lines.length;
  const left = new Map(Object.entries(set));
  for (let i = start + 1; i < end; i++) {
    const m = /^\s*([^=\s]+)\s*=/.exec(lines[i]);
    if (m && left.has(m[1])) {
      lines[i] = `${m[1]} = ${left.get(m[1])}`;
      left.delete(m[1]);
    }
  }
  lines.splice(end, 0, ...[...left].map(([k, v]) => `${k} = ${v}`));
  return lines.join('\n') + '\n';
}

/** Android (ES-DE + RetroArch): the emulators' own files; those under Android/data need Shizuku in the app */
const ANDROID_RA = ['Android/data/com.retroarch.aarch64/files/retroarch.cfg', 'Android/data/com.retroarch/files/retroarch.cfg', 'RetroArch/retroarch.cfg'];
const ANDROID_PSP = ['PSP/SYSTEM/', 'Android/data/org.ppsspp.ppsspp/files/PSP/SYSTEM/'];
const android: Adapter = {
  backup: [...ANDROID_RA, ...ANDROID_PSP.map((d) => `${d}ppsspp.ini`), 'ES-DE/settings/es_settings.xml'],
  settingsFiles: [...ANDROID_RA, ...ANDROID_PSP.flatMap((d) => [`${d}ppsspp.ini`, `${d}ppsspp_retroachievements.dat`])],
  stateThumbs: true,
  apply(want, files) {
    const notes: string[] = [];
    const writes = new Map<string, string>();
    const keys = raSettings(want);
    for (const f of ANDROID_RA) {
      const text = files.get(f);
      if (text == null || !Object.keys(keys).length) continue;
      const next = setRetroArch(text, keys);
      if (next !== text) writes.set(f, next);
    }
    if (!want.ra) return { writes, notes };
    let found = ANDROID_RA.filter((f) => files.get(f) != null).length;
    const unread = [...ANDROID_RA, ...ANDROID_PSP.map((d) => `${d}ppsspp.ini`)].some((f) => f.startsWith('Android/data/') && !files.has(f));
    for (const d of ANDROID_PSP) {
      const ini = files.get(`${d}ppsspp.ini`);
      if (ini == null) continue;
      found++;
      const next = setIniSection(ini, 'Achievements', { AchievementsEnable: 'True', AchievementsUserName: want.ra.username });
      if (next !== ini) writes.set(`${d}ppsspp.ini`, next);
      // PPSSPP keeps the token next to its ini, never in it
      if (want.ra.token && files.get(`${d}ppsspp_retroachievements.dat`) !== want.ra.token) writes.set(`${d}ppsspp_retroachievements.dat`, want.ra.token);
    }
    if (unread) notes.push(note('needShizuku'));
    else if (!found) notes.push(note('noEmulators'));
    return { writes, notes };
  },
};

/** ArkOS/dArkOS: the cheevos_* keys of both RetroArch builds (nothing rewrites them at launch), WiFi as NetworkManager keyfiles.
 * The card (/roms) only reaches its importer, which takes one network at boot and keeps it if it connects then */
const ARK_RA = ['/home/ark/.config/retroarch/retroarch.cfg', '/home/ark/.config/retroarch32/retroarch.cfg'];
const ARK_NM = '/etc/NetworkManager/system-connections/';
const ARK_IMPORT = 'tools/wifikeyfile.txt';
const arkos: Adapter = {
  backup: [...ARK_RA, ARK_NM, '/home/ark/.emulationstation/es_settings.cfg'],
  settingsFiles: [...ARK_RA, ARK_NM],
  stateThumbs: true,
  raMessages: true,
  apply(want, files, reach) {
    const notes: string[] = [];
    const writes = new Map<string, string>();
    const keys = raSettings(want);
    if (want.ra && !reach(ARK_RA[0])) notes.push(note('raInternal'));
    else if (reach(ARK_RA[0]) && Object.keys(keys).length) {
      let found = 0;
      for (const f of ARK_RA) {
        const text = files.get(f);
        if (text == null) continue;
        found++;
        const next = setRetroArch(text, keys);
        if (next !== text) writes.set(f, next);
      }
      if (!found && want.ra) notes.push(note('missing', ARK_RA[0]));
    }
    if (!want.wifi.length && !want.managed.length) return { writes, notes };
    if (reach(ARK_NM)) {
      const net = nmKeyfiles(ARK_NM, want, files);
      for (const [f, t] of net.writes) writes.set(f, t);
      return { writes, notes, modes: net.modes, deletes: net.deletes };
    }
    const first = want.wifi.find((w) => !w.hidden && w.password && !/["\n]/.test(w.ssid + w.password));
    if (first) {
      writes.set(ARK_IMPORT, `ssid="${first.ssid}"\npsk="${first.password}"\n`);
      notes.push(note('wifiOneAtBoot', first.ssid));
    } else notes.push(note('wifiInternal'));
    return { writes, notes };
  },
};

/** NextUI: RetroAchievements in minuisettings.txt on the card; WiFi in wpa_supplicant.conf, internal on TrimUI
 * (tg5040, tg5050) and on the card on the H700 Anbernics */
const NEXTUI_CFG = '.userdata/shared/minuisettings.txt';
const NEXTUI_WPA = ['.userdata/h700/wifi/wpa_supplicant.conf', '/etc/wifi/wpa_supplicant/wpa_supplicant.conf', '/etc/wifi/wpa_supplicant.conf'];
const nextui: Adapter = {
  backup: [NEXTUI_CFG, ...NEXTUI_WPA],
  settingsFiles: [NEXTUI_CFG, ...NEXTUI_WPA],
  apply(want, files) {
    const notes: string[] = [];
    const writes = new Map<string, string>();
    if (want.ra) {
      // A card that never saved its settings has no file yet: NextUI takes defaults for every key left out
      const text = files.get(NEXTUI_CFG) ?? '';
      // minarch logs in with the token only; without one the user presses Authenticate in Settings
      if (!want.ra.token) notes.push(note('raAuthenticate'));
      const next = setKeys(text, {
        raEnable: '1',
        raUsername: want.ra.username,
        ...(want.ra.password ? { raPassword: want.ra.password } : {}),
        ...(want.ra.token ? { raToken: want.ra.token, raServerUsername: want.ra.username, raAuthenticated: '1' } : {}),
      });
      if (next !== text) writes.set(NEXTUI_CFG, next);
    }
    if (want.wifi.length || want.managed.length) {
      const wpa = NEXTUI_WPA.find((f) => typeof files.get(f) === 'string');
      if (wpa) {
        const text = files.get(wpa)!;
        const next = setWpaNetworks(text, want.wifi, want.managed);
        if (next !== text) writes.set(wpa, next);
      } else if (NEXTUI_WPA.some((f) => !files.has(f))) notes.push(note('wifiInternal'));
      else notes.push(note('missing', 'wpa_supplicant.conf'));
    }
    return { writes, notes };
  },
};

const ADAPTERS: Record<string, Adapter> = {
  knulli: batocera(['system/knulli.conf', 'system/batocera.conf'], [
    'system/configs/emulationstation/es_settings.cfg',
    'system/configs/emulationstation/es_input.cfg',
    'system/configs/retroarch/cores/retroarch-core-options.cfg',
    'system/configs/retroarch/config/',
    'system/custom.sh',
  ]),
  onion,
};
ADAPTERS.batocera = ADAPTERS.knulli;
ADAPTERS.muos = muos;
ADAPTERS.rocknix = rocknix;
ADAPTERS['android-esde'] = android;
ADAPTERS.arkos = arkos;
ADAPTERS.nextui = nextui;

export const adapterFor = (firmwareSlug: string): Adapter | null => ADAPTERS[firmwareSlug] ?? null;
export const isAbsolute = (p: string) => p.startsWith('/');
