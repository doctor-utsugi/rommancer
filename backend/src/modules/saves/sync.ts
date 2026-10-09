import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../../lib/prisma.js';
import { enqueue, registerJob, type JobContext } from '../../lib/jobs.js';
import { layoutOf, openSink, type Sink } from '../devices/sink.js';
import { parseDeviceSave } from './service.js';
import { contentFor, decide, deviceFileName, findLogicalSave, receiveFromDevice, saveDirs, setBase, sha1 } from './core.js';
import { identifyRom } from './service.js';

/** Nombre base de la rom en el dispositivo (para que el emulador encuentre el save). */
/** withExt: NextUI names saves after the rom's whole file name, so the match keeps its extension */
async function deviceRomBase(sink: Sink, romsDir: string, romName: string | null, fallback: string, cache: Map<string, string[]>, withExt = false): Promise<string | null> {
  if (!cache.has(romsDir)) cache.set(romsDir, (await sink.list(romsDir)).filter((e) => !e.isDir).map((e) => e.name));
  const files = cache.get(romsDir)!;
  const noExt = (n: string) => n.replace(/\.[^.]+$/, '');
  const strip = (s: string) => s.replace(/\s*[([].*$/, '').toLowerCase();
  const target = strip(romName ?? fallback);
  const hit = files.find((f) => noExt(f) === romName) ?? files.find((f) => noExt(f) === fallback) ?? files.find((f) => strip(noExt(f)) === target);
  if (withExt) return hit ?? null;
  return hit ? noExt(hit) : (romName ?? fallback);
}

/** Sincronizacion de saves con un dispositivo accesible por SD montada o SSH. */
export async function syncDeviceSaves(deviceId: number, direction: 'pull' | 'push' | 'both', ctx?: JobContext) {
  const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId }, include: { firmware: true } });
  if (device.connType === 'AGENT') throw new Error('This device syncs by itself with its event scripts');
  const layout = layoutOf(device);
  const emulators = new Map((await prisma.emulator.findMany()).map((e) => [e.slug, e]));
  const sink = await openSink(device);
  const stats = { pulled: 0, pushed: 0, unchanged: 0, conflicts: 0, unknown: 0 };
  try {
    const visited = new Set<string>();
    if (direction !== 'push') {
      for (const [slug, cfg] of Object.entries(layout.systemMap)) {
        const emu = emulators.get(cfg.emulator);
        if (!emu) continue;
        const dirs = saveDirs(layout, slug, emu);
        const systemId = (await prisma.system.findUnique({ where: { slug } }))?.id;
        for (const dir of new Set([dirs.saves, dirs.states])) {
          for (const e of await sink.list(dir)) {
            const full = path.posix.join(dir, e.name);
            if (e.isDir || visited.has(full)) continue;
            const parsed = parseDeviceSave(e.name, emu, layout.savesLayout);
            if (!parsed) continue;
            // En carpetas compartidas por varios sistemas se decide por la rom
            if (layout.savesLayout === 'flat') {
              const ident = await identifyRom(parsed.baseName);
              if (ident && ident.systemId !== systemId) continue;
              if (!ident) stats.unknown++;
            }
            visited.add(full);
            const r = await receiveFromDevice(device, slug, emu, parsed.kind, parsed.slot, parsed.baseName, await sink.getBuffer(full));
            if (r.action === 'uploaded') {
              stats.pulled++;
              ctx?.log(`Pulled ${full}`);
            } else if (r.action === 'conflict') {
              stats.conflicts++;
              ctx?.log(`Conflict ${full}`);
            } else stats.unchanged++;
          }
        }
      }
    }

    if (direction !== 'pull') {
      const saves = await prisma.save.findMany({ where: { userId: device.userId, currentVersionId: { not: null }, gameId: { not: null } }, include: { game: { include: { system: true } }, rom: true } });
      const romCache = new Map<string, string[]>();
      const done = new Set<string>();
      for (const s of saves) {
        const slug = s.game!.system.slug;
        const target = emulators.get(layout.systemMap[slug]?.emulator ?? '');
        if (!target) continue;
        const logical = await findLogicalSave(device.userId, target, s.kind, s.slot, s.baseName, s.gameId);
        if (!logical || done.has(`${logical.id}`)) continue;
        done.add(`${logical.id}`);
        const dirs = saveDirs(layout, slug, target);
        const minui = layout.savesLayout === 'minui';
        const base = await deviceRomBase(sink, dirs.roms, s.rom?.name ?? null, s.baseName, romCache, minui);
        // Without its rom on the card a NextUI save has no name to take
        if (base === null || (minui && s.kind === 'STATE' && s.slot > 7)) continue;
        const dest = path.posix.join(s.kind === 'SAVE' ? dirs.saves : dirs.states, deviceFileName(base, target, s.kind, s.slot, minui));
        const exists = await sink.stat(dest);
        const deviceBuf = exists ? await sink.getBuffer(dest) : null;
        const d = await decide(logical, device, target, deviceBuf ? { sha1: sha1(deviceBuf) } : null);
        if (d.action === 'download') {
          let content: Buffer;
          try {
            content = await contentFor(logical, d.versionId, target);
          } catch (e) {
            ctx?.log(`Cannot convert ${s.baseName}: ${e instanceof Error ? e.message : e}`);
            continue;
          }
          await sink.putBuffer(content, dest);
          await setBase(logical.id, device.id, d.versionId, sha1(content));
          stats.pushed++;
          ctx?.log(`Pushed ${dest}`);
        } else if (d.action === 'adopt' && deviceBuf) {
          await setBase(logical.id, device.id, logical.currentVersionId, sha1(deviceBuf));
          stats.unchanged++;
        } else stats.unchanged++;
      }
    }
  } finally {
    await sink.close();
  }
  await prisma.device.update({ where: { id: deviceId }, data: { lastSyncAt: new Date() } });
  return stats;
}

registerJob('save-sync', async (ctx) => syncDeviceSaves(ctx.params.deviceId, ctx.params.direction ?? 'both', ctx));

/**
 * SD montadas en el servidor: al aparecer la carpeta del dispositivo se sincroniza una vez.
 * Solo comprueba rutas locales; no hay sondeos por red.
 */
const present = new Map<number, boolean>();
let watcher: NodeJS.Timeout | null = null;

/** Comprueba que dispositivos locales han aparecido desde la ultima vez y encola su sincronizacion. */
export async function checkLocalDevices() {
  const devices = await prisma.device.findMany({ where: { connType: 'LOCAL', syncSaves: true } });
  const queued: number[] = [];
  for (const d of devices) {
    const now = fs.existsSync(d.rootPath);
    const before = present.get(d.id);
    present.set(d.id, now);
    if (now && before === false) {
      const busy = await prisma.job.findFirst({ where: { type: 'save-sync', status: { in: ['PENDING', 'RUNNING'] }, params: { path: '$.deviceId', equals: d.id } } });
      if (!busy) {
        await enqueue('save-sync', { deviceId: d.id, direction: 'both', trigger: 'mounted' }, d.userId);
        queued.push(d.id);
      }
    }
  }
  return queued;
}

export function startLocalDeviceWatcher(intervalMs = 15_000) {
  void checkLocalDevices().catch(() => {});
  watcher = setInterval(() => void checkLocalDevices().catch((e) => console.error(e)), intervalMs);
}

export function stopLocalDeviceWatcher() {
  if (watcher) clearInterval(watcher);
}
