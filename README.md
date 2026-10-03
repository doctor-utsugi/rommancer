# Rommancer

Gestor multiusuario de colecciones de roms: base de datos de juegos y roms a partir de DATs (No-Intro, Redump, FBNeo, hacks), verificación por checksum, listas compartibles, copia a dispositivos (SD o SSH), scraping de carátulas y gestor de saves con historial y conversión.

Stack: Node 22 + Express + Prisma + MySQL 8.4 · React + TypeScript + Vite + shadcn/ui · Podman.

## Estructura

```
backend/            API (Express + Prisma)
  prisma/           esquema de base de datos
  src/lib/          hashing, hash RetroAchievements (port de rcheevos), lector ISO9660/CUE, cola de trabajos
  src/modules/      auth, users, dats, scanner, roms, lists, devices, uploads, scrape, ra, saves
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
npm run db:push -w backend
```

Credenciales externas en `.env` (opcionales, también configurables por usuario en su perfil):

- `SCREENSCRAPER_DEV_ID` / `SCREENSCRAPER_DEV_PASSWORD`: credenciales de desarrollador de ScreenScraper.
- `SCREENSCRAPER_USER` / `SCREENSCRAPER_PASSWORD`: cuenta de usuario de ScreenScraper.
- `RA_USERNAME` / `RA_API_KEY`: Web API Key de RetroAchievements.

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

La prueba usa la base de datos `rommancer_test` (hay que crearla y dar permisos al usuario de MySQL), las roms de `roms/nes` y `roms/snes` y los DATs de `data/dats`. Cubre: autenticación e invitaciones, importación de DATs, escaneo con y sin cabecera, romhacks y traducciones, hash RetroAchievements, listas (compartir, colaborar, clonar, sublistas, exportar, importar, zip), dispositivos locales y SSH, subidas validadas por hash, scraping, saves (historial, restauración, conversión .srm/.sav y tarjetas PS1 .mcd/.gme/.vmp, sincronización y reubicación), renombrado y ordenación, CHD de PS1 y sets arcade FBNeo.

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
- Tras importar DATs, sincronizar RetroAchievements o scrapear, la semilla se actualiza sola (`SEED_AUTO_EXPORT=true`). También se puede exportar o aplicar a mano en Administración > Integraciones.
- En contenedores se monta en `/seed` (`compose.yaml` y Quadlet). Para un despliegue nuevo basta con copiar la carpeta.

## Uso

1. Administración > Bases de datos: los DATs de todas las consolas se cargan desde la semilla. Se pueden reimportar desde libretro-database (botón "Importar DATs de todas las consolas") o subir los oficiales de No-Intro/Redump.
2. Administración > Rutas: registrar las carpetas de roms y escanear. Se detecta el sistema por carpeta o extensión.
3. Juegos / Faltantes: ver qué se tiene y qué falta. Añadir juegos, roms o romhacks a listas.
4. Listas: compartir, crear sublistas con alternativas por región, idioma o compatibilidad RetroAchievements, descargar en zip o enviar a un dispositivo.
5. Dispositivos: registrar consola + firmware (plantillas para Knulli, Batocera, ROCKNIX, muOS, Onion, Android, RetroArch) y su ruta local o SSH. Sincronizar saves manualmente o de forma programada (`SAVE_SYNC_CRON`).
6. Subir roms: cualquier usuario puede aportar roms que coincidan por hash con la base de datos o con RetroAchievements. Se guardan en la ruta marcada como destino de subidas.

## Limitaciones conocidas

- RVZ/WIA se leen con un port propio del código de Dolphin (`backend/src/lib/rvz.ts`): se reconstruye la ISO original, incluido el cifrado y los hashes de las particiones Wii, sin necesidad de `dolphin-tool`.
- RVZ/WIA: se soportan las compresiones Zstandard y sin comprimir (RVZ) y PURGE (WIA). Los WIA con bzip2/LZMA no se leen.
- Los savestates no se convierten entre emuladores (solo se sincronizan entre dispositivos con el mismo emulador).
- PS3 y Xbox 360 quedan fuera.
