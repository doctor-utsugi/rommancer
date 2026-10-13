# Rommancer - Plan to rebuild it from scratch

Self-contained document: it describes what Rommancer is, every decision taken and why, the architecture, the algorithms and the build order. With it and `ROMMANCER.md` (the original specification) the project can be rebuilt without the current code. `PLAN.md` and `README.md` complement it with status and usage.

## 1. Goal

Self-hosted multi-user manager for rom collections:

- Database of games and roms built from DATs (No-Intro, Redump, FBNeo, romhacks), checksum verification of what you have and what you lack.
- Grouping of roms into games (regions), of games into works (platforms) and of works into sagas, by evidence, not by title.
- Romhacks and translations with their exact base rom, IPS/BPS/UPS patches, on-demand generation.
- Shareable and collaborative lists, sublists with preferences (region, language, RetroAchievements, platform), zip download and copying to devices (SD or SSH).
- Media (ScreenScraper, TheGamesDB, libretro-thumbnails) on demand and with each user's own account.
- Steam Cloud style synced saves between devices and emulators, with format conversion and history.
- Everything obtained from external sources is permanent and travels in a seed (`seed/`) for new deployments.

## 2. Project principles and rules

- KISS: the simplest solution that works, with no unnecessary dependencies.
- Free software only; official repositories and sources. Podman, never Docker. Linux/Debian as the target; macOS for development with a Podman machine and the project folder shared as a volume.
- Privacy: no telemetry; no project data leaves for the Internet except queries to the external sources.
- Responsible use of external services (RetroAchievements, ScreenScraper, TheGamesDB, Wikidata, GitHub, DAT-o-MATIC): conditional requests, one at a time, quotas respected, nothing requested twice.
- Nothing is automated that the service explicitly protects against automation (the DAT-o-MATIC case, see 9.6).
- Permanent external data: never deleted because it disappears from the origin; it is marked as removed.
- The title is not a reliable grouping criterion: only a last resort marked as doubtful or as a suggestion.
- The UI ships in English and Spanish (English by default, chosen at first login or via `DEFAULT_LOCALE`, switchable per user). Code, comments and docs are English.
- Git only local. No licensing work for now.

## 3. Stack

| Layer | Choice |
|---|---|
| Backend | Node 22+ (26 in development), TypeScript ESM, Express 5, Zod 4, Prisma 6 (MySQL), jsonwebtoken, bcryptjs, multer, archiver, ssh2, node-cron, fast-xml-parser |
| Database | MySQL 8.4 in a container; `System` is a reserved word (backticks in raw SQL) |
| Frontend | React + TypeScript + Vite, shadcn/ui "base-nova" style (Base UI: `render` and `nativeButton={false}` for links; native selects), TanStack Query, react-router, i18next |
| External binaries | Only `chdman` (CHD) and `7zz` (zip/7z). No dolphin-tool or RAHasher at runtime |
| Monorepo | npm workspaces (`backend`, `frontend`); npm 11 `allowScripts` in the root `package.json` |
| Deployment | `compose.yaml` (mysql in development; api + web with the `full` profile) and Quadlet units for systemd |

Structure:

```
backend/   prisma/ (schema + migrations), src/{config,lib,modules,seed}, test/
frontend/  src/{components,i18n,lib,pages,pages/admin}, nginx.conf
deploy/quadlet/   systemd units (mysql, api, web, network and volume)
seed/      DATs, ra.json, games.json, grouping.json, wikidata.json, removed.json, patches/, retool/, media/, media-large/
tools/rahash-cli/ rcheevos CLI for reference tests only
data/      runtime data (outside git except what goes to seed/)
roms/      the user's test roms (outside git, not modified)
```

## 4. Environment

- Development MySQL at `127.0.0.1:3317` (3307 was taken). Test database `rommancer_test` and shadow database `rommancer_shadow` for creating migrations; the MySQL user needs `CREATE, DROP` permissions on both.
- `.env` (template in `.env.example`): `DATABASE_URL`, `JWT_SECRET` and `ENCRYPTION_KEY` (it cannot start with the example values; `openssl rand -hex 32`), `DATA_DIR`, `SEED_DIR`, `SEED_ON_START`, `ADMIN_*`, `CHDMAN_BIN`, `SEVENZIP_BIN`, `SCREENSCRAPER_DEV_ID/DEV_PASSWORD/USER/PASSWORD`, `RA_USERNAME/RA_API_KEY`, `THEGAMESDB_API_KEY`, `EXTERNAL_SYNC_CRON` (default `0 4 * * 0`), `FORCE_SYNC_MIN_MINUTES` (10), `CORS_ORIGINS`. Every external URL is configurable by variable so it can be simulated in tests.
- Development: `npm run db:up`, `npm run db:migrate -w backend`, `npm run dev:api` (3000) and `npm run dev:web` (5173 with `/api` proxy).

## 5. Data model

Enums: `Role(ADMIN, USER)`, `DatType(USER, NOINTRO, REDUMP, FBNEO, MAME, HACKS, OTHER)`, `MatchStatus(MATCHED, HACK, UNVERIFIED, UNKNOWN)`, `MediaType(COVER, BOX_BACK, BOX_SIDE, BOX_3D, SUPPORT, SCREENSHOT, TITLE, FLYER, FANART, MANUAL, VIDEO, MARQUEE, WHEEL)`, `Visibility`, `ConnType(LOCAL, SSH, AGENT)`, `SaveKind(SAVE, STATE)`, `JobStatus`, `HackType(HACK, TRANSLATION, IMPROVEMENT, OTHER)`.

Models (key fields):

- **User**: encrypted external credentials (AES-256-GCM: ScreenScraper, RA, TheGamesDB), `permissions` (JSON), `mustChangePassword`. **RefreshToken**, **Invitation** (with permissions), **Setting**.
- **System**: slug, `datName`, extensions, `headerType`, `mediaType` (cart/disc/arcade), `raConsoleId`, `ssSystemId`. 19 systems: nes, fds, snes, gb, gbc, gba, n64, nds, gc, wii, sms, gg, md, psx, ps2, psp, fbneo, lynx, a7800.
- **DatSource**: system, type, name, version, file sha1 (set when the import finishes), `priority`.
- **Game**: title, metadata, `metaSources` (provenance per field), `ssGameId`, `tgdbGameId`, `workId`, `wikidataId`, `groupConfidence` (high/low), `franchiseName`, `createdById`.
- **Rom**: name, regions, languages, revision, flags, `isBios`, `raHash`, `raGameId`, `serial`, `localTitle` (Retool), `description` (arcade), `parentName`, `removedFromSource`, `checkedAt`, `createdById`. **RomPart**: hashes with and without header.
- **RomHack**: type, title, `hackName`, author, own version, language, `baseRomId`, `baseEvidence` (dat, patch, content, header, manual, title), hashes (`sha1` and `headerlessSha1`), `sourceUrl`, `removedFromSource`. **RomPatch**: format, path in `DATA_DIR/patches`, sha1, base, source and target crc.
- **RomPath**: scanned path; `targetSystems`, `isDefaultTarget`, `targetScheme` (system, flat or firmware slug), `readOnly`. **RomFile**: relative path, archive entry, sizes, `mtimeMs`, `quickHash`, hashes, `raHash`, status, links, `uploadedById`, `container`, `discId` ("GALE01/0"), `hackCheckedAt`.
- **Media**: type, source, path, region, language, size.
- **List**, **ListItem** (game, rom, romhack or work; unique `itemKey`), **ListShare**.
- **Console**, **Firmware** (roots and folder/emulator map per system), **Device** (`connType`, path, encrypted SSH, overrides, `tokenHash`, `lastSeenAt`, `syncSaves`).
- **Emulator** (save/state format and extensions), **Save**, **SaveVersion**, **SaveDeviceState** (last synced version per device and sha1 on the device), **SaveConflict**.
- **RaGame**, **RaHash**.
- **Work**, **Franchise**, **WikidataItem**, **WikidataLabel**.
- **GroupingEvidence** (rom or game, key, source, confidence), **GroupingRule** (same/different, manual), **ReviewItem** (conflict, wikidata, hack).
- **SourceState** (ETag, Last-Modified, dates per resource), **ScrapeMiss**, **ScrapeQuota**, **Job** (database queue, `runAfter`), **RomSignature** (content fingerprint for romhacks).

Versioned migrations from the start (`prisma migrate`), not `db push`. Migrations that rename or change columns holding data are edited by hand (for example, copy `isUploadTarget` to `isDefaultTarget` before dropping it).

## 6. Backend: modules

REST API under `/api/v1`, Zod validation, uniform errors. Long jobs go in an own queue in MySQL (`Job` table, in-process executor) that is queried by polling.

### 6.1 Authentication, permissions and security
- 15-minute access JWT + 30-day refresh (rotated on every use). Separate files token (12 h, `scope: files`) valid only in `?token=` for GET of media, list downloads, save versions, roms and romhacks; the access token is not valid in a URL.
- Closed registration: admin creates users or invitations (with role and permissions).
- Permissions: `collection.view`, `lists`, `saves`, `roms.download` (also devices and copies), `roms.upload`, `roms.uploadUnverified`, `scrape.lists`, `scrape.bulk`. Default: view, lists, saves and media of lists. Admin: all. Checked in the API (403) and in the menu.
- Login limit: 5 failures in 15 minutes per IP and per user, in memory.
- CORS closed except `CORS_ORIGINS`. Security headers in Express and nginx (CSP, nosniff, DENY; manual media uses SAMEORIGIN for the viewer).
- The initial admin (and any admin whose password is the one in `.env`) gets `mustChangePassword`: the API only allows `GET/PATCH /users/me` until it is changed (minimum 10 characters, different from the current and the initial one). Changing it invalidates sessions and returns new tokens.

### 6.2 DATs
- Own parser for clrmamepro and XML (including the modern P/C format `id`/`cloneofid`, serials, BIOS, hack `patch`). System detection by DAT name stripping suffixes in parentheses.
- Permanent, idempotent importer: a rom with the same name in the same system is the same even if it comes from another source; only what changes is written; parts are updated by name without being deleted; what disappears is marked `removedFromSource`; new roms are created in batch with a provisional game per title and then the grouping resolver decides. DAT clones generate `dat-clone` evidence.
- Hack DATs: create romhacks with their base rom by name, `hackName` extracted from the title, `baseEvidence: dat`.
- "One zip per set" arcade DATs (like the FBNeo one from libretro-database: description as name and a hash of the whole zip) do not create roms.
- Sources: libretro-database on GitHub (No-Intro, Redump, hacks) and the official FBNeo DAT (`libretro/FBNeo/dats/FinalBurn Neo (ClrMame Pro XML, Arcade only).dat`, with clones). DATs are not deleted.

### 6.3 Scanner
- Walks paths, skips unchanged files (`fileSize` + `mtimeMs`) and reuses hashes of moved large files (`quickHash`, over 64 MB and same date).
- Full CRC32/MD5/SHA1 and headerless (NES, FDS, SNES with 512 spare bytes, Lynx, A7800). Inside zip/7z each entry is hashed; arcade is matched by CRC set.
- CHD: `chdman extractcd/extractdvd` to a temp file and track hash; RVZ/WIA: own reader (6.9) that rebuilds the ISO; CSO/ZSO: full ISO (verifiable); WBFS/CISO: identification by disc id and revision against the Redump serial (`DL-DOL-GALE-USA`), unverified status.
- Matching: verified DAT first; user roms (`USER`) give `UNVERIFIED`; romhacks by sha1 or `headerlessSha1`. `rematchAll` after every import.
- After scanning: romhack identification by content (6.6) and RA game linking.

### 6.4 Collection
- Games with filters (system, status, region, RA, work, saga, doubtful grouping), full game page (roms with labels, romhacks with `label`, media, work and other platforms), missing, files, regions.
- Percentages only with verified roms; unverified ones are counted separately; `USER` roms and hack DATs do not count in totals.
- Labels: region, languages, revision only if the game has several, unverified (with user), removed, serial. `hackLabel`: exact base rom without languages + the hack's own name and version ("Gran Turismo 4 (USA) v1.01 + Spec II v1.10", "Contra (Japan) + T-Eng v1.0 (MadHacker)").
- Manual editing with top priority; merge and split games (they create permanent manual rules); renaming and organizing by firmware scheme (dry-run and apply, keeping container extensions).

### 6.5 Final destination and uploads
- `resolveDestination(system)`: the path whose `targetSystems` includes the system; otherwise the default one; otherwise `DATA_DIR/library` is created and registered. Folder scheme per system, flat or of a firmware.
- Verified upload: the hash must match a DAT, romhack or RetroAchievements (RVZ/CSO/ZSO containers by the rebuilt ISO; WBFS/CISO by disc id). Canonical name keeping the container extension.
- Unverified upload: existing or new game, rom, hack or translation with its data. Creates a `USER` `DatSource` per system; it stays `UNVERIFIED`; it becomes verified if a later DAT brings its checksum.

### 6.6 Romhacks by content
- Fingerprint: CRC32 of 1 KiB blocks of the headerless content, ignoring padding (all 00 or FF) and sampling by content (only CRC multiples of 8). Computed once per rom you have (`RomSignature`) and indexed in memory (CRC → roms).
- Score: fraction of the base's blocks that the file keeps. Above 85% the exact base rom is fixed; between 50% and 85% only the game (for example, a translation of the Japanese version when only the American one is owned); if another base from another game falls within 5 points, review.
- Header code against the DAT serial: GBA (0xAC), NDS (0x0C), N64 big endian (0x3B), Mega Drive (0x180). If a single game has that code, it is linked.
- The file name never links: with hack marks and no evidence, an entry goes to the review queue with candidates and title suggestions. Without marks it is registered as type "other" (it may be an altered dump).
- Romhacks linked by title are re-evaluated; manual decisions are respected.

### 6.7 Patches
- Own IPS (RLE, extension and truncation), BPS (all four actions, signed offsets, overlapping copy, source, target and patch checksums) and UPS.
- When registering a patch: the given base, by the patch's CRC in the DAT or in the files you have (another header). If the base is in the collection the result is computed (with and without header; if the patch was made headerless, the final file keeps it), duplicate romhacks created from files are merged and already patched files are linked.
- Downloading or copying a romhack with no file: it is generated on the fly at its final destination and registered.
- BPS patch created from an already patched romhack and its base (SourceRead/TargetRead encoding), so it can be regenerated and carried in the seed.

### 6.8 RetroAchievements
- Own TypeScript port of the rcheevos algorithm for every supported system (including GameCube, Wii and WAD), validated against the compiled rcheevos CLI (`tools/rahash-cli`, tests only).
- Game and hash list per console with the admin's global key, inside the global sync or forced per system. Hashes are never deleted.

### 6.9 Disc readers
- RVZ/WIA: Dolphin port (Zstandard and uncompressed; PURGE in WIA), including the encryption and the hashes of Wii partitions. Verified with a real Melee (SHA1 `d0a925866379c546ceb739eeb780d011383cb07c`, RA hash `d348b1b58cdf435042ae0773c7d03d1a`).
- WBFS (also split), GameCube CISO, CSO v1/v2 (deflate and LZ4 per maxcso) and ZSO (own block LZ4), with random access and 2 MiB block hashing.
- ISO9660/CUE for PS1/PS2/PSP (reading `SYSTEM.CNF` and executables for the RA hash).

### 6.10 Grouping
- Regions (roms → game): union-find over evidence in order of confidence: manual 100, DAT clones 90, Retool 80, RetroAchievements 60, ScreenScraper 60 (rom list by `jeuInfos` hash), title 10 (only for roms without clone information; in arcade the description is used). `different` rules block unions and generate conflicts in the queue. Groups joined only by title stay `groupConfidence: low`. Games left without roms are merged into the target (romhacks, media, saves, lists).
- Platforms (game → work) with Wikidata: local subset of video games per platform (P400; multilingual labels and aliases, P577, P179, P8345, RA P11393, ScreenScraper P7756). Order: manual rule, exact anchor by RA or ScreenScraper id, unique name on the platform (titles of all roms and Retool locals; normalization that keeps non-Latin scripts; year with ±1 to break ties and ±3 with a single candidate). Several candidates: review queue. Verified platform ids (Lynx `Q753657`, Atari 7800 `Q753600`).
- Sagas: Wikidata (franchise or series) and, if missing, libretro franchise.

### 6.11 Media
- ScreenScraper (primary, by hash): all media types, the rom's region and the user's preference; metadata with priority. TheGamesDB as a fallback only with an exact, unique name match on the platform. libretro-thumbnails without an account. Internet Archive only as a manual suggestion the admin confirms.
- Quotas per credential read from each response; pause at 95% of the daily limit; 429/430/431 pause; "not found" remembered for 6 months; one thread; what is pending is requeued with `runAfter`.
- Non-admin users: only their own account; the admin may use the global ones. Triggered when adding to lists (one pending task per user that accumulates games) and from the game page. What is downloaded is common to everyone and goes in the seed (images in `media/`, manuals and videos in `media-large/`).
- Metadata priority: manual > ScreenScraper > TheGamesDB > libretro > Wikidata; a higher-priority source is never overwritten and values are never deleted.

### 6.12 Lists
- Private, shared or public visibility; collaborative; clone; sort; export and import JSON (also works by `wikidataId`) and text.
- Sublists derived by preferences: ordered regions, languages, RA only, only what you have, strict regions and ordered platform preference for works.
- List files (including unverified and generated romhacks), zip per system or per firmware, copy to a device.

### 6.13 Devices and saves
- Firmwares with templates: Knulli, Batocera, ROCKNIX (saves next to the rom), muOS and Onion (per core), Android ES-DE + RetroArch, desktop RetroArch and ES-DE. Per-device overrides.
- Local connection (mounted SD), SSH/SFTP and AGENT (event scripts).
- Steam Cloud style saves, without clocks: per save and device the last synced version and the sha1 on the device are stored. Only the device changed: it uploads. Only the server changed: it downloads, converted. Both changed: both versions are kept, the device keeps its own and a warning is shown. No version is lost (history of 50 with conflict ones protected).
- Logical save shared between emulators of compatible format (savestates only the same emulator). Conversions: raw `.srm`/`.sav` and PS1 cards (`.mcd`/`.mcr`/`.srm`, DexDrive `.gme`, signed PSP/PS3 `.vmp`). Relocation by the device's rom name.
- Scripts (POSIX sh, busybox/toybox, `curl` or `wget`): ES-DE (`scripts/game-start` and `game-end`) and Batocera/Knulli/ROCKNIX (`/userdata/system/scripts`, `gameStart`/`gameStop`). Protocol: `GET /agent/manifest` (candidate paths), `POST /agent/start` (paths and sha1s present → `get` and `put` orders), `GET /agent/file`, `POST /agent/upload`. Rom and paths in base64 in headers. With no network it does not block: it stores the pending rom and repeats it on the next event with network, without nesting. Per-device token, revocable.
- SD cards mounted on the server: every 15 s it checks whether the folder appears and syncs once. No network polling. No `SAVE_SYNC_CRON`.
- Daijishō: no documented events, manual only.

### 6.14 Global source sync
- One task (`EXTERNAL_SYNC_CRON`, weekly) runs in sequence: libretro (preset DATs, `metadat/` metadata and covers of games you have), Retool (clone lists and metadata; frozen repository), RetroAchievements (one call per console, spaced out) and Wikidata (SPARQL per platform and saga labels). Conditional requests with ETag/Last-Modified stored in `SourceState`.
- At the end, once: re-matching, groupings, works and seed export.
- Forced per source and system from Administration: not if one is running (409) nor if the same was forced less than 10 minutes ago (429). Run history.

### 6.15 Seed
- Exports: DATs with manifest and priority, `ra.json`, `games.json` (identified by the names of their roms, not by id or title), `grouping.json` (Retool, ScreenScraper and manual evidence, rules, "not found"), `wikidata.json`, `removed.json` (roms removed from their DAT), `patches/`, `retool/`, `media/` and `media-large/`.
- Applied on startup (`SEED_ON_START`) without downloading anything; what is already imported is skipped. It re-exports itself after syncing or scraping (`SEED_AUTO_EXPORT`).
- With ScreenScraper content it is for private use only.

## 7. Frontend

Pages (EN/ES): login and registration by invitation; forced password change; home per system (have, unverified, unknown); games; game page (gallery, PDF viewer, video, labels, romhacks with download or generation, patches, editing, split/merge, Wikidata link, media download); works and sagas ("missing on some platform"); missing; romhacks; lists and list (works, pending media, sublists with platforms, zip, send to device); devices (event scripts, revoke token, last contact); saves (history, conversion, conflicts); upload (verified and unverified); profile (own credentials); administration: paths (destinations), files, databases, sync, review, users (permissions), integrations, tasks.

Images and downloads use the files token; the menu and buttons are hidden according to permissions.

## 8. Deployment

- `backend/Containerfile`: Node 22 bookworm-slim with `mame-tools`, `7zip` and `openssl`; `prisma migrate deploy` on startup.
- `frontend/Containerfile`: Vite build served by nginx with `/api` proxy and security headers.
- `compose.yaml`: mysql (local port) and `full` profile with api and web; volumes `./data`, `./seed` and `${ROMS_DIR}` at `/roms`.
- Quadlet: network, MySQL volume and mysql, api and web units; configuration in `~/.config/rommancer/rommancer.env`.

## 9. Decisions and discarded alternatives

1. No dolphin-tool: RVZ with an own reader ported from Dolphin.
2. No RAHasher at runtime: own port of rcheevos, validated in tests against the original.
3. No rcheevos version watcher.
4. npm workspaces instead of pnpm (corepack no longer ships with Node 26).
5. Grouping by title discarded as a criterion: only a doubtful last resort.
6. No-Intro P/C pack discarded: the DAT-o-MATIC download page has a hidden button as a trap against automation; it is not bypassed. Manual upload was tried and it was decided to do without it (Retool + clones + RA + ScreenScraper are enough). No-Intro DATs arrive through libretro-database.
7. FBNeo: official DAT with clones; the libretro-database one (one zip per set) was merged and no longer used.
8. TheGamesDB only with exact, unique name (its API does not search by hash).
9. IGDB stays optional (needs a Twitch key).
10. Subagents: OpenCode's `coding` type was configured with a local model that timed out; do not launch subagents without agreeing the model first.

## 10. Tests

`npm test` (node:test with tsx), 57 tests:

- Unit: patches (IPS/BPS/UPS, generated BPS), disc readers with synthetic images (normal and split WBFS, CISO, CSO, ZSO, LZ4), RVZ (test encoder), RA hash against rcheevos, labels, romhack identification (translation, expansion, padding, ambiguity, headers).
- End to end on `rommancer_test` with the roms in `roms/nes` and `roms/snes` and simulated ScreenScraper, TheGamesDB, GitHub (ETag), Wikidata (SPARQL) and RetroAchievements servers: authentication, forced password change, permissions, login limit, CORS, DATs, scanning, collection, RA, lists, zip, local and SSH devices (`rommancer-test-sshd` container), uploads, scraping with quotas and "not found", saves and conversions, organization, CHD, arcade, RVZ, final destination, unverified and later verification, patches and patched romhacks on disk, grouping by evidence and review, works and sagas with per-platform lists, global sync with ETag and permanence, event-driven saves with the real script (start, close, conflict, offline, revoked token) and mounted SD, and accumulated seed with removed roms.
- Repository seed applied over an empty database with no network.
- The test script waits for queued tasks to finish before closing Prisma, and the device scripts run asynchronously (they share a process with the API).

## 11. Build order

1. Monorepo, Podman (MySQL), Prisma with migrations, configuration and secret validation, job queue.
2. Authentication with permissions, files tokens, invitations, login limit, CORS, headers, forced password change. Frontend layout and i18n.
3. Systems, emulators, firmwares and consoles (initial data). Parser and permanent DAT importer. Games and roms in the frontend.
4. Hashing, incremental scanner, zip/7z, headers, CHD, ISO/CUE. Matching and rematch.
5. RetroAchievements hash (port and tests against rcheevos). RVZ/WIA, WBFS, CISO, CSO, ZSO.
6. Grouping by evidence, manual rules, review queue.
7. Destination paths, verified and unverified uploads.
8. Patches, romhacks by content, on-demand generation, BPS from romhacks.
9. Full lists, zip, local and SSH devices, copies, organization by firmware.
10. Media with quotas, TheGamesDB, metadata with priority.
11. Saves: versioned store, conversions, per-baseline sync core, SSH/SD, event scripts, mounted SD cards.
12. Global source sync (libretro, Retool, RA, Wikidata) and works/sagas.
13. Complete seed (export and apply).
14. Frontend for each block as it is built; deployment (Containerfiles, compose, Quadlet); documentation.

## 12. Pending

- Try the real ScreenScraper and TheGamesDB (developer credentials and key missing).
- Check on the AYN Thor (Android with ES-DE) access to save folders and `curl`/`wget`.
- Full visual review of the frontend in a browser.
- Review in the queue the romhacks linked only by title.
- Optional: IGDB, ScreenScraper families for sagas, header code for more systems, RetroAchievements "~Hack~" games, Daijishō.
