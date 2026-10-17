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
