# Browser savestate compatibility

The web player adapts compatible Gambatte serialized layouts in memory before loading them. It never
rewrites the stored SaveVersion, changes its checksum or uploads the browser's progress.

## Verified case

A Power Quest savestate from RetroArch Gambatte v0.5.0 on RG40XX-V had a 51,434-byte core payload. The bundled
EmulatorJS Gambatte core expected 51,413 bytes and rejected the file, silently returning to the game's language
selection. RetroArch's RZIP compression was already understood by the runtime; compression was not the rejection.

Comparing the tagged field layouts showed exactly two extra one-byte link fields: `netsfc` (0) and `netsv`
(255). Their labels, lengths and values account for the 21-byte difference. All other field names and lengths
matched. Removing only those idle link fields from a temporary copy loaded the saved overworld correctly in
the real browser core. The original compressed state and ROM stayed unchanged.

`frontend/public/emulatorjs/savestate.js` validates and decodes RZIP v1 and RASTATE v1, then compares the source
against a freshly serialized template from the running Gambatte core. Every machine-state field must exist
on both sides with the same length. Only those two known idle link fields can be added/removed. Unknown fields,
active link values, changed field lengths, malformed containers or unsupported compression versions fail with
an explicit player error instead of guessing. Other emulators retain the existing load path.

This is compatibility between specific builds of the same core, not a general savestate conversion between
different emulators. Ordinary SRAM saves and memory-card conversion remain separate from CPU/PPU savestates.

## Protocol references

- RetroArch: `libretro-common/streams/rzip_stream.c` (20-byte header, independent zlib chunks).
- RetroArch: RASTATE v1, tagged/aligned memory blocks.
- Gambatte: `libgambatte/src/statesaver.cpp` (named fields with 24-bit lengths).
- Gambatte: `libgambatte/libretro/libretro.cpp`, `retro_unserialize` requires the current serialized size.
- Source: https://github.com/libretro/gambatte-libretro

Tests in `backend/test/web-savestate.test.ts` use synthetic data only. They cover multi-chunk decompression,
size limits/truncation, unchanged machine-state bytes, bidirectional idle-link compatibility and rejection of
unknown/active-link fields. Real Power Quest verification used temporary private fixtures outside the repo.

The fix was deployed in web image `powerquest-20261015-60` and verified against the public HTTPS player with
the original private ROM/state supplied only to the local browser. It loaded the saved overworld with no
player error. The original server-side state retained SHA-1 `3059efb23d938aa0bdcdd9cbed7df3ec01afbe7e`.
