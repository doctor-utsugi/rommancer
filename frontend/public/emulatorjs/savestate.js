const LIMIT = 128 * 1024 * 1024;
const decoder = new TextDecoder('ascii');
const signature = (bytes, text) => decoder.decode(bytes.subarray(0, text.length)) === text;
const invalid = (message) => { throw new Error(message); };

export async function unpackState(input) {
  if (!(input instanceof Uint8Array) || input.length > LIMIT) invalid('Invalid savestate size');
  if (!signature(input, '#RZIPv')) return input;
  if (input.length < 20 || input[6] !== 1 || input[7] !== 35) invalid('Unsupported RetroArch compression version');
  const header = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const chunkSize = header.getUint32(8, true);
  const total = header.getBigUint64(12, true);
  if (!chunkSize || chunkSize > LIMIT || !total || total > BigInt(LIMIT)) invalid('Invalid RetroArch compressed size');
  const result = new Uint8Array(Number(total));
  let offset = 20, written = 0;
  while (written < result.length) {
    if (offset + 4 > input.length) invalid('Truncated RetroArch compressed chunk');
    const compressed = header.getUint32(offset, true);
    offset += 4;
    if (!compressed || offset + compressed > input.length) invalid('Truncated RetroArch compressed data');
    const stream = new Blob([input.slice(offset, offset + compressed)]).stream().pipeThrough(new DecompressionStream('deflate'));
    const reader = stream.getReader();
    const expected = Math.min(chunkSize, result.length - written);
    let chunkWritten = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (chunkWritten + value.length > expected) invalid('RetroArch compressed size mismatch');
        result.set(value, written + chunkWritten);
        chunkWritten += value.length;
      }
    } finally { await reader.cancel().catch(() => {}); }
    if (chunkWritten !== expected) invalid('RetroArch compressed size mismatch');
    written += chunkWritten;
    offset += compressed;
  }
  if (offset !== input.length) invalid('Unexpected data after compressed savestate');
  return result;
}

export function coreState(input) {
  if (!signature(input, 'RASTATE')) return input;
  if (input.length < 8 || input[7] !== 1) invalid('Unsupported RetroArch state container');
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let memory = null, ended = false;
  for (let offset = 8; offset < input.length;) {
    if (offset + 8 > input.length) invalid('Truncated RetroArch block');
    const tag = decoder.decode(input.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8, end = start + size;
    if (end > input.length) invalid('Truncated RetroArch block data');
    if (tag === 'MEM ') {
      if (memory || !size) invalid('Invalid RetroArch memory block');
      memory = input.slice(start, end);
    }
    if (tag === 'END ') { if (size) invalid('Invalid RetroArch end block'); ended = true; break; }
    offset = start + Math.ceil(size / 8) * 8;
  }
  if (!memory || !ended) invalid('Incomplete RetroArch state container');
  return memory;
}

export function gambatteFields(bytes) {
  const read24 = (offset) => bytes[offset] * 65536 + bytes[offset + 1] * 256 + bytes[offset + 2];
  if (bytes.length < 5 || bytes[0] !== 0 || bytes[1] !== 1) invalid('Unsupported Gambatte state format');
  let offset = 5 + read24(2);
  if (offset > bytes.length) invalid('Truncated Gambatte screenshot');
  const fields = new Map();
  while (offset < bytes.length) {
    const end = bytes.indexOf(0, offset);
    if (end < offset + 1 || end - offset > 32 || end + 4 > bytes.length) invalid('Invalid Gambatte field');
    const label = decoder.decode(bytes.subarray(offset, end));
    if (!/^[a-zA-Z0-9]+$/.test(label) || fields.has(label)) invalid('Invalid Gambatte field label');
    const size = read24(end + 1);
    const next = end + 4 + size;
    if (next > bytes.length) invalid('Truncated Gambatte field data');
    fields.set(label, { bytes: bytes.slice(offset, next), value: bytes.slice(end + 4, next) });
    if (fields.size > 512) invalid('Too many Gambatte fields');
    offset = next;
  }
  if (!['pc', 'sp', 'wram', 'vram', 'hram'].every((key) => fields.has(key))) invalid('Incomplete Gambatte state');
  return fields;
}

// Gambatte's network-link builds add two fields but retro_unserialize requires an exact byte count.
// Only idle link metadata is optional; never discard or synthesize unknown machine state.
export function adaptGambatte(source, target) {
  const from = gambatteFields(source), to = gambatteFields(target);
  const idleLink = { netsfc: 0, netsv: 255 };
  const changes = [];
  for (const [key, field] of from) {
    const expected = to.get(key);
    if (expected && field.value.length !== expected.value.length) invalid(`Incompatible Gambatte field: ${key}`);
    if (!expected) {
      if (!(key in idleLink) || field.value.length !== 1 || field.value[0] !== idleLink[key]) invalid(`Unsupported Gambatte field: ${key}`);
      changes.push(key);
    }
  }
  for (const [key, field] of to) {
    if (!from.has(key)) {
      if (!(key in idleLink) || field.value.length !== 1 || field.value[0] !== idleLink[key]) invalid(`Missing Gambatte field: ${key}`);
      changes.push(key);
    }
  }
  const chunks = [new Uint8Array([0, 1, 0, 0, 0]), ...[...to].map(([key, field]) => (from.get(key) ?? field).bytes)];
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  if (result.length !== target.length) invalid('Incompatible Gambatte serialized size');
  return { data: result, adapted: changes.length > 0 };
}

export async function prepareState(input, template, core, sourceCore) {
  if (core !== 'gambatte') return { data: input, adapted: false };
  if (!/\bgambatte\b/i.test(sourceCore ?? '')) invalid('This savestate was not made by Gambatte');
  return adaptGambatte(coreState(await unpackState(input)), coreState(await unpackState(template)));
}
