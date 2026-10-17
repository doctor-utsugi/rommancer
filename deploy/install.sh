#!/bin/sh
# Rommancer's installer in the console: the same steps, fields, choices and defaults as the web installer
# (frontend/src/pages/setup.tsx), through the same API. Keep both in step: backend/test/installer-parity.test.ts.
#   install.sh [URL] [--plain]    URL defaults to http://127.0.0.1:8096 (deploy/podman/rommancer.sh)
set -eu

URL="http://127.0.0.1:8096"
PLAIN=
for a in "$@"; do
  case "$a" in
    --plain) PLAIN=1 ;;
    -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
    *) URL="${a%/}" ;;
  esac
done
API="$URL/api/v1"
# Boxes when a person is at a terminal and whiptail is there; plain questions otherwise (pipes, scripts)
if [ -z "$PLAIN" ] && [ -t 0 ] && [ -t 1 ] && command -v whiptail >/dev/null 2>&1; then UI=box; else UI=plain; fi
command -v curl >/dev/null 2>&1 || { echo "curl is needed" >&2; exit 1; }

# Languages the panel speaks (backend/src/lib/locales.ts, frontend/src/i18n/locales.ts)
LOCALES='en:English es:Español'
# External sync schedules (SYNC_SCHEDULES in setup.tsx)
schedule_weekly='0 4 * * 0'
schedule_daily='0 4 * * *'
schedule_never=''

L=en
case "${LANG:-}" in es*) L=es ;; esac

t() {
  if [ "$L" = es ]; then
    case "$1" in
      title) echo "Instalador de Rommancer" ;;
      buttons) echo "Aceptar Cancelar Sí No" ;;
      language) echo "Idioma" ;;
      waiting) echo "Esperando a Rommancer en $URL…" ;;
      unreachable) echo "Rommancer no responde en $URL. ¿Está arrancado? (deploy/podman/rommancer.sh up)" ;;
      installed) echo "Rommancer ya está instalado: entra en $URL" ;;
      step) echo "Paso $2 de 2" ;;
      dbTitle) echo "Dónde guarda Rommancer sus datos" ;;
      dbBundled) echo "La base de datos de Rommancer (recomendado)" ;;
      dbBundledHint) echo "El MySQL que viene con Rommancer. Sus contraseñas se generaron al arrancar por primera vez; no hay que rellenar nada." ;;
      dbBundledMissing) echo "Esta instalación no incluye su propio MySQL." ;;
      dbExternal) echo "Un servidor MySQL tuyo" ;;
      dbExternalHint) echo "MySQL 8 o MariaDB que ya tengas. La base de datos tiene que existir y el usuario debe poder crear tablas en ella." ;;
      dbHost) echo "Servidor" ;;
      dbPort) echo "Puerto" ;;
      dbName) echo "Base de datos" ;;
      dbUser) echo "Usuario" ;;
      password) echo "Contraseña" ;;
      dbConnecting) echo "Conectando y preparando la base de datos…" ;;
      adminTitle) echo "Administrador y servidor" ;;
      adminHint) echo "La primera cuenta gestiona todo lo demás: usuarios, carpetas de roms y dispositivos. Lo demás se puede cambiar luego en Administración > Servidor." ;;
      username) echo "Usuario" ;;
      email) echo "Email" ;;
      passwordMin) echo "Contraseña (al menos 10 caracteres)" ;;
      confirm) echo "Repite la contraseña" ;;
      mismatch) echo "Las contraseñas no coinciden" ;;
      tooShort) echo "La contraseña necesita al menos 10 caracteres" ;;
      required) echo "Hace falta un valor" ;;
      badPort) echo "El puerto es un número entre 1 y 65535" ;;
      publicUrl) echo "Dirección pública: cómo llegan a este servidor las consolas y los móviles al emparejarse (p. ej. http://192.168.1.10:8096). Vacía: la que usó el navegador." ;;
      externalSync) echo "Actualizar fuentes externas: los DATs, los hashes de RetroAchievements y demás fuentes se vuelven a descargar con esta frecuencia." ;;
      weekly) echo "Cada domingo a las 4:00" ;;
      daily) echo "Cada día a las 4:00" ;;
      never) echo "Nunca (solo cuando se pida)" ;;
      seedOnStart) echo "¿Aplicar la semilla al arrancar? Carga los DATs, hashes e imágenes de la carpeta de semilla al arrancar el servidor; lo que ya está se salta." ;;
      creating) echo "Creando el administrador…" ;;
      failed) echo "No ha funcionado" ;;
      finished) echo "Rommancer está instalado. Entra en $2 como «$3»." ;;
      cancelled) echo "Instalación cancelada; vuelve a lanzarla cuando quieras." ;;
    esac
  else
    case "$1" in
      title) echo "Rommancer installer" ;;
      buttons) echo "Ok Cancel Yes No" ;;
      language) echo "Language" ;;
      waiting) echo "Waiting for Rommancer at $URL…" ;;
      unreachable) echo "Rommancer does not answer at $URL. Is it running? (deploy/podman/rommancer.sh up)" ;;
      installed) echo "Rommancer is already installed: log in at $URL" ;;
      step) echo "Step $2 of 2" ;;
      dbTitle) echo "Where Rommancer keeps its data" ;;
      dbBundled) echo "Rommancer's own database (recommended)" ;;
      dbBundledHint) echo "The MySQL that comes with Rommancer. Its passwords were generated on the first start; nothing to fill in." ;;
      dbBundledMissing) echo "This installation has no MySQL of its own." ;;
      dbExternal) echo "A MySQL server of your own" ;;
      dbExternalHint) echo "MySQL 8 or MariaDB you already run. The database must exist and the user must be able to create tables in it." ;;
      dbHost) echo "Host" ;;
      dbPort) echo "Port" ;;
      dbName) echo "Database" ;;
      dbUser) echo "User" ;;
      password) echo "Password" ;;
      dbConnecting) echo "Connecting and preparing the database…" ;;
      adminTitle) echo "Administrator and server" ;;
      adminHint) echo "The first account manages everything else: users, rom folders and devices. The rest can be changed later in Administration > Server." ;;
      username) echo "Username" ;;
      email) echo "Email" ;;
      passwordMin) echo "Password (at least 10 characters)" ;;
      confirm) echo "Repeat the password" ;;
      mismatch) echo "The passwords do not match" ;;
      tooShort) echo "The password needs at least 10 characters" ;;
      required) echo "A value is needed" ;;
      badPort) echo "The port is a number from 1 to 65535" ;;
      publicUrl) echo "Public address: how consoles and phones reach this server when pairing (e.g. http://192.168.1.10:8096). Empty: the address the browser used." ;;
      externalSync) echo "Update external sources: DATs, RetroAchievements hashes and other sources are fetched again on this schedule." ;;
      weekly) echo "Every Sunday at 4:00" ;;
      daily) echo "Every day at 4:00" ;;
      never) echo "Never (only when asked)" ;;
      seedOnStart) echo "Apply the data seed on start? Loads the DATs, hashes and artwork of the seed folder when the server starts; what is already there is skipped." ;;
      creating) echo "Creating the administrator…" ;;
      failed) echo "That did not work" ;;
      finished) echo "Rommancer is installed. Log in at $2 as \"$3\"." ;;
      cancelled) echo "Installation cancelled; run it again whenever you like." ;;
    esac
  fi
}

# --- Questions: whiptail boxes or plain prompts, same answers either way ---

# Called inside $(...) too: the message goes to the terminal and the failed assignment stops the script (set -e)
cancel() { { echo; t cancelled; } >&2; exit 1; }
box() {
  # shellcheck disable=SC2046
  set -- $(t buttons) "$@"
  ok=$1 no_=$2 yes=$3 no=$4
  shift 4
  whiptail --title "$(t title)" --ok-button "$ok" --cancel-button "$no_" --yes-button "$yes" --no-button "$no" "$@" 3>&1 1>&2 2>&3
}
# Boxes are as tall as their text, wrapped to their width
W=76
rows() { printf '%s\n' "$1" | fold -s -w $((W - 6)) | wc -l; }

note() {
  if [ $UI = box ]; then box --msgbox "$1" $(($(rows "$1") + 7)) $W || true; else printf '%s\n' "$1"; fi
}

status() {
  if [ $UI = box ]; then whiptail --title "$(t title)" --infobox "$1" $(($(rows "$1") + 2)) $W; else printf '%s\n' "$1"; fi
}

# ask TEXT DEFAULT: one line of text
ask() {
  if [ $UI = box ]; then box --inputbox "$1" $(($(rows "$1") + 7)) $W "$2" || cancel; return; fi
  if [ -n "$2" ]; then printf '%s [%s]: ' "$1" "$2" >&2; else printf '%s: ' "$1" >&2; fi
  IFS= read -r v || cancel
  printf '%s' "${v:-$2}"
}

# need TEXT DEFAULT: like ask, until there is a value (the web form's required fields)
need() {
  while :; do
    v=$(ask "$1" "$2")
    [ -n "$v" ] && { printf '%s' "$v"; return; }
    note "$(t required)" >&2
  done
}

# secret TEXT: a password, not echoed
secret() {
  if [ $UI = box ]; then box --passwordbox "$1" $(($(rows "$1") + 7)) $W || cancel; return; fi
  printf '%s: ' "$1" >&2
  [ -t 0 ] && stty -echo
  IFS= read -r v || { [ -t 0 ] && stty echo; cancel; }
  [ -t 0 ] && { stty echo; echo >&2; }
  printf '%s' "$v"
}

# choose TEXT DEFAULT TAG LABEL [TAG LABEL...]: one of the tags
choose() {
  text=$1 def=$2
  shift 2
  if [ $UI = box ]; then n=$(($# / 2))
    box --notags --default-item "$def" --menu "$text" $(($(rows "$text") + n + 7)) $W $n "$@" || cancel; return; fi
  printf '%s\n' "$text" >&2
  i=0 tags=
  while [ $# -gt 0 ]; do
    i=$((i + 1))
    mark=' '; [ "$1" = "$def" ] && mark='*'
    printf ' %s%d) %s\n' "$mark" "$i" "$2" >&2
    tags="$tags $1"
    shift 2
  done
  while :; do
    printf '> ' >&2
    IFS= read -r v || cancel
    [ -z "$v" ] && { printf '%s' "$def"; return; }
    n=0
    for tag in $tags; do
      n=$((n + 1))
      [ "$v" = "$n" ] || [ "$v" = "$tag" ] && { printf '%s' "$tag"; return; }
    done
  done
}

# confirm TEXT: yes (default) or no, as true/false
confirm() {
  if [ $UI = box ]; then
    if box --yesno "$1" $(($(rows "$1") + 6)) $W; then echo true; else echo false; fi
    return
  fi
  printf '%s [Y/n]: ' "$1" >&2
  IFS= read -r v || cancel
  case "$v" in [nN]*) echo false ;; *) echo true ;; esac
}

# --- The API ---

jesc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/	/\\t/g'; }
jstr() { printf '"%s":"%s"' "$1" "$(jesc "$2")"; }
jnum() { printf '"%s":%s' "$1" "$2"; }
jbool() { printf '"%s":%s' "$1" "$2"; }

# call METHOD PATH [BODY]: sets CODE and OUT
call() {
  if [ -n "${3:-}" ]; then
    r=$(curl -s -m 600 -X "$1" -H 'Content-Type: application/json' --data-binary "$3" -w '\n%{http_code}' "$API$2" 2>/dev/null) || r="
000"
  else
    r=$(curl -s -m 10 -w '\n%{http_code}' "$API$2" 2>/dev/null) || r="
000"
  fi
  CODE=$(printf '%s' "$r" | tail -n 1)
  OUT=$(printf '%s' "$r" | sed '$d')
}

# The server's own words for a refusal, with the field a validation error points at
why() {
  e=$(printf '%s' "$OUT" | sed -n 's/.*"error":"\(\([^"\\]\|\\.\)*\)".*/\1/p' | sed 's/\\"/"/g; s/\\\\/\\/g')
  f=$(printf '%s' "$OUT" | sed -n 's/.*"path":\["\([^"]*\)".*/\1/p' | head -n 1)
  printf '%s: %s%s' "$(t failed)" "${e:-HTTP $CODE}" "${f:+ ($f)}"
}

# Waits for GET /setup to answer, until WANT (a JSON fragment) is in it when one is given
wait_setup() {
  i=0
  while :; do
    call GET /setup
    if [ "$CODE" = 200 ]; then
      case "$OUT" in *"${1:-}"*) return 0 ;; esac
    fi
    i=$((i + 1))
    [ $i -ge 90 ] && { note "$(t unreachable)"; exit 1; }
    sleep 2
  done
}

# --- Steps ---

db_body() {
  if [ "$1" = bundled ]; then
    printf '{%s}' "$(jstr mode bundled)"
  else
    printf '{%s,%s,%s,%s,%s,%s}' "$(jstr mode external)" "$(jstr host "$DB_HOST")" "$(jnum port "$DB_PORT")" \
      "$(jstr database "$DB_NAME")" "$(jstr user "$DB_USER")" "$(jstr password "$DB_PASSWORD")"
  fi
}

database_step() {
  DB_HOST='' DB_PORT=3306 DB_NAME=rommancer DB_USER=rommancer DB_PASSWORD=''
  bundled=false mode=bundled
  case "$SETUP" in *'"bundledDatabase":true'*) bundled=true ;; esac
  while :; do
    if [ $bundled = true ]; then
      mode=$(choose "$(t step 1) · $(t dbTitle)

1. $(t dbBundled): $(t dbBundledHint)
2. $(t dbExternal): $(t dbExternalHint)" "$mode" bundled "$(t dbBundled)" external "$(t dbExternal)")
    else
      note "$(t step 1) · $(t dbTitle)

$(t dbBundledMissing)
$(t dbExternal): $(t dbExternalHint)"
      mode=external
    fi
    if [ "$mode" = external ]; then
      DB_HOST=$(need "$(t dbHost)" "$DB_HOST")
      while :; do
        DB_PORT=$(ask "$(t dbPort)" "$DB_PORT")
        case "$DB_PORT" in '' | *[!0-9]*) note "$(t badPort)" ;; *) [ "$DB_PORT" -ge 1 ] && [ "$DB_PORT" -le 65535 ] && break; note "$(t badPort)" ;; esac
      done
      DB_NAME=$(need "$(t dbName)" "$DB_NAME")
      DB_USER=$(need "$(t dbUser)" "$DB_USER")
      DB_PASSWORD=$(secret "$(t password)")
    fi
    status "$(t dbConnecting)"
    call POST /setup/database "$(db_body "$mode")"
    [ "$CODE" = 200 ] && break
    note "$(why)"
  done
  # The installer steps aside for the real server, which answers once it has started
  wait_setup '"needsDatabase":false'
}

admin_body() {
  printf '{%s,%s,%s,%s,%s,%s,%s}' "$(jstr username "$A_USER")" "$(jstr email "$A_EMAIL")" "$(jstr password "$A_PASSWORD")" \
    "$(jstr locale "$L")" "$(jstr publicUrl "$A_URL")" "$(jstr externalSyncCron "$A_CRON")" "$(jbool seedOnStart "$A_SEED")"
}

admin_step() {
  A_USER=admin A_EMAIL='' A_URL=$URL A_CRON=$schedule_weekly A_SEED=true
  note "$(t step 2) · $(t adminTitle)

$(t adminHint)"
  while :; do
    A_USER=$(need "$(t username)" "$A_USER")
    A_EMAIL=$(need "$(t email)" "$A_EMAIL")
    while :; do
      A_PASSWORD=$(secret "$(t passwordMin)")
      again=$(secret "$(t confirm)")
      if [ "$A_PASSWORD" != "$again" ]; then note "$(t mismatch)"
      elif [ ${#A_PASSWORD} -lt 10 ]; then note "$(t tooShort)"
      else break; fi
    done
    A_URL=$(ask "$(t publicUrl)" "$A_URL")
    def=weekly
    [ "$A_CRON" = "$schedule_daily" ] && def=daily
    [ "$A_CRON" = "$schedule_never" ] && def=never
    when=$(choose "$(t externalSync)" "$def" weekly "$(t weekly)" daily "$(t daily)" never "$(t never)")
    case $when in
      weekly) A_CRON=$schedule_weekly ;;
      daily) A_CRON=$schedule_daily ;;
      never) A_CRON=$schedule_never ;;
    esac
    A_SEED=$(confirm "$(t seedOnStart)")
    status "$(t creating)"
    call POST /setup/admin "$(admin_body)"
    [ "$CODE" = 201 ] && break
    note "$(why)"
    # Someone finished the installation meanwhile (the web installer, another console)
    [ "$CODE" = 409 ] && exit 1
  done
  note "$(t finished "$URL" "$A_USER")"
}

# --- Run ---

status "$(t waiting)"
wait_setup
SETUP=$OUT
case "$SETUP" in *'"needsAdmin":false'*) note "$(t installed)"; exit 0 ;; esac

args=
for l in $LOCALES; do args="$args ${l%%:*} ${l#*:}"; done
# shellcheck disable=SC2086
L=$(choose "$(t language)" "$L" $args)

case "$SETUP" in *'"needsDatabase":true'*) database_step ;; esac
# A database chosen anew may already hold an installation
case "$OUT" in *'"needsAdmin":false'*) note "$(t installed)"; exit 0 ;; esac
admin_step
