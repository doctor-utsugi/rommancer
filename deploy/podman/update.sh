#!/bin/sh
# Updates Rommancer to a new release, or puts the previous one back (rollback). Run by rommancer.sh update|rollback,
# from a copy outside the folder it replaces. Every step can be undone until the new version answers:
#   1. download the release and unpack it next to the current folder (nothing running is touched)
#   2. build its images, tagged with its version; the running ones are kept as :previous
#   3. dump the database into UPDATE_DIR/backups
#   4. swap the folders and start the new version, which applies its migrations as it starts
#   5. wait until it answers with its version; otherwise put back the old images, folder and database dump
# Progress goes to UPDATE_DIR/status.json (the update page reads it) and UPDATE_DIR/update.log.
#   update.sh update [--check] [--from FILE|URL] [--to VERSION] [--yes] [--request]
# --request: asked from the update page; the version comes from UPDATE_DIR/request
#   update.sh rollback [--yes]
set -eu
SRC=${ROMMANCER_SRC:?}
ENGINE=${ROMMANCER_ENGINE:?}
WEB_PORT=${ROMMANCER_WEB_PORT:-8096}
UPD=${ROMMANCER_UPDATE_DIR:?}
REPO=${ROMMANCER_REPO:-doctor-utsugi/rommancer}
# Where releases are downloaded from (vVERSION/rommancer.tar.gz under it): GitHub, or a mirror
RELEASES=${ROMMANCER_RELEASES_URL:-https://github.com/$REPO/releases/download}
NET=rommancer
LANG_UI=${LANG:-}
RS="$SRC/deploy/podman/rommancer.sh"
PREV="$SRC.previous"
NEW="$SRC.new"
LOG="$UPD/update.log"
IMAGES='rommancer-mysql rommancer-api rommancer-web'
# How long the new version may take to answer: migrations of a large collection take a while
WAIT_S=${ROMMANCER_UPDATE_WAIT:-1800}

say() {
  case "$LANG_UI" in
    es*) case "$1" in
      current) echo "Versión instalada: $2" ;;
      latest) echo "Última publicada:  $2" ;;
      uptodate) echo "Rommancer ya está al día." ;;
      git) echo "Esta carpeta es un repositorio de git: actualízala con git pull y luego build y up." ;;
      busy) echo "Ya hay una actualización en marcha. Si no es así, borra $UPD/lock." ;;
      noLatest) echo "No he podido saber cuál es la última versión (¿hay conexión con github.com?)." ;;
      confirm) echo "¿Actualizar Rommancer de la $2 a la $3? Antes se guarda una copia de la base de datos." ;;
      download) echo "Descargando Rommancer $2…" ;;
      bad) echo "Lo descargado no es un release de Rommancer." ;;
      older) echo "La $2 no es más nueva que la instalada ($3): no se instala una versión anterior." ;;
      build) echo "Preparando las imágenes de la $2 (unos minutos)…" ;;
      backup) echo "Guardando una copia de la base de datos en $2…" ;;
      start) echo "Arrancando la $2: aplica sus migraciones al arrancar…" ;;
      done) echo "Rommancer está actualizado a la $2. Si algo va mal: $3 rollback" ;;
      failed) echo "La $2 no ha arrancado bien. Vuelvo a la $3 tal como estaba…" ;;
      rolledBack) echo "Rommancer vuelve a estar en la $2, con la base de datos de antes de actualizar. Lo que pasó está en $3" ;;
      buildFailed) echo "No se han podido preparar las imágenes de la $2. No se ha cambiado nada; lo que pasó está en $3" ;;
      noPrevious) echo "No hay una versión anterior guardada a la que volver." ;;
      backupFailed) echo "No se ha podido copiar la base de datos, así que no actualizo. No se ha cambiado nada; lo que pasó está en $2" ;;
      stopped) echo "Rommancer no está en marcha. Arráncalo primero: $2 start" ;;
      backFailed) echo "He vuelto a la $2, pero no responde. Mira $3 y los logs (rommancer.sh logs). La copia de la base de datos sigue en $UPD/backups." ;;
      confirmBack) echo "¿Volver a la $2? La base de datos vuelve a como estaba antes de actualizar ($3): lo que haya cambiado desde entonces se pierde." ;;
      yn) echo s/N ;;
    esac ;;
    *) case "$1" in
      current) echo "Installed version: $2" ;;
      latest) echo "Latest release:    $2" ;;
      uptodate) echo "Rommancer is up to date." ;;
      git) echo "This folder is a git repository: update it with git pull, then build and up." ;;
      busy) echo "An update is already running. If none is, delete $UPD/lock." ;;
      noLatest) echo "Could not find out the latest version (can this computer reach github.com?)." ;;
      confirm) echo "Update Rommancer from $2 to $3? The database is backed up first." ;;
      download) echo "Downloading Rommancer $2…" ;;
      bad) echo "What was downloaded is not a Rommancer release." ;;
      older) echo "$2 is not newer than the installed $3: an older version is never installed over a newer one." ;;
      build) echo "Preparing the images of $2 (a few minutes)…" ;;
      backup) echo "Backing up the database into $2…" ;;
      start) echo "Starting $2: it applies its migrations as it starts…" ;;
      done) echo "Rommancer is updated to $2. If something is wrong: $3 rollback" ;;
      failed) echo "$2 did not start properly. Going back to $3 as it was…" ;;
      rolledBack) echo "Rommancer is back on $2, with the database as it was before the update. What happened is in $3" ;;
      buildFailed) echo "The images of $2 could not be prepared. Nothing was changed; what happened is in $3" ;;
      noPrevious) echo "There is no previous version kept to go back to." ;;
      backupFailed) echo "The database could not be backed up, so nothing is updated. Nothing was changed; what happened is in $2" ;;
      stopped) echo "Rommancer is not running. Start it first: $2 start" ;;
      backFailed) echo "Went back to $2, but it does not answer. Look at $3 and the logs (rommancer.sh logs). The database backup is still in $UPD/backups." ;;
      confirmBack) echo "Go back to $2? The database goes back to how it was before the update ($3): whatever changed since is lost." ;;
      yn) echo y/N ;;
    esac ;;
  esac
}

version_of() { cat "$1/VERSION" 2>/dev/null || echo dev; }

# Negative, zero or positive as x.y.z version $1 is older than, equal to or newer than $2
vcmp() {
  printf '%s\n%s\n' "$1" "$2" | awk -F. 'NR == 1 { a = $1 * 1e8 + $2 * 1e4 + $3 } NR == 2 { b = $1 * 1e8 + $2 * 1e4 + $3 } END { print (a < b ? -1 : a > b ? 1 : 0) }'
}

# The step under way, for the update page: state running|done|failed|rolledback
status() {
  mkdir -p "$UPD"
  printf '{"state":"%s","step":"%s","from":"%s","to":"%s","at":"%s","pid":%s}\n' "$1" "$2" "${FROM:-}" "${TO:-}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" > "$UPD/status.json.new"
  mv "$UPD/status.json.new" "$UPD/status.json"
}

latest() {
  curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1
}

ask() {
  [ -n "$YES" ] && return 0
  [ -t 0 ] || return 0
  printf '%s [%s]: ' "$1" "$(say yn)" >&2
  IFS= read -r a || a=
  case "$a" in [sSyY]*) return 0 ;; *) exit 1 ;; esac
}

# The database's connection, asked to the running API (it knows the bundled database's generated password), kept in
# DB_HOST DB_PORT DB_USER DB_PASS DB_NAME: a restore may happen while the API is down
db_conn() {
  conn=$($ENGINE exec rommancer-api node --input-type=module -e "
    await import('/app/backend/dist/config/bootstrap.js');
    const u = new URL(process.env.DATABASE_URL);
    console.log([u.hostname, u.port || '3306', decodeURIComponent(u.username), decodeURIComponent(u.password), u.pathname.slice(1).split('?')[0]].join('\\n'));") || return 1
  DB_HOST=$(echo "$conn" | sed -n 1p) DB_PORT=$(echo "$conn" | sed -n 2p) DB_USER=$(echo "$conn" | sed -n 3p)
  DB_PASS=$(echo "$conn" | sed -n 4p) DB_NAME=$(echo "$conn" | sed -n 5p)
  [ -n "$DB_HOST" ] && [ -n "$DB_NAME" ]
}

# A MySQL client tool from Rommancer's MySQL image $1, run against the database on Rommancer's network
db_tool() {
  image=$1 tool=$2
  shift 2
  $ENGINE run --rm -i --network "$NET" -e MYSQL_PWD="$DB_PASS" --entrypoint "$tool" "$image" -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$@"
}

backup_db() {
  mkdir -p "$UPD/backups"
  BACKUP="$UPD/backups/before-$TO-$(date +%Y%m%d-%H%M%S).sql.gz"
  say backup "$BACKUP"
  db_conn || return 1
  # The whole database, recreated from scratch when restored: tables a half-applied migration made go too
  db_tool rommancer-mysql:previous mysqldump --single-transaction --no-tablespaces --add-drop-database --databases "$DB_NAME" | gzip > "$BACKUP.part"
  # mysqldump's last line says it finished: a dump cut short is no backup
  gunzip -c "$BACKUP.part" | tail -n 1 | grep -q 'Dump completed' || { rm -f "$BACKUP.part"; return 1; }
  mv "$BACKUP.part" "$BACKUP"
  # The last five are enough
  ls -1t "$UPD/backups"/before-*.sql.gz 2>/dev/null | tail -n +6 | while IFS= read -r f; do rm -f "$f"; done
}

restore_db() {
  # The dump names its database: mysql reads it with none chosen
  gunzip -c "$1" | db_tool rommancer-mysql:latest mysql
}

# Whether the API answers with version $1 within WAIT_S; gives up early when its container keeps failing
answers() {
  t=0
  while [ "$t" -lt "$WAIT_S" ]; do
    v=$(curl -fsS -m 5 "http://127.0.0.1:$WEB_PORT/api/v1/health" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
    [ "$v" = "$1" ] && return 0
    restarts=$($ENGINE inspect -f '{{.RestartCount}}' rommancer-api 2>/dev/null || echo 0)
    running=$($ENGINE inspect -f '{{.State.Running}}' rommancer-api 2>/dev/null || echo false)
    [ "${restarts:-0}" -ge 2 ] && return 1
    [ "$running" = true ] || [ "$t" -lt 30 ] || return 1
    sleep 5
    t=$((t + 5))
  done
  return 1
}

# Images, folder and database back as they were before the update
roll_back() {
  for i in $IMAGES; do $ENGINE tag "$i:previous" "$i:latest"; done
  if [ -d "$PREV" ]; then
    rm -rf "$SRC.failed"
    mv "$SRC" "$SRC.failed"
    mv "$PREV" "$SRC"
  fi
  # The old version's containers, with the database as the dump left it
  $ENGINE stop rommancer-api >/dev/null 2>&1 || true
  [ -n "${BACKUP:-}" ] && restore_db "$BACKUP"
  sh "$RS" up
}

# Rommancer's images are kept only for the versions given (and :latest, :previous): older ones only take disk
prune_images() {
  $ENGINE images --format '{{.Repository}}:{{.Tag}}' | grep -E '(^|/)rommancer-(mysql|api|web):' | while IFS= read -r ref; do
    tag=${ref##*:}
    case " latest previous $* " in *" $tag "*) continue ;; esac
    $ENGINE rmi "$ref" >/dev/null 2>&1 || true
  done
}

lock() {
  mkdir -p "$UPD"
  if ! mkdir "$UPD/lock" 2>/dev/null; then say busy >&2; exit 1; fi
  trap 'rm -rf "$UPD/lock" "$NEW" "$UPD/request"' EXIT
}

update() {
  CHECK='' FROM_SRC='' WANT='' YES=''
  while [ $# -gt 0 ]; do
    case "$1" in
      --check) CHECK=1 ;;
      --from) FROM_SRC=${2:-}; shift ;;
      --to) WANT=${2#v}; shift ;;
      --yes) YES=1 ;;
      --request)
        YES=1
        WANT=$(sed -n 's/.*"to":"\([^"]*\)".*/\1/p' "$UPD/request" 2>/dev/null || true)
        rm -f "$UPD/request" ;;
    esac
    shift
  done
  FROM=$(version_of "$SRC")
  [ -d "$SRC/.git" ] && { say git >&2; exit 1; }
  say current "$FROM"
  [ "$($ENGINE inspect -f '{{.State.Running}}' rommancer-api 2>/dev/null)" = true ] || { say stopped "sh $RS" >&2; exit 1; }
  if [ -z "$FROM_SRC" ]; then
    TO=${WANT:-$(latest)}
    [ -n "$TO" ] || { say noLatest >&2; exit 1; }
    say latest "$TO"
    if [ "$FROM" != dev ] && [ "$(vcmp "$TO" "$FROM")" -le 0 ]; then say uptodate; exit 0; fi
    [ -n "$CHECK" ] && exit 0
    FROM_SRC="${RELEASES%/}/v$TO/rommancer.tar.gz"
  fi
  [ -n "$CHECK" ] && exit 0
  lock
  status running download

  # 1. The release, unpacked next to the current folder
  rm -rf "$NEW"
  mkdir -p "$NEW"
  say download "${TO:-$FROM_SRC}"
  case "$FROM_SRC" in
    http*) curl -fsSL "$FROM_SRC" | tar -xz -C "$NEW" --strip-components=1 ;;
    *) tar -xzf "$FROM_SRC" -C "$NEW" --strip-components=1 ;;
  esac
  [ -f "$NEW/deploy/podman/rommancer.sh" ] && [ -f "$NEW/VERSION" ] || { say bad >&2; status failed download; exit 1; }
  TO=$(version_of "$NEW")
  if [ "$FROM" != dev ] && [ "$(vcmp "$TO" "$FROM")" -le 0 ]; then say older "$TO" "$FROM" >&2; status failed download; exit 1; fi
  ask "$(say confirm "$FROM" "$TO")"

  # 2. Its images; the running ones stay as :previous until the next update
  status running build
  say build "$TO"
  for i in $IMAGES; do
    $ENGINE tag "$i:latest" "$i:previous"
  done
  if ! sh "$NEW/deploy/podman/rommancer.sh" build; then
    for i in $IMAGES; do $ENGINE tag "$i:previous" "$i:latest"; done
    status failed build
    say buildFailed "$TO" "$LOG" >&2
    exit 1
  fi

  # 3. The database as it is now
  status running backup
  if ! backup_db; then
    for i in $IMAGES; do $ENGINE tag "$i:previous" "$i:latest"; done
    status failed backup
    say backupFailed "$LOG" >&2
    exit 1
  fi

  # 4. The new folder in place, and the new version started: its migrations run before it answers
  status running start
  rm -rf "$PREV" "$SRC.failed"
  mv "$SRC" "$PREV"
  mv "$NEW" "$SRC"
  say start "$TO"
  if sh "$RS" up && answers "$TO"; then
    prune_images "$TO" "$FROM"
    status "done" finished
    say "done" "$TO" "sh $RS"
    return 0
  fi

  # 5. It did not come up: everything back
  status running rollback
  say failed "$TO" "$FROM" >&2
  $ENGINE logs --tail 200 rommancer-api >> "$LOG" 2>&1 || true
  roll_back
  prune_images "$FROM"
  if answers "$FROM"; then
    status rolledback rollback
    say rolledBack "$FROM" "$LOG" >&2
  else
    status failed rollback
    say backFailed "$FROM" "$LOG" >&2
  fi
  exit 1
}

rollback() {
  YES=''
  [ "${1:-}" = --yes ] && YES=1
  [ -d "$PREV" ] || { say noPrevious >&2; exit 1; }
  FROM=$(version_of "$SRC") TO=$(version_of "$PREV")
  BACKUP=$(ls -1t "$UPD/backups/before-$FROM-"*.sql.gz 2>/dev/null | head -n 1)
  ask "$(say confirmBack "$TO" "${BACKUP:-?}")"
  [ -z "$BACKUP" ] || db_conn || { say stopped "sh $RS" >&2; exit 1; }
  lock
  status running rollback
  roll_back
  if answers "$TO"; then
    status rolledback rollback
    say rolledBack "$TO" "$LOG"
  else
    status failed rollback
    say backFailed "$TO" "$LOG" >&2
    exit 1
  fi
}

mkdir -p "$UPD"
cmd=${1:-update}
[ $# -gt 0 ] && shift
# Everything said goes to the log as well, for the update page and for whoever has to look into a failure
RC="$UPD/.rc.$$"
{ (
  case "$cmd" in
    update) update "$@" ;;
    rollback) rollback "$@" ;;
    *) sed -n '9,12p' "$0"; exit 2 ;;
  esac
); echo $? > "$RC"; } 2>&1 | tee -a "$LOG"
rc=$(cat "$RC" 2>/dev/null || echo 1)
rm -f "$RC"
exit "$rc"
