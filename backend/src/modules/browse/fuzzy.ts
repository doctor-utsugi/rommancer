/**
 * Fuzzy matching of game titles for the consoles' typeahead: forgiving of typos, roman numerals, acronyms ("ff7") and
 * words written together or apart ("megaman"). Plain code over a few thousand titles kept in memory.
 */

const ROMAN: Record<string, string> = {
  ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10', xi: '11', xii: '12', xiii: '13',
  xiv: '14', xv: '15', xvi: '16', xvii: '17', xviii: '18', xix: '19', xx: '20',
};
const ARTICLES = new Set(['the', 'a', 'an']);

export function normalize(s: string, articles = false): string[] {
  const words = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[([][^)\]]*[)\]]/g, ' ')
    .replace(/&/g, ' and ')
    // "Pokémon: Red" and "pokemon red", "Ys I & II" and "ys 1 2"
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => ROMAN[w] ?? w);
  const kept = articles ? words : words.filter((w) => !ARTICLES.has(w));
  return kept.length ? kept : words;
}

function trigrams(s: string) {
  const p = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3));
  return out;
}

function dice(a: Set<string>, b: Set<string>) {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return (2 * n) / (a.size + b.size);
}

/** Edits (insertions, deletions, changes, swaps of neighbours) between two words, or MAX + 1 once past MAX */
function edits(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
    }
    if (Math.min(...cur) > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

export interface Searchable {
  tokens: string[];
  compact: string;
  acronym: string;
  grams: Set<string>[];
}

export function searchable(title: string): Searchable {
  const tokens = normalize(title);
  // Numbers stay whole in an acronym: "Final Fantasy 7" is "ff7", "Super Mario Bros. 3" is "smb3"
  // with its articles: "Symphony of the Night" is "sotn"
  const acronym = normalize(title, true).map((t) => (/^\d+$/.test(t) ? t : t[0])).join('');
  return { tokens, compact: tokens.join(''), acronym, grams: tokens.map(trigrams) };
}

export interface Query {
  tokens: string[];
  compact: string;
  grams: Set<string>[];
}

export function query(q: string): Query {
  const tokens = normalize(q);
  return { tokens, compact: tokens.join(''), grams: tokens.map(trigrams) };
}

function tokenScore(q: string, qg: Set<string>, t: Searchable) {
  let best = 0;
  for (let i = 0; i < t.tokens.length; i++) {
    const w = t.tokens[i];
    if (w === q) return 10;
    if (w.startsWith(q)) best = Math.max(best, q.length >= 3 || i === 0 ? 8 : 6);
    else if (q.length >= 3 && w.includes(q)) best = Math.max(best, 4);
    else if (q.length >= 4 && w.length >= 3) {
      // A typo: one edit in a short word, two in a long one; else most of its letter triples
      const max = q.length >= 7 ? 2 : 1;
      const e = edits(q, w.slice(0, q.length + max), max);
      if (e <= max) best = Math.max(best, 6 - e);
      const d = dice(qg, t.grams[i]);
      if (d >= 0.45) best = Math.max(best, 6 * d);
    }
  }
  // Written together in the query, apart in the title ("megaman" for "Mega Man")
  if (best < 6 && q.length >= 4 && t.compact.includes(q)) best = 6;
  return best;
}

/** How well the title matches the query: 0 = not at all */
export function score(q: Query, t: Searchable): number {
  if (!q.tokens.length) return 0;
  let total = 0;
  let missed = false;
  for (let i = 0; i < q.tokens.length; i++) {
    const s = tokenScore(q.tokens[i], q.grams[i], t);
    if (!s) missed = true;
    total += s;
  }
  // Apart in the query, together in the title ("mega man" for "Megaman")
  const glued = q.compact.length >= 4 && t.compact.includes(q.compact);
  const acro = q.tokens.length === 1 && t.acronym.length > 1 && (t.acronym.startsWith(q.compact) ? q.compact.length >= 2 : q.compact.length >= 3 && t.acronym.includes(q.compact));
  if (missed && !glued && !acro) return 0;
  if (missed) total = 0;
  if (glued) total += 8;
  if (acro) total += 12;
  if (t.compact.startsWith(q.compact)) total += 5;
  // Shorter titles first among equals: the query covers more of them
  return total + q.compact.length / Math.max(t.compact.length, q.compact.length);
}
