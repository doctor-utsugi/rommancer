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

# The texts of setup.tsx (frontend/src/i18n/locales/*.json, "setup" and "server"), plus the console's own
t() {
  if [ "$L" = es ]; then
    case "$1" in
      title) echo "Instalador de Rommancer" ;;
      buttons) echo "Aceptar Cancelar Sí No" ;;
      yesNo) echo "[S/n]" ;;
      language) echo "Idioma" ;;
      waiting) echo "Esperando a Rommancer en $URL" ;;
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
      dbConnecting) echo "Conectando y preparando la base de datos. La primera vez tarda hasta un minuto…" ;;
      details) echo "Detalles" ;;
      db_unreachable) echo "Nadie responde en ese servidor y puerto. Revisa la dirección, que MySQL esté en marcha y que acepte conexiones desde este servidor." ;;
      db_auth) echo "MySQL rechaza el usuario o la contraseña. Revisa ambos." ;;
      db_missing) echo "Esa base de datos no existe. Créala antes o usa otro nombre." ;;
      db_denied) echo "El usuario no puede usar esa base de datos. Dale todos los privilegios en ella." ;;
      db_bundled) echo "La base de datos de Rommancer no ha respondido a tiempo. Mira su registro (rommancer.sh logs mysql) y vuelve a intentarlo." ;;
      db_failed) echo "No se ha podido preparar la base de datos." ;;
      adminTitle) echo "Administrador y servidor" ;;
      adminHint) echo "La primera cuenta gestiona todo lo demás: usuarios, carpetas de roms y dispositivos. Los ajustes del servidor se pueden cambiar luego en Administración > Servidor." ;;
      username) echo "Usuario" ;;
      usernameHint) echo "Al menos 3 caracteres: letras, números, punto, guion o guion bajo" ;;
      email) echo "Email" ;;
      passwordMin) echo "Al menos 10 caracteres" ;;
      confirm) echo "Repite la contraseña" ;;
      required) echo "Rellena: $2" ;;
      invalidUsername) echo "El usuario lleva al menos 3 caracteres: letras, números, punto, guion o guion bajo" ;;
      invalidEmail) echo "Ese email no es válido" ;;
      tooShort) echo "La contraseña necesita al menos 10 caracteres" ;;
      mismatch) echo "Las contraseñas no coinciden" ;;
      badPort) echo "El puerto es un número entre 1 y 65535" ;;
      publicUrl) echo "Dirección pública" ;;
      publicUrlHint) echo "Cómo llegan a este servidor las consolas y los móviles al emparejarse (p. ej. http://192.168.1.10:8096). Vacía: la dirección por la que llegue cada petición." ;;
      loopbackUrl) echo "Esta dirección solo funciona en esta máquina. Las consolas y los móviles necesitan una a la que puedan llegar: la del servidor en tu red o su dominio." ;;
      externalSync) echo "Actualizar fuentes externas" ;;
      externalSyncHint) echo "Los DATs, los hashes de RetroAchievements y demás fuentes se vuelven a descargar con esta frecuencia." ;;
      weekly) echo "Cada domingo a las 4:00" ;;
      daily) echo "Cada día a las 4:00" ;;
      never) echo "Nunca (solo cuando se pida)" ;;
      seedOnStart) echo "¿Aplicar la semilla al arrancar?" ;;
      seedOnStartHint) echo "Rommancer trae bases de datos de juegos (DATs, hashes de RetroAchievements, imágenes) en su carpeta de semilla: esto las carga al arrancar el servidor, saltándose lo que ya está." ;;
      creating) echo "Creando el administrador…" ;;
      failed) echo "No ha funcionado" ;;
      finished) echo "Rommancer está instalado. Entra en $2 como «$3»." ;;
      cancelled) echo "Instalación cancelada; vuelve a lanzarla cuando quieras." ;;
    esac
  else
    case "$1" in
      title) echo "Rommancer installer" ;;
      buttons) echo "Ok Cancel Yes No" ;;
      yesNo) echo "[Y/n]" ;;
      language) echo "Language" ;;
      waiting) echo "Waiting for Rommancer at $URL" ;;
      unreachable) echo "Rommancer does not answer at $URL. Is it running? (deploy/podman/rommancer.sh up)" ;;
      installed) echo "Rommancer is already installed: log in at $URL" ;;
      step) echo "Step $2 of 2" ;;
      dbTitle) echo "Where Rommancer keeps its data" ;;
      dbBundled) echo "Rommancer's own database (recommended)" ;;
      dbBundledHint) echo "The MySQL that comes with Rommancer. Its passwords were generated on the first start; nothing to fill in." ;;
      dbBundledMissing) echo "This installation does not include its own MySQL." ;;
      dbExternal) echo "A MySQL server of your own" ;;
      dbExternalHint) echo "MySQL 8 or MariaDB you already run. The database must exist and the user must be able to create tables in it." ;;
      dbHost) echo "Host" ;;
      dbPort) echo "Port" ;;
      dbName) echo "Database" ;;
      dbUser) echo "User" ;;
      password) echo "Password" ;;
      dbConnecting) echo "Connecting and preparing the database. The first time takes up to a minute…" ;;
      details) echo "Details" ;;
      db_unreachable) echo "Nothing answers at that host and port. Check the address, that MySQL is running and that it accepts connections from this server." ;;
      db_auth) echo "MySQL refused the user or the password. Check both." ;;
      db_missing) echo "That database does not exist. Create it first or use another name." ;;
      db_denied) echo "The user may not use that database. Grant it all privileges on it." ;;
      db_bundled) echo "Rommancer's own database did not answer in time. Look at its log (rommancer.sh logs mysql) and try again." ;;
      db_failed) echo "The database could not be prepared." ;;
      adminTitle) echo "Administrator and server" ;;
      adminHint) echo "The first account manages everything else: users, rom folders and devices. The server settings can be changed later in Administration > Server." ;;
      username) echo "Username" ;;
      usernameHint) echo "At least 3 characters: letters, digits, dot, dash or underscore" ;;
      email) echo "Email" ;;
      passwordMin) echo "At least 10 characters" ;;
      confirm) echo "Repeat the password" ;;
      required) echo "Fill in: $2" ;;
      invalidUsername) echo "The username takes at least 3 characters: letters, digits, dot, dash or underscore" ;;
      invalidEmail) echo "That email address is not valid" ;;
      tooShort) echo "The password needs at least 10 characters" ;;
      mismatch) echo "The passwords do not match" ;;
      badPort) echo "The port is a number from 1 to 65535" ;;
      publicUrl) echo "Public address" ;;
      publicUrlHint) echo "How consoles and phones reach this server when pairing (e.g. http://192.168.1.10:8096). Empty: the address each request came in on." ;;
      loopbackUrl) echo "This address only works on this machine. Consoles and phones need one they can reach: the server's address on your network or its domain." ;;
      externalSync) echo "Update external sources" ;;
      externalSyncHint) echo "DATs, RetroAchievements hashes and other sources are fetched again on this schedule." ;;
      weekly) echo "Every Sunday at 4:00" ;;
      daily) echo "Every day at 4:00" ;;
      never) echo "Never (only when asked)" ;;
      seedOnStart) echo "Apply the data seed on start?" ;;
      seedOnStartHint) echo "Rommancer comes with game databases (DATs, RetroAchievements hashes, artwork) in its seed folder: this loads them when the server starts, skipping what is already there." ;;
      creating) echo "Creating the administrator…" ;;
      failed) echo "That did not work" ;;
      finished) echo "Rommancer is installed. Log in at $2 as \"$3\"." ;;
      cancelled) echo "Installation cancelled; run it again whenever you like." ;;
    esac
  fi
}

# --- Questions: whiptail boxes or plain prompts, same answers either way ---

# Called inside $(...) too: the message goes to the terminal and the failed assignment stops the script (set -e)
cancel() {
  [ $UI = box ] && clear >&2
  { echo; t cancelled; } >&2
  exit 1
}

# Boxes as wide as the terminal allows (76 at most) and as tall as their text
W=76
cols=$(tput cols 2>/dev/null || echo 80)
[ "$cols" -lt $((W + 4)) ] && W=$((cols - 4))
rows() { printf '%s\n' "$1" | fold -s -w $((W - 6)) | wc -l; }

box() {
  # shellcheck disable=SC2046
  set -- $(t buttons) "$@"
  ok=$1 no_=$2 yes=$3 no=$4
  shift 4
  whiptail --title "$(t title)" --ok-button "$ok" --cancel-button "$no_" --yes-button "$yes" --no-button "$no" "$@" 3>&1 1>&2 2>&3
}

# The text of a question: its label, then its hint after a blank line
text() { if [ -n "${2:-}" ]; then printf '%s\n\n%s' "$1" "$2"; else printf '%s' "$1"; fi; }

note() {
  if [ $UI = box ]; then box --msgbox "$1" $(($(rows "$1") + 7)) $W || true; else printf '%s\n' "$1" >&2; fi
}

# A box that stays up while something runs (TERM=ansi: whiptail would clear it on leaving otherwise)
status() {
  if [ $UI = box ]; then TERM=ansi whiptail --title "$(t title)" --infobox "$1" $(($(rows "$1") + 2)) $W; else printf '%s\n' "$1" >&2; fi
}

# ask LABEL DEFAULT [HINT]: one line of text
ask() {
  if [ $UI = box ]; then x=$(text "$1" "${3:-}"); box --inputbox "$x" $(($(rows "$x") + 7)) $W "$2" || cancel; return; fi
  [ -n "${3:-}" ] && printf '%s\n' "$3" >&2
  if [ -n "$2" ]; then printf '%s [%s]: ' "$1" "$2" >&2; else printf '%s: ' "$1" >&2; fi
  IFS= read -r v || cancel
  printf '%s' "${v:-$2}"
}

# need LABEL DEFAULT [HINT]: like ask, until there is a value (the web form's required fields)
need() {
  while :; do
    v=$(ask "$@")
    [ -n "$v" ] && { printf '%s' "$v"; return; }
    note "$(t required "$1")"
  done
}

# secret LABEL [HINT]: a password, not echoed
secret() {
  if [ $UI = box ]; then x=$(text "$1" "${2:-}"); box --passwordbox "$x" $(($(rows "$x") + 7)) $W || cancel; return; fi
  [ -n "${2:-}" ] && printf '%s\n' "$2" >&2
  printf '%s: ' "$1" >&2
  [ -t 0 ] && stty -echo
  IFS= read -r v || { [ -t 0 ] && stty echo; cancel; }
  [ -t 0 ] && { stty echo; echo >&2; }
  printf '%s' "$v"
}

# choose TEXT DEFAULT TAG LABEL [TAG LABEL...]: one of the tags
choose() {
  x=$1 def=$2
  shift 2
  n=$(($# / 2))
  if [ $UI = box ]; then box --notags --default-item "$def" --menu "$x" $(($(rows "$x") + n + 7)) $W $n "$@" || cancel; return; fi
  printf '%s\n' "$x" >&2
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
    i=0
    for tag in $tags; do
      i=$((i + 1))
      [ "$v" = "$i" ] || [ "$v" = "$tag" ] && { printf '%s' "$tag"; return; }
    done
  done
}

# confirm LABEL [HINT]: yes (the default) or no, as true/false; Esc cancels like everywhere else
confirm() {
  if [ $UI = box ]; then
    x=$(text "$1" "${2:-}")
    rc=0
    box --yesno "$x" $(($(rows "$x") + 6)) $W || rc=$?
    case $rc in 0) echo true ;; 1) echo false ;; *) cancel ;; esac
    return
  fi
  [ -n "${2:-}" ] && printf '%s\n' "$2" >&2
  printf '%s %s: ' "$1" "$(t yesNo)" >&2
  IFS= read -r v || cancel
  case "$v" in [nN]*) echo false ;; *) echo true ;; esac
}

# --- The API ---

jesc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/	/\\t/g'; }
jstr() { printf '"%s":"%s"' "$1" "$(jesc "$2")"; }
jnum() { printf '"%s":%s' "$1" "$2"; }
jbool() { printf '"%s":%s' "$1" "$2"; }
# A string field of the last answer, JSON escapes undone
jget() { printf '%s' "$OUT" | sed -n "s/.*\"$1\":\"\\(\\([^\"\\\\]\\|\\\\.\\)*\\)\".*/\\1/p" | sed 's/\\"/"/g; s/\\\\/\\/g'; }

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

# call_waiting MESSAGE METHOD PATH BODY: call, with the seconds going by on screen while the server works
call_waiting() {
  msg=$1
  shift
  tmp=$(mktemp)
  (call "$@"; printf '%s\n%s' "$CODE" "$OUT" > "$tmp") &
  pid=$! s=0
  status "$msg"
  while kill -0 $pid 2>/dev/null; do
    sleep 1
    s=$((s + 1))
    if [ $UI = box ]; then status "$msg ($s s)"; elif [ $((s % 5)) -eq 0 ]; then printf '.' >&2; fi
  done
  wait $pid || true
  if [ $UI = plain ] && [ $s -ge 5 ]; then echo >&2; fi
  CODE=$(head -n 1 "$tmp")
  OUT=$(sed '1d' "$tmp")
  rm -f "$tmp"
}

# A refusal in the user's language: the database's reason, the field a validation points at, or the server's words
why() {
  code=$(jget code)
  if [ -n "$code" ] && [ -n "$(t "$code")" ]; then
    printf '%s\n\n%s: %s' "$(t "$code")" "$(t details)" "$(jget detail)"
    return
  fi
  f=$(printf '%s' "$OUT" | sed -n 's/.*"path":\["\([^"]*\)".*/\1/p' | head -n 1)
  case "$f" in
    username) t invalidUsername ;;
    email) t invalidEmail ;;
    password) t tooShort ;;
    *) e=$(jget error); printf '%s: %s' "$(t failed)" "${e:-HTTP $CODE}" ;;
  esac
}

# Waits for GET /setup to answer, until WANT (a JSON fragment) is in it when one is given
wait_setup() {
  s=0
  while :; do
    call GET /setup
    if [ "$CODE" = 200 ]; then
      case "$OUT" in *"${1:-}"*) return 0 ;; esac
    fi
    [ $s -ge 180 ] && { note "$(t unreachable)"; exit 1; }
    sleep 2
    s=$((s + 2))
    if [ $UI = box ]; then status "$(t waiting) ($s s)"; elif [ $((s % 10)) -eq 0 ]; then printf '.' >&2; fi
  done
}

is_loopback() { case "$1" in *://localhost* | *://127.* | *://\[::1\]*) return 0 ;; esac; return 1; }

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

$(t dbBundled): $(t dbBundledHint)

$(t dbExternal): $(t dbExternalHint)" "$mode" bundled "$(t dbBundled)" external "$(t dbExternal)")
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
        case "$DB_PORT" in '' | *[!0-9]*) ;; *) [ "$DB_PORT" -ge 1 ] && [ "$DB_PORT" -le 65535 ] && break ;; esac
        note "$(t badPort)"
      done
      DB_NAME=$(need "$(t dbName)" "$DB_NAME")
      DB_USER=$(need "$(t dbUser)" "$DB_USER")
      DB_PASSWORD=$(secret "$(t password)")
    fi
    call_waiting "$(t dbConnecting)" POST /setup/database "$(db_body "$mode")"
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

# The same checks as the web form, in the same order: username, password length, the repeated password
admin_step() {
  A_USER=admin A_EMAIL='' A_URL=$URL A_CRON=$schedule_weekly A_SEED=true
  note "$(t step 2) · $(t adminTitle)

$(t adminHint)"
  while :; do
    while :; do
      A_USER=$(need "$(t username)" "$A_USER" "$(t usernameHint)")
      case "$A_USER" in *[!a-zA-Z0-9_.-]*) ;; *) [ ${#A_USER} -ge 3 ] && [ ${#A_USER} -le 64 ] && break ;; esac
      note "$(t invalidUsername)"
    done
    A_EMAIL=$(need "$(t email)" "$A_EMAIL")
    while :; do
      A_PASSWORD=$(secret "$(t password)" "$(t passwordMin)")
      if [ ${#A_PASSWORD} -lt 10 ]; then note "$(t tooShort)"; continue; fi
      again=$(secret "$(t confirm)")
      [ "$A_PASSWORD" = "$again" ] && break
      note "$(t mismatch)"
    done
    hint=$(t publicUrlHint)
    is_loopback "$A_URL" && hint=$(t loopbackUrl)
    A_URL=$(ask "$(t publicUrl)" "$A_URL" "$hint")
    is_loopback "$A_URL" && note "$(t loopbackUrl)"
    def=weekly
    [ "$A_CRON" = "$schedule_daily" ] && def=daily
    [ "$A_CRON" = "$schedule_never" ] && def=never
    when=$(choose "$(text "$(t externalSync)" "$(t externalSyncHint)")" "$def" weekly "$(t weekly)" daily "$(t daily)" never "$(t never)")
    case $when in
      weekly) A_CRON=$schedule_weekly ;;
      daily) A_CRON=$schedule_daily ;;
      never) A_CRON=$schedule_never ;;
    esac
    A_SEED=$(confirm "$(t seedOnStart)" "$(t seedOnStartHint)")
    call_waiting "$(t creating)" POST /setup/admin "$(admin_body)"
    [ "$CODE" = 201 ] && break
    note "$(why)"
    # Someone finished the installation meanwhile (the web installer, another console)
    [ "$CODE" = 409 ] && exit 1
  done
  note "$(t finished "${A_URL:-$URL}" "$A_USER")"
  if [ $UI = box ]; then clear; t finished "${A_URL:-$URL}" "$A_USER"; fi
}

# --- Run ---

status "$(t waiting)…"
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
