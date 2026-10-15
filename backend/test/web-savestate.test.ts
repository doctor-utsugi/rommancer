import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { unpackState, coreState, gambatteFields, adaptGambatte, prepareState } from '../../frontend/public/emulatorjs/savestate.js';

const field = (name: string, value: number[]) => {
  const size = Buffer.alloc(3); size.writeUIntBE(value.length, 0, 3);
  return Buffer.concat([Buffer.from(name + '\0'), size, Buffer.from(value)]);
};
const machine = (extra: Buffer[] = [], value = 42) => Buffer.concat([
  Buffer.from([0, 1, 0, 0, 0]), ...['hram', 'pc', 'sp', 'vram', 'wram'].map((key) => field(key, [value])), ...extra,
]);
const container = (payload: Buffer) => {
  const header = Buffer.from('RASTATE\x01MEM \0\0\0\0', 'binary'); header.writeUInt32LE(payload.length, 12);
  return Buffer.concat([header, payload, Buffer.alloc((8 - payload.length % 8) % 8), Buffer.from('END \0\0\0\0')]);
};
const rzip = (payload: Buffer, chunk = 128) => {
  const header = Buffer.alloc(20); header.write('#RZIPv\x01#', 'binary'); header.writeUInt32LE(chunk, 8); header.writeBigUInt64LE(BigInt(payload.length), 12);
  const blocks = [header];
  for (let i = 0; i < payload.length; i += chunk) {
    const compressed = deflateSync(payload.subarray(i, i + chunk));
    const size = Buffer.alloc(4); size.writeUInt32LE(compressed.length); blocks.push(size, compressed);
  }
  return Buffer.concat(blocks);
};

test('browser state: RZIP multichunk decoding and RASTATE extraction preserve every byte', async () => {
  const payload = machine([field('netsfc', [0]), field('netsv', [255])]);
  const wrapped = container(payload), compressed = rzip(wrapped, 17);
  assert.deepEqual(Buffer.from(await unpackState(compressed)), wrapped);
  assert.deepEqual(Buffer.from(coreState(await unpackState(compressed))), payload);
  assert.deepEqual(coreState(payload), payload);
  await assert.rejects(unpackState(compressed.subarray(0, compressed.length - 1)));
  await assert.rejects(unpackState(Buffer.concat([compressed, Buffer.from([0])])));
  const huge = Buffer.from(compressed); huge.writeBigUInt64LE(2n ** 40n, 12);
  await assert.rejects(unpackState(huge), /size/);
  const version = Buffer.from(compressed); version[6] = 2;
  await assert.rejects(unpackState(version), /compression version/);
  assert.throws(() => coreState(wrapped.subarray(0, wrapped.length - 1)), /Truncated/);
});

test('Gambatte: only idle link metadata is adapted; machine values survive exactly', async () => {
  const source = machine([field('netsfc', [0]), field('netsv', [255])], 99);
  const target = machine([], 0);
  const result = await prepareState(rzip(container(source)), container(target), 'gambatte', 'RetroArch Gambatte');
  assert.equal(result.adapted, true);
  assert.equal(source.length - result.data.length, 21);
  assert.deepEqual(Buffer.from(result.data), machine([], 99));
  const restored = adaptGambatte(result.data, source);
  assert.deepEqual(Buffer.from(restored.data), source);
  assert.equal(adaptGambatte(target, target).adapted, false);
  assert.throws(() => adaptGambatte(machine([field('unknown', [0])]), target), /Unsupported/);
  assert.throws(() => adaptGambatte(machine([field('netsv', [1])]), target), /Unsupported/);
  assert.throws(() => adaptGambatte(target, machine([field('cpuFlag', [0])])), /Missing/);
  assert.throws(() => gambatteFields(machine([field('pc', [1])])), /label/);
  await assert.rejects(prepareState(source, target, 'gambatte', 'mGBA'), /not made by Gambatte/);
  const untouched = await prepareState(source, target, 'mgba', 'RetroArch mGBA');
  assert.equal(untouched.data, source);
});
