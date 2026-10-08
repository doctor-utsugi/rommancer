/**
 * The server's own way to a console: over SSH it runs the same client the console runs by itself, so
 * there is one sync algorithm whichever side starts it. Used when the console's daemon is quiet (asleep,
 * not started, no app at all) and to install the client on a console that only offers SSH.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// ssh2 is CommonJS: its named exports are only reachable through the default one
import ssh2, { type ConnectConfig } from 'ssh2';

const { Client, utils } = ssh2;
import SftpClient from 'ssh2-sftp-client';
import type { Device, Firmware } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { CLIENT_DIR } from '../link/routes.js';

const KEY_SETTING = 'ssh.serverKey';
/** The daemon polls every 15 s: quiet for longer than this means it is not running */
const QUIET_MS = 2 * 60_000;
/** How often a quiet console is looked for when nothing has been asked for it */
const ROUTINE_MS = 10 * 60_000;
const SWEEP_MS = 60_000;

/** The server's key pair, created on first use; its public half goes into the consoles' authorized_keys */
export async function serverKey(): Promise<{ privateKey: string; publicKey: string }> {
  let pem = decrypt((await prisma.setting.findUnique({ where: { key: KEY_SETTING } }))?.value);
  if (!pem) {
    // RSA in PKCS#1 PEM: the format every ssh2 version and every dropbear accepts
    pem = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    await prisma.setting.create({ data: { key: KEY_SETTING, value: encrypt(pem)! } });
  }
  const parsed = utils.parseKey(pem);
  if (parsed instanceof Error) throw parsed;
  const pub = Array.isArray(parsed) ? parsed[0] : parsed;
  return { privateKey: pem, publicKey: `${pub.type} ${pub.getPublicSSH().toString('base64')} rommancer-server` };
}

async function connectConfig(device: Device): Promise<ConnectConfig> {
  if (!device.sshHost) throw new Error('No SSH address');
  return {
    host: device.sshHost,
    port: device.sshPort ?? 22,
    username: device.sshUser ?? 'root',
    privateKey: decrypt(device.sshKey) ?? (await serverKey()).privateKey,
    password: decrypt(device.sshPassword) ?? undefined,
    // Onion's dropbear runs without authentication: "none" is tried first by ssh2
    tryKeyboard: true,
    readyTimeout: 8000,
  };
}

/** Runs a command and returns its exit code and output (stdout and stderr together, last 4 KB) */
export async function sshExec(device: Device, command: string, timeoutMs = 30 * 60_000): Promise<{ code: number; output: string }> {
  const config = await connectConfig(device);
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let output = '';
    const timer = setTimeout(() => {
      conn.end();
      reject(new Error('SSH command timed out'));
    }, timeoutMs);
    conn
      .on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            conn.end();
            return reject(err);
          }
          const keep = (d: Buffer) => (output = (output + d.toString()).slice(-4096));
          stream.on('data', keep).stderr.on('data', keep);
          stream.on('close', (code: number | null) => {
            clearTimeout(timer);
            conn.end();
            resolve({ code: code ?? -1, output });
          });
        });
      })
      .on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => config.password ?? '')))
      .on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      })
      .connect(config);
  });
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Where the client goes on a console installed over SSH, next to where the installers put it */
export function installDir(device: Device & { firmware: Firmware }) {
  switch (device.firmware.slug) {
    case 'knulli':
    case 'batocera':
      return '/userdata/system/rommancer';
    case 'onion':
      return '/mnt/SDCARD/App/RommancerSync';
    default:
      return path.posix.join(device.rootPath.replace(/\/+$/, ''), 'rommancer');
  }
}

/**
 * Copies the client and its link to the console, hooks it to boot and runs a first sync. The client then
 * installs the server's key itself, so a password given for this is only used once.
 */
export async function installClient(device: Device & { firmware: Firmware }, server: string, token: string) {
  const dir = installDir(device);
  const sftp = new SftpClient();
  await sftp.connect(await connectConfig(device));
  try {
    await sftp.mkdir(`${dir}/.rommancer`, true);
    for (const f of ['rommancer-sync.sh', 'cacert.pem']) await sftp.put(fs.readFileSync(path.join(CLIENT_DIR, f)), `${dir}/${f}`);
    await sftp.put(Buffer.from(`SERVER=${server}\nTOKEN=${token}\nUSER=\n`), `${dir}/.rommancer/config`);
    await sftp.chmod(`${dir}/.rommancer/config`, 0o600);
  } finally {
    await sftp.end();
  }
  // The server's key, so the password is not needed again (the client removes it if SSH access is turned off)
  const { publicKey } = await serverKey();
  // A key left by an earlier server (or before the key was regenerated) is replaced
  const keys = '~/.ssh/authorized_keys';
  await sshExec(device, `mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ${keys} && { grep -v rommancer-server ${keys}; echo ${quote(publicKey)}; } > ${keys}.new && mv ${keys}.new ${keys} && chmod 600 ${keys}`, 30_000);
  const script = `${dir}/rommancer-sync.sh`;
  await prisma.device.update({ where: { id: device.id }, data: { clientPath: script } });
  const run = await sshExec(device, `cd ${quote(dir)} && sh rommancer-sync.sh install && sh rommancer-sync.sh sync && (nohup sh rommancer-sync.sh daemon >/dev/null 2>&1 &)`, 10 * 60_000);
  if (run.code !== 0) throw new Error(run.output.trim().split('\n').pop() || `Client exited with ${run.code}`);
  // From now on the server's key is enough: forget the password if it works
  if (device.sshPassword) {
    const keyOnly = { ...device, sshPassword: null };
    const ok = await sshExec(keyOnly, 'true', 20_000).then((r) => r.code === 0).catch(() => false);
    if (ok) await prisma.device.update({ where: { id: device.id }, data: { sshPassword: null } });
  }
  return run.output;
}

const running = new Set<number>();
/** Last attempt per device, reached or not, so an unreachable console is not knocked on every minute */
const lastTry = new Map<number, number>();

/** Runs the console's client over SSH ("all": saves, requested roms, list roms) and records the outcome */
export async function syncOverSsh(deviceId: number) {
  if (running.has(deviceId)) return { skipped: true as const };
  running.add(deviceId);
  lastTry.set(deviceId, Date.now());
  try {
    const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    if (!device.clientPath) throw new Error('The client is not installed on this device');
    try {
      const r = await sshExec(device, `sh ${quote(device.clientPath)} all; sh ${quote(device.clientPath)} pulls`);
      // The client does not poll in this run: what the web app asked for has just been done
      await prisma.device.update({ where: { id: deviceId }, data: { sshAt: new Date(), sshError: r.code === 0 ? null : `exit ${r.code}`, ...(r.code === 0 ? { wantSyncAt: null } : {}) } });
      return { code: r.code, output: r.output };
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 255);
      await prisma.device.update({ where: { id: deviceId }, data: { sshError: msg } });
      throw e;
    }
  } finally {
    running.delete(deviceId);
  }
}

/**
 * Consoles whose daemon is quiet are synced over SSH: right away when the web app asked for something
 * (a sync, roms to send) and every few minutes otherwise, until they are reached.
 */
export async function sweepSsh(now = Date.now()) {
  const devices = await prisma.device.findMany({
    // Admins' consoles only: the server opens connections inside its own network
    where: { connType: 'AGENT', syncSaves: true, sshHost: { not: null }, clientPath: { not: null }, user: { role: 'ADMIN' } },
    include: { pulls: { where: { status: 'pending' }, select: { createdAt: true }, orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  const started: number[] = [];
  for (const d of devices) {
    if (running.has(d.id)) continue;
    if (d.lastSeenAt && now - d.lastSeenAt.getTime() < QUIET_MS) continue;
    const tried = lastTry.get(d.id) ?? 0;
    // Asked since the last attempt: a sync from the web app or a rom to bring
    const asked = (d.wantSyncAt?.getTime() ?? 0) > tried || (d.pulls[0]?.createdAt.getTime() ?? 0) > tried;
    const last = Math.max(tried, d.lastSeenAt?.getTime() ?? 0);
    if (!asked && now - last < ROUTINE_MS) continue;
    started.push(d.id);
    void syncOverSsh(d.id).catch(() => {});
  }
  return started;
}

let timer: NodeJS.Timeout | null = null;

export function startSshSweep(intervalMs = SWEEP_MS) {
  timer = setInterval(() => void sweepSsh().catch((e) => console.error('ssh sweep', e)), intervalMs);
}

export function stopSshSweep() {
  if (timer) clearInterval(timer);
}
