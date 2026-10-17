#!/bin/sh
# Rootless Podman deployment for a host whose Podman lacks Quadlet (Debian 12 ships 4.3).
# Containers use --restart=always and come back at boot through podman-restart.service.
#   rommancer.sh install | build | up | setup | down | logs [api|web|mysql] | status
# install = build, up, then the installer in the console (setup); the web app runs the same installer.
# install and setup pass their options to deploy/install.sh (--help lists them: unattended installs);
# install also asks for the folder with your roms, or takes it as --roms PATH, and remembers it for up
set -eu
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${ROMMANCER_ENV:-$HOME/.config/rommancer/rommancer.env}"
DATA="${ROMMANCER_DATA:-$HOME/rommancer-data}"
# Deployment choices made by install (the rom folder), kept for the next up
CONF="${ROMMANCER_CONF:-$HOME/.config/rommancer/deploy.conf}"
confval() { [ -f "$CONF" ] && sed -n "s/^$1=//p" "$CONF" | head -n 1; }
ROMS="${ROMMANCER_ROMS:-$(confval ROMMANCER_ROMS || true)}"
ROMS="${ROMS:-$HOME/rommancer-roms}"
WEB_PORT="${ROMMANCER_WEB_PORT:-8096}"
NET=rommancer

# Optional: overrides for the API (see .env.example). An installation from before the installer keeps its database
# passwords there; they are handed to MySQL, which keeps them in data/secrets
envval() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1; }
MYSQL_ROOT_PASSWORD="$(envval MYSQL_ROOT_PASSWORD || true)"
MYSQL_PASSWORD="$(envval MYSQL_PASSWORD || true)"

# The folder with your roms, asked by install: whiptail when there is one, a plain question otherwise
ask_roms() {
  case "${LANG:-}" in
    es*) q="Carpeta con tus roms

Rommancer lee lo que ya hay tal cual: nunca lo mueve ni lo renombra, y solo escribe en ella si luego la eliges como destino de las roms nuevas. ¿Varios discos? Indica una carpeta que los contenga. Se monta en /roms; en la web, «Configurar almacenamiento» la añade a tu colección."
      ok=Aceptar no=Cancelar bye="Instalación cancelada; vuelve a lanzarla cuando quieras." ;;
    *) q="Folder with your roms

Rommancer reads what is already there as it is: it never moves or renames it, and only writes there if you later choose it as the destination of new roms. Several disks? Give a folder that holds them all. It is mounted at /roms; in the web app, Storage setup adds it to your collection."
      ok=Ok no=Cancel bye="Installation cancelled; run it again whenever you like." ;;
  esac
  if [ -z "$2" ] && [ -t 2 ] && command -v whiptail >/dev/null 2>&1; then
    whiptail --title Rommancer --ok-button "$ok" --cancel-button "$no" --inputbox "$q" 14 76 "$1" 3>&1 1>&2 2>&3 || { echo "$bye" >&2; exit 1; }
  else
    printf '%s\n[%s]: ' "$q" "$1" >&2
    IFS= read -r v || exit 1
    printf '%s' "${v:-$1}"
  fi
}

case "${1:-}" in
  build)
    podman build -t rommancer-mysql -f "$SRC/deploy/mysql/Containerfile" "$SRC"
    podman build -t rommancer-api -f "$SRC/backend/Containerfile" "$SRC"
    podman build -t rommancer-web -f "$SRC/frontend/Containerfile" "$SRC" ;;
  up)
    # A rom folder given now (ROMMANCER_ROMS, or install's question) is the one every later up mounts
    if [ -n "${ROMMANCER_ROMS:-}" ]; then
      mkdir -p "$ROMS" "$(dirname "$CONF")"
      ROMS=$(cd "$ROMS" && pwd)
      { [ -f "$CONF" ] && grep -v '^ROMMANCER_ROMS=' "$CONF"; echo "ROMMANCER_ROMS=$ROMS"; } > "$CONF.new" || true
      mv "$CONF.new" "$CONF"
    fi
    mkdir -p "$DATA/app/secrets" "$DATA/mysql" "$ROMS"
    podman network exists "$NET" || podman network create "$NET"
    podman rm -f rommancer-web rommancer-api rommancer-mysql >/dev/null 2>&1 || true
    set --
    [ -n "$MYSQL_ROOT_PASSWORD" ] && set -- "$@" -e MYSQL_ROOT_PASSWORD="$MYSQL_ROOT_PASSWORD"
    [ -n "$MYSQL_PASSWORD" ] && set -- "$@" -e MYSQL_PASSWORD="$MYSQL_PASSWORD"
    podman run -d --name rommancer-mysql --network "$NET" --network-alias mysql --restart=always "$@" \
      -v "$DATA/mysql:/var/lib/mysql:Z" -v "$DATA/app/secrets:/secrets:z" localhost/rommancer-mysql:latest
    until podman exec rommancer-mysql mysqladmin ping -h127.0.0.1 --silent 2>/dev/null; do sleep 2; done
    set --
    [ -f "$ENV_FILE" ] && set -- "$@" --env-file "$ENV_FILE"
    # Chosen before the installer existed: the database the passwords above open
    [ -n "$MYSQL_PASSWORD" ] && [ ! -f "$DATA/app/config/database.json" ] && set -- "$@" -e DATABASE_URL="mysql://rommancer:$MYSQL_PASSWORD@mysql:3306/rommancer"
    podman run -d --name rommancer-api --network "$NET" --network-alias api --restart=always "$@" \
      -e DATA_DIR=/data -e SEED_DIR=/seed -e ROMMANCER_BUNDLED_DB=mysql:3306 \
      -e TZ="${TZ:-$(timedatectl show -p Timezone --value 2>/dev/null || echo UTC)}" \
      -v "$DATA/app:/data:z" -v "$SRC/seed:/seed:Z" -v "$ROMS:/roms:z" -v "$SRC/clients:/app/clients:ro,Z" localhost/rommancer-api:latest
    podman run -d --name rommancer-web --network "$NET" --restart=always -p "127.0.0.1:$WEB_PORT:80" localhost/rommancer-web:latest
    systemctl --user enable --now podman-restart.service >/dev/null 2>&1 || true
    echo "Web on http://127.0.0.1:$WEB_PORT" ;;
  setup)
    shift
    exec sh "$SRC/deploy/install.sh" "http://127.0.0.1:$WEB_PORT" "$@" ;;
  install)
    shift
    # --roms is this script's; everything else goes to the installer
    roms='' plain=''
    n=$#
    while [ "$n" -gt 0 ]; do
      a=$1
      shift
      n=$((n - 1))
      case "$a" in
        --roms) roms=${1:-}; [ "$n" -gt 0 ] && { shift; n=$((n - 1)); } ;;
        --roms=*) roms=${a#*=} ;;
        -h | --help)
          echo "Usage: $0 install [--roms PATH] [installer options]: builds, starts and installs Rommancer; the installer's options:"
          exec sh "$SRC/deploy/install.sh" --help ;;
        *) [ "$a" = --plain ] && plain=1; set -- "$@" "$a" ;;
      esac
    done
    [ -z "$roms" ] && [ -t 0 ] && roms=$(ask_roms "$ROMS" "$plain")
    roms=${roms:-$ROMS}
    case "$roms" in "~"*) roms="$HOME${roms#"~"}" ;; esac
    mkdir -p "$roms"
    ROMS=$(cd "$roms" && pwd)
    export ROMMANCER_ROMS="$ROMS"
    sh "$0" build
    sh "$0" up
    exec sh "$SRC/deploy/install.sh" "http://127.0.0.1:$WEB_PORT" "$@" ;;
  down) podman rm -f rommancer-web rommancer-api rommancer-mysql ;;
  logs) podman logs --tail 100 -f "rommancer-${2:-api}" ;;
  status) podman ps -a --filter name=rommancer --format '{{.Names}}\t{{.Status}}' ;;
  *) echo "Usage: $0 install|build|up|setup|down|logs [api|web|mysql]|status"; exit 2 ;;
esac
