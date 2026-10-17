#!/bin/sh
# Deployment with Podman (rootless, the default) or Docker, on Linux (no Quadlet needed: Debian 12 ships 4.3) and
# macOS (Podman's machine, or Docker Desktop). install --engine podman|docker chooses; up remembers it.
# Started with the computer only as a service (rommancer.sh service on): a systemd user unit, on a Mac a LaunchAgent.
#   rommancer.sh install | build | up | start | stop | service [on|off] | setup | down | logs [api|web|mysql] | status
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
ENGINE="${ROMMANCER_ENGINE:-$(confval ROMMANCER_ENGINE || true)}"
ENGINE="${ENGINE:-podman}"
WEB_PORT="${ROMMANCER_WEB_PORT:-$(confval ROMMANCER_WEB_PORT || true)}"
WEB_PORT="${WEB_PORT:-8096}"
# network: any computer of the local network reaches the web (the consoles need it); local: only this one
LISTEN="${ROMMANCER_LISTEN:-$(confval ROMMANCER_LISTEN || true)}"
LISTEN="${LISTEN:-network}"
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

# Texts of install's last part and of service, in the installer's language
say() {
  case "$LANG_UI" in
    es*) case "$1" in
      running) printf '\nRommancer está funcionando en segundo plano: puedes cerrar esta terminal.\nÁbrelo en %s\n\n  %s status        ver si está en marcha\n  %s stop          pararlo\n  %s start         arrancarlo\n  %s logs          ver qué está haciendo\n  %s service on    instalarlo como servicio (off para quitarlo)\n\n' "$(web_url)" "$CMD" "$CMD" "$CMD" "$CMD" "$CMD" ;;
      ask) echo "¿Instalar Rommancer como servicio?

Así arranca solo cada vez que se enciende el equipo, aunque nadie inicie sesión. Si no, después de cada reinicio tendrás que arrancarlo tú con «$CMD start».${2:+

Hace falta tu contraseña de sudo una vez, para «$2».}" ;;
      askMac) echo "¿Instalar Rommancer como servicio?

Así arranca solo cada vez que inicias sesión en el Mac. Si no, tendrás que arrancarlo tú con «$CMD start»." ;;
      intro) echo "Vas a instalar Rommancer.

Rommancer funciona dentro de contenedores, con Podman (recomendado) o con Docker. Todo lo que necesita (su servidor, su base de datos y sus herramientas) va dentro de ellos, así que no instala nada más en tu sistema ni lo cambia.

Primero te pedirá la carpeta de tus roms. Luego preparará los contenedores, que la primera vez tarda unos minutos, y al final elegirás la base de datos y crearás tu cuenta." ;;
      ok) echo Aceptar ;;
      port) echo "¿En qué puerto quieres abrir Rommancer?

$(if [ -n "$2" ]; then echo "El $2 ya lo usa otro programa, así que te propongo el $3, que está libre."; else echo "El $3 está libre."; fi)" ;;
      portBad) echo "El $2 no sirve: tiene que ser un número entre 1 y 65535 que no esté usando otro programa." ;;
      listen) echo "¿Desde dónde se podrá abrir Rommancer?

Tus consolas y tus otros equipos solo lo encuentran si se puede abrir desde la red." ;;
      network) echo "Desde cualquier equipo de tu red (recomendado)" ;;
      local) echo "Solo desde este equipo" ;;
      cancel) echo Cancelar ;;
      engine) echo "¿Con qué quieres ejecutar los contenedores?

Tienes Podman y Docker. Podman funciona con tu usuario, sin un servicio con permisos de root; Docker usa su propio servicio." ;;
      podman) echo "Podman (recomendado)" ;;
      noEngine) echo "Rommancer necesita Podman (recomendado) o Docker, y no encuentro ninguno de los dos.

  Debian o Ubuntu:  sudo apt install podman
  Mac:              brew install podman, o Podman Desktop (https://podman-desktop.io)
  Docker:           https://docs.docker.com/get-docker/" ;;
      engineDown) echo "$2 está instalado, pero no responde: o su servicio no está en marcha o tu usuario no puede usarlo.
Con Docker, añade tu usuario al grupo docker (sudo usermod -aG docker $USER) y vuelve a entrar en la sesión." ;;
      yes) echo Sí ;;
      no) echo No ;;
      yn) echo s/N ;;
      on) echo "Rommancer está instalado como servicio y arrancará solo con el equipo. Para quitarlo: $CMD service off" ;;
      onMac) echo "Rommancer está instalado como servicio y arrancará cada vez que inicies sesión. Para quitarlo: $CMD service off" ;;
      off) echo "Rommancer no está instalado como servicio, así que no arrancará solo después de reiniciar.

  Arrancarlo:  $CMD start
  Pararlo:     $CMD stop

Para instalarlo como servicio más adelante: $CMD service on" ;;
      already) echo "Rommancer ya está instalado como servicio. Para quitarlo: $CMD service off" ;;
      noLinger) echo "Sin «sudo loginctl enable-linger $USER», Rommancer arrancará al iniciar sesión, no al encender el equipo." ;;
    esac ;;
    *) case "$1" in
      running) printf '\nRommancer is running in the background: you can close this terminal.\nOpen it at %s\n\n  %s status        is it running?\n  %s stop          stop it\n  %s start         start it\n  %s logs          see what it is doing\n  %s service on    install it as a service (off removes it)\n\n' "$(web_url)" "$CMD" "$CMD" "$CMD" "$CMD" "$CMD" ;;
      ask) echo "Install Rommancer as a service?

Then it starts by itself every time the computer starts, even with nobody logged in. Otherwise you start it after every reboot with \"$CMD start\".${2:+

It takes your sudo password once, for \"$2\".}" ;;
      askMac) echo "Install Rommancer as a service?

Then it starts by itself every time you log in to the Mac. Otherwise you start it with \"$CMD start\"." ;;
      intro) echo "You are about to install Rommancer.

Rommancer runs inside containers, with Podman (recommended) or Docker. Everything it needs (its server, its database and its tools) goes inside them, so nothing else is installed or changed on your system.

First it asks for your roms folder. Then it prepares the containers, which takes a few minutes the first time, and last you choose the database and create your account." ;;
      ok) echo Ok ;;
      port) echo "Which port should Rommancer use?

$(if [ -n "$2" ]; then echo "Another program already uses $2, so here is $3, which is free."; else echo "$3 is free."; fi)" ;;
      portBad) echo "$2 won't do: it has to be a number from 1 to 65535 that no other program uses." ;;
      listen) echo "Where can Rommancer be opened from?

Your consoles and other computers only find it when it can be opened from the network." ;;
      network) echo "Any computer on your network (recommended)" ;;
      local) echo "Only this computer" ;;
      cancel) echo Cancel ;;
      engine) echo "Which one should run the containers?

You have Podman and Docker. Podman runs as your user, with no service running as root; Docker uses its own service." ;;
      podman) echo "Podman (recommended)" ;;
      noEngine) echo "Rommancer needs Podman (recommended) or Docker, and neither is installed.

  Debian or Ubuntu:  sudo apt install podman
  Mac:               brew install podman, or Podman Desktop (https://podman-desktop.io)
  Docker:            https://docs.docker.com/get-docker/" ;;
      engineDown) echo "$2 is installed but does not answer: its service is not running or your user may not use it.
With Docker, add your user to the docker group (sudo usermod -aG docker $USER) and log in again." ;;
      yes) echo Yes ;;
      no) echo No ;;
      yn) echo y/N ;;
      on) echo "Rommancer is installed as a service and starts with the computer. To remove it: $CMD service off" ;;
      onMac) echo "Rommancer is installed as a service and starts every time you log in. To remove it: $CMD service off" ;;
      off) echo "Rommancer is not installed as a service, so it won't start by itself after a reboot.

  Start it:  $CMD start
  Stop it:   $CMD stop

To install it as a service later: $CMD service on" ;;
      already) echo "Rommancer is already installed as a service. To remove it: $CMD service off" ;;
      noLinger) echo "Without \"sudo loginctl enable-linger $USER\", Rommancer starts when you log in, not when the computer starts." ;;
    esac ;;
  esac
}
LANG_UI=${LANG:-}
CMD="sh $SRC/deploy/podman/rommancer.sh"
UNIT="$HOME/.config/systemd/user/rommancer.service"
AGENT="$HOME/Library/LaunchAgents/com.rommancer.start.plist"
linger() { [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" = yes ]; }

# Whether Rommancer is a service already (Linux: its unit, started at boot thanks to lingering)
service_on() {
  if [ "$OS" = Darwin ]; then [ -f "$AGENT" ]; else [ -f "$UNIT" ] && linger; fi
}

# Rommancer as a service: started with the computer (Linux: a systemd user unit, plus lingering so the user's units
# start at boot, which takes sudo once) or at login (Mac: a LaunchAgent)
service() {
  case "$1" in
    on)
      if [ "$OS" = Darwin ]; then
        mkdir -p "$(dirname "$AGENT")"
        cat > "$AGENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.rommancer.start</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>$SRC/deploy/podman/rommancer.sh</string><string>start</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$(command -v "$ENGINE")"):/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
</dict></plist>
EOF
        say onMac
        return
      fi
      mkdir -p "$(dirname "$UNIT")"
      cat > "$UNIT" <<EOF
[Unit]
Description=Rommancer
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh $SRC/deploy/podman/rommancer.sh start
ExecStop=/bin/sh $SRC/deploy/podman/rommancer.sh stop

[Install]
WantedBy=default.target
EOF
      systemctl --user daemon-reload
      systemctl --user enable rommancer.service >/dev/null 2>&1
      if ! linger && ! sudo loginctl enable-linger "$USER"; then
        say noLinger
        return
      fi
      say on ;;
    off)
      if [ "$OS" = Darwin ]; then
        rm -f "$AGENT"
      else
        systemctl --user disable rommancer.service >/dev/null 2>&1 || true
        rm -f "$UNIT"
        systemctl --user daemon-reload
      fi
      say off ;;
    *) echo "Usage: $0 service on|off" >&2; exit 2 ;;
  esac
}

# After install: how Rommancer runs and how to handle it, then whether to install it as a service (WANT: yes, no, or
# empty to ask)
after_install() {
  say running
  if service_on; then say already; return; fi
  want=$1
  if [ -z "$want" ]; then
    if [ ! -t 0 ]; then say off; return; fi
    sudo_for=
    [ "$OS" = Linux ] && ! linger && sudo_for="sudo loginctl enable-linger $USER"
    if [ "$OS" = Darwin ]; then q=$(say askMac); else q=$(say ask "$sudo_for"); fi
    if [ -t 2 ] && command -v whiptail >/dev/null 2>&1; then
      whiptail --title Rommancer --yes-button "$(say yes)" --no-button "$(say no)" --yesno "$q" 14 76 3>&1 1>&2 2>&3 && want=yes || want=no
    else
      printf '%s [%s]: ' "$q" "$(say yn)" >&2
      IFS= read -r a || a=
      case "$a" in [sSyY]*) want=yes ;; *) want=no ;; esac
    fi
  fi
  if [ "$want" = yes ]; then service on; else say off; fi
}

# install's choice of engine: the one given, the only one there is, or the person's pick (Podman first)
choose_engine() {
  if [ -n "$1" ]; then
    case "$1" in podman | docker) ENGINE=$1 ;; *) echo "--engine: podman or docker" >&2; exit 2 ;; esac
  else
    p='' d=''
    command -v podman >/dev/null 2>&1 && p=1
    command -v docker >/dev/null 2>&1 && d=1
    if [ -z "$p$d" ]; then say noEngine >&2; exit 1; fi
    if [ -n "$p" ] && [ -n "$d" ] && [ -t 0 ]; then
      if [ -z "$2" ] && [ -t 2 ] && command -v whiptail >/dev/null 2>&1; then
        ENGINE=$(whiptail --title Rommancer --ok-button "$(say ok)" --cancel-button "$(say cancel)" --notags --menu "$(say engine)" 14 76 2 \
          podman "$(say podman)" docker Docker 3>&1 1>&2 2>&3) || exit 1
      else
        printf '%s\n 1) %s\n 2) Docker\n[1]: ' "$(say engine)" "$(say podman)" >&2
        IFS= read -r a || a=
        case "$a" in 2 | docker | Docker) ENGINE=docker ;; *) ENGINE=podman ;; esac
      fi
    elif [ -n "$p" ]; then ENGINE=podman
    else ENGINE=docker
    fi
  fi
  if [ "$ENGINE" = docker ] || [ "$OS" != Darwin ]; then
    "$ENGINE" info >/dev/null 2>&1 || { say engineDown "$ENGINE" >&2; exit 1; }
  fi
}

# On a Mac Podman runs the containers in its Linux machine: made the first time (seeing your home and /Volumes),
# started when stopped. Its data stays in volumes inside it: MySQL is unreliable on folders shared from the Mac
machine() {
  [ "$OS" = Darwin ] && [ "$ENGINE" = podman ] || return 0
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

# This computer's address on the local network
host_ip() {
  ip=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')
  [ -n "$ip" ] || ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
  [ -n "$ip" ] || ip=$(hostname -I 2>/dev/null | cut -d' ' -f1)
  echo "${ip:-127.0.0.1}"
}

# The address to open Rommancer at: from the network when it listens there
web_url() {
  if [ "$LISTEN" = network ]; then echo "http://$(host_ip):$WEB_PORT"; else echo "http://127.0.0.1:$WEB_PORT"; fi
}

# Whether another program listens on port $1 (Rommancer's own web, about to be replaced, does not count)
port_busy() {
  $ENGINE port rommancer-web 80/tcp 2>/dev/null | grep -q ":$1\$" && return 1
  if command -v ss >/dev/null 2>&1; then [ -n "$(ss -Hltn "sport = :$1" 2>/dev/null)" ]
  elif command -v lsof >/dev/null 2>&1; then lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else nc -z 127.0.0.1 "$1" >/dev/null 2>&1
  fi
}

# The first free port from $1 on
free_port() {
  p=$1
  while port_busy "$p" && [ "$p" -lt 65535 ]; do p=$((p + 1)); done
  echo "$p"
}

# install's port and who may open the web: the ones given, or the person's answers (a free port is proposed)
choose_web() {
  box=''
  [ -z "$3" ] && [ -t 2 ] && command -v whiptail >/dev/null 2>&1 && box=1
  if [ -n "$1" ]; then
    case "$1" in '' | *[!0-9]*) say portBad "$1" >&2; exit 2 ;; esac
    if [ "$1" -lt 1 ] || [ "$1" -gt 65535 ] || port_busy "$1"; then say portBad "$1" >&2; exit 2; fi
    WEB_PORT=$1
  else
    free=$(free_port "$WEB_PORT")
    taken=''
    [ "$free" = "$WEB_PORT" ] || taken=$WEB_PORT
    WEB_PORT=$free
    if [ -t 0 ]; then
      while :; do
        if [ -n "$box" ]; then
          v=$(whiptail --title Rommancer --ok-button "$(say ok)" --cancel-button "$(say cancel)" --inputbox "$(say port "$taken" "$WEB_PORT")" 12 76 "$WEB_PORT" 3>&1 1>&2 2>&3) || exit 1
        else
          printf '%s\n[%s]: ' "$(say port "$taken" "$WEB_PORT")" "$WEB_PORT" >&2
          IFS= read -r v || exit 1
          v=${v:-$WEB_PORT}
        fi
        case "$v" in '' | *[!0-9]*) ;; *) [ "$v" -ge 1 ] && [ "$v" -le 65535 ] && ! port_busy "$v" && break ;; esac
        if [ -n "$box" ]; then whiptail --title Rommancer --msgbox "$(say portBad "$v")" 9 76; else say portBad "$v" >&2; fi
      done
      WEB_PORT=$v
    fi
  fi
  if [ -n "$2" ]; then
    case "$2" in network | local) LISTEN=$2 ;; *) echo "--listen: network or local" >&2; exit 2 ;; esac
  elif [ -t 0 ]; then
    if [ -n "$box" ]; then
      LISTEN=$(whiptail --title Rommancer --ok-button "$(say ok)" --cancel-button "$(say cancel)" --notags --default-item "$LISTEN" \
        --menu "$(say listen)" 14 76 2 network "$(say network)" local "$(say local)" 3>&1 1>&2 2>&3) || exit 1
    else
      printf '%s\n 1) %s\n 2) %s\n[1]: ' "$(say listen)" "$(say network)" "$(say local)" >&2
      IFS= read -r a || a=
      case "$a" in 2 | local) LISTEN=local ;; *) LISTEN=network ;; esac
    fi
  fi
}

remember() {
  mkdir -p "$(dirname "$CONF")"
  { [ -f "$CONF" ] && grep -v "^$1=" "$CONF"; echo "$1=$2"; } > "$CONF.new" || true
  mv "$CONF.new" "$CONF"
}

host_tz() {
  timedatectl show -p Timezone --value 2>/dev/null && return
  z=$(readlink /etc/localtime 2>/dev/null) && case "$z" in *zoneinfo/*) echo "${z#*zoneinfo/}"; return ;; esac
  echo UTC
}

case "${1:-}" in
  build)
    machine
    $ENGINE build -t rommancer-mysql -f "$SRC/deploy/mysql/Containerfile" "$SRC"
    $ENGINE build -t rommancer-api -f "$SRC/backend/Containerfile" "$SRC"
    $ENGINE build -t rommancer-web -f "$SRC/frontend/Containerfile" "$SRC" ;;
  up)
    # A rom folder or engine given now (ROMMANCER_ROMS, ROMMANCER_ENGINE, or install's questions) is the one every
    # later command uses
    if [ -n "${ROMMANCER_ROMS:-}" ]; then
      mkdir -p "$ROMS"
      ROMS=$(cd "$ROMS" && pwd)
      remember ROMMANCER_ROMS "$ROMS"
    fi
    [ -n "${ROMMANCER_ENGINE:-}" ] && remember ROMMANCER_ENGINE "$ENGINE"
    [ -n "${ROMMANCER_WEB_PORT:-}" ] && remember ROMMANCER_WEB_PORT "$WEB_PORT"
    [ -n "${ROMMANCER_LISTEN:-}" ] && remember ROMMANCER_LISTEN "$LISTEN"
    mkdir -p "$ROMS"
    machine
    if [ "$OS" = Darwin ] && [ "$ENGINE" = podman ] && ! shared "$ROMS"; then
      echo "Podman's machine can't see $ROMS: move your roms into your home folder or onto a disk in /Volumes," >&2
      echo "or make the machine again (podman machine rm, then rommancer.sh up makes one that sees both)." >&2
      exit 1
    fi
    bind=''
    [ "$LISTEN" = local ] && bind=127.0.0.1:
    $ENGINE network inspect "$NET" >/dev/null 2>&1 || $ENGINE network create "$NET" >/dev/null
    $ENGINE rm -f rommancer-web rommancer-api rommancer-mysql >/dev/null 2>&1 || true
    set --
    [ -n "$MYSQL_ROOT_PASSWORD" ] && set -- "$@" -e MYSQL_ROOT_PASSWORD="$MYSQL_ROOT_PASSWORD"
    [ -n "$MYSQL_PASSWORD" ] && set -- "$@" -e MYSQL_PASSWORD="$MYSQL_PASSWORD"
    if [ "$OS" = Linux ]; then
      mkdir -p "$DATA/app/secrets" "$DATA/mysql"
      set -- "$@" -v "$DATA/mysql:/var/lib/mysql:Z" -v "$DATA/app/secrets:/secrets:z"
    else
      set -- "$@" -v rommancer-mysql:/var/lib/mysql -v rommancer-secrets:/secrets
    fi
    $ENGINE run -d --name rommancer-mysql --network "$NET" --network-alias mysql --restart=on-failure "$@" rommancer-mysql:latest
    until $ENGINE exec rommancer-mysql mysqladmin ping -h127.0.0.1 --silent 2>/dev/null; do sleep 2; done
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
    $ENGINE run -d --name rommancer-api --network "$NET" --network-alias api --restart=on-failure "$@" \
      -e DATA_DIR=/data -e SEED_DIR=/seed -e ROMMANCER_BUNDLED_DB=mysql:3306 -e TZ="${TZ:-$(host_tz)}" rommancer-api:latest
    $ENGINE run -d --name rommancer-web --network "$NET" --restart=on-failure -p "$bind$WEB_PORT:80" rommancer-web:latest
    echo "Web on $(web_url)" ;;
  start)
    machine
    $ENGINE start rommancer-mysql rommancer-api rommancer-web ;;
  stop) $ENGINE stop rommancer-web rommancer-api rommancer-mysql ;;
  service) service "${2:-on}" ;;
  setup)
    shift
    ROMMANCER_SHOW_URL=$(web_url) exec sh "$SRC/deploy/install.sh" "http://127.0.0.1:$WEB_PORT" "$@" ;;
  install)
    shift
    # --roms is this script's; everything else goes to the installer
    roms='' plain='' svc='' engine='' port='' listen=''
    n=$#
    while [ "$n" -gt 0 ]; do
      a=$1
      shift
      n=$((n - 1))
      case "$a" in
        --roms) roms=${1:-}; [ "$n" -gt 0 ] && { shift; n=$((n - 1)); } ;;
        --roms=*) roms=${a#*=} ;;
        -h | --help)
          echo "Usage: $0 install [--roms PATH] [--engine podman|docker] [--service yes|no] [installer options]: builds, starts and installs Rommancer"
          echo "  --engine podman|docker   what runs the containers (Podman when both are there and it is not given)"
          echo "  --port PORT              the web's port (a free one from 8096 on when not given)"
          echo "  --listen network|local   who may open it: any computer of the network (default) or only this one"
          echo "  --service yes|no   install it as a service, started with the computer (asked when not given); the installer's options:"
          exec sh "$SRC/deploy/install.sh" --help ;;
        --port) port=${1:-}; [ "$n" -gt 0 ] && { shift; n=$((n - 1)); } ;;
        --port=*) port=${a#*=} ;;
        --listen) listen=${1:-}; [ "$n" -gt 0 ] && { shift; n=$((n - 1)); } ;;
        --listen=*) listen=${a#*=} ;;
        --engine) engine=${1:-}; [ "$n" -gt 0 ] && { shift; n=$((n - 1)); } ;;
        --engine=*) engine=${a#*=} ;;
        --service) svc=${1:-}; [ "$n" -gt 0 ] && { shift; n=$((n - 1)); } ;;
        --service=*) svc=${a#*=} ;;
        --lang) LANG_UI=${1:-}; set -- "$@" "$a" ;;
        --lang=*) LANG_UI=${a#*=}; set -- "$@" "$a" ;;
        *) [ "$a" = --plain ] && plain=1; set -- "$@" "$a" ;;
      esac
    done
    if [ -t 0 ]; then
      if [ -z "$plain" ] && [ -t 2 ] && command -v whiptail >/dev/null 2>&1; then
        whiptail --title Rommancer --ok-button "$(say ok)" --msgbox "$(say intro)" 16 76 3>&1 1>&2 2>&3 || exit 1
      else
        printf '%s\n\n' "$(say intro)" >&2
      fi
    fi
    choose_engine "$engine" "$plain"
    export ROMMANCER_ENGINE="$ENGINE"
    [ -z "$roms" ] && [ -t 0 ] && roms=$(ask_roms "$ROMS" "$plain")
    roms=${roms:-$ROMS}
    case "$roms" in "~"*) roms="$HOME${roms#"~"}" ;; esac
    mkdir -p "$roms"
    ROMS=$(cd "$roms" && pwd)
    export ROMMANCER_ROMS="$ROMS"
    choose_web "$port" "$listen" "$plain"
    export ROMMANCER_WEB_PORT="$WEB_PORT" ROMMANCER_LISTEN="$LISTEN"
    sh "$0" build
    sh "$0" up
    ROMMANCER_SHOW_URL=$(web_url) sh "$SRC/deploy/install.sh" "http://127.0.0.1:$WEB_PORT" "$@"
    after_install "$svc" ;;
  down) machine; $ENGINE rm -f rommancer-web rommancer-api rommancer-mysql ;;
  logs) $ENGINE logs --tail 100 -f "rommancer-${2:-api}" ;;
  status) $ENGINE ps -a --filter name=rommancer --format '{{.Names}}\t{{.Status}}' ;;
  *) echo "Usage: $0 install|build|up|start|stop|service [on|off]|setup|down|logs [api|web|mysql]|status"; exit 2 ;;
esac
