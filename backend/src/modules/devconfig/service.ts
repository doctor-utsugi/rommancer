/** Device configuration work, queued per device and done by whichever channel reaches it first:
 * plan (files to read) -> file (each one) -> ready (copy kept, files to write) -> out -> done. See docs/device-config.md. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Console, Device, DeviceConfigOp, Firmware } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { env } from '../../config/env.js';
import { HttpError, badRequest } from '../../lib/http.js';
import { adapterFor, isAbsolute, note, type DesiredSettings } from './adapters.js';

export type Channel = 'agent' | 'sd';
type FullDevice = Device & { firmware: Firmware; console?: Console | null };

const BLOBS = () => path.join(env.dataDir, 'device-config', 'blobs');
const MAX_FILE = 4 * 1024 * 1024;
const MAX_FILES = 400;
/** Work a channel took and never finished (its connection dropped) is offered again after this */
const STALE_MS = 30 * 60_000;
/** Copies taken automatically before a change that are kept per device */
const KEEP_BEFORE = 15;

export async function putBlob(buf: Buffer): Promise<string> {
  const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
  const file = path.join(BLOBS(), sha1.slice(0, 2), sha1);
  if (!fs.existsSync(file)) {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file + '.tmp', buf);
    await fs.promises.rename(file + '.tmp', file);
  }
  return sha1;
}

export const readBlob = (sha1: string) => fs.promises.readFile(path.join(BLOBS(), sha1.slice(0, 2), sha1));

/** RA's login for emulators: the token RetroArch and the standalone emulators keep instead of the password */
export async function raLogin(username: string, password: string): Promise<string> {
  const base = env.ra.baseUrl.replace(/\/API\/?$/, '');
  const r = await fetch(`${base}/dorequest.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Rommancer/1.0' },
    body: new URLSearchParams({ r: 'login2', u: username, p: password }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  const j = r ? ((await r.json().catch(() => null)) as { Success?: boolean; Token?: string; Error?: string } | null) : null;
  if (!r) throw new HttpError(502, 'RetroAchievements could not be reached');
  if (!j?.Success || !j.Token) throw badRequest(j?.Error ?? 'RetroAchievements did not accept that user and password');
  return j.Token;
}

/** WiFi bands of a device: what it reported or the user set, else its console model's */
export const bandsOf = (d: Device & { console?: Console | null }) => d.wifiBands ?? d.console?.wifiBands ?? null;

export async function desiredFor(device: Device & { console?: Console | null }): Promise<{ want: DesiredSettings; hash: string; empty: boolean }> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: device.userId }, include: { wifiNetworks: { orderBy: [{ priority: 'asc' }, { id: 'asc' }] } } });
  const username = decrypt(user.raUser);
  const password = decrypt(user.raPassword);
  const token = decrypt(user.raToken);
  // Devices coming from a client's token arrive without their console model
  const model = device.console !== undefined ? device.console : await prisma.console.findUnique({ where: { id: device.consoleId } });
  const bands = bandsOf({ ...device, console: model });
  const wifi =
    bands === 'none'
      ? []
      : user.wifiNetworks
          // A 2.4 GHz-only device cannot see a network that only exists on 5 GHz
          .filter((w) => !(bands === '2.4' && w.band === '5'))
          .map((w) => ({ ssid: w.ssid, password: decrypt(w.password), hidden: w.hidden }));
  const ra = username && (password || token) ? { username, password, token } : null;
  const hash = crypto.createHmac('sha1', env.encryptionKey).update(JSON.stringify({ ra, wifi })).digest('hex');
  // Networks written by an earlier application count as Rommancer's even after the user removed them
  const last = await prisma.deviceConfigOp.findFirst({ where: { deviceId: device.id, kind: 'settings', status: 'done' }, orderBy: { id: 'desc' } });
  const written = ((last?.payload ?? {}) as Payload).wifiSsids ?? [];
  const managed = [...new Set([...user.wifiNetworks.map((w) => w.ssid), ...written])];
  const want: DesiredSettings = { ra, wifi, managed };
  return { want, hash, empty: !ra && !wifi.length && !written.length };
}

/** Networks left out for a device because of its bands, to say so in the web app */
export async function wifiLeftOut(device: Device & { console?: Console | null }) {
  const bands = bandsOf(device);
  if (bands !== '2.4' && bands !== 'none') return [];
  const nets = await prisma.wifiNetwork.findMany({ where: { userId: device.userId }, select: { ssid: true, band: true } });
  return nets.filter((n) => bands === 'none' || n.band === '5').map((n) => n.ssid);
}

export async function settingsPending(device: FullDevice) {
  if (!device.keepSettings || !adapterFor(device.firmware.slug)) return false;
  const d = await desiredFor(device);
  return !d.empty && d.hash !== device.settingsHash;
}

interface Payload {
  versionId?: number;
  paths?: string[];
  gets?: string[];
  collected?: Record<string, { sha1: string; size: number } | null>;
  writes?: { path: string; sha1: string }[];
  notes?: string[];
  settingsHash?: string;
  /** Networks this application wrote, so they can be removed later if the user drops them */
  wifiSsids?: string[];
  /** Some settings files were out of this channel's reach (the console's internal memory from its card) */
  partial?: boolean;
}

const payloadOf = (op: DeviceConfigOp) => (op.payload ?? {}) as Payload;

export async function queueOp(deviceId: number, kind: 'backup' | 'settings' | 'restore', payload: Payload = {}) {
  // One settings application at a time: a newer one replaces a pending one
  if (kind === 'settings') await prisma.deviceConfigOp.deleteMany({ where: { deviceId, kind, status: 'pending' } });
  const op = await prisma.deviceConfigOp.create({ data: { deviceId, kind, payload: payload as Prisma.InputJsonValue } });
  // The client syncs at its next poll, and a quiet console is reached over SSH
  await prisma.device.update({ where: { id: deviceId }, data: { wantSyncAt: new Date() } });
  return op;
}

/** The next piece of work for a device, creating the settings application when its settings changed */
async function nextOp(device: FullDevice, channel: Channel): Promise<DeviceConfigOp | null> {
  const stale = new Date(Date.now() - STALE_MS);
  const open = await prisma.deviceConfigOp.findFirst({
    where: { deviceId: device.id, OR: [{ status: 'pending' }, { status: { in: ['collecting', 'applying'] }, updatedAt: { lt: stale } }] },
    orderBy: { id: 'asc' },
  });
  if (open) return open;
  if (!(await settingsPending(device))) return null;
  const { hash } = await desiredFor(device);
  // The same settings failed recently: not retried on every sync
  const failed = await prisma.deviceConfigOp.findFirst({ where: { deviceId: device.id, kind: 'settings', status: 'failed', updatedAt: { gt: new Date(Date.now() - 3600_000) } }, orderBy: { id: 'desc' } });
  if (failed && payloadOf(failed).settingsHash === hash) return null;
  // Already applied as far as this channel reaches: the rest waits for the console's client or SSH
  const partial = await prisma.deviceConfigOp.findFirst({ where: { deviceId: device.id, kind: 'settings', status: 'done', channel }, orderBy: { id: 'desc' } });
  if (partial && payloadOf(partial).partial && payloadOf(partial).settingsHash === hash) return null;
  return prisma.deviceConfigOp.create({ data: { deviceId: device.id, kind: 'settings', payload: { settingsHash: hash } } });
}

const reachable = (p: string, channel: Channel) => channel !== 'sd' || !isAbsolute(p);

/** Starts the device's next piece of work: what to read from it. Null when there is nothing to do. */
export async function plan(device: FullDevice, channel: Channel) {
  const adapter = adapterFor(device.firmware.slug);
  const op = await nextOp(device, channel);
  if (!op) return null;
  const p = payloadOf(op);
  let gets: string[];
  if (op.kind === 'restore') {
    const v = await prisma.deviceConfigVersion.findUnique({ where: { id: p.versionId ?? -1 } });
    if (!v || v.deviceId !== device.id) {
      await finish(op, false, note('copyGone'));
      return null;
    }
    const all = (v.files as { path: string }[]).map((f) => f.path);
    // What is about to be replaced is copied first
    gets = p.paths?.length ? all.filter((x) => p.paths!.includes(x)) : all;
  } else {
    if (!adapter) {
      await finish(op, false, note('unsupported', device.firmware.name));
      return null;
    }
    gets = [...new Set([...adapter.backup, ...(op.kind === 'settings' ? adapter.settingsFiles : [])])];
  }
  gets = gets.filter((g) => reachable(g, channel));
  const data = { ...p, gets, collected: {}, writes: [], notes: [] };
  await prisma.deviceConfigOp.update({ where: { id: op.id }, data: { status: 'collecting', channel, payload: data as Prisma.InputJsonValue, error: null } });
  return { op: { ...op, payload: data }, gets };
}

async function openOp(device: Device, opId: number, status: string) {
  const op = await prisma.deviceConfigOp.findUnique({ where: { id: opId } });
  if (!op || op.deviceId !== device.id) throw new HttpError(404, 'Unknown operation');
  if (op.status !== status) throw new HttpError(409, `Operation is ${op.status}`);
  return op;
}

/** A path the plan asked for: one of its files, or a file inside one of its folders */
function asked(p: Payload, file: string) {
  if (file.includes('..') || file.includes('\0')) return false;
  return (p.gets ?? []).some((g) => (g.endsWith('/') ? file.startsWith(g) && file.length > g.length : g === file));
}

/** A file read from the device (null: it does not exist there) */
export async function receiveFile(device: Device, opId: number, file: string, content: Buffer | null) {
  const op = await openOp(device, opId, 'collecting');
  const p = payloadOf(op);
  if (!asked(p, file)) throw badRequest(`Not asked for: ${file}`);
  const collected = p.collected ?? {};
  if (Object.keys(collected).length >= MAX_FILES && !(file in collected)) throw badRequest('Too many files');
  if (content && content.length > MAX_FILE) {
    collected[file] = null;
    p.notes = [...(p.notes ?? []), note('tooBig', file)];
  } else collected[file] = content ? { sha1: await putBlob(content), size: content.length } : null;
  await prisma.deviceConfigOp.update({ where: { id: op.id }, data: { payload: { ...p, collected } as Prisma.InputJsonValue } });
}

async function keepVersion(deviceId: number, source: string, files: { path: string; sha1: string; size: number }[], note?: string) {
  if (!files.length) return null;
  const v = await prisma.deviceConfigVersion.create({
    data: { deviceId, source, note: note?.slice(0, 255), files: files.sort((a, b) => a.path.localeCompare(b.path)), bytes: files.reduce((n, f) => n + f.size, 0) },
  });
  const old = await prisma.deviceConfigVersion.findMany({ where: { deviceId, source: 'before' }, orderBy: { id: 'desc' }, skip: KEEP_BEFORE, select: { id: true } });
  if (old.length) await prisma.deviceConfigVersion.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
  return v;
}

/** Everything was read: a copy is kept, and the files to write are worked out. Returns them, in order. */
export async function ready(device: FullDevice, opId: number) {
  const op = await openOp(device, opId, 'collecting');
  const p = payloadOf(op);
  const collected = p.collected ?? {};
  const present = Object.entries(collected).flatMap(([f, c]) => (c ? [{ path: f, ...c }] : []));
  const notes = [...(p.notes ?? [])];
  const writes: { path: string; sha1: string }[] = [];
  if (op.kind === 'settings') {
    const adapter = adapterFor(device.firmware.slug)!;
    const files = new Map<string, string | null>();
    for (const f of adapter.settingsFiles) {
      if (!(f in collected)) continue;
      const c = collected[f];
      files.set(f, c ? (await readBlob(c.sha1)).toString('utf8') : null);
    }
    const { want, hash } = await desiredFor(device);
    p.settingsHash = hash;
    p.partial = adapter.settingsFiles.some((f) => !reachable(f, op.channel as Channel));
    p.wifiSsids = want.wifi.map((w) => w.ssid);
    const out = adapter.apply(want, files);
    notes.push(...out.notes);
    for (const [f, text] of out.writes) writes.push({ path: f, sha1: await putBlob(Buffer.from(text, 'utf8')) });
  } else if (op.kind === 'restore') {
    const src = await prisma.deviceConfigVersion.findUniqueOrThrow({ where: { id: p.versionId! } });
    for (const f of src.files as { path: string; sha1: string }[]) {
      if (p.paths?.length && !p.paths.includes(f.path)) continue;
      if (!reachable(f.path, op.channel as Channel)) {
        notes.push(note('unreachable', f.path));
        continue;
      }
      if (collected[f.path]?.sha1 !== f.sha1) writes.push({ path: f.path, sha1: f.sha1 });
    }
  }
  // A copy is kept when asked for, or before something is changed
  const v = op.kind === 'backup' || writes.length
    ? await keepVersion(device.id, op.kind === 'backup' ? 'backup' : 'before', present, op.kind === 'restore' ? 'restore' : op.kind === 'settings' ? 'settings' : undefined)
    : null;
  const data = { ...p, writes, notes };
  await prisma.deviceConfigOp.update({ where: { id: op.id }, data: { status: 'applying', versionId: v?.id ?? null, payload: data as Prisma.InputJsonValue } });
  if (!writes.length) {
    // Settings that could not be written anywhere (their file is missing) are not applied: tried again later
    const failed = op.kind === 'settings' && notes.length > 0 && !p.partial;
    await finish({ ...op, payload: data as Prisma.JsonValue }, !failed);
    return [];
  }
  return writes.map((w, i) => ({ n: i, path: w.path }));
}

/** The content of the Nth file to write */
export async function outFile(device: Device, opId: number, n: number) {
  const op = await openOp(device, opId, 'applying');
  const w = payloadOf(op).writes?.[n];
  if (!w) throw new HttpError(404, 'No such file');
  return readBlob(w.sha1);
}

async function finish(op: DeviceConfigOp, ok: boolean, error?: string) {
  const p = payloadOf(op);
  const msg = (error ?? (p.notes?.length ? p.notes.join('\n') : null))?.slice(0, 512) ?? null;
  await prisma.deviceConfigOp.update({ where: { id: op.id }, data: { status: ok ? 'done' : 'failed', error: msg, doneAt: new Date() } });
  if (op.kind === 'settings') {
    await prisma.device.update({
      where: { id: op.deviceId },
      data: { settingsAt: new Date(), settingsError: msg, ...(ok && p.settingsHash && !p.partial ? { settingsHash: p.settingsHash } : {}) },
    });
  }
}

/** The client wrote the files (or could not) */
export async function done(device: Device, opId: number, ok: boolean, error?: string) {
  const op = await openOp(device, opId, 'applying');
  await finish(op, ok, ok ? undefined : error || note('writeFailed'));
}

/** Bands reported by a client ("2.4" or "dual"); a band set by the user wins */
export async function storeWifiBands(device: Device, reported: string | undefined) {
  const b = reported?.trim();
  if (!b || !['none', '2.4', 'dual'].includes(b) || device.wifiBandsManual || device.wifiBands === b) return;
  await prisma.device.update({ where: { id: device.id }, data: { wifiBands: b } });
}

/** A copy edited in the web app: a new version with that file changed, and its restore queued */
export async function editVersion(device: Device, versionId: number, file: string, content: string) {
  const v = await prisma.deviceConfigVersion.findUnique({ where: { id: versionId } });
  if (!v || v.deviceId !== device.id) throw new HttpError(404, 'Unknown copy');
  const files = (v.files as { path: string; sha1: string; size: number }[]).map((f) => ({ ...f }));
  const f = files.find((x) => x.path === file);
  if (!f) throw badRequest(`The copy has no ${file}`);
  const buf = Buffer.from(content, 'utf8');
  f.sha1 = await putBlob(buf);
  f.size = buf.length;
  const nv = await keepVersion(device.id, 'edit', files, file);
  const op = await queueOp(device.id, 'restore', { versionId: nv!.id, paths: [file] });
  return { version: nv!, op };
}

export const encryptNullable = (s: string | null | undefined) => (s ? encrypt(s) : null);
