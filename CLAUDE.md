# Rules for working on Rommancer

## The two installers stay in step

Rommancer installs from the web app (`frontend/src/pages/setup.tsx`) or from the console (`deploy/install.sh`, also
`deploy/podman/rommancer.sh install|setup`). Both drive the same API (`GET /api/v1/setup`, `POST /setup/database`,
`POST /setup/admin`) and must offer the same thing:

- the same steps, in the same order;
- every field the API takes (`databaseBody` in `backend/src/installer.ts`, `adminBody` in
  `backend/src/modules/setup/routes.ts`), with the same defaults and the same checks before sending;
- the same choices (database modes, languages) and the same texts in every language;
- in the console, also an option for every field (`--db`, `--admin`…), so an install can run unattended.

A change to one installer or to the setup API goes to the other in the same commit. `backend/test/installer-parity.test.ts`
fails when they drift; run it after touching any of these files, and extend it when a new kind of option appears.

## Nothing an update does may break

People update Rommancer from Administration > Update (or `rommancer.sh update`), and an update that fails goes back to
the previous version by itself. Consoles may run clients older or newer than the server. So:

- **Migrations only add** (`backend/prisma/migration-rules.ts`): new tables, nullable or defaulted columns, wider types.
  Removing or renaming takes two releases, the second marked `-- rommancer: contract <why>`. New migrations are named
  `m041_name`, `m042_name`… (`npm run migration:new -w backend -- name` does it). `backend/test/migrations.test.ts`
  checks both; `backend/test/upgrade.test.ts` migrates a 1.97 database with data.
- **The API only grows.** No route is removed or renamed (`backend/test/api-surface.test.ts`; new routes go into
  `backend/test/fixtures/api-routes.txt` with `UPDATE_API_SNAPSHOT=1`), and no field changes meaning.
- **Clients check before using something new.** A route or field a client needs from a newer server gets a name in
  `FEATURES` (`backend/src/lib/version.ts`); the Android and desktop apps read `GET /api/v1/version` (`ServerInfo.kt`,
  `update::server_info`) and leave the feature out when the server lacks it.
- **Every release has a `CHANGELOG.md` entry** (`## VERSION (DATE)`), written for the people who use Rommancer.
  `deploy/release.sh` refuses to publish without it, and the update page shows it.
