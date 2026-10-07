/**
 * Pairing of standalone sync clients (shell on Linux handhelds, Android app).
 * Code flow for devices without a keyboard: the client gets a short code, the user approves it in the
 * web app and the client collects its device token by polling. Logged-in clients can claim directly.
 * Public endpoints answer plain text ("key<TAB>value" lines) so busybox clients need no JSON parser.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { decrypt, encrypt, sha256 } from '../../lib/crypto.js';
import { HttpError, badRequest } from '../../lib/http.js';
import { env } from '../../config/env.js';
import { me, requirePerm } from '../auth/middleware.js';

export const linkPublicRouter = Router();
export const linkRouter = Router();

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_TTL_MS = 15 * 60_000;
const POLL_SECONDS = 3;
const CLIENT_SCRIPT = path.resolve(import.meta.dirname, '../../../../clients/linux/rommancer-sync.sh');

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
  const console = consoles.find((c) => model && model.includes(c.name.toLowerCase())) ?? consoles.find((c) => c.name === 'Other') ?? null;
  return { firmwareId: firmware?.id ?? null, consoleId: console?.id ?? null };
}

async function createAgentDevice(userId: number, data: { name: string; consoleId: number; firmwareId: number; rootPath: string; overrides?: Prisma.InputJsonValue }) {
  const token = crypto.randomBytes(24).toString('base64url');
  const device = await prisma.device.create({
    data: { userId, name: data.name, consoleId: data.consoleId, firmwareId: data.firmwareId, connType: 'AGENT', rootPath: data.rootPath, overrides: data.overrides, syncSaves: true, tokenHash: sha256(token), tokenCreatedAt: new Date() },
  });
  return { device, token };
}

const text = (lines: [string, string | number][]) => lines.map(([k, v]) => `${k}\t${v}`).join('\n') + '\n';

linkPublicRouter.post('/start', express.urlencoded({ extended: false, limit: '64kb' }), express.json({ limit: '64kb' }), async (req, res) => {
  const h = hints.parse(req.body);
  const secret = crypto.randomBytes(32).toString('base64url');
  let code = newCode();
  while (await prisma.deviceLink.findUnique({ where: { code } })) code = newCode();
  await prisma.deviceLink.create({
    data: { code, secretHash: sha256(secret), deviceName: h.name, firmwareHint: h.firmware || null, rootHint: h.root || null, model: h.model || null, overrides: parseOverrides(h.overrides), expiresAt: new Date(Date.now() + CODE_TTL_MS) },
  });
  const base = env.publicUrl || `${req.get('x-forwarded-proto') ?? req.protocol}://${req.get('x-forwarded-host') ?? req.get('host')}`;
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
  const s = await suggest({ firmwareHint: h.firmware, model: h.model });
  if (!s.firmwareId || !s.consoleId) throw badRequest('Unknown firmware or console');
  const { device, token } = await createAgentDevice(me(req).id, { name: h.name, consoleId: s.consoleId, firmwareId: s.firmwareId, rootPath: h.root, overrides: parseOverrides(h.overrides) });
  res.status(201).json({ deviceId: device.id, token });
});
