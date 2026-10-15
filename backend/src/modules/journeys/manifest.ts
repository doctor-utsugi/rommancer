import crypto from 'node:crypto';
import { badRequest } from '../../lib/http.js';

export interface Entry { key: string; sha1: string; size: number }
export const HASH = /^[a-f0-9]{40}$/;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const hash = (data: Buffer | string) => crypto.createHash('sha1').update(data).digest('hex');

export function parseManifest(text: string): Entry[] {
  const entries: Entry[] = [];
  const keys = new Set<string>();
  for (const line of text.split('\n').filter(Boolean)) {
    const [key, sha1, size, extra] = line.split('\t');
    if (!/^[a-z0-9-]+\/(save|state|thumb)\/(-1|\d+)$/.test(key) || !HASH.test(sha1 ?? '') || !/^\d+$/.test(size ?? '') || extra !== undefined)
      throw badRequest('Invalid journey manifest');
    const bytes = Number(size);
    const [, kind, slot] = key.split('/');
    const slotNumber = Number(slot);
    if (!Number.isSafeInteger(slotNumber) || slotNumber > 2147483647 || String(slotNumber) !== slot || (kind === 'save' && slot !== '0')) throw badRequest('Invalid journey slot');
    if (!Number.isSafeInteger(bytes) || bytes > 128 * 1024 * 1024 || keys.has(key)) throw badRequest('Invalid journey entry');
    keys.add(key);
    entries.push({ key, sha1, size: bytes });
  }
  if (entries.length > 10000) throw badRequest('Too many journey entries');
  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

export const manifestText = (entries: Entry[]) => entries.map((e) => `${e.key}\t${e.sha1}\t${e.size}\n`).join('');
export const identityKey = (platform: string, digest: string) => hash(`${platform}\0file-sha1\0${digest}`);
