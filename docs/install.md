# Installing

The [README](../README.md) covers the usual install: a release and `deploy/podman/rommancer.sh install`. This page
has the other ways and the details.

## What the installer asks

- **Your roms folder** (`rommancer.sh install` only): mounted at `/roms`, remembered in
  `~/.config/rommancer/deploy.conf`. What is in it is read as it is, never moved or renamed.
- **The database**: Rommancer's own MySQL (recommended, its passwords are generated) or a MySQL 8 / MariaDB of yours.
- **Your account**: the first administrator.

Everything else (public address, sync schedule, data seed, ScreenScraper developer keys) has a default and is in
Administration > Server. The secrets are generated into `data/secrets` on the first start: keep that folder in your
backups, it holds the key the stored credentials are encrypted with.

The installer is the same in the web app and in the console (`deploy/install.sh URL`, boxes with `whiptail` or plain
questions with `--plain`).

## rommancer.sh

For hosts with rootless Podman (Quadlet not needed). The web is served on `127.0.0.1:8096`.

| Command | Does |
|---|---|
| `install [--roms PATH] [options]` | `build`, `up`, then `setup` |
| `build` | builds the three images |
| `up` | starts MySQL, the API and the web (again after an update) |
| `setup [options]` | the installer in the console |
| `down`, `status`, `logs [api\|web\|mysql]` | stop, list, follow the logs |

Data in `~/rommancer-data`; `ROMMANCER_ROMS`, `ROMMANCER_DATA` and `ROMMANCER_WEB_PORT` change the defaults.
`~/.config/rommancer/rommancer.env` is optional (overrides, as in `.env.example`): a variable set there wins over the
panel, which then shows it locked.

## Unattended

Every answer can be an option; then nothing is asked (`deploy/install.sh --help` lists them):

```bash
ROMMANCER_ADMIN_PASSWORD='a long password' sh rommancer/deploy/podman/rommancer.sh install \
  --roms /srv/roms --lang en --db bundled --admin admin --email me@example.com
```

`ROMMANCER_DB_PASSWORD` gives an external database's password the same way.

## podman-compose

From the extracted folder (web on port 8080):

```bash
ROMS_DIR=/path/to/my/roms podman-compose --profile full up -d --build
sh deploy/install.sh http://localhost:8080
```

## Quadlet (systemd)

```bash
podman build -t rommancer-mysql -f deploy/mysql/Containerfile .
podman build -t rommancer-api -f backend/Containerfile .
podman build -t rommancer-web -f frontend/Containerfile .
mkdir -p ~/.config/containers/systemd ~/rommancer/data/secrets
cp deploy/quadlet/* ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start rommancer-web
sh deploy/install.sh http://localhost:8080
```

The roms are mounted from `~/roms` (edit `rommancer-api.container` to change it).
