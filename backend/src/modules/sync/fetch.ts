import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';

/**
 * Descarga condicional: solo baja el recurso si ha cambiado desde la ultima vez (ETag / Last-Modified).
 * Devuelve null si no hay cambios o si no existe (404).
 */
export async function conditionalFetch(key: string, url: string, force = false): Promise<{ text: string; buf: Buffer } | null> {
  const state = await prisma.sourceState.findUnique({ where: { key } });
  const headers: Record<string, string> = { 'User-Agent': env.userAgent };
  if (!force && state?.etag) headers['If-None-Match'] = state.etag;
  if (!force && state?.lastModified) headers['If-Modified-Since'] = state.lastModified;
  const r = await fetch(url, { headers });
  const now = new Date();
  if (r.status === 304 || r.status === 404) {
    await prisma.sourceState.upsert({ where: { key }, create: { key, checkedAt: now }, update: { checkedAt: now } });
    return null;
  }
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const data = { etag: r.headers.get('etag'), lastModified: r.headers.get('last-modified'), checkedAt: now, changedAt: now };
  await prisma.sourceState.upsert({ where: { key }, create: { key, ...data }, update: data });
  return { text: buf.toString('utf8'), buf };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
