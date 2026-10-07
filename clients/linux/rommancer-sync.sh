#!/bin/sh
# Rommancer Sync for Linux handhelds (Onion, muOS, Knulli, Batocera, ROCKNIX) and PCs.
# POSIX sh for busybox: needs curl or wget, sha1sum and base64.
#
#   rommancer-sync.sh link SERVER   pair this device (shows a code to approve in the web app)
#   rommancer-sync.sh enroll        pair with the one-time token of an installer package (enroll.txt)
#   rommancer-sync.sh sync          one sync pass
#   rommancer-sync.sh daemon        sync whenever a save changes, and every few minutes
#   rommancer-sync.sh setup         on-screen setup with the gamepad (Onion)
#   rommancer-sync.sh install       start the daemon at boot and sync when a game ends (Knulli, Batocera)
#   rommancer-sync.sh update        fetch a newer client from the server (the daemon does it by itself)
#   rommancer-sync.sh status | unlink
#   rommancer-sync.sh               link if needed, then start the daemon in the background
set -u
CLIENT_VERSION=20261007
# Onion keeps curl (with TLS) and friends outside the default PATH
[ -d /mnt/SDCARD/.tmp_update/bin ] && PATH="/mnt/SDCARD/.tmp_update/bin:$PATH"

DIR="$(cd "$(dirname "$0")" && pwd)"
STATE="${ROMMANCER_STATE:-$DIR/.rommancer}"
CONF="$STATE/config"
CACHE="$STATE/hashes"
LOG="$STATE/log"
# Transient files go to RAM: fewer writes to the SD card, and they survive a read-only card
WORK="${TMPDIR:-/tmp}/rommancer-$(id -u 2>/dev/null || echo 0)"
LOCK="$WORK/lock"
WATCH_SECONDS="${ROMMANCER_WATCH_SECONDS:-15}"
FULL_SECONDS="${ROMMANCER_FULL_SECONDS:-300}"
# Roms up to this size are hashed (once, cached) so games are recognised whatever their file name
HASH_MAX="${ROMMANCER_HASH_MAX:-67108864}"
TAB="$(printf '\t')"
mkdir -p "$STATE" "$WORK"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG" 2>/dev/null; }
say() { printf '%s\n' "$*"; log "$*"; }
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
sha1() { sha1sum "$1" 2>/dev/null | cut -d' ' -f1; }

SERVER=""
TOKEN=""
USER=""
[ -f "$CONF" ] && . "$CONF"
USER_NAME="$USER"
# Installer packages bring the server address (and a one-time enrolment token) next to the script
[ -z "$SERVER" ] && [ -f "$DIR/server.txt" ] && SERVER="$(head -n 1 "$DIR/server.txt" | tr -d '\r ')"

# http METHOD URL BODYFILE OUTFILE [HEADER...]; BODYFILE "-" = no body, OUTFILE "-" = stdout
http() {
  m="$1"; u="$2"; body="$3"; out="$4"; shift 4
  [ -n "$TOKEN" ] && set -- "$@" "X-Device-Token: $TOKEN"
  n=$#
  if command -v curl >/dev/null 2>&1; then
    while [ "$n" -gt 0 ]; do set -- "$@" -H "$1"; shift; n=$((n - 1)); done
    # Some firmwares (Onion) ship curl without root certificates: use the bundle next to the script
    [ -f "$DIR/cacert.pem" ] && set -- "$@" --cacert "$DIR/cacert.pem"
    [ "$body" != "-" ] && set -- "$@" --data-binary "@$body"
    if [ "$out" = "-" ]; then curl -fsS --connect-timeout 5 --max-time 120 -X "$m" "$@" "$u"
    else curl -fsS --connect-timeout 5 --max-time 120 -X "$m" "$@" -o "$out" "$u"; fi
  else
    # busybox wget: POST when there is a body, GET otherwise
    while [ "$n" -gt 0 ]; do set -- "$@" "--header=$1"; shift; n=$((n - 1)); done
    [ "$body" != "-" ] && set -- "$@" "--post-file=$body"
    wget -q -T 30 -O "$out" "$@" "$u"
  fi
}

# Handhelds without a battery-backed clock boot in the past, and TLS then rejects valid certificates
fix_clock() {
  [ "$(date +%Y%m%d)" -ge "$CLIENT_VERSION" ] && return 0
  command -v ntpdate >/dev/null 2>&1 && ntpdate -u pool.ntp.org >/dev/null 2>&1 && log "clock set by NTP: $(date)"
  return 0
}

# ---------- detection ----------

detect() {
  FW=""; ROOT=""; MODEL=""
  if [ -d /mnt/SDCARD/.tmp_update ]; then
    FW=onion; ROOT=/mnt/SDCARD
    if [ -f /customer/app/axp_test ]; then MODEL="Miyoo Mini Plus"; else MODEL="Miyoo Mini"; fi
  elif [ -d /mnt/mmc/MUOS ]; then
    FW=muos; ROOT=/mnt/mmc
  elif [ -d /userdata/system ]; then
    ROOT=/userdata
    if [ -d /usr/share/knulli ] || grep -qi knulli /etc/issue 2>/dev/null; then FW=knulli; else FW=batocera; fi
  elif grep -qi rocknix /etc/os-release 2>/dev/null; then
    FW=rocknix; ROOT=/storage
  else
    FW=retroarch-desktop; ROOT="${HOME:-/root}"
  fi
  [ -n "${ROMMANCER_FIRMWARE:-}" ] && FW="$ROMMANCER_FIRMWARE"
  [ -n "${ROMMANCER_ROOT:-}" ] && ROOT="$ROMMANCER_ROOT"
  [ -z "$MODEL" ] && [ -r /sys/firmware/devicetree/base/model ] && MODEL="$(tr -d '\0' < /sys/firmware/devicetree/base/model)"
  [ -z "$MODEL" ] && [ -r /sys/class/dmi/id/product_name ] && MODEL="$(cat /sys/class/dmi/id/product_name)"
  NAME="${ROMMANCER_NAME:-$(hostname 2>/dev/null || echo device)}"
}

# On-screen message on Onion (infoPanel); "wait" blocks until a button, otherwise it stays until dismissed
panel() {
  ip=/mnt/SDCARD/.tmp_update/bin/infoPanel
  [ -x "$ip" ] || return 0
  touch /tmp/dismiss_info_panel; sleep 0.2; rm -f /tmp/dismiss_info_panel
  if [ "${3:-}" = wait ]; then "$ip" -t "$1" -m "$2" >/dev/null 2>&1
  else "$ip" -t "$1" -m "$2" --persistent >/dev/null 2>&1 & fi
}
panel_close() { touch /tmp/dismiss_info_panel; }

# Shows the pairing code where the user can see it
show_code() {
  msg="Open $2 and enter code $1"
  printf '\n  ==============================\n    Rommancer: %s\n  ==============================\n  %s\n  (or scan %s)\n\n' "$1" "$msg" "$3"
  printf '%s\n%s\n' "$1" "$msg" > "$STATE/code.txt"
  panel "Rommancer Sync" "Open $2 and enter code $1"
}

# ---------- commands ----------

cmd_link() {
  [ -n "${1:-}" ] && SERVER="${1%/}"
  [ -n "$SERVER" ] || { say "Usage: $0 link http://server:port"; exit 2; }
  fix_clock
  detect
  TOKEN=""
  form="name=$(urlenc "$NAME")&firmware=$(urlenc "$FW")&root=$(urlenc "$ROOT")&model=$(urlenc "$MODEL")"
  printf '%s' "$form" > "$WORK/form"
  resp="$(http POST "$SERVER/api/v1/link/start" "$WORK/form" - "Content-Type: application/x-www-form-urlencoded")" || { say "Cannot reach $SERVER"; exit 1; }
  code="$(field code "$resp")"; secret="$(field secret "$resp")"; url="$(field url "$resp")"; qr="$(field qr "$resp")"
  interval="$(field interval "$resp")"; expires="$(field expires "$resp")"
  show_code "$code" "$url" "$qr"
  waited=0
  while [ "$waited" -lt "${expires:-900}" ]; do
    sleep "${interval:-3}"; waited=$((waited + ${interval:-3}))
    r="$(http GET "$SERVER/api/v1/link/poll?secret=$secret" - -)" || continue
    case "$r" in
      pending*) ;;
      expired*) say "Code expired, run link again"; exit 1 ;;
      token*)
        TOKEN="$(field token "$r")"
        save_link
        rm -f "$STATE/code.txt"
        panel_close
        say "Linked to $SERVER as \"$NAME\" ($FW)"; return 0 ;;
    esac
  done
  say "Code expired, run link again"; exit 1
}

save_link() {
  printf 'SERVER=%s\nTOKEN=%s\nUSER=%s\n' "$SERVER" "$TOKEN" "${USER_NAME:-}" > "$CONF"; chmod 600 "$CONF"
}

# One-time token from an installer package: the device registers itself, no code to type
cmd_enroll() {
  [ -n "$SERVER" ] && [ -f "$DIR/enroll.txt" ] || return 1
  fix_clock
  detect
  TOKEN=""
  form="name=$(urlenc "$NAME")&firmware=$(urlenc "$FW")&root=$(urlenc "$ROOT")&model=$(urlenc "$MODEL")&token=$(urlenc "$(head -n 1 "$DIR/enroll.txt" | tr -d '\r ')")"
  printf '%s' "$form" > "$WORK/form"
  resp="$(http POST "$SERVER/api/v1/link/enroll" "$WORK/form" - "Content-Type: application/x-www-form-urlencoded")" || { say "Enrolment failed (server unreachable or token already used)"; return 1; }
  TOKEN="$(field token "$resp")"
  [ -n "$TOKEN" ] || return 1
  save_link
  rm -f "$DIR/enroll.txt"
  say "Enrolled in $SERVER as \"$NAME\" ($FW)"
}

field() { printf '%s\n' "$2" | sed -n "s/^$1$TAB//p" | head -n 1; }

urlenc() {
  printf '%s' "$1" | od -An -tx1 -v | tr -s ' \n' '\n\n' | while read -r x; do
    case "$x" in
      3[0-9]|4[1-9a-f]|5[0-9a]|6[1-9a-f]|7[0-9a]|2d|2e|5f|7e) printf "\\$(printf '%03o' "0x$x")" ;;
      '') ;;
      *) printf '%%%s' "$x" ;;
    esac
  done
}

need_link() { [ -n "$TOKEN" ] || { say "Not linked. Run: $0 link http://server:port"; exit 2; }; }

# Hash with cache keyed by size and mtime; SKIP > 0 hashes without that many leading bytes (rom headers)
cached_sha1() {
  f="$1"; skip="${2:-0}"; meta="$(stat -c '%s %Y' "$f" 2>/dev/null)" || return 1
  key="$f"; [ "$skip" -gt 0 ] && key="$f#$skip"
  hit="$(grep -F "$key$TAB$meta$TAB" "$CACHE" 2>/dev/null | head -n 1 | cut -f3)"
  if [ -n "$hit" ]; then printf '%s' "$hit"; return 0; fi
  if [ "$skip" -gt 0 ]; then s="$(tail -c +$((skip + 1)) "$f" | sha1sum | cut -d' ' -f1)"; else s="$(sha1 "$f")"; fi
  [ -n "$s" ] || return 1
  printf '%s\t%s\t%s\n' "$key" "$meta" "$s" >> "$CACHE"
  printf '%s' "$s"
}

# Bytes of header that DATs leave out, by extension (and the 512-byte SNES copier header by size)
header_size() {
  case "$(printf '%s' "$1" | tr 'A-Z' 'a-z')" in
    *.nes|*.fds) echo 16 ;;
    *.lnx) echo 64 ;;
    *.a78) echo 128 ;;
    *.smc|*.sfc|*.swc|*.fig) [ $(( $(stat -c %s "$1") % 1024 )) -eq 512 ] && echo 512 || echo 0 ;;
    *) echo 0 ;;
  esac
}

rom_line() {
  f="$1"; size="$(stat -c %s "$f" 2>/dev/null)" || return 0
  if [ "${size:-0}" -gt "$HASH_MAX" ]; then printf 'rom\t%s\n' "$f"; return 0; fi
  full="$(cached_sha1 "$f")"; hs="$(header_size "$f")"; hl=""
  [ "$hs" -gt 0 ] && hl="$(cached_sha1 "$f" "$hs")"
  printf 'rom\t%s\t%s\t%s\n' "$f" "$full" "$hl"
}

is_save() {
  n="$(printf '%s' "$1" | tr 'A-Z' 'a-z')"
  for e in $EXTS; do
    case "$n" in *"$e"|*"$e"[0-9]|*"$e".auto) return 0 ;; esac
  done
  return 1
}

is_rom() {
  case "$(printf '%s' "$1" | tr 'A-Z' 'a-z')" in
    *.png|*.jpg|*.jpeg|*.mp4|*.xml|*.txt|*.json|*.cfg|*.db|*.ini|*.pdf|*.srm|*.sav|*.state*|*.ss[0-9]|*.mcd|*.mcr|*.dsv|*.cht|*.log|*.sh|*.lpl) return 1 ;;
  esac
  is_save "$1" && return 1
  return 0
}

# Writes the sync request: every rom plus every save file with its sha1
build_request() {
  out="$1"; : > "$out"
  roots="$(http GET "$SERVER/api/v1/agent/roots" - -)" || return 1
  ROMS="$(field roms "$roots")"; EXTS="$(field exts "$roots")"
  find "$ROMS" -mindepth 2 -maxdepth 2 -type f 2>/dev/null | while IFS= read -r f; do
    case "$f" in */.*|*"$TAB"*) continue ;; esac
    is_rom "$f" && rom_line "$f" >> "$out"
  done
  printf '%s\n' "$roots" | sed -n "s/^saves$TAB//p" | while IFS= read -r d; do
    find "$d" -type f 2>/dev/null | while IFS= read -r f; do
      case "$f" in */.*|*"$TAB"*) continue ;; esac
      is_save "$f" || continue
      s="$(cached_sha1 "$f")" && printf 'file\t%s\t%s\n' "$f" "$s" >> "$out"
    done
  done
}

cmd_sync() {
  need_link
  if ! mkdir "$LOCK" 2>/dev/null; then
    # Interactive syncs wait for the background one instead of doing nothing
    [ -n "${VERBOSE:-}" ] || { log "sync already running"; return 0; }
    n=0; while ! mkdir "$LOCK" 2>/dev/null; do sleep 1; n=$((n + 1)); [ "$n" -lt 600 ] || return 1; done
  fi
  trap 'rmdir "$LOCK" 2>/dev/null' EXIT INT TERM
  req="$WORK/request"; plan="$WORK/plan"
  if ! touch "$STATE/.write-test" 2>/dev/null; then
    log "storage is read-only, skipping sync"; rmdir "$LOCK"; return 1
  fi
  rm -f "$STATE/.write-test"
  fix_clock
  build_request "$req" || { log "server unreachable"; rmdir "$LOCK"; return 1; }
  http POST "$SERVER/api/v1/agent/sync" "$req" "$plan" || { log "sync request failed"; rmdir "$LOCK"; return 1; }
  ups=0; downs=0; errs=0
  while IFS="$TAB" read -r action p a b; do
    case "$action" in
      put)
        rh="$(grep -F "rom$TAB$a$TAB" "$req" | head -n 1 | cut -f3,4 | tr '\t' ',')"
        if http POST "$SERVER/api/v1/agent/upload" "$p" - "X-Rom-B64: $(b64 "$a")" "X-Path-B64: $(b64 "$p")" "X-Rom-Sha1: $rh" "X-Save-Exact: ${b:-0}" >/dev/null; then ups=$((ups + 1)); else errs=$((errs + 1)); fi ;;
      get)
        mkdir -p "$(dirname "$p")"
        if http GET "$SERVER/api/v1/agent/file?v=$a" - "$p.rommancer-tmp" "X-Rom-B64: $(b64 "$b")" "X-Path-B64: $(b64 "$p")" && mv "$p.rommancer-tmp" "$p"; then
          downs=$((downs + 1))
        else rm -f "$p.rommancer-tmp"; errs=$((errs + 1)); fi ;;
    esac
  done < "$plan"
  log "sync: $ups up, $downs down, $errs errors"
  [ -n "${VERBOSE:-}" ] && printf 'sync: %s up, %s down, %s errors\n' "$ups" "$downs" "$errs"
  rmdir "$LOCK" 2>/dev/null
  trap - EXIT INT TERM
  return 0
}

# Cheap change detector: sizes and mtimes of the save files
fingerprint() {
  [ -n "${SAVE_DIRS:-}" ] || return 0
  printf '%s\n' "$SAVE_DIRS" | while IFS= read -r d; do
    find "$d" -type f 2>/dev/null | while IFS= read -r f; do is_save "$f" && stat -c '%n %s %Y' "$f" 2>/dev/null; done
  done | cksum
}

# Self-update from the server: files whose sha1 differs from the server's copy are replaced.
# rename() keeps the running shell on the old inode; prints "restart" when this script changed.
cmd_update() {
  need_link
  man="$(http GET "$SERVER/api/v1/link/client/manifest" - -)" || return 1
  printf '%s\n' "$man" | while IFS="$TAB" read -r kind name hash; do
    [ "$kind" = file ] || continue
    case "$name" in */*|.*|"") continue ;; esac
    target="$DIR/$name"
    # Only what this device uses: the script always, the setup app's files where the app is installed
    case "$name" in
      rommancer-sync.sh|cacert.pem) ;;
      *) [ -f "$DIR/rommancer-ui.py" ] || continue ;;
    esac
    [ -f "$target" ] && [ "$(sha1 "$target")" = "$hash" ] && continue
    http GET "$SERVER/api/v1/link/client/file/$name" - "$WORK/update.tmp" || continue
    [ "$(sha1 "$WORK/update.tmp")" = "$hash" ] || { log "update: bad download of $name"; continue; }
    cp "$WORK/update.tmp" "$target.new" && chmod +x "$target.new" 2>/dev/null; mv "$target.new" "$target" && log "updated $name"
    [ "$name" = rommancer-sync.sh ] && echo restart
  done
}

cmd_daemon() {
  need_link
  echo $$ > "$STATE/pid"
  last=""; since=$FULL_SECONDS
  while :; do
    # Each full pass also checks for a newer client and restarts into it
    if [ "$since" -ge "$FULL_SECONDS" ] && [ "$(cmd_update 2>/dev/null)" = restart ]; then
      exec sh "$DIR/$(basename "$0")" daemon
    fi
    if [ -z "${SAVE_DIRS:-}" ]; then
      roots="$(http GET "$SERVER/api/v1/agent/roots" - -)" && { SAVE_DIRS="$(printf '%s\n' "$roots" | sed -n "s/^saves$TAB//p")"; EXTS="$(field exts "$roots")"; }
    fi
    fp="$(fingerprint)"
    if [ "$fp" != "$last" ] || [ "$since" -ge "$FULL_SECONDS" ]; then
      cmd_sync && { last="$(fingerprint)"; since=0; }
    fi
    sleep "$WATCH_SECONDS"; since=$((since + WATCH_SECONDS))
  done
}

# Boot and game-end hooks where the firmware offers them
cmd_install() {
  detect
  self="$DIR/$(basename "$0")"
  case "$FW" in
    knulli|batocera)
      boot=/userdata/system/custom.sh
      if ! grep -qF "rommancer-sync" "$boot" 2>/dev/null; then
        [ -f "$boot" ] || printf '#!/bin/sh\n' > "$boot"
        printf '# rommancer-sync\n[ "$1" = start ] && nohup sh "%s" daemon >/dev/null 2>&1 &\n' "$self" >> "$boot"
        chmod +x "$boot"
      fi
      mkdir -p /userdata/system/scripts
      printf '#!/bin/sh\n# rommancer-sync: upload saves when a game ends\n[ "$1" = gameStop ] && nohup sh "%s" sync >/dev/null 2>&1 &\nexit 0\n' "$self" > /userdata/system/scripts/rommancer-sync.sh
      chmod +x /userdata/system/scripts/rommancer-sync.sh
      say "Installed: daemon at boot ($boot) and sync after each game" ;;
    onion)
      boot=/mnt/SDCARD/.tmp_update/startup/rommancer-sync.sh
      mkdir -p "$(dirname "$boot")"
      printf '#!/bin/sh\n[ -f "%s" ] && (cd "%s" && sh "%s" boot >/dev/null 2>&1 &)\n' "$self" "$DIR" "$self" > "$boot"
      say "Installed: daemon at boot ($boot)" ;;
    *) say "No automatic install for $FW yet; run '$self daemon' at startup" ;;
  esac
}

# ---------- setup screens with Onion's own menu (prompt) and on-screen keyboard (kbinput) ----------

ONION_BIN="${ROMMANCER_ONION_BIN:-/mnt/SDCARD/.tmp_update/bin}"
onion_ui() { bin="$1"; shift; LD_PRELOAD=/mnt/SDCARD/miyoo/lib/libpadsp.so "$ONION_BIN/$bin" "$@"; }

# Menu: prints nothing, returns the index of the chosen item (255 = back)
menu() { title="$1"; msg="$2"; shift 2; onion_ui prompt -t "$title" -m "$msg" "$@"; }

# Keyboard: prints the text, fails when cancelled
ask() {
  onion_ui kbinput -i "$2" -t "$1" > "$WORK/kb" 2>/dev/null || return 1
  tail -n 1 "$WORK/kb"
}

tr_es() { grep -qs '"language"[^,]*es' /appconfigs/system.json; }
t() {
  if tr_es; then
    case "$1" in
      server) echo "Servidor" ;; login) echo "Entrar" ;; signup) echo "Crear cuenta" ;; quit) echo "Salir" ;;
      user) echo "USUARIO O EMAIL" ;; username) echo "USUARIO" ;; email) echo "EMAIL" ;; password) echo "CONTRASENA" ;;
      sync) echo "Sincronizar ahora" ;; status) echo "Estado" ;; unlink) echo "Desconectar esta consola" ;;
      connected) echo "Conectado a $SERVER como ${USER_NAME:-?}" ;; notlinked) echo "Esta consola no esta vinculada" ;;
      badserver) echo "No hay un Rommancer en esa direccion" ;; badlogin) echo "Usuario o contrasena incorrectos" ;;
      closed) echo "Este servidor no permite crear cuentas" ;; finished) echo "Listo. Los saves se sincronizan solos." ;;
      syncing) echo "Sincronizando..." ;; *) echo "$1" ;;
    esac
  else
    case "$1" in
      server) echo "Server" ;; login) echo "Log in" ;; signup) echo "Create account" ;; quit) echo "Exit" ;;
      user) echo "USERNAME OR EMAIL" ;; username) echo "USERNAME" ;; email) echo "EMAIL" ;; password) echo "PASSWORD" ;;
      sync) echo "Sync now" ;; status) echo "Status" ;; unlink) echo "Unlink this console" ;;
      connected) echo "Connected to $SERVER as ${USER_NAME:-?}" ;; notlinked) echo "This console is not linked" ;;
      badserver) echo "No Rommancer at that address" ;; badlogin) echo "Wrong username or password" ;;
      closed) echo "This server does not allow new accounts" ;; finished) echo "Done. Saves now sync by themselves." ;;
      syncing) echo "Syncing..." ;; *) echo "$1" ;;
    esac
  fi
}

# POST a device form to /link/login or /link/signup and keep the token
link_with() {
  detect
  form="name=$(urlenc "$NAME")&firmware=$(urlenc "$FW")&root=$(urlenc "$ROOT")&model=$(urlenc "$MODEL")$1"
  printf '%s' "$form" > "$WORK/form"
  TOKEN=""
  resp="$(http POST "$SERVER/api/v1/link/$2" "$WORK/form" - "Content-Type: application/x-www-form-urlencoded")" || return 1
  TOKEN="$(field token "$resp")"; USER_NAME="$(field user "$resp")"
  [ -n "$TOKEN" ] || return 1
  save_link
}

setup_after_link() {
  panel "Rommancer Sync" "$(t syncing)"
  VERBOSE=1 cmd_sync > "$WORK/first-sync" 2>&1
  cmd_install > /dev/null 2>&1
  if ! { [ -f "$STATE/pid" ] && kill -0 "$(cat "$STATE/pid")" 2>/dev/null; }; then
    nohup sh "$DIR/$(basename "$0")" daemon >/dev/null 2>&1 &
  fi
  panel_close
  panel "Rommancer Sync" "$(t finished) $(tail -n 1 "$WORK/first-sync")" wait
}

cmd_setup() {
  [ -x "$ONION_BIN/prompt" ] && [ -x "$ONION_BIN/kbinput" ] || { say "setup needs Onion's prompt and kbinput"; exit 2; }
  fix_clock
  # An installer package links by itself with its token
  if [ -z "$TOKEN" ] && [ -f "$DIR/enroll.txt" ] && cmd_enroll > /dev/null 2>&1; then setup_after_link; fi
  [ -n "$SERVER" ] || SERVER="https://"
  while :; do
    if [ -n "$TOKEN" ]; then
      menu "Rommancer Sync" "$(t connected)" "$(t sync)" "$(t status)" "$(t unlink)" "$(t quit)"; rc=$?
      case $rc in
        0) panel "Rommancer Sync" "$(t syncing)"; VERBOSE=1 cmd_sync > "$WORK/sync" 2>&1; panel_close
           panel "Rommancer Sync" "$(tail -n 1 "$WORK/sync")" wait ;;
        1) panel "$(t status)" "$(tail -n 4 "$LOG" 2>/dev/null | cut -c21- | tr '\n' ' ')" wait ;;
        2) keep="$SERVER"; cmd_unlink > /dev/null; TOKEN=""; USER_NAME=""; SERVER="$keep" ;;
        *) return 0 ;;
      esac
    else
      menu "Rommancer Sync" "$(t notlinked)" "$(t server): $SERVER" "$(t login)" "$(t signup)" "$(t quit)"; rc=$?
      case $rc in
        0) v="$(ask "$(t server)" "$SERVER")" && SERVER="${v%/}" ;;
        1|2)
          info="$(http GET "$SERVER/api/v1/link/info" - -)" || { panel "Rommancer Sync" "$(t badserver)" wait; continue; }
          if [ "$rc" -eq 1 ]; then
            u="$(ask "$(t user)" "")" || continue
            p="$(ask "$(t password)" "")" || continue
            if link_with "&username=$(urlenc "$u")&password=$(urlenc "$p")" login; then setup_after_link; else panel "Rommancer Sync" "$(t badlogin)" wait; fi
          else
            [ "$(field signup "$info")" = 1 ] || { panel "Rommancer Sync" "$(t closed)" wait; continue; }
            u="$(ask "$(t username)" "")" || continue
            e="$(ask "$(t email)" "")" || continue
            p="$(ask "$(t password)" "")" || continue
            if link_with "&username=$(urlenc "$u")&email=$(urlenc "$e")&password=$(urlenc "$p")" signup; then setup_after_link; else panel "Rommancer Sync" "$(t badlogin)" wait; fi
          fi ;;
        *) return 0 ;;
      esac
    fi
  done
}

cmd_status() {
  if [ -n "$TOKEN" ]; then echo "Linked to $SERVER"; else echo "Not linked"; fi
  if [ -f "$STATE/pid" ] && kill -0 "$(cat "$STATE/pid")" 2>/dev/null; then echo "Daemon running (pid $(cat "$STATE/pid"))"; else echo "Daemon stopped"; fi
  tail -n 5 "$LOG" 2>/dev/null
}

cmd_unlink() {
  [ -f "$STATE/pid" ] && kill "$(cat "$STATE/pid")" 2>/dev/null
  rm -f "$CONF" "$STATE/pid" "$CACHE"
  echo "Unlinked"
}

case "${1:-}" in
  link) shift; cmd_link "${1:-$SERVER}" ;;
  enroll) cmd_enroll ;;
  hints) detect; printf 'name\t%s\nfirmware\t%s\nroot\t%s\nmodel\t%s\nstate\t%s\n' "$NAME" "$FW" "$ROOT" "$MODEL" "$STATE" ;;
  sync) VERBOSE=1 cmd_sync ;;
  daemon) cmd_daemon ;;
  install) cmd_install ;;
  setup) cmd_setup ;;
  update) cmd_update ;;
  boot)
    # At power-on: sync in the background if linked (or linkable with a package token); never ask anything
    [ -n "$TOKEN" ] || cmd_enroll > /dev/null 2>&1 || exit 0
    nohup sh "$DIR/$(basename "$0")" daemon >/dev/null 2>&1 & ;;
  status) cmd_status ;;
  unlink) cmd_unlink ;;
  "")
    if [ -z "$TOKEN" ]; then
      [ -n "${ROMMANCER_SERVER:-}" ] && SERVER="$ROMMANCER_SERVER"
      cmd_enroll || cmd_link "$SERVER"
    fi
    panel "Rommancer Sync" "Syncing saves..."
    VERBOSE=1 cmd_sync > "$WORK/first-sync" 2>&1; cat "$WORK/first-sync"
    cmd_install > /dev/null
    if ! { [ -f "$STATE/pid" ] && kill -0 "$(cat "$STATE/pid")" 2>/dev/null; }; then
      nohup sh "$DIR/$(basename "$0")" daemon >/dev/null 2>&1 &
    fi
    panel_close
    panel "Rommancer Sync" "Linked to $SERVER. $(tail -n 1 "$WORK/first-sync"). Saves now sync in the background." wait
    echo "Syncing in the background" ;;
  *) echo "Usage: $0 [link SERVER|sync|daemon|install|status|unlink]"; exit 2 ;;
esac
