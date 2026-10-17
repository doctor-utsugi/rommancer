/**
 * The server's own settings, set in the installer and in Administration > Server and kept in the Setting table
 * ("server.<name>"). An environment variable of the same name fixes one (development, tests, a deployment that wants
 * it so): the panel shows it and cannot change it. Read synchronously from a cache filled when the server starts.
 */
import { prisma } from './prisma.js';
import { decrypt, encrypt } from './crypto.js';
import { setSettingsLookup } from '../config/env.js';

export const SERVER_SETTINGS = {
  publicUrl: { env: 'PUBLIC_URL', fallback: '' },
  corsOrigins: { env: 'CORS_ORIGINS', fallback: '' },
  externalSyncCron: { env: 'EXTERNAL_SYNC_CRON', fallback: '0 4 * * 0' },
  forceSyncMinMinutes: { env: 'FORCE_SYNC_MIN_MINUTES', fallback: '10' },
  seedOnStart: { env: 'SEED_ON_START', fallback: 'true' },
  seedAutoExport: { env: 'SEED_AUTO_EXPORT', fallback: 'true' },
  screenscraperDevId: { env: 'SCREENSCRAPER_DEV_ID', fallback: '' },
  screenscraperDevPassword: { env: 'SCREENSCRAPER_DEV_PASSWORD', fallback: '', secret: true },
} as const;

export type ServerSettingKey = keyof typeof SERVER_SETTINGS;

const PREFIX = 'server.';
const cache = new Map<ServerSettingKey, string>();
const listeners: ((changed: ServerSettingKey[]) => void)[] = [];

const def = (k: ServerSettingKey): { env: string; fallback: string; secret?: boolean } => SERVER_SETTINGS[k];

export const lockedByEnv = (k: ServerSettingKey) => process.env[def(k).env] !== undefined;

export function serverSetting(k: ServerSettingKey): string {
  const fromEnv = process.env[def(k).env];
  if (fromEnv !== undefined) return fromEnv;
  return cache.get(k) ?? def(k).fallback;
}

/** Reads the stored settings into the cache; called once the database is there */
export async function loadServerSettings() {
  const rows = await prisma.setting.findMany({ where: { key: { startsWith: PREFIX } } });
  cache.clear();
  for (const r of rows) {
    const k = r.key.slice(PREFIX.length) as ServerSettingKey;
    if (!(k in SERVER_SETTINGS)) continue;
    cache.set(k, def(k).secret ? (decrypt(r.value) ?? '') : r.value);
  }
}

/** Stores the given settings (those fixed by the environment are left out) and tells who follows them */
export async function setServerSettings(values: Partial<Record<ServerSettingKey, string>>) {
  const changed: ServerSettingKey[] = [];
  for (const [k, v] of Object.entries(values) as [ServerSettingKey, string | undefined][]) {
    if (v === undefined || lockedByEnv(k) || serverSetting(k) === v) continue;
    const stored = def(k).secret ? (encrypt(v) ?? '') : v;
    await prisma.setting.upsert({ where: { key: PREFIX + k }, create: { key: PREFIX + k, value: stored }, update: { value: stored } });
    cache.set(k, v);
    changed.push(k);
  }
  if (changed.length) for (const l of listeners) l(changed);
  return changed;
}

export function onServerSettingsChange(fn: (changed: ServerSettingKey[]) => void) {
  listeners.push(fn);
}

setSettingsLookup((k) => serverSetting(k as ServerSettingKey));
