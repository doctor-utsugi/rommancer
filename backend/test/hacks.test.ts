import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { decide, headerCode, rankBases, sampleChunks, type Signature } from '../src/modules/hacks/identify.js';

const KB = 1024;
const sig = (romId: number, gameId: number, buf: Buffer): Signature => ({ romId, gameId, name: `rom${romId}`, sample: sampleChunks(buf) });

// Cambia n bloques de 1 KiB elegidos al azar
function mutate(buf: Buffer, blocks: number) {
  const out = Buffer.from(buf);
  for (let i = 0; i < blocks; i++) crypto.randomBytes(KB).copy(out, crypto.randomInt(0, buf.length / KB) * KB);
  return out;
}

test('romhacks: la traduccion se enlaza con su rom base exacta por contenido', () => {
  const japan = crypto.randomBytes(512 * KB);
  // Otra region del mismo juego: comparte casi todo
  const usa = mutate(japan, 40);
  const other = crypto.randomBytes(512 * KB);
  const sigs = [sig(1, 10, japan), sig(2, 10, usa), sig(3, 20, other)];
  const translation = mutate(japan, 25);
  const ranked = rankBases(sampleChunks(translation), sigs);
  assert.equal(ranked[0].romId, 1);
  assert.ok(ranked[0].score > 0.8, String(ranked[0].score));
  assert.deepEqual(decide(ranked, [], true), { base: { romId: 1, gameId: 10 }, evidence: 'content' });
});

test('romhacks: hack ampliado con datos desplazados y relleno', () => {
  const base = crypto.randomBytes(256 * KB);
  const expanded = Buffer.concat([crypto.randomBytes(7 * KB), mutate(base, 30), Buffer.alloc(256 * KB, 0xff)]);
  const ranked = rankBases(sampleChunks(expanded), [sig(1, 10, base), sig(2, 20, crypto.randomBytes(256 * KB))]);
  assert.equal(ranked[0].romId, 1);
  assert.ok(ranked[0].score >= 0.5);
});

test('romhacks: parecido medio enlaza el juego pero no fija la rom base', () => {
  const usa = crypto.randomBytes(256 * KB);
  const japanTranslation = mutate(usa, 90);
  const ranked = rankBases(sampleChunks(japanTranslation), [sig(1, 10, usa)]);
  assert.ok(ranked[0].score > 0.5 && ranked[0].score < 0.85, String(ranked[0].score));
  assert.deepEqual(decide(ranked, [], true), { base: { romId: null, gameId: 10 }, evidence: 'content' });
});

test('romhacks: el relleno no cuenta como parecido', () => {
  const a = Buffer.concat([crypto.randomBytes(16 * KB), Buffer.alloc(240 * KB, 0xff)]);
  const b = Buffer.concat([crypto.randomBytes(16 * KB), Buffer.alloc(240 * KB, 0xff)]);
  const ranked = rankBases(sampleChunks(b), [sig(1, 10, a)]);
  assert.ok(!ranked.length || ranked[0].score < 0.2);
});

test('romhacks: dos juegos distintos casi iguales van a revision', () => {
  const a = crypto.randomBytes(256 * KB);
  const b = mutate(a, 2);
  const ranked = rankBases(sampleChunks(mutate(a, 1)), [sig(1, 10, a), sig(2, 20, b)]);
  const d = decide(ranked, [], true);
  assert.ok(d && 'review' in d);
});

test('romhacks: el nombre solo genera revision y sin marcas no se hace nada', () => {
  const d = decide([], [], true);
  assert.ok(d && 'review' in d);
  assert.equal(decide([], [], false), null);
});

test('romhacks: codigo de cabecera (GBA, NDS, N64, Mega Drive)', () => {
  const gba = Buffer.alloc(0x200);
  gba.write('BPEE', 0xac, 'latin1');
  assert.equal(headerCode('gba', gba), 'BPEE');
  const nds = Buffer.alloc(0x200);
  nds.write('ADAE', 0x0c, 'latin1');
  assert.equal(headerCode('nds', nds), 'ADAE');
  const n64 = Buffer.alloc(0x200);
  n64.writeUInt32BE(0x80371240, 0);
  n64.write('NSME', 0x3b, 'latin1');
  assert.equal(headerCode('n64', n64), 'NSME');
  const md = Buffer.alloc(0x200);
  md.write('GM T-48073-00', 0x180, 'latin1');
  assert.equal(headerCode('md', md), 'T-48073-00');
  assert.equal(headerCode('snes', gba), null);
  // Codigo de cabecera con un unico juego: enlace aunque no se tenga la base
  assert.deepEqual(decide([], [{ romId: 5, gameId: 50, name: 'x' }], false), { base: { romId: 5, gameId: 50 }, evidence: 'header' });
});
