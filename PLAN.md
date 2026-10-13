# Rommancer - Implementation plan

Phase 1 (below) and phase 2 (final section). Phase 2 decisions replace those of phase 1 where they contradict.

Multi-user manager for roms, lists, devices and saves. Source: `/Users/Shared/Proyects/wanda/rommancer/ROMMANCER.md` plus decisions made in conversation.

## Closed decisions

| Topic | Decision |
|---|---|
| Stack | Node 22 + TypeScript, Express, Prisma, MySQL 8. React + TypeScript + Vite + shadcn/ui + Tailwind. Podman (not Docker). |
| Repo | Monorepo: `/backend`, `/frontend`, `/compose.yaml`, `/data` (app volume). pnpm workspaces. |
| Deployment | 3 containers: `mysql`, `api`, `web` (nginx serves the React build and proxies `/api`). One `/data` volume (media, saves, uploads, dats). The user's rom paths as bind mounts. Development: only mysql in Podman, node local. |
| DAT sources | No-Intro and Redump (XML .dat uploaded by admin), FBNeo (DAT from GitHub), RetroAchievements (API), romhacks (romhacking.net / rhdn archive). |
| Phase 1 systems | NES, SNES, GB, GBC, GBA, N64, NDS, Master System, Game Gear, Mega Drive, PS1, PS2, PSP, GameCube, Wii (ISO/RVZ), Arcade (FBNeo). PS3/360 out. |
| Hash | CRC32 + MD5 + SHA1 of the whole file and, for NES/FDS/SNES/Lynx/A7800, also without header. Inside .zip/.7z each inner file is hashed. CHD: SHA1 of the header for single-track (DVD); for multi-track CD extract with `chdman extractcd` to tmp and hash the tracks, cached by (path, mtime, size). RVZ: verification via `dolphin-tool verify`. |
| RetroAchievements | Build `RAHasher` from rcheevos with CHD support into the `api` image; it is invoked as a subprocess per rom. Result cached in `RomFile.raHash`. |
| Roms | Several paths scanned as they are, without moving anything. Renaming/sorting is an explicit action. One path marked as upload destination. |
| Renaming | Canonical No-Intro/Redump name. Folder scheme configurable per firmware when exporting to a device. |
| Scraping | ScreenScraper.fr through its API (by hash) with queue and limits; libretro-thumbnails as fallback. Per-user credentials with fallback to global ones. |
| Auth | Local JWT (access + refresh), roles `ADMIN` / `USER`. Closed registration: admin creates users or invitations. |
| Uploads | Client-side hash (Web Crypto, SHA1/MD5 in a worker), query `/api/roms/match` before uploading; the server rehashes and stores in the destination path under the canonical name. |
| Lists | Private / shared / public levels. Collaborative. Clone. JSON export/import. Sublists derived by filter (region, RA compatible). |
| Devices | Tables `Console`, `Firmware` (template of paths and folder names per system), `Device` = console + firmware + connection (local path or SSH). Seeds for muOS, Knulli, Rocknix, Batocera, ES-DE, Android RetroArch, Windows RetroArch. |
| Saves | Versioned history per (user, game, emulator/core). Manual push/pull (the cron is replaced by events in phase 2). Conflicts: see phase 2. Conversion: .srm <-> .sav (GBA/SNES/MD), PS1 memory cards (.mcr/.mcd/.srm/.gme/.vmp), relocation by rom name. |
| Transfer | Mounted path, SSH/SFTP (ssh2), zip download from the browser (stream). |
| i18n | ES + EN with i18next from the start. |

## Data model (Prisma)

```
User(id, username, email, passwordHash, role, locale, ssUser?, ssPassword?, raApiKey?, createdAt)
Invitation(id, token, createdBy, usedBy?, expiresAt)

System(id, slug, name, manufacturer, generation, extensions[], headerSize?, raConsoleId?)
DatSource(id, type[NOINTRO|REDUMP|FBNEO|RA|ROMHACK], systemId, name, version, importedAt, fileHash)

Game(id, systemId, title, titleNormalized, releaseYear?, developer?, publisher?, genre?, description?, igdbId?, ssId?)
Rom(id, gameId, datSourceId, name, region[], languages[], version?, revision?, isVerified, isProto, isBeta, isHack, parentRomId?, raHash?, raGameId?)
RomPart(id, romId, name, size, crc32, md5, sha1, headerlessCrc32?, headerlessMd5?, headerlessSha1?)  -- multi-track and arcade sets
RomHack(id, gameId, title, author, version, patchFormat, sourceUrl, baseRomId?, resultCrc32?, resultMd5?, resultSha1?)

RomPath(id, label, path, isUploadTarget, readOnly, lastScanAt)
RomFile(id, romPathId, relativePath, archiveEntry?, size, mtime, crc32, md5, sha1, headerlessSha1?, raHash?, romPartId?, matchStatus[MATCHED|UNKNOWN|HEADERED|BAD], scannedAt)
ScanJob(id, romPathId, status, total, processed, startedAt, finishedAt, log)

Media(id, gameId|romId, type[COVER|SCREENSHOT|TITLE|MANUAL|VIDEO|MARQUEE], source, path, lang?)
ScrapeJob(id, userId, scope, status, progress)

List(id, ownerId, name, description, visibility[PRIVATE|SHARED|PUBLIC], isCollaborative, parentListId?, derivedFilter? json, createdAt)
ListItem(id, listId, gameId?, romId?, position, note?)
ListShare(listId, userId, canEdit)

Console(id, name, manufacturer, formFactor)
Firmware(id, name, consoleId?, romsRoot, savesRoot, statesRoot, biosRoot, folderMap json {systemSlug: folder}, saveExtMap json)
Device(id, userId, name, consoleId, firmwareId, connType[LOCAL|SSH], localPath?, sshHost?, sshPort?, sshUser?, sshKey?/sshPassword?, overrides json)
TransferJob(id, userId, deviceId, listId, direction, status, progress, log)

Emulator(id, name, core?, saveFormat, saveExt, stateExt)
Save(id, userId, gameId, romId?, emulatorId, kind[SAVE|STATE], slot?, currentVersionId)
SaveVersion(id, saveId, path, size, sha1, sourceDeviceId?, createdAt)
SaveSyncJob(id, deviceId, direction, status, log)
```

Prisma uses MySQL; arrays are stored as JSON.

## Backend (`/backend`)

```
src/
  app.ts, server.ts
  config/env.ts
  lib/prisma.ts, lib/logger.ts (pino), lib/queue.ts (BullMQ? no: simple queue in MySQL + in-process worker, KISS)
  modules/
    auth/        login, refresh, invitations, role middleware
    users/
    systems/
    dats/        XML parsers (fast-xml-parser) No-Intro, Redump, FBNeo; idempotent importer; title normalization -> Game
    ra/          RA API client, RAHasher subprocess, raHash -> Rom mapping
    romhacks/    rhdn importer, association by name/base
    scanner/     path walk, streaming hashing (crc32 via zlib, md5/sha1 via crypto), yauzl + 7z (node-7z over the 7zz binary), headers, chdman, dolphin-tool; matching against RomPart
    roms/        collection queries, missing, rename/organize (dry-run + apply), match by hash
    uploads/     multer streaming, hash verification, placement
    scrape/      ScreenScraper client (rate limit, by hash), libretro-thumbnails fallback, storage in /data/media
    lists/       CRUD, share, clone, derived (region/RA/version filters), JSON export/import, zip download (archiver stream)
    devices/     consoles, firmwares (seeds), devices, SSH connection test
    transfer/    list -> device copy via fs or sftp, folder mapping per firmware, on-the-fly renaming
    saves/       upload, history, push/pull, cron (node-cron), converters/ (srm-sav, ps1-memcard), relocate
  jobs/          in-process worker with a generic Job table
```

REST API under `/api/v1`, validation with zod, uniform errors. Long jobs (scan, scrape, transfer, sync) return a jobId and are queried by polling or SSE (`/api/v1/jobs/:id/events`).

`api` image (Containerfile): node:22-bookworm-slim + chdman (package `mame-tools`), 7zip (`7zip`), dolphin-tool (build or package), RAHasher built from rcheevos with `HAVE_CHD=1`.

## Frontend (`/frontend`)

Vite + React 18 + TS, shadcn/ui, TanStack Query, TanStack Table, react-router, react-hook-form + zod, i18next.

Pages:
- Login / invitation
- Dashboard: summary per system (have / missing / verified)
- Systems and games: table with filter, game page with roms, romhacks, media, RA status
- Collection: paths, start a scan, results, unknowns, rename/sort (dry-run view)
- Upload roms: hash in a worker, pre-query, progress bar
- Lists: mine, shared, public; editor; derived sublist; export; send to device; download zip
- Devices: registration with console/firmware, connection test, overrides
- Saves: per game, history, restore, push/pull to a device, conversion
- Admin: users, invitations, import DATs, global credentials, jobs

## Phases

1. Skeleton: monorepo, compose, Prisma schema, auth, users, i18n, shadcn layout.
2. Systems + DAT importer (No-Intro, Redump, FBNeo) + Game/Rom/RomPart + games UI.
3. Scanner: paths, hashing (plain, zip/7z, headers), matching, missing, collection UI.
4. CHD and RVZ, RAHasher, RA mapping.
5. Full lists (visibility, collaborative, clone, derived, export/import, zip).
6. Devices, firmwares with seeds, local and SSH transfer, renaming per firmware.
7. User uploads with hash validation.
8. ScreenScraper + libretro-thumbnails scraping.
9. Saves: versioned store, push/pull, cron, converters, relocation.
10. Romhacks.
11. Rename/organize the local collection.

## Risks and notes

- ScreenScraper limits threads and requests per account; use a sequential queue per user.
- Extracting a CD CHD to verify it is slow; it is done once and cached by mtime/size.
- Arcade: the hash is per file inside the zip; matching is by set, not by file. `RomFile` points to the zip and `RomPart` to each inner rom.
- SSH credentials and API keys are encrypted at rest (AES-256-GCM with the key in env).
- Nothing goes out to the Internet except ScreenScraper, RA, GitHub (thumbnails, FBNeo DAT) and rhdn, always at the user's request.

## Implementation status

All 11 phases implemented. Changes from the initial plan:

- npm workspaces instead of pnpm (corepack no longer ships with Node 26).
- RAHasher is not built: the rcheevos algorithm is ported to TypeScript (`backend/src/lib/rahash.ts`), CHD via `chdman extractcd/extractdvd`.
- MySQL on host port 3317 (3307 was taken).
- Linux deployment with Quadlet (`deploy/quadlet/`) besides `compose.yaml`.
- No-Intro/Redump DATs taken from libretro-database (public copy on GitHub); the official ones can be uploaded.
- RA hash for every system (including Wii) validated against compiled rcheevos (tools/rahash-cli).
- RVZ/WIA: own reader ported from Dolphin (no dolphin-tool), rebuilds the ISO to verify against Redump.
- `seed/` seed with DATs for every console, RA and scraping; it is applied on startup and updated automatically.

## Phase 2

Implemented. Decisions and status:

| Topic | Decision |
|---|---|
| Git and schema | Local git repository (seed/ included). Prisma with versioned migrations (`prisma/migrations`), `migrate deploy` in the container; `npm run migration:new -w backend -- name` for new ones. |
| Permissions | Per user and in invitations: view collection, lists, saves, download roms (and devices), upload verified, upload unverified, media of their lists, bulk scraping. Default: view, lists, saves and media of lists. Admin: everything. |
| Security | Login limit (5 failures / 15 min per IP and user), closed CORS (`CORS_ORIGINS`), headers in Express and nginx, refuses to start with example secrets, 15 min tokens, separate files token for URLs, forced change of the initial password. |
| Destination for new roms | Destination paths per system with a folder scheme; otherwise the default one; otherwise `DATA_DIR/library`. For uploads, generated patches and verified containers. |
| Unverified uploads | `UNVERIFIED` status, with the user who uploaded it; they do not count in percentages; they become verified if a later DAT includes them. WBFS/CISO stay this way (identified by disc id). |
| Discs | Own readers for WBFS (also split), CISO, CSO v1/v2 and ZSO (own LZ4). |
| Patches | Own IPS/BPS/UPS with checksums. On-demand generation at the final destination. Hash with and without header. Merging of duplicate romhacks. BPS patch created from an already patched romhack and its base. |
| Romhacks | Identified by content (1 KiB block similarity with the roms you have; >= 85% fixes the exact base rom, >= 50% only the game), header code (GBA, NDS, N64, MD) or patch. The name only produces suggestions in the review queue. |
| Labels | Region, languages, version only if there are several, unverified, removed, serial; romhack with exact base rom and its own version ("Gran Turismo 4 (USA) v1.01 + Spec II v1.10"). |
| Grouping | Evidence + union-find: manual rules, DAT clones (official FBNeo), Retool, RetroAchievements, ScreenScraper (by hash). Title as a last resort marked as doubtful. No No-Intro P/C pack (download protected against automation; user's decision). |
| Works and sagas | Wikidata (CC0): anchors by RA/ScreenScraper ids, unique name on the platform, review queue if there are several candidates. Saga from Wikidata or libretro. Lists with works and platform preference. |
| Permanent data | Nothing external is deleted: removed roms and romhacks are marked; `seed/removed.json` keeps them for new deployments. Metadata priority: manual > ScreenScraper > TheGamesDB > libretro. |
| Global sync | Weekly `EXTERNAL_SYNC_CRON`: libretro (DATs, metadata, covers of what you have), Retool, RetroAchievements, Wikidata, in sequence and with conditional requests. Forced per source and system with a minimum interval. |
| FBNeo | Official DAT (libretro/FBNeo, "Arcade only", with clones). The libretro-database one (one zip per set) does not create roms. |
| Media | On demand when adding to lists and from the game page; only with the user's own account (admin may use the global ones). ScreenScraper quotas respected and resumed the next day; "not found" remembered for 6 months; TheGamesDB as a fallback by exact, unique name; Internet Archive only as a suggestion. |
| Saves | Steam Cloud style: per-device baseline, no clocks; conflict if both sides change (both versions are kept). Event scripts for ES-DE and Batocera/Knulli/ROCKNIX with a per-device token and retry when offline. SD cards mounted on the server: sync on connection. No `SAVE_SYNC_CRON`. |

Pending:
- Try the real ScreenScraper and TheGamesDB (developer credentials and key missing in `.env`).
- Check on the AYN Thor (Android) access to save folders and `curl`/`wget`.
- Daijisho (no documented events): manual sync only.
- Optional: IGDB for works Wikidata lacks; ScreenScraper families for sagas; header code for more systems; RetroAchievements "~Hack~" games.
