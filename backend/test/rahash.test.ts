/**
 * Valida el port TypeScript del hash de RetroAchievements contra rcheevos compilado
 * (tools/rahash-cli, `make -C tools/rahash-cli`). Se omite si el binario no existe.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashFile } from '../src/lib/hash.js';
import { raHashFile, raHashFromHashes } from '../src/lib/rahash.js';
import { makeGcRvz } from './helpers/rvz-encoder.js';
import { RvzReader } from '../src/lib/rvz.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CLI = path.join(ROOT, 'tools/rahash-cli/rahash');
const skip = !fs.existsSync(CLI);
const CONSOLE: Record<string, number> = { md: 1, n64: 2, snes: 3, gb: 4, gba: 5, nes: 7, psx: 12, lynx: 13, gc: 16, nds: 18, wii: 19, ps2: 21, fbneo: 27, psp: 41, a7800: 51 };

const reference = (system: string, file: string) => execFileSync(CLI, [String(CONSOLE[system]), file]).toString().trim();

async function ours(system: string, file: string) {
  const h = await hashFile(file, system === 'snes' ? 'snes' : system === 'nes' ? 'nes' : system === 'lynx' ? 'lynx' : system === 'a7800' ? 'a7800' : 'none');
  return raHashFromHashes(system, h) ?? (await raHashFile(system, file));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rahash-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const write = (name: string, buf: Buffer) => {
  const p = path.join(tmp, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  return p;
};

async function check(system: string, file: string) {
  const ref = reference(system, file);
  assert.equal(await ours(system, file), ref, `${system}: ${path.basename(file)}`);
}

function makeIso(name: string, files: Record<string, Buffer>): string | null {
  const src = path.join(tmp, `${name}-src`);
  for (const [rel, buf] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), buf);
  }
  const iso = path.join(tmp, `${name}.iso`);
  try {
    execSync(`hdiutil makehybrid -iso -default-volume-name TEST -o "${iso}" "${src}"`, { stdio: 'ignore' });
  } catch {
    try {
      execSync(`xorriso -as mkisofs -o "${iso}" "${src}"`, { stdio: 'ignore' });
    } catch {
      return null;
    }
  }
  return iso;
}

test('RA: todas las roms reales de NES y SNES', { skip }, async () => {
  for (const sys of ['nes', 'snes']) {
    const dir = path.join(ROOT, 'roms', sys);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) await check(sys, path.join(dir, f));
  }
});

test('RA: cartuchos con y sin cabecera (GB, GBA, MD, Lynx, 7800)', { skip }, async () => {
  await check('gb', write('a.gb', crypto.randomBytes(32768)));
  await check('gba', write('a.gba', crypto.randomBytes(65536)));
  await check('md', write('a.md', crypto.randomBytes(131072)));
  const lynx = crypto.randomBytes(64 + 65536);
  lynx.write('LYNX\0', 0, 'latin1');
  await check('lynx', write('a.lnx', lynx));
  const a78 = crypto.randomBytes(128 + 32768);
  a78.write('ATARI7800', 1, 'latin1');
  await check('a7800', write('a.a78', a78));
});

test('RA: N64 en z64, v64 y n64', { skip }, async () => {
  const z64 = crypto.randomBytes(1 << 20);
  z64.writeUInt32BE(0x80371240, 0);
  const v64 = Buffer.from(z64).swap16();
  const n64 = Buffer.from(z64).swap32();
  const ref = reference('n64', write('a.z64', z64));
  for (const [n, b] of [['b.v64', v64], ['c.n64', n64]] as const) {
    const f = write(n, b);
    assert.equal(reference('n64', f), ref);
    assert.equal(await ours('n64', f), ref);
  }
  assert.equal(await ours('n64', path.join(tmp, 'a.z64')), ref);
});

test('RA: Nintendo DS', { skip }, async () => {
  const rom = crypto.randomBytes(0x40000);
  rom.writeUInt32LE(0x4000, 0x20);
  rom.writeUInt32LE(0x8000, 0x2c);
  rom.writeUInt32LE(0x10000, 0x30);
  rom.writeUInt32LE(0x4000, 0x3c);
  rom.writeUInt32LE(0x20000, 0x68);
  await check('nds', write('a.nds', rom));
});

test('RA: PlayStation, PS2 y PSP (ISO9660)', { skip }, async (t) => {
  const exe = crypto.randomBytes(2048 + 8192);
  exe.write('PS-X EXE', 0, 'latin1');
  exe.writeUInt32LE(8192, 28);
  const psx = makeIso('psx', { 'SYSTEM.CNF': Buffer.from('BOOT = cdrom:\\SLUS_012.34;1\r\nTCB = 4\r\n'), 'SLUS_012.34': exe });
  if (!psx) return t.skip('sin herramienta ISO');
  await check('psx', psx);
  const elf = crypto.randomBytes(40000);
  elf.write('\x7fELF', 0, 'latin1');
  const ps2 = makeIso('ps2', { 'SYSTEM.CNF': Buffer.from('BOOT2 = cdrom0:\\SLUS_200.00;1\r\nVER = 1.00\r\n'), 'SLUS_200.00': elf });
  await check('ps2', ps2!);
  const psp = makeIso('psp', { 'PSP_GAME/PARAM.SFO': crypto.randomBytes(1200), 'PSP_GAME/SYSDIR/EBOOT.BIN': crypto.randomBytes(30000) });
  await check('psp', psp!);
});

test('RA: GameCube desde ISO y desde RVZ', { skip }, async () => {
  const { iso, rvz } = makeGcRvz();
  const isoFile = write('gc.iso', iso);
  const rvzFile = write('gc.rvz', rvz);
  const ref = reference('gc', isoFile);
  assert.equal(await ours('gc', isoFile), ref);
  assert.equal(await ours('gc', rvzFile), ref);
});

test('RA: Wii cifrado, descifrado y WiiWare', { skip }, async () => {
  const disc = crypto.randomBytes(0x50000 + 0x20000 + 40 * 0x8000);
  disc.writeUInt32BE(0x5d1c9ea3, 0x18);
  disc[0x61] = 0;
  disc.fill(0, 0x40000, 0x40040);
  disc.writeUInt32BE(1, 0x40000);
  disc.writeUInt32BE(0x40020 >> 2, 0x40004);
  disc.writeUInt32BE(0x50000 >> 2, 0x40020);
  disc.writeUInt32BE(0, 0x40024);
  const part = 0x50000;
  disc.writeUInt32BE(0x208, part + 0x2a4);
  disc.writeUInt32BE(0x2c0 >> 2, part + 0x2a8);
  disc.writeUInt32BE(0x20000 >> 2, part + 0x2b8);
  disc.writeUInt32BE((40 * 0x8000) >> 2, part + 0x2bc);
  await check('wii', write('enc.iso', disc));

  // Descifrado: la particion contiene apploader y main.dol con offsets desplazados 2 bits
  const dec = Buffer.from(disc);
  dec[0x61] = 1;
  // rcheevos interpreta el offset de datos de la particion como absoluto
  const p = part + 0x20000;
  dec.writeUInt32BE(p >> 2, part + 0x2b8);
  dec.writeUInt32BE(0x1000, p + 0x2440 + 0x14);
  dec.writeUInt32BE(0x100, p + 0x2440 + 0x18);
  dec.writeUInt32BE(0x30000 >> 2, p + 0x420);
  dec.fill(0, p + 0x30000, p + 0x300d8);
  dec.writeUInt32BE(0x31000 >> 2, p + 0x30000);
  dec.writeUInt32BE(0x2000 >> 2, p + 0x30090);
  await check('wii', write('dec.iso', dec));

  const wad = crypto.randomBytes(0x4000);
  wad.writeUInt32BE(0x20, 0);
  wad.write('Is\0\0', 4, 'latin1');
  wad.writeUInt32BE(0xa00, 0x08);
  wad.writeUInt32BE(0x2a4, 0x10);
  wad.writeUInt32BE(0x208, 0x14);
  const tmd = 0x40 + 0xa00 + 0x2c0;
  wad.writeUInt16BE(1, tmd + 0x1de);
  wad.writeUInt32BE(0, tmd + 0x1e4 + 8);
  wad.writeUInt32BE(0x1000, tmd + 0x1e4 + 12);
  await check('wii', write('a.wad', wad));
});

test('RA: arcade por nombre de set', { skip }, async () => {
  await check('fbneo', write('arcade/sf2.zip', crypto.randomBytes(100)));
});

const MELEE = path.join(ROOT, 'roms/gc/Super Smash Bros. Melee (Europe) (En,Fr,De,Es,It).rvz');

test('RA: RVZ real de GameCube (Melee) contra rcheevos sobre la ISO extraida', { skip: skip || !fs.existsSync(MELEE) }, async () => {
  const r = await RvzReader.open(MELEE);
  const iso = path.join(tmp, 'melee.iso');
  const fd = fs.openSync(iso, 'w');
  try {
    for (let p = 0; p < r.isoSize; p += 1 << 21) fs.writeSync(fd, await r.read(p, Math.min(1 << 21, r.isoSize - p)));
  } finally {
    fs.closeSync(fd);
    await r.close();
  }
  const ref = reference('gc', iso);
  fs.rmSync(iso);
  assert.equal(await ours('gc', MELEE), ref);
});
