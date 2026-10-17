# Development

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

## Setup

The API and the web run on the host with Node; only MySQL runs in Podman.

```bash
npm install
npm run db:up           # MySQL in Podman (port 127.0.0.1:3317), passwords in data/secrets
echo "DATABASE_URL=mysql://rommancer:$(podman unshare cat data/secrets/mysql-password)@127.0.0.1:3317/rommancer" > .env
npm run db:migrate -w backend
```

Schema changes: edit `backend/prisma/schema.prisma` and create the migration with `npm run migration:new -w backend -- <name>` (it needs the `rommancer_shadow` database, with permissions for the MySQL user). The API container applies migrations on startup (`prisma migrate deploy`).

The first visit to the web app runs the installer (the administrator and the server's settings). Every setting of `.env.example` is optional: one set in the environment wins over the installer and Administration > Server, which then shows it and cannot change it.

External credentials. Each user, the administrator included, sets their own in their profile (Connected services). The ScreenScraper developer credentials are in Administration > Server.

Without ScreenScraper, covers come from libretro-thumbnails.

## Running

```bash
npm run dev:api   # http://localhost:3000
npm run dev:web   # http://localhost:5173 (proxy /api -> 3000)
```

The first visit runs the installer, which creates the administrator.

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

## Languages

The web app ships in English and Spanish.

- The installer takes the language it is shown in as the default for new accounts; Administration > Users changes it.
- Every user can switch their own language afterwards.

To add a language:

1. Copy `frontend/src/i18n/locales/en.json` to `frontend/src/i18n/locales/<code>.json` and translate it.
2. Add the language to `frontend/src/i18n/locales.ts`.
3. Add an entry to `LOCALES` in `backend/src/lib/locales.ts`.
4. Run `npm run i18n:check -w frontend`.

## Releases

`deploy/release.sh [VERSION] --publish` packs the source at HEAD with the built Android and desktop apps
(`clients/*/release`, not in git) into `rommancer.tar.gz` and `rommancer.zip`, tags `vVERSION` and publishes a GitHub
release. Without `--publish` it only builds them into `dist-release/`.
