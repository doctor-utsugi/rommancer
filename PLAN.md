# Rommancer - Plan de implementacion

Fase 1 (abajo) y fase 2 (seccion final). Las decisiones de la fase 2 sustituyen a las de la fase 1 cuando se contradicen.

Gestor multiusuario de roms, listas, dispositivos y saves. Fuente: `/Users/Shared/Proyects/wanda/rommancer/ROMMANCER.md` mas decisiones tomadas en conversacion.

## Decisiones cerradas

| Tema | Decision |
|---|---|
| Stack | Node 22 + TypeScript, Express, Prisma, MySQL 8. React + TypeScript + Vite + shadcn/ui + Tailwind. Podman (no Docker). |
| Repo | Monorepo: `/backend`, `/frontend`, `/compose.yaml`, `/data` (volumen app). pnpm workspaces. |
| Despliegue | 3 contenedores: `mysql`, `api`, `web` (nginx sirve build React y proxy `/api`). Un volumen `/data` (media, saves, uploads, dats). Paths de roms del usuario como bind mounts. Desarrollo: solo mysql en Podman, node local. |
| Fuentes DAT | No-Intro y Redump (XML .dat subidos por admin), FBNeo (DAT de GitHub), RetroAchievements (API), romhacks (romhacking.net / rhdn archive). |
| Sistemas fase 1 | NES, SNES, GB, GBC, GBA, N64, NDS, Master System, Game Gear, Mega Drive, PS1, PS2, PSP, GameCube, Wii (ISO/RVZ), Arcade (FBNeo). PS3/360 fuera. |
| Hash | CRC32 + MD5 + SHA1 del fichero completo y, para NES/FDS/SNES/Lynx/A7800, tambien sin cabecera. Dentro de .zip/.7z se hashea cada fichero interno. CHD: SHA1 del header para single-track (DVD); para CD multi-track extraer con `chdman extractcd` a tmp y hashear pistas, con cache por (path, mtime, size). RVZ: verificacion via `dolphin-tool verify`. |
| RetroAchievements | Compilar `RAHasher` de rcheevos con soporte CHD en la imagen `api`; se invoca como subproceso por rom. Resultado cacheado en `RomFile.raHash`. |
| Roms | Varios paths escaneados tal cual, sin mover. Renombrar/ordenar es accion explicita. Un path marcado como destino de subidas. |
| Renombrado | Nombre canonico No-Intro/Redump. Esquema de carpetas configurable por firmware al exportar a dispositivo. |
| Scraping | ScreenScraper.fr por API (por hash) con cola y limites; libretro-thumbnails como fallback. Credenciales por usuario con fallback a globales. |
| Auth | JWT (access + refresh) local, roles `ADMIN` / `USER`. Registro cerrado: admin crea usuarios o invitaciones. |
| Subidas | Hash en cliente (Web Crypto, SHA1/MD5 en worker), consulta `/api/roms/match` antes de subir; servidor rehashea y guarda en path destino con nombre canonico. |
| Listas | Niveles privada / compartida / publica. Colaborativas. Clonar. Exportar/importar JSON. Sublistas derivadas por filtro (region, RA compatible). |
| Dispositivos | Tablas `Console`, `Firmware` (plantilla de rutas y nombres de carpeta por sistema), `Device` = consola + firmware + conexion (path local o SSH). Seeds para muOS, Knulli, Rocknix, Batocera, ES-DE, Android RetroArch, Windows RetroArch. |
| Saves | Historial versionado por (usuario, juego, emulador/core). Push/pull manual (el cron se sustituye en la fase 2 por eventos). Conflictos: ver fase 2. Conversion: .srm <-> .sav (GBA/SNES/MD), memory cards PS1 (.mcr/.mcd/.srm/.gme/.vmp), reubicacion por nombre de rom. |
| Transferencia | Path montado, SSH/SFTP (ssh2), descarga zip desde navegador (stream). |
| i18n | ES + EN con i18next desde el inicio. |

## Modelo de datos (Prisma)

```
User(id, username, email, passwordHash, role, locale, ssUser?, ssPassword?, raApiKey?, createdAt)
Invitation(id, token, createdBy, usedBy?, expiresAt)

System(id, slug, name, manufacturer, generation, extensions[], headerSize?, raConsoleId?)
DatSource(id, type[NOINTRO|REDUMP|FBNEO|RA|ROMHACK], systemId, name, version, importedAt, fileHash)

Game(id, systemId, title, titleNormalized, releaseYear?, developer?, publisher?, genre?, description?, igdbId?, ssId?)
Rom(id, gameId, datSourceId, name, region[], languages[], version?, revision?, isVerified, isProto, isBeta, isHack, parentRomId?, raHash?, raGameId?)
RomPart(id, romId, name, size, crc32, md5, sha1, headerlessCrc32?, headerlessMd5?, headerlessSha1?)  -- multi-pista y sets arcade
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

Prisma usa MySQL; los arrays se guardan como JSON.

## Backend (`/backend`)

```
src/
  app.ts, server.ts
  config/env.ts
  lib/prisma.ts, lib/logger.ts (pino), lib/queue.ts (BullMQ? no: cola simple en MySQL + worker en proceso, KISS)
  modules/
    auth/        login, refresh, invitations, middleware roles
    users/
    systems/
    dats/        parsers XML (fast-xml-parser) No-Intro, Redump, FBNeo; importador idempotente; normalizacion de titulo -> Game
    ra/          cliente API RA, RAHasher subprocess, mapping raHash -> Rom
    romhacks/    importador rhdn, asociacion por nombre/base
    scanner/     walk de paths, hashing streaming (crc32 via zlib, md5/sha1 via crypto), yauzl + 7z (node-7z sobre binario 7zz), cabeceras, chdman, dolphin-tool; emparejado contra RomPart
    roms/        consulta coleccion, faltantes, rename/organize (dry-run + apply), match por hash
    uploads/     multer streaming, verificacion hash, colocacion
    scrape/      ScreenScraper client (rate limit, por hash), libretro-thumbnails fallback, almacenamiento /data/media
    lists/       CRUD, share, clone, derived (filtros region/RA/version), export/import JSON, descarga zip (archiver stream)
    devices/     consolas, firmwares (seeds), dispositivos, test de conexion SSH
    transfer/    copia lista -> dispositivo via fs o sftp, mapeo de carpetas por firmware, renombrado al vuelo
    saves/       subida, historial, push/pull, cron (node-cron), converters/ (srm-sav, ps1-memcard), relocate
  jobs/          worker en proceso con tabla Job generica
```

API REST bajo `/api/v1`, validacion con zod, errores uniformes. Trabajos largos (scan, scrape, transfer, sync) devuelven jobId y se consultan por polling o SSE (`/api/v1/jobs/:id/events`).

Imagen `api` (Containerfile): node:22-bookworm-slim + chdman (paquete `mame-tools`), 7zip (`7zip`), dolphin-tool (build o paquete), RAHasher compilado desde rcheevos con `HAVE_CHD=1`.

## Frontend (`/frontend`)

Vite + React 18 + TS, shadcn/ui, TanStack Query, TanStack Table, react-router, react-hook-form + zod, i18next.

Paginas:
- Login / invitacion
- Dashboard: resumen por sistema (tengo / faltan / verificadas)
- Sistemas y juegos: tabla con filtro, ficha de juego con roms, romhacks, media, estado RA
- Coleccion: paths, lanzar escaneo, resultados, desconocidos, renombrar/ordenar (vista dry-run)
- Subir roms: hash en worker, pre-consulta, barra de progreso
- Listas: mias, compartidas, publicas; editor; sublista derivada; exportar; enviar a dispositivo; descargar zip
- Dispositivos: alta con consola/firmware, prueba de conexion, overrides
- Saves: por juego, historial, restaurar, push/pull a dispositivo, conversion
- Admin: usuarios, invitaciones, importar DATs, credenciales globales, jobs

## Fases

1. Esqueleto: monorepo, compose, Prisma schema, auth, usuarios, i18n, layout shadcn.
2. Sistemas + importador DAT (No-Intro, Redump, FBNeo) + Game/Rom/RomPart + UI de juegos.
3. Escaner: paths, hashing (plano, zip/7z, cabeceras), emparejado, faltantes, UI coleccion.
4. CHD y RVZ, RAHasher, mapeo RA.
5. Listas completas (visibilidad, colaborativas, clonar, derivadas, export/import, zip).
6. Dispositivos, firmwares con seeds, transfer local y SSH, renombrado por firmware.
7. Subidas de usuarios con validacion por hash.
8. Scraping ScreenScraper + libretro-thumbnails.
9. Saves: almacen versionado, push/pull, cron, conversores, reubicacion.
10. Romhacks.
11. Rename/organize de la coleccion local.

## Riesgos y notas

- ScreenScraper limita hilos y peticiones por cuenta; usar cola secuencial por usuario.
- Extraer CHD de CD para verificar es lento; se hace una vez y se cachea por mtime/size.
- Arcade: el hash es por fichero interno del zip; el emparejado es por conjunto, no por fichero. `RomFile` apunta al zip y `RomPart` a cada rom interna.
- Credenciales SSH y claves de API se cifran en reposo (AES-256-GCM con clave en env).
- Nada sale a Internet salvo ScreenScraper, RA, GitHub (thumbnails, FBNeo DAT) y rhdn, siempre a peticion del usuario.

## Estado de la implementacion

Implementadas las 11 fases. Cambios respecto al plan inicial:

- npm workspaces en lugar de pnpm (corepack ya no viene con Node 26).
- RAHasher no se compila: el algoritmo de rcheevos esta portado a TypeScript (`backend/src/lib/rahash.ts`), CHD via `chdman extractcd/extractdvd`.
- MySQL en el puerto 3317 del host (el 3307 estaba ocupado).
- Despliegue en Linux con Quadlet (`deploy/quadlet/`) ademas de `compose.yaml`.
- DATs de No-Intro/Redump obtenidos de libretro-database (copia publica en GitHub); se pueden subir los oficiales.
- Hash RA de todos los sistemas (incluido Wii) validado contra rcheevos compilado (tools/rahash-cli).
- RVZ/WIA: lector propio portado de Dolphin (sin dolphin-tool), reconstruye la ISO para verificar contra Redump.
- Semilla `seed/` con DATs de todas las consolas, RA y scraping; se aplica al arrancar y se actualiza automaticamente.

## Fase 2

Implementada. Decisiones y estado:

| Tema | Decision |
|---|---|
| Git y esquema | Repositorio git local (seed/ incluido). Prisma con migraciones versionadas (`prisma/migrations`), `migrate deploy` en el contenedor; `npm run migration:new -w backend -- nombre` para nuevas. |
| Permisos | Por usuario y en invitaciones: ver coleccion, listas, saves, descargar roms (y dispositivos), subir verificadas, subir no verificadas, multimedia de sus listas, scraping masivo. Por defecto: ver, listas, saves y multimedia de listas. Admin: todo. |
| Seguridad | Limite de login (5 fallos / 15 min por IP y usuario), CORS cerrado (`CORS_ORIGINS`), cabeceras en Express y nginx, no arranca con secretos de ejemplo, tokens de 15 min, token de ficheros aparte para URLs, cambio obligatorio de la contrasena inicial. |
| Destino de roms nuevas | Rutas destino por sistema con esquema de carpetas; si no, predeterminada; si no, `DATA_DIR/library`. Para subidas, parches generados y contenedores verificados. |
| Subidas no verificadas | Estado `UNVERIFIED`, con usuario que la subio; no cuentan en porcentajes; pasan a verificadas si un DAT posterior las incluye. WBFS/CISO quedan asi (se identifican por id de disco). |
| Discos | Lectores propios WBFS (tambien partido), CISO, CSO v1/v2 y ZSO (LZ4 propio). |
| Parches | IPS/BPS/UPS propios con checksums. Generacion bajo demanda en el destino final. Hash con y sin cabecera. Fusion de romhacks duplicados. Parche BPS creado desde un romhack ya parcheado y su base. |
| Romhacks | Identificados por contenido (parecido por bloques de 1 KiB con las roms que se tienen; >= 85 % fija la rom base exacta, >= 50 % solo el juego), codigo de cabecera (GBA, NDS, N64, MD) o parche. El nombre solo genera sugerencias en la cola de revision. |
| Etiquetas | Region, idiomas, version solo si hay varias, no verificada, retirada, serial; romhack con rom base exacta y version propia ("Gran Turismo 4 (USA) v1.01 + Spec II v1.10"). |
| Agrupacion | Evidencias + union-find: reglas manuales, clones del DAT (FBNeo oficial), Retool, RetroAchievements, ScreenScraper (por hash). Titulo como ultimo recurso marcado como dudoso. Sin paquete P/C de No-Intro (descarga protegida contra automatismos; decision del usuario). |
| Obras y sagas | Wikidata (CC0): anclas por ids de RA/ScreenScraper, nombre unico en la plataforma, cola de revision si hay varios candidatos. Saga de Wikidata o libretro. Listas con obras y preferencia de plataforma. |
| Datos permanentes | Nada externo se borra: roms y romhacks retirados se marcan; `seed/removed.json` los conserva para despliegues nuevos. Prioridad de metadatos: manual > ScreenScraper > TheGamesDB > libretro. |
| Sincronizacion global | `EXTERNAL_SYNC_CRON` semanal: libretro (DATs, metadatos, caratulas de lo que se tiene), Retool, RetroAchievements, Wikidata, en secuencia y con peticiones condicionales. Forzado por fuente y sistema con intervalo minimo. |
| FBNeo | DAT oficial (libretro/FBNeo, "Arcade only", con clones). El de libretro-database (un zip por set) no crea roms. |
| Multimedia | Bajo demanda al anadir a listas y desde la ficha; solo con la cuenta propia del usuario (el admin puede usar las globales). Cuotas de ScreenScraper respetadas y reanudacion al dia siguiente; "no encontrado" recordado 6 meses; TheGamesDB como respaldo por nombre exacto y unico; Internet Archive solo como sugerencia. |
| Saves | Estilo Steam Cloud: base por dispositivo, sin relojes; conflicto si cambian ambos lados (se guardan las dos versiones). Scripts de eventos para ES-DE y Batocera/Knulli/ROCKNIX con token por dispositivo y reintento sin red. SD montadas en el servidor: sincronizacion al conectarse. Sin `SAVE_SYNC_CRON`. |

Pendiente:
- Probar ScreenScraper y TheGamesDB reales (faltan credenciales de desarrollador y clave en `.env`).
- Comprobar en la AYN Thor (Android) acceso a carpetas de saves y `curl`/`wget`.
- Daijisho (sin eventos documentados): solo sincronizacion manual.
- Opcional: IGDB para obras que Wikidata no tenga; familias de ScreenScraper para sagas; codigo de cabecera de mas sistemas; juegos "~Hack~" de RetroAchievements.
