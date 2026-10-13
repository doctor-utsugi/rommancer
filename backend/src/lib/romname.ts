// Helpers for No-Intro / Redump / GoodTools names

export const REGIONS = [
  'World', 'USA', 'Europe', 'Japan', 'Spain', 'France', 'Germany', 'Italy', 'UK', 'Australia', 'Korea', 'China', 'Taiwan',
  'Hong Kong', 'Asia', 'Brazil', 'Canada', 'Netherlands', 'Sweden', 'Scandinavia', 'Russia', 'Portugal', 'Denmark',
  'Finland', 'Norway', 'Poland', 'Greece', 'Latin America', 'Mexico', 'Argentina', 'New Zealand', 'Belgium', 'Austria',
  'Switzerland', 'India', 'Unknown',
];

const REGION_SET = new Set(REGIONS);
const LANG_RE = /^[A-Z][a-z](-[A-Z][a-z])?(,[A-Z][a-z](-[A-Z][a-z])?)*$/;

const FLAG_PATTERNS: [RegExp, string][] = [
  [/^Proto( \d+)?$/i, 'proto'],
  [/^Beta( \d+)?$/i, 'beta'],
  [/^Demo$/i, 'demo'],
  [/^Sample$/i, 'sample'],
  [/^Unl$/i, 'unlicensed'],
  [/^Pirate$/i, 'pirate'],
  [/^Aftermarket$/i, 'aftermarket'],
  [/^Virtual Console$/i, 'virtual-console'],
  [/Collection|Classic Mini|Switch Online|Evercade/i, 'rerelease'],
  [/^Hack\b/i, 'hack'],
];

export interface ParsedName {
  title: string;
  regions: string[];
  languages: string[];
  revision: string | null;
  flags: string[];
  // GoodTools marks: [T+Spa], [h], [!]...
  tags: string[];
  hack: { type: 'TRANSLATION' | 'HACK'; language?: string; author?: string; version?: string } | null;
}

export function parseRomName(raw: string): ParsedName {
  const name = raw.replace(/\.[a-z0-9]{1,5}$/i, '');
  const groups = [...name.matchAll(/\(([^)]*)\)/g)].map((m) => m[1].trim());
  const tags = [...name.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1].trim());
  const title = name.replace(/\s*[([].*$/, '').trim() || name.trim();
  const regions: string[] = [];
  const languages: string[] = [];
  const flags: string[] = [];
  let revision: string | null = null;
  for (const g of groups) {
    const parts = g.split(/\s*,\s*/);
    if (parts.every((p) => REGION_SET.has(p))) {
      regions.push(...parts);
      continue;
    }
    if (LANG_RE.test(g)) {
      languages.push(...g.split(','));
      continue;
    }
    const rev = g.match(/^(Rev [\w.]+|v\d[\w.]*)$/i);
    if (rev) {
      revision = rev[1];
      continue;
    }
    for (const [re, flag] of FLAG_PATTERNS) if (re.test(g)) flags.push(flag);
  }
  let hack: ParsedName['hack'] = null;
  for (const t of tags) {
    const tr = t.match(/^T[+-]\s?([A-Za-z]{2,3})(.*)$/);
    if (tr) {
      const rest = tr[2];
      const version = rest.match(/\d[\d.]*[a-zA-Z]?/)?.[0];
      const author = rest.match(/(?:_|\bby\s)(.+)$/)?.[1]?.trim();
      hack = { type: 'TRANSLATION', language: tr[1], version, author };
      break;
    }
    if (/^h\d*/i.test(t) || /^Hack/i.test(t)) {
      hack = { type: 'HACK', author: t.replace(/^Hack( by)?\s*/i, '') || undefined };
      break;
    }
  }
  if (!hack && flags.includes('hack')) hack = { type: 'HACK', version: revision ?? undefined };
  return { title, regions, languages, revision, flags, tags, hack };
}

/** Game grouping key: lowercase, no moved articles or punctuation. */
export function normalizeTitle(title: string): string {
  let t = title.toLowerCase();
  const art = t.match(/^(.*), (the|a|an|el|la|los|las|le|les|der|die|das)( - .*)?$/);
  if (art) t = `${art[2]} ${art[1]}${art[3] ?? ''}`;
  return t
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Filesystem-safe name (FAT/exFAT of SD cards). */
export function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
}

/** Base rom name of a name with GoodTools marks: "Contra (Japan) [T+Eng1.0_MadHacker]" -> "Contra (Japan)". */
export function baseRomName(raw: string): string {
  return raw.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/\s*\[[^\]]*\]/g, '').trim();
}

/**
 * Label of a romhack with its exact base rom and its own version, apart from the game's:
 * "Gran Turismo 4 (USA) v1.01 + Spec II v1.10", "Contra (Japan) + T-Eng v1.0 (MadHacker)".
 */
export function hackLabel(base: { name: string } | null, hack: { type: string; hackName?: string | null; title: string; version?: string | null; language?: string | null; author?: string | null }): string {
  const baseText = base ? base.name.replace(/\s*\((?:[A-Z][a-z](?:-[A-Z][a-z])?,?)+\)/g, '').replace(/\(Rev ([\w.]+)\)/, 'Rev $1').replace(/\((v[\d.]+\w*)\)/, '$1').replace(/\s+/g, ' ').trim() : null;
  const name = hack.type === 'TRANSLATION' ? `T-${hack.language ?? '?'}` : (hack.hackName ?? hack.title);
  const own = [name, hack.version ? (/^v/i.test(hack.version) ? hack.version : `v${hack.version}`) : null].filter(Boolean).join(' ');
  const author = hack.type === 'TRANSLATION' && hack.author ? ` (${hack.author})` : '';
  return baseText ? `${baseText} + ${own}${author}` : `${own}${author}`;
}
