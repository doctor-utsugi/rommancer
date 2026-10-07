#!/bin/sh
# Rommancer Sync for Linux handhelds (Onion, muOS, Knulli, Batocera, ROCKNIX) and PCs.
# POSIX sh for busybox: needs curl or wget, sha1sum and base64.
#
#   rommancer-sync.sh link SERVER   pair this device (shows a code to approve in the web app)
#   rommancer-sync.sh sync          one sync pass
#   rommancer-sync.sh daemon        sync whenever a save changes, and every few minutes
#   rommancer-sync.sh install       start the daemon at boot and sync when a game ends (Knulli, Batocera)
#   rommancer-sync.sh status | unlink
#   rommancer-sync.sh               link if needed, then start the daemon in the background
set -u
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
TAB="$(printf '\t')"
mkdir -p "$STATE" "$WORK"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG" 2>/dev/null; }
say() { printf '%s\n' "$*"; log "$*"; }
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
sha1() { sha1sum "$1" 2>/dev/null | cut -d' ' -f1; }

SERVER=""
TOKEN=""
[ -f "$CONF" ] && . "$CONF"

# http METHOD URL BODYFILE OUTFILE [HEADER...]; BODYFILE "-" = no body, OUTFILE "-" = stdout
http() {
  m="$1"; u="$2"; body="$3"; out="$4"; shift 4
  [ -n "$TOKEN" ] && set -- "$@" "X-Device-Token: $TOKEN"
  n=$#
  if command -v curl >/dev/null 2>&1; then
    while [ "$n" -gt 0 ]; do set -- "$@" -H "$1"; shift; n=$((n - 1)); done
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

# Shows the pairing code where the user can see it
show_code() {
  msg="Open $2 and enter code $1"
  printf '\n  ==============================\n    Rommancer: %s\n  ==============================\n  %s\n  (or scan %s)\n\n' "$1" "$msg" "$3"
  printf '%s\n%s\n' "$1" "$msg" > "$STATE/code.txt"
  ip=/mnt/SDCARD/.tmp_update/bin/infoPanel
  [ -x "$ip" ] && "$ip" -t "Rommancer" -m "Code: $1  -  $2" --auto >/dev/null 2>&1 &
}

# ---------- commands ----------

cmd_link() {
  [ -n "${1:-}" ] && SERVER="${1%/}"
  [ -n "$SERVER" ] || { say "Usage: $0 link http://server:port"; exit 2; }
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
        printf 'SERVER=%s\nTOKEN=%s\n' "$SERVER" "$TOKEN" > "$CONF"; chmod 600 "$CONF"
        rm -f "$STATE/code.txt"
        say "Linked to $SERVER as \"$NAME\" ($FW)"; return 0 ;;
    esac
  done
  say "Code expired, run link again"; exit 1
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

# Hash with cache keyed by size and mtime (saves rarely change, states can be large)
cached_sha1() {
  f="$1"; meta="$(stat -c '%s %Y' "$f" 2>/dev/null)" || return 1
  hit="$(grep -F "$f$TAB$meta$TAB" "$CACHE" 2>/dev/null | head -n 1 | cut -f3)"
  if [ -n "$hit" ]; then printf '%s' "$hit"; return 0; fi
  s="$(sha1 "$f")" || return 1
  printf '%s\t%s\t%s\n' "$f" "$meta" "$s" >> "$CACHE"
  printf '%s' "$s"
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
    is_rom "$f" && printf 'rom\t%s\n' "$f" >> "$out"
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
  if ! mkdir "$LOCK" 2>/dev/null; then log "sync already running"; return 0; fi
  trap 'rmdir "$LOCK" 2>/dev/null' EXIT INT TERM
  req="$WORK/request"; plan="$WORK/plan"
  if ! touch "$STATE/.write-test" 2>/dev/null; then
    log "storage is read-only, skipping sync"; rmdir "$LOCK"; return 1
  fi
  rm -f "$STATE/.write-test"
  build_request "$req" || { log "server unreachable"; rmdir "$LOCK"; return 1; }
  http POST "$SERVER/api/v1/agent/sync" "$req" "$plan" || { log "sync request failed"; rmdir "$LOCK"; return 1; }
  ups=0; downs=0; errs=0
  while IFS="$TAB" read -r action p a b; do
    case "$action" in
      put)
        if http POST "$SERVER/api/v1/agent/upload" "$p" - "X-Rom-B64: $(b64 "$a")" "X-Path-B64: $(b64 "$p")" >/dev/null; then ups=$((ups + 1)); else errs=$((errs + 1)); fi ;;
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

cmd_daemon() {
  need_link
  echo $$ > "$STATE/pid"
  last=""; since=$FULL_SECONDS
  while :; do
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
    *) say "No automatic install for $FW yet; run '$self daemon' at startup" ;;
  esac
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
  link) shift; cmd_link "${1:-}" ;;
  sync) VERBOSE=1 cmd_sync ;;
  daemon) cmd_daemon ;;
  install) cmd_install ;;
  status) cmd_status ;;
  unlink) cmd_unlink ;;
  "")
    [ -n "$TOKEN" ] || cmd_link "${ROMMANCER_SERVER:-}"
    VERBOSE=1 cmd_sync
    cmd_install
    nohup "$0" daemon >/dev/null 2>&1 &
    echo "Syncing in the background" ;;
  *) echo "Usage: $0 [link SERVER|sync|daemon|install|status|unlink]"; exit 2 ;;
esac
