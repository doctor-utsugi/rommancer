/** Device side of the configuration work (see service.ts): clients read and write the files the server asks for. */
import express, { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { badRequest } from '../../lib/http.js';
import { decrypt } from '../../lib/crypto.js';
import { deviceFromToken } from '../saves/agent.js';
import { done, outFile, plan, ready, receiveFile, type Channel } from './service.js';

export const configAgentRouter = Router();

const channelOf = (v: string | undefined): Channel => (v === 'sd' ? 'sd' : 'agent');
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/** "op<TAB>id<TAB>kind", then "get<TAB>path" (a file) or "dir<TAB>path/" (every file inside); empty: nothing to do */
configAgentRouter.get('/plan', async (req, res) => {
  const device = await deviceFromToken(req);
  const p = await plan(device, channelOf(req.header('x-channel')));
  if (!p) return res.type('text/plain').send('');
  const lines = [`op\t${p.op.id}\t${p.op.kind}`, ...p.gets.map((g) => (g.endsWith('/') ? `dir\t${g}` : `get\t${g}`))];
  res.type('text/plain').send(lines.join('\n') + '\n');
});

/** One file read from the device: X-Path-B64 names it, X-Missing says it is not there */
configAgentRouter.post('/file/:op', express.raw({ type: '*/*', limit: '8mb' }), async (req, res) => {
  const device = await deviceFromToken(req);
  const file = Buffer.from(req.header('x-path-b64') ?? '', 'base64').toString('utf8');
  if (!file) throw badRequest('Missing X-Path-B64');
  const missing = req.header('x-missing') === '1';
  await receiveFile(device, Number(req.params.op), file, missing ? null : Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
  res.status(204).end();
});

/** All read: "put<TAB>n<TAB>path" for each file to write (fetched from /out), or nothing */
configAgentRouter.post('/ready/:op', async (req, res) => {
  const device = await deviceFromToken(req);
  const writes = await ready(device, Number(req.params.op));
  res.type('text/plain').send(writes.map((w) => `put\t${w.n}\t${w.path}`).join('\n') + (writes.length ? '\n' : ''));
});

configAgentRouter.get('/out/:op/:n', async (req, res) => {
  const device = await deviceFromToken(req);
  res.type('application/octet-stream').send(await outFile(device, Number(req.params.op), Number(req.params.n)));
});

/** Body "ok", or "error<TAB>what went wrong" */
configAgentRouter.post('/done/:op', express.text({ type: '*/*', limit: '64kb' }), async (req, res) => {
  const device = await deviceFromToken(req);
  const [status, ...msg] = String(req.body ?? '').trim().split('\t');
  await done(device, Number(req.params.op), status === 'ok', msg.join(' ').slice(0, 500));
  res.status(204).end();
});

/** The user's networks for clients that hand them to their system (Android):
 * "wifi<TAB>ssid (base64)<TAB>password (base64)<TAB>band<TAB>hidden" */
configAgentRouter.get('/wifi', async (req, res) => {
  const device = await deviceFromToken(req);
  const nets = await prisma.wifiNetwork.findMany({ where: { userId: device.userId }, orderBy: [{ priority: 'asc' }, { id: 'asc' }] });
  res.type('text/plain').send(nets.map((n) => `wifi\t${b64(n.ssid)}\t${b64(decrypt(n.password) ?? '')}\t${n.band}\t${n.hidden ? 1 : 0}`).join('\n') + (nets.length ? '\n' : ''));
});
