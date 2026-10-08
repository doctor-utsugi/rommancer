/** Where each firmware keeps the managed settings and what a backup copies (paths relative to the device root,
 * absolute outside it). Nothing is reloaded live, so a sync over WiFi is never cut short. */

export interface DesiredSettings {
  ra: { username: string; password: string | null; token: string | null } | null;
  /** Networks this device can use, in priority order */
  wifi: { ssid: string; password: string | null; hidden: boolean }[];
  /** Every network Rommancer manages for the user (or wrote before): others found on the device are theirs and stay */
  managed: string[];
}

export interface Applied {
  writes: Map<string, string>;
  /** Settings that could not be applied here, as "code" or "code:detail" (the web app words them) */
  notes: string[];
}

/** A note for the web app: a code it translates, and what it is about */
export const note = (code: string, detail?: string) => (detail ? `${code}:${detail}` : code);

export interface Adapter {
  /** Files (or folders, ending in "/") copied by a backup */
  backup: string[];
  settingsFiles: string[];
  apply(want: DesiredSettings, files: Map<string, string | null>): Applied;
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

/** Batocera and Knulli: everything in batocera.conf; RetroArch's cheevos_* are generated from it at each launch */
const batocera = (conf: string, backup: string[]): Adapter => ({
  backup,
  settingsFiles: [conf],
  apply(want, files) {
    const notes: string[] = [];
    const writes = new Map<string, string>();
    const text = files.get(conf);
    if (text == null) return { writes, notes: [note('missing', conf)] };
    const set: Record<string, string | null> = {};
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
      // Networks set up on the device itself keep a slot, so it never loses its way back
      const own: DesiredSettings['wifi'] = [];
      for (const slot of ['wifi', 'wifi2', 'wifi3']) {
        const ssid = keyOf(text, `${slot}.ssid`);
        const ss = ssid ? batoUnescape(ssid) : null;
        if (!ss || want.managed.includes(ss) || ours.some((w) => w.ssid === ss) || own.some((w) => w.ssid === ss)) continue;
        own.push({ ssid: ss, password: batoUnescape(keyOf(text, `${slot}.key`) ?? ''), hidden: false });
      }
      const room = ours.length ? Math.max(1, 3 - own.length) : 0;
      const named = [...ours.slice(0, room), ...own].slice(0, 3);
      const out = ours.slice(room);
      if (out.length) notes.push(note('wifiFull', out.map((w) => w.ssid).join(', ')));
      ['wifi', 'wifi2', 'wifi3'].forEach((slot, i) => {
        const w = named[i];
        set[`${slot}.ssid`] = w ? batoEscape(w.ssid) : null;
        set[`${slot}.key`] = w ? batoEscape(w.password ?? '') : null;
      });
      const hidden = want.wifi.find((w) => w.hidden);
      const ownHidden = keyOf(text, 'wifi.hidden.ssid');
      if (hidden || (ownHidden && want.managed.includes(batoUnescape(ownHidden)))) {
        set['wifi.hidden.ssid'] = hidden ? batoEscape(hidden.ssid) : null;
        set['wifi.hidden.key'] = hidden ? batoEscape(hidden.password ?? '') : null;
      }
      if (named.length || hidden) set['wifi.enabled'] = '1';
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
  apply(want, files) {
    const notes: string[] = [];
    const writes = new Map<string, string>();
    const cfg = 'RetroArch/.retroarch/retroarch.cfg';
    if (want.ra) {
      const text = files.get(cfg);
      if (text == null) notes.push(note('missing', cfg));
      else {
        const next = setRetroArch(text, {
          cheevos_enable: 'true',
          cheevos_username: raQuote(want.ra.username),
          // With a token RetroArch does not need the password (and would replace it with a token anyway)
          ...(want.ra.token ? { cheevos_token: raQuote(want.ra.token), cheevos_password: '' } : { cheevos_password: raQuote(want.ra.password ?? '') }),
        });
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

const ADAPTERS: Record<string, Adapter> = {
  knulli: batocera('system/batocera.conf', [
    'system/batocera.conf',
    'system/configs/emulationstation/es_settings.cfg',
    'system/configs/emulationstation/es_input.cfg',
    'system/configs/retroarch/cores/retroarch-core-options.cfg',
    'system/configs/retroarch/config/',
    'system/custom.sh',
  ]),
  onion,
};
ADAPTERS.batocera = ADAPTERS.knulli;

export const adapterFor = (firmwareSlug: string): Adapter | null => ADAPTERS[firmwareSlug] ?? null;
export const isAbsolute = (p: string) => p.startsWith('/');
