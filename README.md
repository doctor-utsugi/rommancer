<p align="center"><img src="docs/logo.png" alt="Rommancer" width="200" /></p>

# Rommancer

Gestor multiusuario de colecciones de roms: base de datos de juegos y roms a partir de DATs (No-Intro, Redump, FBNeo, hacks), verificación por checksum, agrupación por evidencias (regiones, plataformas y sagas), listas compartibles, copia a dispositivos (SD o SSH), parches de romhacks, multimedia bajo demanda y saves sincronizados al estilo Steam Cloud.

Stack: Node 22 + Express + Prisma + MySQL 8.4 · React + TypeScript + Vite + shadcn/ui · Podman.

## Rommancer Sync

Sincronización de saves entre consolas (Onion, Knulli, Batocera, ROCKNIX, muOS, ArkOS, NextUI, PC): ver [docs/sync.md](docs/sync.md). Almacenamiento en el servidor (carpetas, discos, destinos): [docs/storage.md](docs/storage.md). Configuración de las consolas (RetroAchievements, WiFi, copias): [docs/device-config.md](docs/device-config.md). Listas, favoritos y sublistas: [docs/lists.md](docs/lists.md).

## Estructura

```
backend/            API (Express + Prisma)
  prisma/           esquema y migraciones versionadas
  src/lib/          hashing, hash RetroAchievements (port de rcheevos), lectores RVZ/WBFS/CISO/CSO/ZSO, parches IPS/BPS/UPS, cola de trabajos
  src/modules/      auth, users, dats, scanner, roms, lists, devices, uploads, scrape, ra, saves, grouping, patches, sync, seed
  test/e2e.test.ts  prueba de extremo a extremo de todos los flujos
frontend/           SPA React (i18n ES/EN)
deploy/quadlet/     unidades Quadlet para un servidor Linux con systemd
compose.yaml        mysql (desarrollo) y pila completa (perfil "full")
data/               datos de la app: dats, media, saves, uploads, tmp
seed/               semilla para nuevos despliegues: DATs, hashes RA, metadatos y multimedia
```

## Requisitos

- Node 22 o superior, Podman y podman-compose.
- `chdman` (paquete `rom-tools` en Homebrew, `mame-tools` en Debian) para CHD.
- `7zz` (paquete `sevenzip` en Homebrew, `7zip` en Debian) para zip/7z.

En macOS Podman necesita su máquina virtual: `podman machine init` y `podman machine start`. Al crearla se comparte la carpeta del proyecto con `--volume`.

## Configuración

```bash
cp .env.example .env    # rellenar contraseñas, JWT_SECRET y ENCRYPTION_KEY (openssl rand -hex 32)
npm install
npm run db:up           # MySQL en Podman (puerto 127.0.0.1:3317)
npm run db:migrate -w backend
```

Cambios de esquema: editar `backend/prisma/schema.prisma` y crear la migración con `npm run migration:new -w backend -- <nombre>` (necesita la base `rommancer_shadow` con permisos para el usuario de MySQL). El contenedor de la API aplica las migraciones al arrancar (`prisma migrate deploy`).

`JWT_SECRET` y `ENCRYPTION_KEY` no pueden tener el valor de ejemplo: la API no arranca. El administrador inicial debe cambiar su contraseña en el primer acceso.

Credenciales externas en `.env` (opcionales). Las globales solo las usa el administrador; el resto de usuarios usan las suyas, configuradas en su perfil:

- `SCREENSCRAPER_DEV_ID` / `SCREENSCRAPER_DEV_PASSWORD`: credenciales de desarrollador de ScreenScraper.
- `SCREENSCRAPER_USER` / `SCREENSCRAPER_PASSWORD`: cuenta de usuario de ScreenScraper.
- `RA_USERNAME` / `RA_API_KEY`: Web API Key de RetroAchievements (sincronización global).
- `THEGAMESDB_API_KEY`: respaldo de multimedia (contraportadas, fanart, logos, capturas).
- `EXTERNAL_SYNC_CRON`: sincronización global de fuentes externas (por defecto domingos a las 4:00; vacío = desactivada).
- `CORS_ORIGINS`: orígenes web permitidos (vacío = solo el mismo origen).

Sin ScreenScraper se usan las carátulas de libretro-thumbnails.

## Desarrollo

```bash
npm run dev:api   # http://localhost:3000
npm run dev:web   # http://localhost:5173 (proxy /api -> 3000)
```

El primer arranque crea el usuario administrador definido en `ADMIN_USERNAME` / `ADMIN_PASSWORD`.

## Pruebas

```bash
# Opcional: servidor SFTP de prueba para dispositivos SSH
podman build -t rommancer-test-sshd backend/test/sshd
podman run -d --rm --name rommancer-sshd -p 127.0.0.1:2222:22 rommancer-test-sshd

npm test
```

Validación del hash de RetroAchievements contra la implementación oficial: `make -C tools/rahash-cli` descarga rcheevos y compila un CLI de referencia; `test/rahash.test.ts` compara ambos (se omite si no está compilado).

La prueba usa la base de datos `rommancer_test` (hay que crearla y dar permisos al usuario de MySQL), las roms de `roms/nes` y `roms/snes` y los DATs de `data/dats`. Todos los servicios externos (ScreenScraper, TheGamesDB, GitHub, Wikidata, RetroAchievements) se simulan con un servidor local. Cubre: autenticación e invitaciones, importación de DATs, escaneo con y sin cabecera, romhacks y traducciones, hash RetroAchievements, listas (compartir, colaborar, clonar, sublistas, exportar, importar, zip), dispositivos locales y SSH, subidas validadas por hash, scraping, saves (historial, restauración, conversión .srm/.sav y tarjetas PS1 .mcd/.gme/.vmp, sincronización y reubicación), renombrado y ordenación, CHD de PS1, sets arcade FBNeo, RVZ, permisos, cambio de contraseña obligatorio, límite de login, CORS, destino final, subidas no verificadas, parches, agrupación por evidencias y revisión, obras de Wikidata, sincronización global con ETag, permanencia de datos, cuotas de ScreenScraper, TheGamesDB, saves por eventos con el script real y semilla acumulada.

```sql
CREATE DATABASE rommancer_test; GRANT ALL ON rommancer_test.* TO 'rommancer'@'%';
```

## Pila completa con Podman

```bash
ROMS_DIR=/ruta/a/mis/roms podman-compose --profile full up -d --build
```

Web en http://localhost:8080. Las roms quedan montadas en `/roms` dentro del contenedor: las rutas se registran en Administración como `/roms/...`.

## Servidor Linux con Quadlet

```bash
podman build -t rommancer-api -f backend/Containerfile .
podman build -t rommancer-web -f frontend/Containerfile .
mkdir -p ~/.config/rommancer ~/.config/containers/systemd ~/rommancer/data
cp .env.example ~/.config/rommancer/rommancer.env   # DATABASE_URL=mysql://USUARIO:PASS@mysql:3306/rommancer
cp deploy/quadlet/* ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start rommancer-web
```

Las roms se montan desde `~/roms` (editar `rommancer-api.container` para cambiarlo).

## Semilla de datos

La carpeta `seed/` contiene los DATs de todas las consolas soportadas (No-Intro, Redump, FBNeo y hacks de libretro-database), los hashes de RetroAchievements sincronizados y lo scrapeado (metadatos y multimedia).

- Al arrancar, la API aplica la semilla (`SEED_ON_START=true`): importa los DATs que falten, los hashes RA y rellena metadatos y carátulas de los juegos que no los tengan. Lo ya importado se omite, así que el arranque normal no tarda.
- Tras importar DATs, sincronizar o scrapear, la semilla se actualiza sola (`SEED_AUTO_EXPORT=true`). También se puede exportar o aplicar a mano en Administración > Integraciones.
- Contiene el total acumulado: nada obtenido de fuentes externas se borra aunque desaparezca del origen. Incluye además evidencias de agrupación (Retool, ScreenScraper), decisiones manuales, "no encontrados", el subconjunto local de Wikidata, parches (`seed/patches`), listas de Retool y la multimedia (`seed/media` imágenes, `seed/media-large` manuales y vídeos).
- Con contenido de ScreenScraper la semilla es solo para uso privado: no publicar el repositorio con esos datos.
- En contenedores se monta en `/seed` (`compose.yaml` y Quadlet). Para un despliegue nuevo basta con copiar la carpeta.

## Uso

1. Administración > Bases de datos: los DATs de todas las consolas se cargan desde la semilla. La sincronización global (semanal) comprueba libretro-database, Retool, RetroAchievements y Wikidata y solo descarga lo cambiado; se puede forzar por fuente y por sistema.
2. Administración > Rutas: registrar las carpetas de roms y escanear. Se detecta el sistema por carpeta o extensión. Cada ruta puede ser destino de roms nuevas (subidas, parches) de uno o varios sistemas; si no hay destino se usa la predeterminada o `DATA_DIR/library`.
3. Juegos / Faltantes: ver qué se tiene y qué falta. Añadir juegos, roms o romhacks a listas.
4. Listas: compartir, crear sublistas con alternativas por región, idioma o compatibilidad RetroAchievements, descargar en zip o enviar a un dispositivo.
5. Dispositivos: registrar consola + firmware (plantillas para Knulli, Batocera, ROCKNIX, muOS, ArkOS, NextUI, Onion, Android, RetroArch) y su ruta local o SSH. Los que ejecutan scripts de eventos (ES-DE en Android y Linux, Batocera, Knulli, ROCKNIX) se dan de alta como "agente": Rommancer genera los scripts con un token propio; al iniciar un juego bajan el save adaptado y al cerrarlo lo suben. Si cambian el servidor y el dispositivo a la vez se guardan ambas versiones y se avisa. Las SD montadas en el servidor se sincronizan al conectarse; el resto, a mano.
6. Subir roms: con permiso, las que coinciden por hash con la base de datos o con RetroAchievements; con otro permiso, roms no verificadas (homebrew, hacks, traducciones), que no cuentan en los porcentajes y pasan a verificadas si un DAT posterior las incluye.
7. Permisos por usuario en Administración > Usuarios (también en invitaciones). Por defecto: ver colección, listas, saves y multimedia de sus listas con su propia cuenta.
8. Revisión de agrupaciones: conflictos entre fuentes y enlaces dudosos con Wikidata.

## Limitaciones conocidas

- RVZ/WIA se leen con un port propio del código de Dolphin (`backend/src/lib/rvz.ts`): se reconstruye la ISO original, incluido el cifrado y los hashes de las particiones Wii, sin necesidad de `dolphin-tool`.
- RVZ/WIA: se soportan las compresiones Zstandard y sin comprimir (RVZ) y PURGE (WIA). Los WIA con bzip2/LZMA no se leen.
- WBFS y CISO de GameCube no conservan la imagen original: se identifican por id de disco y revisión y quedan como no verificados. CSO/ZSO sí se verifican contra Redump.
- Daijishō no tiene eventos de juego documentados: sus dispositivos se sincronizan a mano.
- Los savestates no se convierten entre emuladores (solo se sincronizan entre dispositivos con el mismo emulador). Cada uno guarda la versión del core que lo hizo y se avisa si otra consola tiene otra; las capturas solo llegan de RetroArch y NextUI.
- PS3 y Xbox 360 quedan fuera.
