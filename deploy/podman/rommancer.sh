#!/bin/sh
# Rootless Podman deployment for Linux (no Quadlet needed: Debian 12 ships 4.3) and macOS (Podman's machine).
# Containers use --restart=always and come back at boot through podman-restart.service, on a Mac through a LaunchAgent.
#   rommancer.sh install | build | up | start | setup | down | logs [api|web|mysql] | status
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
OS=$(uname -s)

# Optional: overrides for the API (see .env.example). An installation from before the installer keeps its database
# passwords there; they are handed to MySQL, which keeps them in data/secrets
envval() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1; }
MYSQL_ROOT_PASSWORD="$(envval MYSQL_ROOT_PASSWORD || true)"
MYSQL_PASSWORD="$(envval MYSQL_PASSWORD || true)"

# The folder with your roms, asked by install: whiptail when there is one, a plain question otherwise
ask_roms() {
  case "${LANG:-}" in
    es*) q="¿Dónde tienes tus roms?

Elige la carpeta donde están. Si las tienes en varios discos, una que los contenga a todos.

Rommancer no moverá, renombrará ni borrará nada de lo que haya dentro. Si aún no tienes roms, deja la que viene propuesta."
      ok=Aceptar no=Cancelar bye="Instalación cancelada; vuelve a lanzarla cuando quieras." ;;
    *) q="Where are your roms?

Pick the folder they're in. If they're spread across several disks, pick one that holds them all.

Rommancer won't move, rename or delete anything inside it. No roms yet? Keep the one suggested."
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

# After install: how Rommancer runs and how to handle it, then whether it should start with the computer (Linux:
# rootless containers come back after a reboot only for a user with lingering, which takes sudo once)
after_install() {
  cmd="sh $SRC/deploy/podman/rommancer.sh"
  case "$1" in
    es*) printf '\nRommancer se queda funcionando en segundo plano: puedes cerrar esta terminal.\nÁbrelo en http://127.0.0.1:%s\n\n  %s status   ver si está en marcha\n  %s down     pararlo\n  %s up       volver a arrancarlo\n  %s logs     ver qué está haciendo\n\n' "$WEB_PORT" "$cmd" "$cmd" "$cmd" "$cmd"
      mac="Arrancará solo cada vez que inicies sesión en el Mac."
      q="¿Quieres que Rommancer arranque solo al encender el ordenador?

Si no, después de reiniciar no vuelve hasta que inicies sesión. Para que arranque siempre hay que ejecutar una vez «sudo loginctl enable-linger $USER», que te pedirá tu contraseña."
      yes=Sí no=No yn=s/N later="Cuando quieras que arranque con el ordenador: sudo loginctl enable-linger $USER" ;;
    *) printf '\nRommancer keeps running in the background: you can close this terminal.\nOpen it at http://127.0.0.1:%s\n\n  %s status   is it running?\n  %s down     stop it\n  %s up       start it again\n  %s logs     see what it is doing\n\n' "$WEB_PORT" "$cmd" "$cmd" "$cmd" "$cmd"
      mac="It will start by itself every time you log in to the Mac."
      q="Should Rommancer start by itself when the computer starts?

Otherwise, after a reboot it stays off until you log in. Starting it always takes running \"sudo loginctl enable-linger $USER\" once, which asks for your password."
      yes=Yes no=No yn=y/N later="To start it with the computer later: sudo loginctl enable-linger $USER" ;;
  esac
  if [ "$OS" = Darwin ]; then echo "$mac"; return; fi
  [ "$OS" = Linux ] && command -v loginctl >/dev/null 2>&1 || return 0
  loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q '=yes' && return 0
  if [ ! -t 0 ]; then echo "$later"; return; fi
  if [ -t 2 ] && command -v whiptail >/dev/null 2>&1; then
    whiptail --title Rommancer --yes-button "$yes" --no-button "$no" --yesno "$q" 12 76 3>&1 1>&2 2>&3 && a=y || a=n
  else
    printf '%s [%s]: ' "$q" "$yn" >&2
    IFS= read -r a || a=n
    case "$a" in [sSyY]*) a=y ;; *) a=n ;; esac
  fi
  if [ "$a" = y ] && sudo loginctl enable-linger "$USER"; then
    case "$1" in es*) echo "Hecho: Rommancer arrancará con el ordenador." ;; *) echo "Done: Rommancer will start with the computer." ;; esac
  else
    echo "$later"
  fi
}

# On a Mac the containers run in Podman's Linux machine: made the first time (seeing your home and /Volumes), started
# when stopped. Its data stays in volumes inside it: MySQL is unreliable on folders shared from the Mac
machine() {
  [ "$OS" = Darwin ] || return 0
  podman info >/dev/null 2>&1 && return 0
  podman machine inspect >/dev/null 2>&1 || podman machine init --memory 4096 -v "$HOME:$HOME" -v /Volumes:/Volumes
  podman machine start
}

# Whether Podman's machine sees this folder of the Mac (only the folders it was made with)
shared() {
  podman machine inspect --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' 2>/dev/null | while IFS= read -r m; do
    [ -n "$m" ] && case "$1/" in "${m%/}"/*) exit 3 ;; esac
  done
  [ $? = 3 ]
}

host_tz() {
  timedatectl show -p Timezone --value 2>/dev/null && return
  z=$(readlink /etc/localtime 2>/dev/null) && case "$z" in *zoneinfo/*) echo "${z#*zoneinfo/}"; return ;; esac
  echo UTC
}

case "${1:-}" in
  build)
    machine
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
    mkdir -p "$ROMS"
    machine
    if [ "$OS" = Darwin ] && ! shared "$ROMS"; then
      echo "Podman's machine can't see $ROMS: move your roms into your home folder or onto a disk in /Volumes," >&2
      echo "or make the machine again (podman machine rm, then rommancer.sh up makes one that sees both)." >&2
      exit 1
    fi
    podman network exists "$NET" || podman network create "$NET"
    podman rm -f rommancer-web rommancer-api rommancer-mysql >/dev/null 2>&1 || true
    set --
    [ -n "$MYSQL_ROOT_PASSWORD" ] && set -- "$@" -e MYSQL_ROOT_PASSWORD="$MYSQL_ROOT_PASSWORD"
    [ -n "$MYSQL_PASSWORD" ] && set -- "$@" -e MYSQL_PASSWORD="$MYSQL_PASSWORD"
    if [ "$OS" = Linux ]; then
      mkdir -p "$DATA/app/secrets" "$DATA/mysql"
      set -- "$@" -v "$DATA/mysql:/var/lib/mysql:Z" -v "$DATA/app/secrets:/secrets:z"
    else
      set -- "$@" -v rommancer-mysql:/var/lib/mysql -v rommancer-secrets:/secrets
    fi
    podman run -d --name rommancer-mysql --network "$NET" --network-alias mysql --restart=always "$@" localhost/rommancer-mysql:latest
    until podman exec rommancer-mysql mysqladmin ping -h127.0.0.1 --silent 2>/dev/null; do sleep 2; done
    set --
    [ -f "$ENV_FILE" ] && set -- "$@" --env-file "$ENV_FILE"
    # Chosen before the installer existed: the database the passwords above open
    [ -n "$MYSQL_PASSWORD" ] && [ ! -f "$DATA/app/config/database.json" ] && set -- "$@" -e DATABASE_URL="mysql://rommancer:$MYSQL_PASSWORD@mysql:3306/rommancer"
    if [ "$OS" = Linux ]; then
      set -- "$@" -v "$DATA/app:/data:z" -v "$SRC/seed:/seed:Z" -v "$ROMS:/roms:z" -v "$SRC/clients:/app/clients:ro,Z"
    else
      # The Mac's folders come through the machine's own sharing, which SELinux labels can't apply to
      set -- "$@" --security-opt label=disable -v rommancer-data:/data -v rommancer-secrets:/data/secrets \
        -v "$SRC/seed:/seed" -v "$ROMS:/roms" -v "$SRC/clients:/app/clients:ro"
    fi
    podman run -d --name rommancer-api --network "$NET" --network-alias api --restart=always "$@" \
      -e DATA_DIR=/data -e SEED_DIR=/seed -e ROMMANCER_BUNDLED_DB=mysql:3306 -e TZ="${TZ:-$(host_tz)}" localhost/rommancer-api:latest
    podman run -d --name rommancer-web --network "$NET" --restart=always -p "127.0.0.1:$WEB_PORT:80" localhost/rommancer-web:latest
    if [ "$OS" = Darwin ]; then
      # At login: the machine, then the containers (start)
      agent="$HOME/Library/LaunchAgents/com.rommancer.start.plist"
      mkdir -p "$(dirname "$agent")"
      cat > "$agent" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.rommancer.start</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>$SRC/deploy/podman/rommancer.sh</string><string>start</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$(command -v podman)"):/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
</dict></plist>
EOF
    else
      systemctl --user enable --now podman-restart.service >/dev/null 2>&1 || true
    fi
    echo "Web on http://127.0.0.1:$WEB_PORT" ;;
  start)
    machine
    podman start rommancer-mysql rommancer-api rommancer-web ;;
  setup)
    shift
    exec sh "$SRC/deploy/install.sh" "http://127.0.0.1:$WEB_PORT" "$@" ;;
  install)
    shift
    # --roms is this script's; everything else goes to the installer
    roms='' plain='' lang=${LANG:-}
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
        --lang) lang=${1:-}; set -- "$@" "$a" ;;
        --lang=*) lang=${a#*=}; set -- "$@" "$a" ;;
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
    sh "$SRC/deploy/install.sh" "http://127.0.0.1:$WEB_PORT" "$@"
    after_install "$lang" ;;
  down) machine; podman rm -f rommancer-web rommancer-api rommancer-mysql ;;
  logs) podman logs --tail 100 -f "rommancer-${2:-api}" ;;
  status) podman ps -a --filter name=rommancer --format '{{.Names}}\t{{.Status}}' ;;
  *) echo "Usage: $0 install|build|up|start|setup|down|logs [api|web|mysql]|status"; exit 2 ;;
esac
