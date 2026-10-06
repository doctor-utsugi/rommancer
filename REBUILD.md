# Rommancer - Plan para rehacerlo desde cero

Documento autocontenido: describe qué es Rommancer, todas las decisiones tomadas y por qué, la arquitectura, los algoritmos y el orden de construcción. Con él y `ROMMANCER.md` (especificación original) se puede reconstruir el proyecto sin el código actual. `PLAN.md` y `README.md` complementan con el estado y el uso.

## 1. Objetivo

Gestor multiusuario de colecciones de roms, autoalojado:

- Base de datos de juegos y roms a partir de DATs (No-Intro, Redump, FBNeo, romhacks), verificación por checksum de lo que se tiene y de lo que falta.
- Agrupación de roms en juegos (regiones), de juegos en obras (plataformas) y de obras en sagas, por evidencias, no por título.
- Romhacks y traducciones con su rom base exacta, parches IPS/BPS/UPS, generación bajo demanda.
- Listas compartibles y colaborativas, sublistas con preferencias (región, idioma, RetroAchievements, plataforma), descarga en zip y copia a dispositivos (SD o SSH).
- Multimedia (ScreenScraper, TheGamesDB, libretro-thumbnails) bajo demanda y con la cuenta de cada usuario.
- Saves sincronizados al estilo Steam Cloud entre dispositivos y emuladores, con conversión de formatos e historial.
- Todo lo obtenido de fuentes externas es permanente y viaja en una semilla (`seed/`) para nuevos despliegues.

## 2. Principios y reglas del proyecto

- KISS: la solución más simple que funcione, sin dependencias innecesarias.
- Solo software libre; repositorios y fuentes oficiales. Podman, nunca Docker. Linux/Debian como destino; macOS para desarrollo con máquina de Podman y la carpeta del proyecto compartida como volumen.
- Privacidad: sin telemetría; ningún dato del proyecto sale a Internet salvo las consultas a las fuentes externas.
- Uso responsable de servicios externos (RetroAchievements, ScreenScraper, TheGamesDB, Wikidata, GitHub, DAT-o-MATIC): peticiones condicionales, una por vez, cuotas respetadas, nada se pide dos veces.
- No se automatiza nada que el servicio proteja expresamente contra automatismos (caso DAT-o-MATIC, ver 9.6).
- Datos externos permanentes: nunca se borran por desaparecer del origen; se marcan como retirados.
- El título no es criterio de agrupación fiable: solo último recurso marcado como dudoso o sugerencia.
- Interfaz en español de España e inglés. Código, variables y ficheros en inglés. Comentarios en español, escasos.
- Git solo local. Sin trabajo de licencias por ahora.

## 3. Stack

| Capa | Elección |
|---|---|
| Backend | Node 22+ (26 en desarrollo), TypeScript ESM, Express 5, Zod 4, Prisma 6 (MySQL), jsonwebtoken, bcryptjs, multer, archiver, ssh2, node-cron, fast-xml-parser |
| Base de datos | MySQL 8.4 en contenedor; `System` es palabra reservada (comillas invertidas en SQL crudo) |
| Frontend | React + TypeScript + Vite, shadcn/ui estilo "base-nova" (Base UI: `render` y `nativeButton={false}` para enlaces; selects nativos), TanStack Query, react-router, i18next |
| Binarios externos | Solo `chdman` (CHD) y `7zz` (zip/7z). Nada de dolphin-tool ni RAHasher en ejecución |
| Monorepo | npm workspaces (`backend`, `frontend`); `allowScripts` de npm 11 en el `package.json` raíz |
| Despliegue | `compose.yaml` (mysql en desarrollo; api + web con perfil `full`) y unidades Quadlet para systemd |

Estructura:

```
backend/   prisma/ (schema + migrations), src/{config,lib,modules,seed}, test/
frontend/  src/{components,i18n,lib,pages,pages/admin}, nginx.conf
deploy/quadlet/   unidades systemd (mysql, api, web, red y volumen)
seed/      DATs, ra.json, games.json, grouping.json, wikidata.json, removed.json, patches/, retool/, media/, media-large/
tools/rahash-cli/ CLI de rcheevos solo para pruebas de referencia
data/      datos de ejecución (fuera de git salvo lo que va a seed/)
roms/      roms de prueba del usuario (fuera de git, no se modifican)
```

## 4. Entorno

- MySQL de desarrollo en `127.0.0.1:3317` (el 3307 estaba ocupado). Base de pruebas `rommancer_test` y base sombra `rommancer_shadow` para crear migraciones; el usuario de MySQL necesita permisos `CREATE, DROP` y sobre ambas.
- `.env` (plantilla en `.env.example`): `DATABASE_URL`, `JWT_SECRET` y `ENCRYPTION_KEY` (no puede arrancar con los valores de ejemplo; `openssl rand -hex 32`), `DATA_DIR`, `SEED_DIR`, `SEED_ON_START`, `ADMIN_*`, `CHDMAN_BIN`, `SEVENZIP_BIN`, `SCREENSCRAPER_DEV_ID/DEV_PASSWORD/USER/PASSWORD`, `RA_USERNAME/RA_API_KEY`, `THEGAMESDB_API_KEY`, `EXTERNAL_SYNC_CRON` (por defecto `0 4 * * 0`), `FORCE_SYNC_MIN_MINUTES` (10), `CORS_ORIGINS`. Todas las URLs externas son configurables por variable para poder simularlas en pruebas.
- Desarrollo: `npm run db:up`, `npm run db:migrate -w backend`, `npm run dev:api` (3000) y `npm run dev:web` (5173 con proxy `/api`).

## 5. Modelo de datos

Enums: `Role(ADMIN, USER)`, `DatType(USER, NOINTRO, REDUMP, FBNEO, MAME, HACKS, OTHER)`, `MatchStatus(MATCHED, HACK, UNVERIFIED, UNKNOWN)`, `MediaType(COVER, BOX_BACK, BOX_SIDE, BOX_3D, SUPPORT, SCREENSHOT, TITLE, FLYER, FANART, MANUAL, VIDEO, MARQUEE, WHEEL)`, `Visibility`, `ConnType(LOCAL, SSH, AGENT)`, `SaveKind(SAVE, STATE)`, `JobStatus`, `HackType(HACK, TRANSLATION, IMPROVEMENT, OTHER)`.

Modelos (campos clave):

- **User**: credenciales externas cifradas (AES-256-GCM: ScreenScraper, RA, TheGamesDB), `permissions` (JSON), `mustChangePassword`. **RefreshToken**, **Invitation** (con permisos), **Setting**.
- **System**: slug, `datName`, extensiones, `headerType`, `mediaType` (cart/disc/arcade), `raConsoleId`, `ssSystemId`. 19 sistemas: nes, fds, snes, gb, gbc, gba, n64, nds, gc, wii, sms, gg, md, psx, ps2, psp, fbneo, lynx, a7800.
- **DatSource**: sistema, tipo, nombre, versión, sha1 del fichero (se fija al terminar la importación), `priority`.
- **Game**: título, metadatos, `metaSources` (procedencia por campo), `ssGameId`, `tgdbGameId`, `workId`, `wikidataId`, `groupConfidence` (high/low), `franchiseName`, `createdById`.
- **Rom**: nombre, regiones, idiomas, revisión, flags, `isBios`, `raHash`, `raGameId`, `serial`, `localTitle` (Retool), `description` (arcade), `parentName`, `removedFromSource`, `checkedAt`, `createdById`. **RomPart**: hashes con y sin cabecera.
- **RomHack**: tipo, título, `hackName`, autor, versión propia, idioma, `baseRomId`, `baseEvidence` (dat, patch, content, header, manual, title), hashes (`sha1` y `headerlessSha1`), `sourceUrl`, `removedFromSource`. **RomPatch**: formato, ruta en `DATA_DIR/patches`, sha1, base, crc de origen y destino.
- **RomPath**: ruta escaneada; `targetSystems`, `isDefaultTarget`, `targetScheme` (system, flat o slug de firmware), `readOnly`. **RomFile**: ruta relativa, entrada de archivo, tamaños, `mtimeMs`, `quickHash`, hashes, `raHash`, estado, enlaces, `uploadedById`, `container`, `discId` ("GALE01/0"), `hackCheckedAt`.
- **Media**: tipo, fuente, ruta, región, idioma, tamaño.
- **List**, **ListItem** (juego, rom, romhack u obra; `itemKey` único), **ListShare**.
- **Console**, **Firmware** (raíces y mapa de carpetas/emulador por sistema), **Device** (`connType`, ruta, SSH cifrado, overrides, `tokenHash`, `lastSeenAt`, `syncSaves`).
- **Emulator** (formato y extensiones de save/state), **Save**, **SaveVersion**, **SaveDeviceState** (última versión sincronizada por dispositivo y sha1 en el dispositivo), **SaveConflict**.
- **RaGame**, **RaHash**.
- **Work**, **Franchise**, **WikidataItem**, **WikidataLabel**.
- **GroupingEvidence** (rom o juego, clave, fuente, confianza), **GroupingRule** (same/different, manuales), **ReviewItem** (conflict, wikidata, hack).
- **SourceState** (ETag, Last-Modified, fechas por recurso), **ScrapeMiss**, **ScrapeQuota**, **Job** (cola en base de datos, `runAfter`), **RomSignature** (huella de contenido para romhacks).

Migraciones versionadas desde el principio (`prisma migrate`), no `db push`. Las migraciones que renombran o cambian columnas con datos se editan a mano (por ejemplo, copiar `isUploadTarget` a `isDefaultTarget` antes de borrarla).

## 6. Backend: módulos

API REST bajo `/api/v1`, validación con Zod, errores uniformes. Trabajos largos en una cola propia en MySQL (tabla `Job`, ejecutor en proceso) que se consultan por polling.

### 6.1 Autenticación, permisos y seguridad
- JWT de acceso de 15 minutos + refresh de 30 días (rotación en cada uso). Token de ficheros aparte (12 h, `scope: files`) que solo vale en `?token=` para GET de media, descargas de listas, versiones de saves, roms y romhacks; el token de acceso no vale en URL.
- Registro cerrado: admin crea usuarios o invitaciones (con rol y permisos).
- Permisos: `collection.view`, `lists`, `saves`, `roms.download` (también dispositivos y copias), `roms.upload`, `roms.uploadUnverified`, `scrape.lists`, `scrape.bulk`. Por defecto: ver, listas, saves y multimedia de listas. Admin: todos. Comprobación en la API (403) y en el menú.
- Límite de login: 5 fallos en 15 minutos por IP y por usuario, en memoria.
- CORS cerrado salvo `CORS_ORIGINS`. Cabeceras de seguridad en Express y nginx (CSP, nosniff, DENY; la media de manuales usa SAMEORIGIN para el visor).
- El admin inicial (y cualquier admin cuya contraseña sea la de `.env`) queda con `mustChangePassword`: la API solo permite `GET/PATCH /users/me` hasta cambiarla (mínimo 10 caracteres, distinta de la actual y de la inicial). Al cambiarla se invalidan las sesiones y se devuelven tokens nuevos.

### 6.2 DATs
- Parser propio de clrmamepro y XML (incluido el formato P/C moderno `id`/`cloneofid`, seriales, BIOS, `patch` de hacks). Detección de sistema por nombre del DAT quitando sufijos entre paréntesis.
- Importador permanente e idempotente: una rom con el mismo nombre en el mismo sistema es la misma aunque venga de otra fuente; solo se escribe lo que cambia; las partes se actualizan por nombre sin borrarse; lo que desaparece se marca `removedFromSource`; las roms nuevas se crean en lote con un juego provisional por título y luego decide el resolvedor de agrupaciones. Los clones del DAT generan evidencias `dat-clone`.
- DATs de hacks: crean romhacks con su rom base por nombre, `hackName` extraído del título, `baseEvidence: dat`.
- DATs de arcade de "un zip por set" (como el de FBNeo de libretro-database: descripción como nombre y un hash del zip entero) no crean roms.
- Fuentes: libretro-database en GitHub (No-Intro, Redump, hacks) y el DAT oficial de FBNeo (`libretro/FBNeo/dats/FinalBurn Neo (ClrMame Pro XML, Arcade only).dat`, con clones). Los DATs no se borran.

### 6.3 Escáner
- Recorre rutas, salta ficheros sin cambios (`fileSize` + `mtimeMs`) y reutiliza hashes de ficheros grandes movidos (`quickHash`, más de 64 MB y misma fecha).
- CRC32/MD5/SHA1 completos y sin cabecera (NES, FDS, SNES con 512 bytes sobrantes, Lynx, A7800). Dentro de zip/7z se hashea cada entrada; arcade se empareja por conjunto de CRC.
- CHD: `chdman extractcd/extractdvd` a temporal y hash de pistas; RVZ/WIA: lector propio (6.9) que reconstruye la ISO; CSO/ZSO: ISO completa (verificable); WBFS/CISO: identificación por id de disco y revisión contra el serial de Redump (`DL-DOL-GALE-USA`), estado no verificado.
- Emparejado: DAT verificado primero; las roms de usuario (`USER`) dan `UNVERIFIED`; romhacks por sha1 o `headerlessSha1`. `rematchAll` tras cada importación.
- Tras escanear: identificación de romhacks por contenido (6.6) y enlace de juegos RA.

### 6.4 Colección
- Juegos con filtros (sistema, estado, región, RA, obra, saga, agrupación dudosa), ficha completa (roms con etiquetas, romhacks con `label`, media, obra y otras plataformas), faltantes, ficheros, regiones.
- Porcentajes solo con roms verificadas; las no verificadas se cuentan aparte; las roms `USER` y los DATs de hacks no cuentan en totales.
- Etiquetas: región, idiomas, revisión solo si el juego tiene varias, no verificada (con usuario), retirada, serial. `hackLabel`: rom base exacta sin idiomas + nombre y versión propia del hack ("Gran Turismo 4 (USA) v1.01 + Spec II v1.10", "Contra (Japan) + T-Eng v1.0 (MadHacker)").
- Edición manual con prioridad máxima; unir y separar juegos (crean reglas manuales permanentes); renombrado y organización por esquema de firmware (dry-run y aplicar, conservando extensiones de contenedor).

### 6.5 Destino final y subidas
- `resolveDestination(sistema)`: ruta cuyo `targetSystems` incluye el sistema; si no, la predeterminada; si no, se crea y registra `DATA_DIR/library`. Esquema de carpetas por sistema, plano o de un firmware.
- Subida verificada: el hash debe coincidir con DAT, romhack o RetroAchievements (contenedores RVZ/CSO/ZSO por la ISO reconstruida; WBFS/CISO por id de disco). Nombre canónico conservando la extensión del contenedor.
- Subida no verificada: juego existente o nuevo, rom, hack o traducción con sus datos. Crea un `DatSource` de tipo `USER` por sistema; queda `UNVERIFIED`; pasa a verificada si un DAT posterior trae su checksum.

### 6.6 Romhacks por contenido
- Huella: CRC32 de bloques de 1 KiB del contenido sin cabecera, ignorando relleno (todo 00 o FF) y muestreando por contenido (solo CRC múltiplo de 8). Se calcula una vez por rom que se tiene (`RomSignature`) y se indexa en memoria (CRC → roms).
- Puntuación: fracción de los bloques de la base que conserva el fichero. Por encima del 85 % se fija la rom base exacta; entre el 50 % y el 85 % solo el juego (por ejemplo, traducción de la versión japonesa cuando solo se tiene la americana); si otra base de otro juego queda a menos de 5 puntos, revisión.
- Código de cabecera frente al serial del DAT: GBA (0xAC), NDS (0x0C), N64 big endian (0x3B), Mega Drive (0x180). Si un único juego tiene ese código, se enlaza.
- El nombre del fichero nunca enlaza: con marcas de hack y sin evidencia, entrada en la cola de revisión con candidatas y sugerencias por título. Sin marcas se registra como tipo "otro" (puede ser un volcado alterado).
- Los romhacks enlazados por título se reevalúan; las decisiones manuales se respetan.

### 6.7 Parches
- IPS (RLE, ampliación y truncado), BPS (las cuatro acciones, offsets con signo, copia solapada, checksums de origen, destino y parche) y UPS, propios.
- Al registrar un parche: base indicada, por CRC del parche en el DAT o en los ficheros que se tienen (otra cabecera). Si la base está en la colección se calcula el resultado (con y sin cabecera; si el parche se hizo sin cabecera, el fichero final la conserva), se fusionan los romhacks duplicados creados desde ficheros y se enlazan los ficheros ya parcheados.
- Descarga o copia de un romhack sin fichero: se genera al vuelo en su destino final y queda registrado.
- Parche BPS creado desde un romhack ya parcheado y su base (codificación SourceRead/TargetRead), para poder regenerarlo y llevarlo en la semilla.

### 6.8 RetroAchievements
- Port propio en TypeScript del algoritmo de rcheevos para todos los sistemas soportados (incluidos GameCube, Wii y WAD), validado contra el CLI compilado de rcheevos (`tools/rahash-cli`, solo en pruebas).
- Lista de juegos y hashes por consola con la clave global del admin, dentro de la sincronización global o forzada por sistema. Los hashes nunca se borran.

### 6.9 Lectores de disco
- RVZ/WIA: port de Dolphin (Zstandard y sin comprimir; PURGE en WIA), incluido el cifrado y los hashes de particiones Wii. Verificado con un Melee real (SHA1 `d0a925866379c546ceb739eeb780d011383cb07c`, hash RA `d348b1b58cdf435042ae0773c7d03d1a`).
- WBFS (también partido), CISO de GameCube, CSO v1/v2 (deflate y LZ4 según maxcso) y ZSO (LZ4 de bloque propio), con acceso aleatorio y hash por bloques de 2 MiB.
- ISO9660/CUE para PS1/PS2/PSP (lectura de `SYSTEM.CNF` y ejecutables para el hash RA).

### 6.10 Agrupación
- Regiones (roms → juego): union-find sobre evidencias por orden de confianza: manual 100, clones del DAT 90, Retool 80, RetroAchievements 60, ScreenScraper 60 (lista de roms por hash de `jeuInfos`), título 10 (solo para roms sin información de clones; en arcade se usa la descripción). Las reglas `different` bloquean uniones y generan conflictos en la cola. Los grupos unidos solo por título quedan `groupConfidence: low`. Los juegos que se quedan sin roms se fusionan con el destino (romhacks, media, saves, listas).
- Plataformas (juego → obra) con Wikidata: subconjunto local de videojuegos por plataforma (P400; etiquetas y alias multilingües, P577, P179, P8345, RA P11393, ScreenScraper P7756). Orden: regla manual, ancla exacta por id de RA o ScreenScraper, nombre único en la plataforma (títulos de todas las roms y locales de Retool; normalización que conserva escrituras no latinas; año con ±1 para desempatar y ±3 con un solo candidato). Varios candidatos: cola de revisión. Ids de plataforma verificados (Lynx `Q753657`, Atari 7800 `Q753600`).
- Sagas: Wikidata (franquicia o serie) y, si falta, franquicia de libretro.

### 6.11 Multimedia
- ScreenScraper (principal, por hash): todos los tipos de media, región de la rom y preferencia del usuario; metadatos con prioridad. TheGamesDB como respaldo solo con coincidencia exacta y única del nombre en la plataforma. libretro-thumbnails sin cuenta. Internet Archive solo como sugerencia de manual que confirma el admin.
- Cuotas por credencial leídas de cada respuesta; pausa al 95 % del límite diario; 429/430/431 pausan; "no encontrado" recordado 6 meses; un hilo; lo pendiente se reencola con `runAfter`.
- Usuarios no admin: solo su propia cuenta; el admin puede usar las globales. Se dispara al añadir a listas (una tarea pendiente por usuario que acumula juegos) y desde la ficha. Lo descargado es común a todos y entra en la semilla (imágenes en `media/`, manuales y vídeos en `media-large/`).
- Prioridad de metadatos: manual > ScreenScraper > TheGamesDB > libretro > Wikidata; nunca se pisa a una fuente de mayor prioridad ni se borran valores.

### 6.12 Listas
- Visibilidad privada, compartida o pública; colaborativas; clonar; ordenar; exportar e importar JSON (también obras por `wikidataId`) y texto.
- Sublistas derivadas por preferencias: regiones ordenadas, idiomas, solo RA, solo lo que se tiene, regiones estrictas y preferencia ordenada de plataforma para obras.
- Ficheros de la lista (incluye no verificadas y romhacks generados), zip por sistema o por firmware, copia a dispositivo.

### 6.13 Dispositivos y saves
- Firmwares con plantillas: Knulli, Batocera, ROCKNIX (saves junto a la rom), muOS y Onion (por core), Android ES-DE + RetroArch, RetroArch y ES-DE de escritorio. Overrides por dispositivo.
- Conexión local (SD montada), SSH/SFTP y AGENT (scripts de eventos).
- Saves estilo Steam Cloud, sin relojes: por save y dispositivo se guarda la última versión sincronizada y el sha1 en el dispositivo. Solo cambió el dispositivo: sube. Solo cambió el servidor: baja convertido. Cambiaron ambos: se guardan las dos versiones, el dispositivo conserva la suya y se avisa. Ninguna versión se pierde (historial de 50 con las de conflicto protegidas).
- Save lógico compartido entre emuladores de formato compatible (savestates solo mismo emulador). Conversiones: `.srm`/`.sav` crudos y tarjetas PS1 (`.mcd`/`.mcr`/`.srm`, `.gme` DexDrive, `.vmp` PSP/PS3 con firma). Reubicación por nombre de rom del dispositivo.
- Scripts (POSIX sh, busybox/toybox, `curl` o `wget`): ES-DE (`scripts/game-start` y `game-end`) y Batocera/Knulli/ROCKNIX (`/userdata/system/scripts`, `gameStart`/`gameStop`). Protocolo: `GET /agent/manifest` (rutas candidatas), `POST /agent/start` (rutas y sha1 presentes → órdenes `get` y `put`), `GET /agent/file`, `POST /agent/upload`. Rom y rutas en base64 en cabeceras. Sin red no bloquea: guarda la rom pendiente y la repite en el siguiente evento con red, sin anidar. Token por dispositivo, revocable.
- SD montadas en el servidor: se comprueba cada 15 s si aparece la carpeta y se sincroniza una vez. Sin sondeos por red. Sin `SAVE_SYNC_CRON`.
- Daijishō: sin eventos documentados, solo manual.

### 6.14 Sincronización global de fuentes
- Una tarea (`EXTERNAL_SYNC_CRON`, semanal) recorre en secuencia: libretro (DATs de los preajustes, metadatos de `metadat/` y carátulas de juegos que se tienen), Retool (listas de clones y metadatos; repositorio congelado), RetroAchievements (una llamada por consola, espaciadas) y Wikidata (SPARQL por plataforma y etiquetas de sagas). Peticiones condicionales con ETag/Last-Modified guardados en `SourceState`.
- Al final, una sola vez: re-emparejado, agrupaciones, obras y exportación de la semilla.
- Forzado por fuente y sistema desde Administración: no si hay una en curso (409) ni si se forzó lo mismo hace menos de 10 minutos (429). Historial de ejecuciones.

### 6.15 Semilla
- Exporta: DATs con manifiesto y prioridad, `ra.json`, `games.json` (identificados por los nombres de sus roms, no por id ni título), `grouping.json` (evidencias de Retool, ScreenScraper y manuales, reglas, "no encontrados"), `wikidata.json`, `removed.json` (roms retiradas de su DAT), `patches/`, `retool/`, `media/` y `media-large/`.
- Se aplica al arrancar (`SEED_ON_START`) sin descargar nada; lo ya importado se omite. Se reexporta sola tras sincronizar o scrapear (`SEED_AUTO_EXPORT`).
- Con contenido de ScreenScraper es solo para uso privado.

## 7. Frontend

Páginas (ES/EN): login y registro por invitación; cambio obligatorio de contraseña; inicio por sistema (tengo, no verificadas, desconocidas); juegos; ficha de juego (galería, visor de PDF, vídeo, etiquetas, romhacks con descarga o generación, parches, edición, separar/unir, enlace con Wikidata, descarga de multimedia); obras y sagas ("me falta en alguna plataforma"); faltantes; romhacks; listas y lista (obras, multimedia pendiente, sublistas con plataformas, zip, envío a dispositivo); dispositivos (scripts de eventos, revocar token, último contacto); saves (historial, conversión, conflictos); subir (verificada y no verificada); perfil (credenciales propias); administración: rutas (destinos), ficheros, bases de datos, sincronización, revisión, usuarios (permisos), integraciones, tareas.

Las imágenes y descargas usan el token de ficheros; el menú y los botones se ocultan según permisos.

## 8. Despliegue

- `backend/Containerfile`: Node 22 bookworm-slim con `mame-tools`, `7zip` y `openssl`; `prisma migrate deploy` al arrancar.
- `frontend/Containerfile`: build de Vite servido por nginx con proxy `/api` y cabeceras de seguridad.
- `compose.yaml`: mysql (puerto local) y perfil `full` con api y web; volúmenes `./data`, `./seed` y `${ROMS_DIR}` en `/roms`.
- Quadlet: red, volumen de MySQL y unidades de mysql, api y web; configuración en `~/.config/rommancer/rommancer.env`.

## 9. Decisiones y alternativas descartadas

1. Sin dolphin-tool: RVZ con lector propio portado de Dolphin.
2. Sin RAHasher en ejecución: port propio de rcheevos, validado en pruebas contra el original.
3. Sin vigilante de versiones de rcheevos.
4. npm workspaces en vez de pnpm (corepack ya no viene con Node 26).
5. Agrupación por título descartada como criterio: solo último recurso dudoso.
6. Paquete P/C de No-Intro descartado: la página de descarga de DAT-o-MATIC tiene un botón oculto como trampa contra automatismos; no se esquiva. Se probó la subida manual y se eligió prescindir de él (Retool + clones + RA + ScreenScraper bastan). Los DATs de No-Intro llegan por libretro-database.
7. FBNeo: DAT oficial con clones; el de libretro-database (un zip por set) se fusionó y dejó de usarse.
8. TheGamesDB solo con nombre exacto y único (su API no busca por hash).
9. IGDB queda opcional (requiere clave de Twitch).
10. Subagentes: el tipo `coding` de OpenCode estaba configurado con un modelo local que agotaba el tiempo; no lanzar subagentes sin acordar antes el modelo.

## 10. Pruebas

`npm test` (node:test con tsx), 57 pruebas:

- Unitarias: parches (IPS/BPS/UPS, BPS generado), lectores de disco con imágenes sintéticas (WBFS normal y partido, CISO, CSO, ZSO, LZ4), RVZ (codificador de prueba), hash RA frente a rcheevos, etiquetas, identificación de romhacks (traducción, ampliación, relleno, ambigüedad, cabeceras).
- Extremo a extremo sobre `rommancer_test` con las roms de `roms/nes` y `roms/snes` y servidores simulados de ScreenScraper, TheGamesDB, GitHub (ETag), Wikidata (SPARQL) y RetroAchievements: autenticación, cambio de contraseña obligatorio, permisos, límite de login, CORS, DATs, escaneo, colección, RA, listas, zip, dispositivos local y SSH (contenedor `rommancer-test-sshd`), subidas, scraping con cuotas y "no encontrado", saves y conversiones, organización, CHD, arcade, RVZ, destino final, no verificadas y verificación posterior, parches y romhacks parcheados en disco, agrupación por evidencias y revisión, obras y sagas con listas por plataforma, sincronización global con ETag y permanencia, saves por eventos con el script real (inicio, cierre, conflicto, sin red, token revocado) y SD montada, y semilla acumulada con roms retiradas.
- Semilla del repositorio aplicada sobre base vacía sin red.
- El script de pruebas espera a que terminen las tareas en cola antes de cerrar Prisma, y los scripts de dispositivo se ejecutan de forma asíncrona (comparten proceso con la API).

## 11. Orden de construcción

1. Monorepo, Podman (MySQL), Prisma con migraciones, configuración y validación de secretos, cola de trabajos.
2. Autenticación con permisos, tokens de ficheros, invitaciones, límite de login, CORS, cabeceras, cambio obligatorio de contraseña. Layout del frontend e i18n.
3. Sistemas, emuladores, firmwares y consolas (datos iniciales). Parser e importador permanente de DATs. Juegos y roms en el frontend.
4. Hashing, escáner incremental, zip/7z, cabeceras, CHD, ISO/CUE. Emparejado y rematch.
5. Hash RetroAchievements (port y pruebas contra rcheevos). RVZ/WIA, WBFS, CISO, CSO, ZSO.
6. Agrupación por evidencias, reglas manuales, cola de revisión.
7. Rutas destino, subidas verificadas y no verificadas.
8. Parches, romhacks por contenido, generación bajo demanda, BPS desde romhacks.
9. Listas completas, zip, dispositivos local y SSH, copias, organización por firmware.
10. Multimedia con cuotas, TheGamesDB, metadatos con prioridad.
11. Saves: almacén versionado, conversiones, núcleo de sincronización por base, SSH/SD, scripts de eventos, SD montadas.
12. Sincronización global de fuentes (libretro, Retool, RA, Wikidata) y obras/sagas.
13. Semilla completa (exportar y aplicar).
14. Frontend de cada bloque a medida que se construye; despliegue (Containerfiles, compose, Quadlet); documentación.

## 12. Pendiente

- Probar ScreenScraper y TheGamesDB reales (faltan credenciales de desarrollador y clave).
- Comprobar en la AYN Thor (Android con ES-DE) el acceso a carpetas de saves y `curl`/`wget`.
- Revisión visual completa del frontend en navegador.
- Revisar en la cola los romhacks enlazados solo por título.
- Opcional: IGDB, familias de ScreenScraper para sagas, código de cabecera de más sistemas, juegos "~Hack~" de RetroAchievements, Daijishō.
