import { XMLParser } from 'fast-xml-parser';

export interface DatRom {
  name: string;
  size: number;
  crc32: string | null;
  md5: string | null;
  sha1: string | null;
}

export interface DatGame {
  name: string;
  description?: string;
  cloneOf?: string;
  serial?: string;
  isBios?: boolean;
  roms: DatRom[];
  patch?: string;
}

export interface DatFile {
  name: string;
  description?: string;
  version?: string;
  games: DatGame[];
}

// Normaliza un hash; descarta valores mal formados que aparecen en algunos DATs
const hash = (v: unknown, len: number) => {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return new RegExp(`^[0-9a-f]{${len}}$`).test(s) ? s : null;
};

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined);

export function parseDat(text: string): DatFile {
  const t = text.trimStart();
  if (t.startsWith('<')) return parseXml(text);
  return parseClrMamePro(text);
}

function parseXml(text: string): DatFile {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    isArray: (name) => ['game', 'machine', 'rom', 'disk'].includes(name),
  });
  const doc = parser.parse(text);
  const df = doc.datafile ?? doc.mame ?? {};
  const header = df.header ?? {};
  const games: DatGame[] = [];
  const all = [...(df.game ?? []), ...(df.machine ?? [])];
  // Formato P/C moderno de No-Intro: id / cloneofid en lugar de cloneof
  const idToName = new Map<string, string>();
  for (const g of all) if (g.id != null) idToName.set(String(g.id), g.name);
  for (const g of all) {
    const roms: DatRom[] = (g.rom ?? [])
      .filter((r: Record<string, string>) => r.status !== 'nodump')
      .map((r: Record<string, string>) => ({
        name: r.name,
        size: Number(r.size ?? 0),
        crc32: hash(r.crc, 8),
        md5: hash(r.md5, 32),
        sha1: hash(r.sha1, 40),
      }));
    games.push({
      name: g.name,
      description: typeof g.description === 'string' ? g.description : undefined,
      cloneOf: g.cloneof ?? (g.cloneofid != null ? idToName.get(String(g.cloneofid)) : undefined),
      serial: str(g.serial) ?? str((g.rom ?? [])[0]?.serial),
      isBios: g.isbios === 'yes',
      roms,
    });
  }
  return { name: String(header.name ?? ''), description: header.description, version: header.version != null ? String(header.version) : undefined, games };
}

type Node = { [k: string]: (string | Node)[] };

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
    } else if (c === '(' || c === ')') {
      tokens.push(c);
      i++;
    } else if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && text[j + 1] === '"') {
          s += '"';
          j += 2;
        } else s += text[j++];
      }
      tokens.push('\u0000' + s);
      i = j + 1;
    } else {
      let j = i;
      while (j < text.length && !' \t\r\n()"'.includes(text[j])) j++;
      tokens.push(text.slice(i, j));
      i = j;
    }
  }
  return tokens;
}

function parseClrMamePro(text: string): DatFile {
  const tokens = tokenize(text);
  let pos = 0;
  const str = (t: string) => (t.startsWith('\u0000') ? t.slice(1) : t);

  function block(): Node {
    // se asume tokens[pos] === '('
    pos++;
    const node: Node = {};
    while (pos < tokens.length && tokens[pos] !== ')') {
      const key = str(tokens[pos++]);
      const v = tokens[pos];
      const value: string | Node = v === '(' ? block() : str(tokens[pos++]);
      (node[key] ??= []).push(value);
    }
    pos++;
    return node;
  }

  const out: DatFile = { name: '', games: [] };
  while (pos < tokens.length) {
    const key = str(tokens[pos++]);
    if (tokens[pos] !== '(') continue;
    const node = block();
    const s = (k: string) => (typeof node[k]?.[0] === 'string' ? (node[k][0] as string) : undefined);
    if (key === 'clrmamepro') {
      out.name = s('name') ?? '';
      out.description = s('description');
      out.version = s('version');
    } else if (key === 'game' || key === 'machine' || key === 'resource') {
      const roms = ((node.rom ?? []) as Node[]).map((r) => {
        const rs = (k: string) => (typeof r[k]?.[0] === 'string' ? (r[k][0] as string) : null);
        return { name: rs('name') ?? '', size: Number(rs('size') ?? 0), crc32: hash(rs('crc'), 8), md5: hash(rs('md5'), 32), sha1: hash(rs('sha1'), 40) };
      });
      out.games.push({
        name: s('name') ?? '',
        description: s('description'),
        cloneOf: s('cloneof'),
        serial: s('serial') ?? (((node.rom ?? []) as Node[])[0]?.serial?.[0] as string | undefined),
        isBios: key === 'resource',
        roms,
        patch: s('patch'),
      });
    }
  }
  return out;
}

/** Entradas "game ( ... )" de un fichero clrmamepro como pares clave/valor simples (metadat de libretro). */
export function parseClrMameEntries(text: string): Record<string, string>[] {
  const tokens = tokenize(text);
  const str = (t: string) => (t.startsWith('\u0000') ? t.slice(1) : t);
  const out: Record<string, string>[] = [];
  let pos = 0;
  while (pos < tokens.length) {
    const key = str(tokens[pos++]);
    if (tokens[pos] !== '(') continue;
    pos++;
    const entry: Record<string, string> = {};
    let depth = 1;
    while (pos < tokens.length && depth > 0) {
      const t = tokens[pos];
      if (t === '(') {
        depth++;
        pos++;
      } else if (t === ')') {
        depth--;
        pos++;
      } else {
        const k = str(t);
        const v = tokens[pos + 1];
        if (v !== undefined && v !== '(' && v !== ')') {
          // Solo el primer nivel; en rom ( crc X ) se guarda como rom.crc
          const name = depth === 1 ? k : `rom.${k}`;
          if (!(name in entry)) entry[name] = str(v);
          pos += 2;
        } else pos++;
      }
    }
    if (key === 'game') out.push(entry);
  }
  return out;
}
