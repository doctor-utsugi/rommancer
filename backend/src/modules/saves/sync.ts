import path from 'node:path';
import cron from 'node-cron';
import type { Emulator } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { enqueue, registerJob, type JobContext } from '../../lib/jobs.js';
import { layoutOf, openSink, type DeviceLayout, type Sink } from '../devices/sink.js';
import { convertSave, type SaveFormat } from './convert.js';
import { identifyRom, parseSaveFile, readVersion, storeVersion } from './service.js';

function saveDirs(layout: DeviceLayout, slug: string, emu: Emulator) {
  const folder = layout.systemMap[slug]?.folder ?? slug;
  const sub = (root: string) => {
    switch (layout.savesLayout) {
      case 'system':
        return path.posix.join(root, folder);
      case 'core':
        return path.posix.join(root, emu.core ?? emu.name);
      case 'rom':
        return path.posix.join(layout.romsRoot, folder);
      default:
        return root;
    }
  };
  return { saves: sub(layout.savesRoot), states: sub(layout.statesRoot), roms: path.posix.join(layout.romsRoot, folder) };
}

/** Nombre base de la rom en el dispositivo (para que el emulador encuentre el save). */
async function deviceRomBase(sink: Sink, romsDir: string, romName: string | null, fallback: string, cache: Map<string, string[]>): Promise<string> {
  if (!cache.has(romsDir)) cache.set(romsDir, (await sink.list(romsDir)).filter((e) => !e.isDir).map((e) => e.name.replace(/\.[^.]+$/, '')));
  const names = cache.get(romsDir)!;
  if (romName && names.includes(romName)) return romName;
  if (names.includes(fallback)) return fallback;
  // Coincidencia aproximada: mismo titulo sin etiquetas
  const strip = (s: string) => s.replace(/\s*[([].*$/, '').toLowerCase();
  const target = strip(romName ?? fallback);
  return names.find((n) => strip(n) === target) ?? romName ?? fallback;
}

export async function syncDeviceSaves(deviceId: number, direction: 'pull' | 'push' | 'both', ctx?: JobContext) {
  const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId }, include: { firmware: true } });
  const layout = layoutOf(device);
  const emulators = new Map((await prisma.emulator.findMany()).map((e) => [e.slug, e]));
  const systems = new Map((await prisma.system.findMany()).map((s) => [s.slug, s]));
  const sink = await openSink(device);
  const stats = { pulled: 0, pushed: 0, unchanged: 0, unknown: 0, converted: 0 };
  try {
    const visited = new Set<string>();
    // --- Pull: dispositivo -> servidor ---
    if (direction !== 'push') {
      for (const [slug, cfg] of Object.entries(layout.systemMap)) {
        const emu = emulators.get(cfg.emulator);
        if (!emu) continue;
        const dirs = saveDirs(layout, slug, emu);
        for (const dir of new Set([dirs.saves, dirs.states])) {
          for (const e of await sink.list(dir)) {
            const full = path.posix.join(dir, e.name);
            if (e.isDir || visited.has(full)) continue;
            const parsed = parseSaveFile(e.name, emu);
            if (!parsed) continue;
            // En layouts planos un mismo directorio sirve a varios sistemas: se decide por la rom
            const ident = await identifyRom(parsed.baseName, layout.savesLayout === 'flat' ? null : systems.get(slug)?.id);
            if (layout.savesLayout === 'flat' && ident && ident.systemId !== systems.get(slug)?.id) continue;
            visited.add(full);
            if (!ident) stats.unknown++;
            const buf = await sink.getBuffer(full);
            const r = await storeVersion(
              { userId: device.userId, emulatorId: emu.id, kind: parsed.kind, slot: parsed.slot, baseName: parsed.baseName },
              buf,
              new Date(e.mtimeMs),
              { sourceDeviceId: device.id, gameId: ident?.gameId ?? null, romId: ident?.romId ?? null },
            );
            if (r.created) {
              stats.pulled++;
              ctx?.log(`Pulled ${full}`);
            } else stats.unchanged++;
          }
        }
      }
    }

    // --- Push: servidor -> dispositivo ---
    if (direction !== 'pull') {
      const saves = await prisma.save.findMany({
        where: { userId: device.userId, currentVersionId: { not: null } },
        include: { emulator: true, game: { include: { system: true } }, rom: true, versions: true },
      });
      const romCache = new Map<string, string[]>();
      for (const s of saves) {
        const slug = s.game?.system.slug;
        if (!slug || !layout.systemMap[slug]) continue;
        const target = emulators.get(layout.systemMap[slug].emulator);
        if (!target) continue;
        // Los savestates no son portables entre emuladores
        if (s.kind === 'STATE' && target.id !== s.emulatorId) continue;
        const current = s.versions.find((v) => v.id === s.currentVersionId)!;
        let buf = await readVersion(current.id);
        if (target.saveFormat !== s.emulator.saveFormat) {
          try {
            buf = convertSave(buf, s.emulator.saveFormat as SaveFormat, target.saveFormat as SaveFormat);
            stats.converted++;
          } catch (e) {
            ctx?.log(`Cannot convert ${s.baseName}: ${e instanceof Error ? e.message : e}`);
            continue;
          }
        }
        const dirs = saveDirs(layout, slug, target);
        const base = await deviceRomBase(sink, dirs.roms, s.rom?.name ?? null, s.baseName, romCache);
        const ext = s.kind === 'SAVE' ? target.saveExt : `${target.stateExt}${s.slot > 0 ? s.slot : s.slot === -1 ? '.auto' : ''}`;
        const dest = path.posix.join(s.kind === 'SAVE' ? dirs.saves : dirs.states, base + ext);
        const existing = await sink.stat(dest);
        if (existing && existing.mtimeMs >= current.fileMtime.getTime()) {
          const devBuf = await sink.getBuffer(dest);
          if (devBuf.equals(buf) || existing.mtimeMs > current.fileMtime.getTime()) {
            stats.unchanged++;
            continue;
          }
        }
        await sink.putBuffer(buf, dest, current.fileMtime);
        stats.pushed++;
        ctx?.log(`Pushed ${dest}`);
      }
    }
  } finally {
    await sink.close();
  }
  await prisma.device.update({ where: { id: deviceId }, data: { lastSyncAt: new Date() } });
  return stats;
}

registerJob('save-sync', async (ctx) => syncDeviceSaves(ctx.params.deviceId, ctx.params.direction ?? 'both', ctx));

export function startSaveSyncCron() {
  if (!env.saveSyncCron || !cron.validate(env.saveSyncCron)) return;
  cron.schedule(env.saveSyncCron, async () => {
    const devices = await prisma.device.findMany({ where: { syncSaves: true } });
    for (const d of devices) {
      const busy = await prisma.job.findFirst({ where: { type: 'save-sync', status: { in: ['PENDING', 'RUNNING'] }, params: { path: '$.deviceId', equals: d.id } } });
      if (!busy) await enqueue('save-sync', { deviceId: d.id, direction: 'both' }, d.userId);
    }
  });
}
