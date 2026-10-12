/**
 * Pairing of standalone sync clients (shell on Linux handhelds, Android app).
 * Code flow for devices without a keyboard: the client gets a short code, the user approves it in the
 * web app and the client collects its device token by polling. Logged-in clients can claim directly.
 * Public endpoints answer plain text ("key<TAB>value" lines) so busybox clients need no JSON parser.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { Router, type Request } from 'express';
import { ZipArchive } from 'archiver';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { decrypt, encrypt, sha256 } from '../../lib/crypto.js';
import { HttpError, badRequest } from '../../lib/http.js';
import { env } from '../../config/env.js';
import { me, requirePerm } from '../auth/middleware.js';
import { selfSignup, signupBody, signupOpen, verifyCredentials } from '../auth/routes.js';
import { hasPermission, normalizePermissions } from '../../lib/permissions.js';

export const linkPublicRouter = Router();
export const linkRouter = Router();

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_TTL_MS = 15 * 60_000;
const POLL_SECONDS = 3;
export const CLIENT_DIR = path.resolve(import.meta.dirname, '../../../../clients/linux');
const CLIENT_SCRIPT = path.join(CLIENT_DIR, 'rommancer-sync.sh');
const ENROLL_TTL_MS = 30 * 86400_000;

const newCode = () => Array.from(crypto.randomBytes(8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
const showCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`;
const normCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');

const hints = z.object({
  name: z.string().trim().min(1).max(128),
  firmware: z.string().max(64).optional(),
  root: z.string().max(512).optional(),
  model: z.string().max(128).optional(),
  overrides: z.string().max(8192).optional(),
});
type Hints = z.infer<typeof hints>;

function parseOverrides(raw?: string): Prisma.InputJsonValue | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    throw badRequest('Invalid overrides');
  }
}

/** Console and firmware suggested from what the client detected. */
async function suggest(h: { firmwareHint?: string | null; model?: string | null }) {
  const firmware = h.firmwareHint ? await prisma.firmware.findUnique({ where: { slug: h.firmwareHint } }) : null;
  const model = (h.model ?? '').toLowerCase().replace(/[_-]/g, ' ');
  const consoles = await prisma.console.findMany({ orderBy: { name: 'asc' } });
  // The longest name that fits: "Miyoo Mini Plus" is not a "Miyoo Mini"
  const fits = consoles.filter((c) => model && model.includes(c.name.toLowerCase())).sort((a, b) => b.name.length - a.name.length);
  const console = fits[0] ?? consoles.find((c) => c.name === 'Other') ?? null;
  return { firmwareId: firmware?.id ?? null, consoleId: console?.id ?? null };
}

export async function createAgentDevice(userId: number, data: { name: string; consoleId: number; firmwareId: number; rootPath: string; overrides?: Prisma.InputJsonValue }) {
  const token = crypto.randomBytes(24).toString('base64url');
  const device = await prisma.device.create({
    data: { userId, name: data.name, consoleId: data.consoleId, firmwareId: data.firmwareId, connType: 'AGENT', rootPath: data.rootPath, overrides: data.overrides, syncSaves: true, tokenHash: sha256(token), tokenCreatedAt: new Date() },
  });
  return { device, token };
}

export const publicBase = (req: Request) => env.publicUrl || `${req.get('x-forwarded-proto') ?? req.protocol}://${req.get('x-forwarded-host') ?? req.get('host')}`;

const text = (lines: [string, string | number][]) => lines.map(([k, v]) => `${k}\t${v}`).join('\n') + '\n';

linkPublicRouter.post('/start', express.urlencoded({ extended: false, limit: '64kb' }), express.json({ limit: '64kb' }), async (req, res) => {
  const h = hints.parse(req.body);
  const secret = crypto.randomBytes(32).toString('base64url');
  let code = newCode();
  while (await prisma.deviceLink.findUnique({ where: { code } })) code = newCode();
  await prisma.deviceLink.create({
    data: { code, secretHash: sha256(secret), deviceName: h.name, firmwareHint: h.firmware || null, rootHint: h.root || null, model: h.model || null, overrides: parseOverrides(h.overrides), expiresAt: new Date(Date.now() + CODE_TTL_MS) },
  });
  const base = publicBase(req);
  res.type('text/plain').send(text([['code', showCode(code)], ['secret', secret], ['url', `${base}/link`], ['qr', `${base}/link?code=${code}`], ['interval', POLL_SECONDS], ['expires', CODE_TTL_MS / 1000]]));
});

linkPublicRouter.get('/poll', async (req, res) => {
  const secret = String(req.query.secret ?? '');
  const link = secret ? await prisma.deviceLink.findUnique({ where: { secretHash: sha256(secret) } }) : null;
  res.type('text/plain');
  if (!link || link.deliveredAt) return void res.status(404).send('invalid\n');
  if (!link.approvedAt) return void res.send(link.expiresAt < new Date() ? 'expired\n' : 'pending\n');
  const token = decrypt(link.tokenEnc);
  await prisma.deviceLink.update({ where: { id: link.id }, data: { deliveredAt: new Date(), tokenEnc: null } });
  res.send(text([['token', token ?? ''], ['device', link.deviceId ?? '']]));
});

const form = [express.urlencoded({ extended: false, limit: '64kb' }), express.json({ limit: '64kb' })];

// What a console shows before logging in
linkPublicRouter.get('/info', async (req, res) => {
  res.type('text/plain').send(text([['name', 'Rommancer'], ['url', publicBase(req)], ['signup', (await signupOpen()) ? 1 : 0]]));
});

/** Registers the console for a user that just authenticated on it. */
async function deviceForUser(user: { id: number; role: string; permissions: unknown }, h: Hints) {
  if (!hasPermission({ role: user.role, permissions: normalizePermissions(user.permissions) }, 'saves')) throw new HttpError(403, 'This account cannot sync saves');
  if (!h.root) throw badRequest('Missing root');
  const s = await suggest({ firmwareHint: h.firmware, model: h.model });
  if (!s.firmwareId || !s.consoleId) throw badRequest('Unknown firmware or console');
  return createAgentDevice(user.id, { name: h.name, consoleId: s.consoleId, firmwareId: s.firmwareId, rootPath: h.root, overrides: parseOverrides(h.overrides) });
}

// Login typed on the console itself
linkPublicRouter.post('/login', ...form, async (req, res) => {
  const h = hints.extend({ username: z.string().max(191), password: z.string().max(512) }).parse(req.body);
  const user = await verifyCredentials(req, h.username, h.password);
  const { device, token } = await deviceForUser(user, h);
  res.type('text/plain').send(text([['token', token], ['device', device.id], ['user', user.username]]));
});

// Account created on the console itself (only when the server allows sign-up)
linkPublicRouter.post('/signup', ...form, async (req, res) => {
  const h = hints.merge(signupBody).parse(req.body);
  const user = await selfSignup(req, h);
  const { device, token } = await deviceForUser(user, h);
  res.status(201).type('text/plain').send(text([['token', token], ['device', device.id], ['user', user.username]]));
});

// Self-enrolment with the one-time token bundled in an installer package
linkPublicRouter.post('/enroll', express.urlencoded({ extended: false, limit: '64kb' }), express.json({ limit: '64kb' }), async (req, res) => {
  const h = hints.extend({ token: z.string().min(20).max(128) }).parse(req.body);
  const link = await prisma.deviceLink.findUnique({ where: { secretHash: sha256(h.token) } });
  res.type('text/plain');
  if (!link || !link.approvedAt || link.deviceId || link.deliveredAt || !link.userId) return void res.status(404).send('invalid\n');
  if (link.expiresAt < new Date()) return void res.status(410).send('expired\n');
  if (!h.root) throw badRequest('Missing root');
  const s = await suggest({ firmwareHint: h.firmware, model: h.model });
  if (!s.firmwareId || !s.consoleId) throw badRequest('Unknown firmware or console');
  const { device, token } = await createAgentDevice(link.userId, { name: h.name, consoleId: s.consoleId, firmwareId: s.firmwareId, rootPath: h.root, overrides: parseOverrides(h.overrides) });
  await prisma.deviceLink.update({ where: { id: link.id }, data: { deviceId: device.id, deliveredAt: new Date(), deviceName: h.name, firmwareHint: h.firmware || null, model: h.model || null, rootHint: h.root } });
  res.send(text([['token', token], ['device', device.id]]));
});

// Self-update: devices compare these hashes with their copies and fetch what changed
const CLIENT_FILES = ['rommancer-sync.sh', 'rommancer-ui.py', 'savepoint.png', 'cacert.pem', 'CREDITS.txt', 'icon.png', 'rommancer-art.png'];

linkPublicRouter.get('/client/manifest', (_req, res) => {
  const lines = CLIENT_FILES.filter((f) => fs.existsSync(path.join(CLIENT_DIR, f))).map((f) => `file\t${f}\t${crypto.createHash('sha1').update(fs.readFileSync(path.join(CLIENT_DIR, f))).digest('hex')}`);
  // The server's clock in its time zone: handhelds without a clock that keeps time date their updates by it
  lines.push(`now\t${new Date().toLocaleString('sv-SE', { hour12: false }).slice(0, 16)}`);
  // The same clock in UTC (seconds, and as `date -s` takes it): consoles whose clock is off set theirs by it
  const now = new Date();
  lines.push(`clock\t${Math.floor(now.getTime() / 1000)}\t${now.toISOString().slice(0, 19).replace('T', ' ')}`);
  res.type('text/plain').send(lines.join('\n') + '\n');
});

linkPublicRouter.get('/client/file/:name', (req, res) => {
  const name = String(req.params.name);
  if (!CLIENT_FILES.includes(name) || !fs.existsSync(path.join(CLIENT_DIR, name))) throw new HttpError(404, 'Unknown client file');
  res.type('application/octet-stream').sendFile(path.join(CLIENT_DIR, name));
});

// The desktop companion's installers (clients/desktop/build-release.sh puts them there)
const DESKTOP_DIR = path.resolve(CLIENT_DIR, '../desktop/release');
const DESKTOP_FILES = ['rommancer-desktop-setup.exe', 'rommancer-desktop.deb', 'rommancer-desktop.AppImage'];
linkPublicRouter.get('/desktop/:name', (req, res) => {
  const name = String(req.params.name);
  if (!DESKTOP_FILES.includes(name) || !fs.existsSync(path.join(DESKTOP_DIR, name))) throw new HttpError(404, 'Not built yet');
  res.download(path.join(DESKTOP_DIR, name), name);
});

// The Android app: its version (the app updates itself when the server has a newer one) and the APK
const ANDROID_DIR = path.resolve(CLIENT_DIR, '../android/release');
linkPublicRouter.get('/android/version', (_req, res) => {
  const v = fs.existsSync(path.join(ANDROID_DIR, 'version.txt')) ? fs.readFileSync(path.join(ANDROID_DIR, 'version.txt'), 'utf8').trim() : '';
  const [code, name] = v.split(/\s+/);
  if (!code || !fs.existsSync(path.join(ANDROID_DIR, 'rommancer-sync.apk'))) throw new HttpError(404, 'Not built yet');
  res.type('text/plain').send(`code\t${code}\nname\t${name ?? code}\nsize\t${fs.statSync(path.join(ANDROID_DIR, 'rommancer-sync.apk')).size}\n`);
});
linkPublicRouter.get('/android/rommancer-sync.apk', (_req, res) => {
  const f = path.join(ANDROID_DIR, 'rommancer-sync.apk');
  if (!fs.existsSync(f)) throw new HttpError(404, 'Not built yet');
  res.type('application/vnd.android.package-archive').download(f, 'rommancer-sync.apk');
});

// The Linux client itself, so a device only needs: wget -O- SERVER/api/v1/link/client.sh | sh
linkPublicRouter.get('/client.sh', (_req, res) => {
  if (!fs.existsSync(CLIENT_SCRIPT)) throw new HttpError(404, 'Client not bundled');
  res.type('text/x-shellscript').sendFile(CLIENT_SCRIPT);
});

linkRouter.use(requirePerm('saves'));

linkRouter.get('/:code', async (req, res) => {
  const link = await prisma.deviceLink.findUnique({ where: { code: normCode(req.params.code) } });
  if (!link || link.approvedAt || link.expiresAt < new Date()) throw new HttpError(404, 'Invalid or expired code');
  const s = await suggest(link);
  res.json({ code: showCode(link.code), deviceName: link.deviceName, firmwareHint: link.firmwareHint, model: link.model, rootHint: link.rootHint, suggestedFirmwareId: s.firmwareId, suggestedConsoleId: s.consoleId });
});

linkRouter.post('/:code/approve', async (req, res) => {
  const body = z.object({ name: z.string().trim().min(1).max(128), consoleId: z.number().int(), firmwareId: z.number().int() }).parse(req.body);
  const link = await prisma.deviceLink.findUnique({ where: { code: normCode(req.params.code) } });
  if (!link || link.approvedAt || link.expiresAt < new Date()) throw new HttpError(404, 'Invalid or expired code');
  if (!link.rootHint) throw badRequest('The device did not report its root folder');
  const { device, token } = await createAgentDevice(me(req).id, { name: body.name, consoleId: body.consoleId, firmwareId: body.firmwareId, rootPath: link.rootHint, overrides: (link.overrides ?? undefined) as Prisma.InputJsonValue | undefined });
  await prisma.deviceLink.update({ where: { id: link.id }, data: { approvedAt: new Date(), userId: me(req).id, deviceId: device.id, tokenEnc: encrypt(token) } });
  res.status(201).json({ deviceId: device.id, name: device.name });
});

// Direct pairing for clients where the user logs in (Android app)
linkRouter.post('/claim', async (req, res) => {
  const h: Hints = hints.parse(req.body);
  if (!h.root) throw badRequest('Missing root');
  // The desktop companion lets the user pick the console and firmware of a card
  const picked = z.object({ consoleId: z.coerce.number().int().optional(), firmwareId: z.coerce.number().int().optional(), offline: z.boolean().optional() }).parse(req.body);
  const guess = await suggest({ firmwareHint: h.firmware, model: h.model });
  const s = { consoleId: picked.consoleId ?? guess.consoleId, firmwareId: picked.firmwareId ?? guess.firmwareId };
  if (!s.firmwareId || !s.consoleId) throw badRequest('Unknown firmware or console');
  const { device, token } = await createAgentDevice(me(req).id, { name: h.name, consoleId: s.consoleId, firmwareId: s.firmwareId, rootPath: h.root, overrides: parseOverrides(h.overrides) });
  if (picked.offline) await prisma.device.update({ where: { id: device.id }, data: { offline: true } });
  res.status(201).json({ deviceId: device.id, token });
});

type PackageFile = { name: string; content: string | Buffer; mode?: number };

const ONION_DIR = 'App/RommancerSync';

/** Files of an installer that the user unzips on the device's card or share. */
const FLAVORS = ['onion', 'knulli', 'arkos', 'nextui'] as const;

function packageFiles(flavor: (typeof FLAVORS)[number], server: string, enrollToken: string): PackageFile[] {
  const script = fs.readFileSync(CLIENT_SCRIPT);
  const ca = fs.readFileSync(path.join(CLIENT_DIR, 'cacert.pem'));
  const common = (dir: string): PackageFile[] => [
    { name: `${dir}/rommancer-sync.sh`, content: script, mode: 0o755 },
    { name: `${dir}/cacert.pem`, content: ca },
    { name: `${dir}/server.txt`, content: server + '\n' },
    { name: `${dir}/enroll.txt`, content: enrollToken + '\n' },
  ];
  if (flavor === 'onion') {
    return [
      ...common(ONION_DIR),
      { name: `${ONION_DIR}/icon.png`, content: fs.readFileSync(path.join(CLIENT_DIR, 'icon.png')) },
      { name: `${ONION_DIR}/config.json`, content: JSON.stringify({ label: 'Rommancer Sync', icon: 'icon.png', iconsel: '', launch: 'launch.sh', description: 'Sync saves with Rommancer' }, null, 2) + '\n' },
      // The app opens the setup menu (server, log in or create account) with Onion's own menu and keyboard
      { name: `${ONION_DIR}/launch.sh`, content: '#!/bin/sh\ncd "$(dirname "$0")"\nsh rommancer-sync.sh setup > last-run.txt 2>&1\n', mode: 0o755 },
      // Onion runs every script in .tmp_update/startup at boot: the device enrols and syncs without opening the app
      { name: '.tmp_update/startup/rommancer-sync.sh', content: `#!/bin/sh\n[ -f /mnt/SDCARD/${ONION_DIR}/rommancer-sync.sh ] && (cd /mnt/SDCARD/${ONION_DIR} && sh rommancer-sync.sh boot > last-run.txt 2>&1 &)\n`, mode: 0o755 },
    ];
  }
  // ArkOS: unzip on the EASYROMS partition (/roms); Options -> Tools runs the launcher as ark (from /opt/system/Tools), the client needs root
  if (flavor === 'arkos') {
    return [
      ...common('rommancer'),
      { name: 'rommancer/rommancer-art.png', content: fs.readFileSync(path.join(CLIENT_DIR, 'rommancer-art.png')) },
      { name: 'tools/Rommancer Sync.sh', content: '#!/bin/bash\ncd /roms/rommancer 2>/dev/null || cd /roms2/rommancer || exit 1\nprintf "\\033c" > /dev/tty1\n{ [ ! -f enroll.txt ] || sudo -n sh rommancer-sync.sh enroll; } && sudo -n sh rommancer-sync.sh install && sudo -n sh rommancer-sync.sh sync && sudo -n systemctl restart rommancer-sync.service\nsleep 5\n', mode: 0o755 },
    ];
  }
  // NextUI: unzip at the card's root; Tools -> Rommancer Sync links, installs the boot and game hooks and syncs
  if (flavor === 'nextui') {
    const launch = '#!/bin/sh\ncd /mnt/SDCARD/rommancer || exit 1\n{ [ ! -f enroll.txt ] || sh rommancer-sync.sh enroll; } > last-run.txt 2>&1\nsh rommancer-sync.sh install >> last-run.txt 2>&1\nsh rommancer-sync.sh sync >> last-run.txt 2>&1\n(nohup sh rommancer-sync.sh daemon >/dev/null 2>&1 &)\n';
    return [...common('rommancer'), ...['tg5040', 'tg5050', 'h700'].map((plat) => ({ name: `Tools/${plat}/Rommancer Sync.pak/launch.sh`, content: launch, mode: 0o755 }))];
  }
  // Knulli/Batocera: unzip on the "share" (/userdata); the port runs once and installs boot and game hooks
  return [
    ...common('system/rommancer'),
    { name: 'system/rommancer/rommancer-ui.py', content: fs.readFileSync(path.join(CLIENT_DIR, 'rommancer-ui.py')), mode: 0o755 },
    { name: 'system/rommancer/rommancer-art.png', content: fs.readFileSync(path.join(CLIENT_DIR, 'rommancer-art.png')) },
    { name: 'system/rommancer/savepoint.png', content: fs.readFileSync(path.join(CLIENT_DIR, 'savepoint.png')) },
    { name: 'system/rommancer/CREDITS.txt', content: fs.readFileSync(path.join(CLIENT_DIR, 'CREDITS.txt')) },
    // The port opens the gamepad setup screen; with the package's token it links by itself first
    { name: 'roms/ports/Rommancer Sync.sh', content: '#!/bin/sh\ncd /userdata/system/rommancer\n[ -f enroll.txt ] && sh rommancer-sync.sh enroll > last-run.txt 2>&1 && sh rommancer-sync.sh install >> last-run.txt 2>&1\npython3 rommancer-ui.py > ui-last-run.txt 2>&1\n', mode: 0o755 },
  ];
}

linkRouter.get('/package/:flavor', async (req, res) => {
  const flavor = z.enum(FLAVORS).parse(req.params.flavor);
  const enroll = crypto.randomBytes(32).toString('base64url');
  let code = newCode();
  while (await prisma.deviceLink.findUnique({ where: { code } })) code = newCode();
  await prisma.deviceLink.create({ data: { code, secretHash: sha256(enroll), deviceName: `${flavor} installer`, firmwareHint: flavor, userId: me(req).id, approvedAt: new Date(), expiresAt: new Date(Date.now() + ENROLL_TTL_MS) } });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="rommancer-sync-${flavor}.zip"`);
  const zip = new ZipArchive({ zlib: { level: 6 } });
  zip.on('error', (e: Error) => res.destroy(e));
  zip.pipe(res);
  for (const f of packageFiles(flavor, publicBase(req), enroll)) zip.append(f.content, { name: f.name, mode: f.mode });
  await zip.finalize();
});
