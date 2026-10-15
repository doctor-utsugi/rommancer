<p align="center"><img src="docs/logo.png" alt="Rommancer" width="200" /></p>

# Rommancer

Multi-user ROM collection manager: a database of games and roms built from DATs (No-Intro, Redump, FBNeo, hacks), checksum verification, grouping by evidence (regions, platforms and sagas), shareable lists, copying to devices (SD or SSH), romhack patches, on-demand media and Steam Cloud style synced saves.

Stack: Node 22 + Express + Prisma + MySQL 8.4 · React + TypeScript + Vite + shadcn/ui · Podman.

## Rommancer Sync

Journeys provide independent save/savestate blocks per exact ROM, selected separately on each console.
The initial Android/Linux RetroArch adapter supports cached offline switching; see [Journeys](docs/journeys.md)
for its capability matrix and rollout requirements.

Save syncing between consoles (Onion, Knulli, Batocera, ROCKNIX, muOS, ArkOS, NextUI, PC): see [docs/sync.md](docs/sync.md). Storage on the server (folders, disks, destinations): [docs/storage.md](docs/storage.md). Console configuration (RetroAchievements, WiFi, copies): [docs/device-config.md](docs/device-config.md). Lists, favourites and sublists: [docs/lists.md](docs/lists.md).

## Structure

```
backend/            API (Express + Prisma)
  prisma/           schema and versioned migrations
  src/lib/          hashing, RetroAchievements hash (rcheevos port), RVZ/WBFS/CISO/CSO/ZSO readers, IPS/BPS/UPS patches, job queue
  src/modules/      auth, users, dats, scanner, roms, lists, devices, uploads, scrape, ra, saves, grouping, patches, sync, seed
  test/e2e.test.ts  end-to-end test of every flow
frontend/           React SPA (i18n EN/ES)
deploy/quadlet/     Quadlet units for a Linux server with systemd
compose.yaml        mysql (development) and the full stack ("full" profile)
data/               app data: dats, media, saves, uploads, tmp
seed/               seed for new deployments: DATs, RA hashes, metadata and media
```

## Requirements

- Node 22 or later, Podman and podman-compose.
- `chdman` (package `rom-tools` on Homebrew, `mame-tools` on Debian) for CHD.
- `7zz` (package `sevenzip` on Homebrew, `7zip` on Debian) for zip/7z.

On macOS Podman needs its virtual machine: `podman machine init` and `podman machine start`. Share the project folder with `--volume` when creating it.

## Configuration

```bash
cp .env.example .env    # fill in passwords, JWT_SECRET and ENCRYPTION_KEY (openssl rand -hex 32)
npm install
npm run db:up           # MySQL in Podman (port 127.0.0.1:3317)
npm run db:migrate -w backend
```

Schema changes: edit `backend/prisma/schema.prisma` and create the migration with `npm run migration:new -w backend -- <name>` (it needs the `rommancer_shadow` database, with permissions for the MySQL user). The API container applies migrations on startup (`prisma migrate deploy`).

`JWT_SECRET` and `ENCRYPTION_KEY` must not keep the example value: the API will not start. The initial administrator must change their password on first login.

External credentials in `.env` (optional). The global ones are only used by the administrator; every other user uses their own, set in their profile:

- `SCREENSCRAPER_DEV_ID` / `SCREENSCRAPER_DEV_PASSWORD`: ScreenScraper developer credentials.
- `SCREENSCRAPER_USER` / `SCREENSCRAPER_PASSWORD`: ScreenScraper user account.
- `RA_USERNAME` / `RA_API_KEY`: RetroAchievements Web API Key (global sync).
- `THEGAMESDB_API_KEY`: media fallback (back covers, fanart, logos, screenshots).
- `EXTERNAL_SYNC_CRON`: global sync of external sources (default Sundays at 4:00; empty = disabled).
- `CORS_ORIGINS`: allowed web origins (empty = same origin only).

Without ScreenScraper, covers come from libretro-thumbnails.

## Language

The web app ships in English and Spanish.

- `DEFAULT_LOCALE` (`en` or `es`, default `en`) sets the language the app starts in.
- The administrator chooses the language on first login.
- Every user can switch their own language afterwards.

To add a language:

1. Copy `frontend/src/i18n/locales/en.json` to `frontend/src/i18n/locales/<code>.json` and translate it.
2. Add the language to `frontend/src/i18n/locales.ts`.
3. Add an entry to `LOCALES` in `backend/src/lib/locales.ts`.
4. Run `npm run i18n:check -w frontend`.

## Development

```bash
npm run dev:api   # http://localhost:3000
npm run dev:web   # http://localhost:5173 (proxy /api -> 3000)
```

The first start creates the administrator user defined in `ADMIN_USERNAME` / `ADMIN_PASSWORD`.

## Tests

```bash
# Optional: test SFTP server for SSH devices
podman build -t rommancer-test-sshd backend/test/sshd
podman run -d --rm --name rommancer-sshd -p 127.0.0.1:2222:22 rommancer-test-sshd

npm test
```

RetroAchievements hash validation against the official implementation: `make -C tools/rahash-cli` downloads rcheevos and builds a reference CLI; `test/rahash.test.ts` compares both (skipped if it is not built).

The test uses the `rommancer_test` database (create it and grant permissions to the MySQL user), the roms in `roms/nes` and `roms/snes` and the DATs in `data/dats`. All external services (ScreenScraper, TheGamesDB, GitHub, Wikidata, RetroAchievements) are simulated with a local server. It covers: authentication and invitations, DAT import, scanning with and without header, romhacks and translations, RetroAchievements hash, lists (sharing, collaborating, cloning, sublists, export, import, zip), local and SSH devices, hash-validated uploads, scraping, saves (history, restore, .srm/.sav conversion and PS1 .mcd/.gme/.vmp cards, per-game memory cards (PS1 and GameCube), sync and relocation), renaming and organizing, PS1 CHD, FBNeo arcade sets, RVZ, permissions, forced password change, login limit, CORS, final destination, unverified uploads, patches, grouping by evidence and review, Wikidata works, global sync with ETag, data permanence, ScreenScraper quotas, TheGamesDB, event-driven saves with the real script and accumulated seed.

```sql
CREATE DATABASE rommancer_test; GRANT ALL ON rommancer_test.* TO 'rommancer'@'%';
```

## Full stack with Podman

```bash
ROMS_DIR=/path/to/my/roms podman-compose --profile full up -d --build
```

Web at http://localhost:8080. The roms are mounted at `/roms` inside the container: register paths in Administration as `/roms/...`.

## Linux server with Quadlet

```bash
podman build -t rommancer-api -f backend/Containerfile .
podman build -t rommancer-web -f frontend/Containerfile .
mkdir -p ~/.config/rommancer ~/.config/containers/systemd ~/rommancer/data
cp .env.example ~/.config/rommancer/rommancer.env   # DATABASE_URL=mysql://USER:PASS@mysql:3306/rommancer
cp deploy/quadlet/* ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start rommancer-web
```

The roms are mounted from `~/roms` (edit `rommancer-api.container` to change it).

## Data seed

The `seed/` folder holds the DATs for every supported console (No-Intro, Redump, FBNeo and libretro-database hacks), the synced RetroAchievements hashes and everything scraped (metadata and media).

- On startup the API applies the seed (`SEED_ON_START=true`): it imports the DATs that are missing and the RA hashes, and fills in metadata and covers for games that lack them. Anything already imported is skipped, so a normal start is quick.
- After importing DATs, syncing or scraping, the seed updates itself (`SEED_AUTO_EXPORT=true`). It can also be exported or applied by hand in Administration > Integrations.
- It holds the accumulated total: nothing obtained from external sources is deleted even if it disappears from the origin. It also includes grouping evidence (Retool, ScreenScraper), manual decisions, "not found" entries, the local Wikidata subset, patches (`seed/patches`), Retool lists and the media (`seed/media` images, `seed/media-large` manuals and videos).
- With ScreenScraper content the seed is for private use only: do not publish the repository with that data.
- In containers it is mounted at `/seed` (`compose.yaml` and Quadlet). For a new deployment, just copy the folder.

## Usage

1. Administration > Databases: the DATs for every console are loaded from the seed. The global (weekly) sync checks libretro-database, Retool, RetroAchievements and Wikidata and only downloads what changed; it can be forced per source and per system.
2. Administration > Paths: register the rom folders and scan. The system is detected by folder or extension. Each path can be the destination for new roms (uploads, patches) of one or several systems; with no destination, the default one or `DATA_DIR/library` is used.
3. Games / Missing: see what you have and what you lack. Add games, roms or romhacks to lists.
4. Lists: share, create sublists with alternatives by region, language or RetroAchievements compatibility, download as zip or send to a device.
5. Devices: register console + firmware (templates for Knulli, Batocera, ROCKNIX, muOS, ArkOS, NextUI, Onion, Android, RetroArch) and their local or SSH path. Those that run event scripts (ES-DE on Android and Linux, Batocera, Knulli, ROCKNIX) are registered as "agent": Rommancer generates the scripts with their own token; when a game starts they download the adapted save and when it closes they upload it. If the server and the device both change, both versions are kept and a warning is shown. SD cards mounted on the server sync when they connect; the rest, by hand.
6. Uploading roms: with permission, those that match the database or RetroAchievements by hash; with another permission, unverified roms (homebrew, hacks, translations), which do not count in the percentages and become verified if a later DAT includes them.
7. Per-user permissions in Administration > Users (also in invitations). By default: view the collection, lists, saves and media of their lists with their own account.
8. Grouping review: conflicts between sources and doubtful Wikidata links.

## Known limitations

- RVZ/WIA are read with a port of Dolphin's code (`backend/src/lib/rvz.ts`): the original ISO is rebuilt, including the encryption and the hashes of Wii partitions, without needing `dolphin-tool`.
- RVZ/WIA: Zstandard and uncompressed (RVZ) and PURGE (WIA) compression are supported. WIA files with bzip2/LZMA cannot be read.
- GameCube WBFS and CISO do not keep the original image: they are identified by disc id and revision and stay unverified. CSO/ZSO are verified against Redump.
- Daijishō has no documented game events: its devices sync by hand.
- Memory cards: PS1 and GameCube (Dolphin, GCI folders and `.raw` images); PS2 and PSP will come later. The Android app uploads its PS1 cards but does not write them, because it cannot know whether an emulator is open. Dolphin saves for Android (`.gci` files) do sync both ways, once you give it access to the Dolphin folder from the app menu. Desktop Dolphin's are not searched for yet.
- Savestates are not converted between emulators (they only sync between devices with the same emulator). Each one stores the version of the core that made it, and a warning is shown if another console has a different one; screenshots only come from RetroArch and NextUI.
- PS3 and Xbox 360 are out of scope.
