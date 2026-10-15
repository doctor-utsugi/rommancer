/**
 * Browsing the server's games from a console (docs/browse.md): the systems and games it can send, a fuzzy search,
 * and adding a selection to the device's picks once it fits in the device's free space. Plain text like the other
 * agent endpoints; outcomes the console shows (no permission, no space) are lines, never HTTP errors (the shell
 * client's curl -f drops error bodies).
 */
import express, { Router, type Request } from 'express';
import type { Device, Firmware } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { hasPermission } from '../../lib/permissions.js';
import { deviceFromToken, storeSpace } from '../saves/agent.js';
import { deviceUser } from '../devices/lists.js';
import { addPicks } from '../devices/picks.js';
import { devicePlan, keptBytes } from '../devices/plan.js';
import { copiesSystem, layoutOf, systemFilterOf, type SystemFilter } from '../devices/sink.js';
import { catalog, type CatalogGame } from './catalog.js';
import { query, score } from './fuzzy.js';

export const browseRouter = Router();

type AgentDevice = Device & { firmware: Firmware; homeRoot?: string };

const field = (s: string) => s.replace(/[\t\r\n]+/g, ' ').trim();

/** The device, or null when its owner may not download games (the console then hides browsing) */
async function allowed(req: Request) {
  const device = (await deviceFromToken(req)) as AgentDevice;
  return hasPermission(await deviceUser(device), 'roms.download') ? device : null;
}

/** Systems this console plays: those its layout names (a layout naming none takes them all) */
function plays(device: AgentDevice) {
  const map = layoutOf(device).systemMap;
  return Object.keys(map).length ? (slug: string) => slug in map : () => true;
}

/** Games on the device (any version, a hack counting for its game) and games one of its lists still has to bring */
async function deviceGames(device: AgentDevice) {
  const inv = await prisma.deviceRom.findMany({ where: { deviceId: device.id }, select: { gameId: true, baseGameId: true } });
  const here = new Set(inv.flatMap((r) => [r.gameId, r.baseGameId].filter((x): x is number => !!x)));
  const items = await prisma.listItem.findMany({
    where: { list: { devices: { some: { deviceId: device.id } } } },
    select: { gameId: true, rom: { select: { gameId: true } }, hack: { select: { gameId: true } } },
  });
  const queued = new Set(items.flatMap((i) => [i.gameId, i.rom?.gameId, i.hack?.gameId].filter((x): x is number => !!x && !here.has(x))));
  return { here, queued };
}

const stateOf = (g: CatalogGame, d: { here: Set<number>; queued: Set<number> }) => (d.here.has(g.gameId) ? 'here' : d.queued.has(g.gameId) ? 'queued' : 'new');

// "system<TAB>slug<TAB>games<TAB>bytes<TAB>here<TAB>name<TAB>newBytes" per system with games to send that this console
// plays (newBytes: the size of the games not here yet)
browseRouter.get('/systems', async (req, res) => {
  const device = await allowed(req);
  if (!device) return res.type('text/plain').send('denied\n');
  const cat = await catalog();
  const ok = plays(device);
  const mine = await deviceGames(device);
  const by = new Map<string, { games: number; bytes: number; here: number; fresh: number }>();
  for (const g of cat.games) {
    if (!ok(g.system)) continue;
    const s = by.get(g.system) ?? { games: 0, bytes: 0, here: 0, fresh: 0 };
    s.games++;
    s.bytes += g.bytes;
    if (stateOf(g, mine) !== 'new') s.here++;
    else s.fresh += g.bytes;
    by.set(g.system, s);
  }
  const rows = [...by].map(([slug, s]) => ({ slug, name: cat.systems.get(slug) ?? slug, ...s })).sort((a, b) => a.name.localeCompare(b.name));
  res.type('text/plain').send(rows.map((r) => ['system', r.slug, r.games, r.bytes, r.here, field(r.name), r.fresh].join('\t')).join('\n') + (rows.length ? '\n' : ''));
});

// "total<TAB>n", then "game<TAB>id<TAB>bytes<TAB>state<TAB>system<TAB>title": a system's games (or every system's), by
// title or, with q, by how well they match it; show=new leaves out the games here or queued
browseRouter.get('/games', async (req, res) => {
  const device = await allowed(req);
  if (!device) return res.type('text/plain').send('denied\n');
  const system = String(req.query.system ?? '').trim();
  const q = String(req.query.q ?? '').trim().slice(0, 100);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const cat = await catalog();
  const ok = plays(device);
  let games = cat.games.filter((g) => ok(g.system) && (!system || system === '-' || g.system === system));
  if (q.length >= 2) {
    const qq = query(q);
    games = games
      .map((g) => ({ g, n: score(qq, g.s) }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n || a.g.title.localeCompare(b.g.title))
      .map((x) => x.g);
  }
  const mine = await deviceGames(device);
  if (req.query.show === 'new') games = games.filter((g) => stateOf(g, mine) === 'new');
  const page = games.slice(offset, offset + limit);
  const out = [`total\t${games.length}`, ...page.map((g) => ['game', g.gameId, g.bytes, stateOf(g, mine), g.system, field(g.title)].join('\t'))];
  res.type('text/plain').send(out.join('\n') + '\n');
});

interface Selection {
  games: Set<number>;
  systems: Set<string>;
  skip: Set<number>;
}

function selectionOf(body: unknown): Selection {
  const sel: Selection = { games: new Set(), systems: new Set(), skip: new Set() };
  for (const line of String(body ?? '').split('\n').slice(0, 50_000)) {
    const [kind, v] = line.trim().split('\t');
    if (kind === 'game' && /^\d+$/.test(v ?? '')) sel.games.add(Number(v));
    else if (kind === 'skip' && /^\d+$/.test(v ?? '')) sel.skip.add(Number(v));
    else if (kind === 'system' && v && v.length <= 32) sel.systems.add(v);
  }
  return sel;
}

/** What a selection would add to the device, and whether it fits with what its lists still have to bring */
async function check(device: AgentDevice, sel: Selection) {
  const cat = await catalog();
  const ok = plays(device);
  const mine = await deviceGames(device);
  const picked = cat.games.filter((g) => ok(g.system) && (sel.games.has(g.gameId) || (sel.systems.has(g.system) && !sel.skip.has(g.gameId))));
  const fresh = picked.filter((g) => stateOf(g, mine) === 'new');
  const need = fresh.reduce((n, g) => n + g.bytes, 0);
  // A pick of a system or game the device leaves out turns it back on; the plan then counts what that brings too
  const before = systemFilterOf(device);
  const filter: SystemFilter = { ...before, excluded: [...before.excluded], known: [...before.known], excludedGames: before.excludedGames.filter((id) => !fresh.some((g) => g.gameId === id)) };
  for (const slug of new Set(fresh.map((g) => g.system))) {
    if (copiesSystem(filter, slug)) continue;
    filter.excluded = filter.excluded.filter((s) => s !== slug);
    if (!filter.known.includes(slug)) filter.known.push(slug);
  }
  const changed = JSON.stringify(filter) !== JSON.stringify(before);
  const plan = await devicePlan({ ...device, systemFilter: filter as never }, device.rootPath, device.homeRoot ?? device.rootPath);
  // As GET /agent/roms spends its budget: files neither left out nor present in any version
  const pending = plan.files.filter((f) => !f.excluded && !f.present).reduce((n, f) => n + f.size, 0);
  const kept = plan.reserveBytes != null ? keptBytes(plan.reserveBytes) : null;
  const fits = !fresh.length || (plan.budget != null && need + pending <= plan.budget);
  const lines = [
    `need\t${need}\t${fresh.length}`,
    `have\t${picked.length - fresh.length}`,
    `pending\t${pending}`,
    plan.free != null && kept != null ? `space\t${plan.budget}\t${plan.free}\t${kept}` : 'space\t-',
    `fits\t${fits ? 1 : 0}`,
  ];
  return { fresh, need, fits, filter: changed ? filter : null, lines };
}

const textBody = express.text({ limit: '1mb', type: '*/*' });

browseRouter.post('/check', textBody, async (req, res) => {
  const device = await allowed(req);
  if (!device) return res.type('text/plain').send('denied\n');
  const r = await check(await storeSpace(device, req), selectionOf(req.body));
  res.type('text/plain').send(r.lines.join('\n') + '\n');
});

// The selection goes to the device's picks when it fits ("added<TAB>games<TAB>bytes"); otherwise nothing changes
browseRouter.post('/add', textBody, async (req, res) => {
  const device = await allowed(req);
  if (!device) return res.type('text/plain').send('denied\n');
  const r = await check(await storeSpace(device, req), selectionOf(req.body));
  if (!r.fits) return res.type('text/plain').send([...r.lines, 'nospace'].join('\n') + '\n');
  if (r.filter) await prisma.device.update({ where: { id: device.id }, data: { systemFilter: r.filter as never } });
  const { added } = r.fresh.length ? await addPicks(device, r.fresh.map((g) => (g.romId ? { romId: g.romId } : { hackId: g.hackId! }))) : { added: 0 };
  res.type('text/plain').send([...r.lines, `added\t${added}\t${r.need}`].join('\n') + '\n');
});
