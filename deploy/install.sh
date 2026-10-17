#!/bin/sh
# Rommancer's installer in the console: the same steps, fields, choices and defaults as the web installer
# (frontend/src/pages/setup.tsx), through the same API. Keep both in step: backend/test/installer-parity.test.ts.
set -eu

usage() {
  cat <<'EOF'
Usage: install.sh [URL] [options]
  URL                    Rommancer's web address (default http://127.0.0.1:8096, as deploy/podman/rommancer.sh serves it)
  --plain                plain questions instead of boxes
  --lang en|es           the installer's language and the server's default one
  --db bundled|external  Rommancer's own database, or a MySQL server of your own:
    --db-host HOST  --db-port PORT  --db-name NAME  --db-user USER  --db-password PASSWORD
  --admin USER  --password PASSWORD     your account
Every option given skips its question; with all of them nothing is asked (unattended installs).
The passwords can come from ROMMANCER_DB_PASSWORD and ROMMANCER_ADMIN_PASSWORD instead, out of sight of ps.
EOF
}

URL="http://127.0.0.1:8096"
PLAIN=
O_LANG='' O_DB='' O_DB_HOST='' O_DB_PORT='' O_DB_NAME='' O_DB_USER='' O_ADMIN=''
O_DB_PASSWORD=${ROMMANCER_DB_PASSWORD:-} O_PASSWORD=${ROMMANCER_ADMIN_PASSWORD:-}
# Which answers came with the command (an empty database password is an answer too)
G_DB_PASSWORD=${ROMMANCER_DB_PASSWORD+1} G_PASSWORD=${ROMMANCER_ADMIN_PASSWORD+1}
while [ $# -gt 0 ]; do
  opt=$1 val=
  case "$opt" in
    --*=*) val=${opt#*=}; opt=${opt%%=*} ;;
    --plain | -h | --help) ;;
    --*) [ $# -ge 2 ] || { usage >&2; exit 2; }; val=$2; shift ;;
  esac
  case "$opt" in
    --plain) PLAIN=1 ;;
    -h | --help) usage; exit 0 ;;
    --lang) O_LANG=$val ;;
    --db) O_DB=$val ;;
    --db-host) O_DB_HOST=$val ;;
    --db-port) O_DB_PORT=$val ;;
    --db-name) O_DB_NAME=$val ;;
    --db-user) O_DB_USER=$val ;;
    --db-password) O_DB_PASSWORD=$val G_DB_PASSWORD=1 ;;
    --admin) O_ADMIN=$val ;;
    --password) O_PASSWORD=$val G_PASSWORD=1 ;;
    --*) usage >&2; exit 2 ;;
    *) URL="${opt%/}" ;;
  esac
  shift
done
API="$URL/api/v1"
# The address people use, when the installer reaches Rommancer by another one (rommancer.ps1 runs it in a container)
SHOWN=${ROMMANCER_SHOW_URL:-$URL}
# Boxes when a person is at a terminal and whiptail is there; plain questions otherwise (pipes, scripts)
if [ -z "$PLAIN" ] && [ -t 0 ] && [ -t 1 ] && command -v whiptail >/dev/null 2>&1; then UI=box; else UI=plain; fi
command -v curl >/dev/null 2>&1 || { echo "curl is needed" >&2; exit 1; }

# Languages the panel speaks (backend/src/lib/locales.ts, frontend/src/i18n/locales.ts)
LOCALES='en:English es:Español'

L=en
case "${LANG:-}" in es*) L=es ;; esac
if [ -n "$O_LANG" ]; then
  case " $LOCALES" in *" $O_LANG:"*) L=$O_LANG ;; *) echo "--lang: one of $LOCALES" >&2; exit 2 ;; esac
fi

# The texts of setup.tsx (frontend/src/i18n/locales/*.json, "setup" and "server"), plus the console's own
t() {
  if [ "$L" = es ]; then
    case "$1" in
      title) echo "Instalador de Rommancer" ;;
      buttons) echo "Aceptar Cancelar Sí No" ;;
      language) echo "Idioma" ;;
      starting) echo "Base de datos lista. Arrancando Rommancer con ella…" ;;
      waiting) echo "Esperando a que Rommancer responda en $SHOWN" ;;
      unreachable) echo "Rommancer no responde en $SHOWN. Comprueba que está en marcha (rommancer.sh status)." ;;
      installed) echo "Rommancer ya estaba instalado. Entra en $SHOWN" ;;
      step) echo "Paso $2 de 2" ;;
      dbTitle) echo "Elige dónde guardar los datos" ;;
      dbBundled) echo "La base de datos que trae Rommancer (recomendado)" ;;
      dbBundledHint) echo "Ya está preparada y con sus contraseñas puestas. No tienes que rellenar nada." ;;
      dbBundledMissing) echo "Esta instalación no trae base de datos propia, así que necesitas un MySQL tuyo." ;;
      dbExternal) echo "Mi propio servidor MySQL" ;;
      dbExternalHint) echo "Un MySQL 8 o MariaDB que ya tengas funcionando. Crea antes la base de datos y un usuario que pueda crear tablas en ella." ;;
      dbHost) echo "Servidor (nombre o IP)" ;;
      dbPort) echo "Puerto" ;;
      dbName) echo "Nombre de la base de datos" ;;
      dbUser) echo "Usuario de MySQL" ;;
      password) echo "Contraseña" ;;
      dbConnecting) echo "Preparando la base de datos. La primera vez puede tardar un minuto…" ;;
      details) echo "Detalles" ;;
      db_unreachable) echo "No hay respuesta en ese servidor y puerto. Comprueba la dirección, que MySQL esté en marcha y que acepte conexiones desde esta máquina." ;;
      db_auth) echo "MySQL no acepta ese usuario o esa contraseña." ;;
      db_missing) echo "Esa base de datos no existe. Créala primero o escribe otro nombre." ;;
      db_denied) echo "Ese usuario no tiene permiso para usar la base de datos. Dale todos los privilegios sobre ella." ;;
      db_bundled) echo "La base de datos de Rommancer no ha arrancado a tiempo. Mira qué le pasa con «rommancer.sh logs mysql» y vuelve a intentarlo." ;;
      db_failed) echo "No se ha podido preparar la base de datos." ;;
      adminTitle) echo "Crea tu cuenta" ;;
      adminHint) echo "Con esta cuenta administras Rommancer: añades usuarios, carpetas de roms y consolas. El resto de ajustes ya viene con valores que funcionan; si quieres cambiarlos, están en Administración > Servidor." ;;
      username) echo "Nombre de usuario" ;;
      usernameHint) echo "Letras, números, punto, guion o guion bajo; mínimo 3." ;;
      confirm) echo "Repite la contraseña" ;;
      required) echo "Falta rellenar: $2" ;;
      invalidUsername) echo "Ese nombre de usuario no vale: usa al menos 3 caracteres entre letras, números, punto, guion o guion bajo." ;;
      mismatch) echo "Las dos contraseñas no coinciden. Escríbelas otra vez." ;;
      badPort) echo "El puerto tiene que ser un número entre 1 y 65535." ;;
      badDb) echo "--db: bundled o external" ;;
      creating) echo "Creando tu cuenta…" ;;
      failed) echo "Algo ha fallado" ;;
      finished) echo "Listo. Entra en $2 con el usuario «$3»." ;;
      cancelled) echo "Instalación cancelada; vuelve a lanzarla cuando quieras." ;;
    esac
  else
    case "$1" in
      title) echo "Rommancer installer" ;;
      buttons) echo "Ok Cancel Yes No" ;;
      language) echo "Language" ;;
      starting) echo "The database is ready. Starting Rommancer with it…" ;;
      waiting) echo "Waiting for Rommancer to answer at $SHOWN" ;;
      unreachable) echo "Rommancer doesn't answer at $SHOWN. Check that it is running (rommancer.sh status)." ;;
      installed) echo "Rommancer was already installed. Log in at $SHOWN" ;;
      step) echo "Step $2 of 2" ;;
      dbTitle) echo "Choose where to keep the data" ;;
      dbBundled) echo "The database that comes with Rommancer (recommended)" ;;
      dbBundledHint) echo "It is ready and its passwords are already set. Nothing to fill in." ;;
      dbBundledMissing) echo "This installation has no database of its own, so you need a MySQL server of yours." ;;
      dbExternal) echo "My own MySQL server" ;;
      dbExternalHint) echo "A MySQL 8 or MariaDB you already run. Create the database first, and a user that can create tables in it." ;;
      dbHost) echo "Server (name or IP)" ;;
      dbPort) echo "Port" ;;
      dbName) echo "Database name" ;;
      dbUser) echo "MySQL user" ;;
      password) echo "Password" ;;
      dbConnecting) echo "Preparing the database. The first time can take a minute…" ;;
      details) echo "Details" ;;
      db_unreachable) echo "Nothing answers at that server and port. Check the address, that MySQL is running and that it accepts connections from this machine." ;;
      db_auth) echo "MySQL doesn't accept that user or that password." ;;
      db_missing) echo "That database doesn't exist. Create it first or type another name." ;;
      db_denied) echo "That user isn't allowed to use the database. Grant it all privileges on it." ;;
      db_bundled) echo "Rommancer's database didn't start in time. See what happened with \"rommancer.sh logs mysql\" and try again." ;;
      db_failed) echo "The database couldn't be prepared." ;;
      adminTitle) echo "Create your account" ;;
      adminHint) echo "This account runs Rommancer: it adds users, rom folders and consoles. Every other setting already has a value that works; to change them, go to Administration > Server." ;;
      username) echo "Username" ;;
      usernameHint) echo "Letters, digits, dot, dash or underscore; 3 at least." ;;
      confirm) echo "Repeat the password" ;;
      required) echo "Still empty: $2" ;;
      invalidUsername) echo "That username won't work: use at least 3 letters, digits, dots, dashes or underscores." ;;
      mismatch) echo "The two passwords don't match. Type them again." ;;
      badPort) echo "The port has to be a number from 1 to 65535." ;;
      badDb) echo "--db: bundled or external" ;;
      creating) echo "Creating your account…" ;;
      failed) echo "Something went wrong" ;;
      finished) echo "Done. Log in at $2 as \"$3\"." ;;
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

# An answer given with the command that cannot work: asking again would ask nobody
die() {
  [ $UI = box ] && clear >&2
  printf '%s\n' "$1" >&2
  exit 2
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
  if [ $UI = box ]; then TERM=ansi whiptail --title "$(t title)" --infobox "$1" $(($(rows "$1") + 6)) $W; else printf '%s\n' "$1" >&2; fi
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

# --- The API ---

jesc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/	/\\t/g'; }
jstr() { printf '"%s":"%s"' "$1" "$(jesc "$2")"; }
jnum() { printf '"%s":%s' "$1" "$2"; }
# A string field of the last answer, JSON escapes undone
jget() { printf '%s' "$OUT" | sed -nE "s/.*\"$1\":\"(([^\"\\\\]|\\\\.)*)\".*/\\1/p" | sed 's/\\"/"/g; s/\\\\/\\/g'; }

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
    *) e=$(jget error); printf '%s: %s' "$(t failed)" "${e:-HTTP $CODE}" ;;
  esac
}

# Waits for GET /setup to answer, until WANT (a JSON fragment) is in it when one is given; MESSAGE says what for
wait_setup() {
  s=0 msg=${2:-$(t waiting)}
  status "$msg"
  while :; do
    call GET /setup
    if [ "$CODE" = 200 ]; then
      case "$OUT" in *"${1:-}"*) return 0 ;; esac
    fi
    [ $s -ge 180 ] && { note "$(t unreachable)"; exit 1; }
    sleep 2
    s=$((s + 2))
    if [ $UI = box ]; then status "$msg ($s s)"; elif [ $((s % 10)) -eq 0 ]; then printf '.' >&2; fi
  done
}

valid_port() { case "$1" in '' | *[!0-9]*) return 1 ;; esac; [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }
valid_user() { case "$1" in *[!a-zA-Z0-9_.-]*) return 1 ;; esac; [ ${#1} -ge 3 ] && [ ${#1} -le 64 ]; }

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
  DB_HOST=$O_DB_HOST DB_PORT=${O_DB_PORT:-3306} DB_NAME=${O_DB_NAME:-rommancer} DB_USER=${O_DB_USER:-rommancer} DB_PASSWORD=$O_DB_PASSWORD
  bundled=false mode=${O_DB:-bundled}
  case "$SETUP" in *'"bundledDatabase":true'*) bundled=true ;; esac
  [ "$O_DB" != bundled ] || [ $bundled = true ] || die "$(t dbBundledMissing)"
  # Everything this step needs came with the command: a refusal ends the run instead of asking again
  given=
  [ "$O_DB" = bundled ] && given=1
  [ "$O_DB" = external ] && [ -n "$O_DB_HOST" ] && [ -n "${G_DB_PASSWORD:-}" ] && given=1
  while :; do
    if [ -n "$O_DB" ]; then mode=$O_DB
    elif [ $bundled = true ]; then
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
      [ -n "$O_DB_HOST" ] || DB_HOST=$(need "$(t dbHost)" "$DB_HOST")
      if [ -z "$O_DB_PORT" ]; then
        while :; do
          DB_PORT=$(ask "$(t dbPort)" "$DB_PORT")
          valid_port "$DB_PORT" && break
          note "$(t badPort)"
        done
      fi
      [ -n "$O_DB_NAME" ] || DB_NAME=$(need "$(t dbName)" "$DB_NAME")
      [ -n "$O_DB_USER" ] || DB_USER=$(need "$(t dbUser)" "$DB_USER")
      [ -n "${G_DB_PASSWORD:-}" ] || DB_PASSWORD=$(secret "$(t password)")
    fi
    call_waiting "$(t dbConnecting)" POST /setup/database "$(db_body "$mode")"
    [ "$CODE" = 200 ] && break
    [ -n "$given" ] && die "$(why)"
    note "$(why)"
  done
  # The installer steps aside for the real server, which answers once it has started
  wait_setup '"needsDatabase":false' "$(t starting)"
}

admin_body() {
  printf '{%s,%s,%s}' "$(jstr username "$A_USER")" "$(jstr password "$A_PASSWORD")" "$(jstr locale "$L")"
}

# The same checks as the web form, in the same order: username, a password, the repeated password
admin_step() {
  A_USER=${O_ADMIN:-admin} A_PASSWORD=$O_PASSWORD
  given=
  [ -n "$O_ADMIN" ] && [ -n "${G_PASSWORD:-}" ] && given=1
  [ -n "$given" ] || note "$(t step 2) · $(t adminTitle)

$(t adminHint)"
  while :; do
    if [ -z "$O_ADMIN" ]; then
      while :; do
        A_USER=$(need "$(t username)" "$A_USER" "$(t usernameHint)")
        valid_user "$A_USER" && break
        note "$(t invalidUsername)"
      done
    fi
    if [ -z "${G_PASSWORD:-}" ]; then
      while :; do
        A_PASSWORD=$(secret "$(t password)")
        if [ -z "$A_PASSWORD" ]; then note "$(t required "$(t password)")"; continue; fi
        again=$(secret "$(t confirm)")
        [ "$A_PASSWORD" = "$again" ] && break
        note "$(t mismatch)"
      done
    fi
    call_waiting "$(t creating)" POST /setup/admin "$(admin_body)"
    [ "$CODE" = 201 ] && break
    [ -n "$given" ] && die "$(why)"
    note "$(why)"
    # Someone finished the installation meanwhile (the web installer, another console)
    [ "$CODE" = 409 ] && exit 1
  done
  if [ -n "$given" ]; then [ $UI = box ] && clear; t finished "$SHOWN" "$A_USER"; return; fi
  note "$(t finished "$SHOWN" "$A_USER")"
  if [ $UI = box ]; then clear; t finished "$SHOWN" "$A_USER"; fi
}

# --- Run ---

# Answers given with the command are checked before anything is done with them
case "$O_DB" in '' | bundled | external) ;; *) die "$(t badDb)" ;; esac
if [ -n "$O_DB_PORT" ] && ! valid_port "$O_DB_PORT"; then die "--db-port: $(t badPort)"; fi
if [ -n "$O_ADMIN" ] && ! valid_user "$O_ADMIN"; then die "--admin: $(t invalidUsername)"; fi
if [ -n "${G_PASSWORD:-}" ] && [ -z "$O_PASSWORD" ]; then die "--password: $(t required "$(t password)")"; fi

wait_setup
SETUP=$OUT
case "$SETUP" in *'"needsAdmin":false'*) note "$(t installed)"; exit 0 ;; esac

if [ -z "$O_LANG" ]; then
  args=
  for l in $LOCALES; do args="$args ${l%%:*} ${l#*:}"; done
  # shellcheck disable=SC2086
  L=$(choose "$(t language)" "$L" $args)
fi

case "$SETUP" in *'"needsDatabase":true'*) database_step ;; esac
# A database chosen anew may already hold an installation
case "$OUT" in *'"needsAdmin":false'*) note "$(t installed)"; exit 0 ;; esac
admin_step
