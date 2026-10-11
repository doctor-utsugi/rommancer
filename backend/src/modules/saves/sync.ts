import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../../lib/prisma.js';
import { enqueue, registerJob, type JobContext } from '../../lib/jobs.js';
import { layoutOf, openSink, type Sink } from '../devices/sink.js';
import { parseDeviceSave, readThumb, storeThumb, THUMB_MAX } from './service.js';
import { contentFor, decide, deviceFileName, deviceThumbPath, findLogicalSave, receiveFromDevice, saveDirs, setBase, sha1 } from './core.js';
import { identifyRom } from './service.js';
import type { Device, Emulator } from '@prisma/client';
import { sshExec } from '../devices/ssh.js';
import { commitOffer, deviceCard, forgetDeviceCard, gameForSerial, isCardEmulator, namedCard, observeCard, prepareCard, recordOffer } from './cards.js';

/** Emulators that load a memory card into memory and write it back whole */
const EMULATOR_PROCESS = /retroarch|minarch|duckstation|emulatorlauncher|pcsx|swanstation|epsxe|retrorun/;

/** Memory cards are written only while no emulator runs on the device (an SD card in the server never has one) */
function cardWriteGuard(device: Device) {
  let answer: Promise<boolean> | null = null;
  return () =>
    (answer ??=
      device.connType === 'LOCAL'
        ? Promise.resolve(true)
        : sshExec(device, 'ps 2>/dev/null || ps -ef', 20_000)
            .then((r) => r.code === 0 && !r.output.split('\n').some((l) => EMULATOR_PROCESS.test(l)))
            .catch(() => false));
}

type CardWriteGuard = ReturnType<typeof cardWriteGuard>;

/**
 * A memory card file on a device reached by SD or SSH: read when it changed, then the server's newer entries
 * written into it (atomically, only if it is still the file just read and no emulator runs).
 */
async function syncCardFile(sink: Sink, device: Device, rel: string, emu: Emulator, scope: { shared: boolean; gameId: number | null }, canWrite: CardWriteGuard, ctx?: JobContext) {
  let dc = await deviceCard(device, rel, emu, scope);
  const exists = await sink.stat(rel);
  const read = async () => (exists ? sha1(await sink.getBuffer(rel)) : null);
  let deviceSha1: string | null = null;
  let pulled = false;
  if (exists) {
    const buf = await sink.getBuffer(rel);
    deviceSha1 = sha1(buf);
    if (dc.offerSha1 === deviceSha1) dc = await commitOffer(dc, device.id);
    if (deviceSha1 !== dc.lastSha1) {
      const r = await observeCard(device, dc, emu, buf);
      dc = (await prisma.deviceCard.findUniqueOrThrow({ where: { id: dc.id } }))!;
      pulled = r.uploaded > 0;
      if (r.conflicts) ctx?.log(`Conflict in card ${rel}`);
    }
  } else {
    if (scope.shared) return { pulled, pushed: false };
    if (dc.lastSha1 || dc.offerSha1) dc = await forgetDeviceCard(dc);
  }
  const prepared = await prepareCard(device, dc, emu, deviceSha1);
  if (!prepared) return { pulled, pushed: false };
  if (!(await canWrite())) {
    ctx?.log(`Card ${rel} not written: an emulator is running`);
    return { pulled, pushed: false };
  }
  if ((await read()) !== deviceSha1) return { pulled, pushed: false };
  dc = await recordOffer(device, dc, prepared);
  await sink.replaceBuffer(prepared.file, rel);
  if (sha1(await sink.getBuffer(rel)) === prepared.sha1) await commitOffer(dc, device.id);
  ctx?.log(`Card written ${rel}`);
  return { pulled, pushed: true };
}

/** A savestate's screenshot on the device, kept with VERSIONID (a new version, or the current one still without one) */
async function takeThumb(sink: Sink, statePath: string, emu: Emulator, savesLayout: string, versionId: number | null) {
  const thumb = versionId ? deviceThumbPath(statePath, emu, savesLayout) : null;
  if (!thumb) return;
  // A screenshot that cannot be read is left out; the state itself is already synced
  try {
    const st = await sink.stat(thumb);
    if (st && st.size <= THUMB_MAX) await storeThumb(versionId!, await sink.getBuffer(thumb));
  } catch {
    /* ignored */
  }
}

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
  const canWrite = cardWriteGuard(device);
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
            // Memory cards: shared ones and those named after a serial, by name; per-game ones after their rom
            const named = namedCard(e.name);
            const parsed = parseDeviceSave(e.name, emu, layout.savesLayout);
            // In a folder shared by several systems, a per-game card is only one when its rom is of this system
            const foreign =
              !named && parsed?.kind === 'SAVE' && isCardEmulator(emu) && layout.savesLayout === 'flat'
                ? await identifyRom(parsed.baseName).then((ident) => !!ident && ident.systemId !== systemId)
                : false;
            if (foreign) continue;
            if (named || (parsed?.kind === 'SAVE' && isCardEmulator(emu))) {
              visited.add(full);
              const gameId = named ? (named.serial ? await gameForSerial(named.serial) : null) : ((await identifyRom(parsed!.baseName, systemId))?.gameId ?? null);
              const cardEmu = named ? (emulators.get(named.emulator) ?? emu) : emu;
              const r = await syncCardFile(sink, device, full, cardEmu, { shared: named?.shared ?? false, gameId }, canWrite, ctx);
              if (r.pulled) stats.pulled++;
              if (r.pushed) stats.pushed++;
              if (!r.pulled && !r.pushed) stats.unchanged++;
              continue;
            }
            if (!parsed) continue;
            // En carpetas compartidas por varios sistemas se decide por la rom
            if (layout.savesLayout === 'flat') {
              const ident = await identifyRom(parsed.baseName);
              if (ident && ident.systemId !== systemId) continue;
              if (!ident) stats.unknown++;
            }
            visited.add(full);
            const buf = await sink.getBuffer(full);
            const r = await receiveFromDevice(device, slug, emu, parsed.kind, parsed.slot, parsed.baseName, buf);
            if (parsed.kind === 'STATE') {
              const saved = !r.versionId && r.saveId ? await prisma.save.findUnique({ where: { id: r.saveId }, select: { currentVersionId: true } }) : null;
              const current = saved?.currentVersionId ? await prisma.saveVersion.findUnique({ where: { id: saved.currentVersionId }, select: { id: true, sha1: true, thumbPath: true } }) : null;
              const bare = current && !current.thumbPath && current.sha1 === sha1(buf) ? current.id : null;
              await takeThumb(sink, full, emu, layout.savesLayout, r.versionId ?? bare);
            }
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
      const saves = await prisma.save.findMany({
        where: { userId: device.userId, currentVersionId: { not: null }, gameId: { not: null }, supersededAt: null },
        include: { game: { include: { system: true } }, rom: true },
      });
      const romCache = new Map<string, string[]>();
      const done = new Set<string>();
      for (const s of saves) {
        const slug = s.game!.system.slug;
        const target = emulators.get(layout.systemMap[slug]?.emulator ?? '');
        if (!target) continue;
        // Memory card entries go into the game's card file
        if (s.kind === 'ENTRY' || (s.kind === 'SAVE' && isCardEmulator(target))) {
          if (s.kind !== 'ENTRY' || !isCardEmulator(target)) continue;
          const dirs = saveDirs(layout, slug, target);
          const minui = layout.savesLayout === 'minui';
          const base = await deviceRomBase(sink, dirs.roms, s.rom?.name ?? null, s.game!.title, romCache, minui);
          if (base === null) continue;
          const dest = path.posix.join(dirs.saves, deviceFileName(base, target, 'SAVE', 0, minui));
          if (done.has(dest) || visited.has(dest)) continue;
          done.add(dest);
          // Only for a rom the device holds
          if (!(romCache.get(dirs.roms) ?? []).some((f) => (minui ? f : f.replace(/\.[^.]+$/, '')) === base)) continue;
          const r = await syncCardFile(sink, device, dest, target, { shared: false, gameId: s.gameId }, canWrite, ctx);
          if (r.pushed) stats.pushed++;
          continue;
        }
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
          const v = s.kind === 'STATE' ? await prisma.saveVersion.findUnique({ where: { id: d.versionId }, select: { thumbPath: true } }) : null;
          const thumb = v?.thumbPath ? deviceThumbPath(dest, target, layout.savesLayout) : null;
          if (thumb) await readThumb(v!.thumbPath!).then((t) => sink.putBuffer(t.buf, thumb)).catch(() => ctx?.log(`Screenshot not written: ${thumb}`));
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
