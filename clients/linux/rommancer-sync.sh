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
#   rommancer-sync.sh roms          download the roms of the lists assigned to this device
#   rommancer-sync.sh conflicts | resolve ID device|server
#   rommancer-sync.sh game-start ROM   fetch that rom's saves (called by firmware game events)
#   rommancer-sync.sh game-stop        upload saves after a game (called by firmware game events)
#   rommancer-sync.sh set AUTO_ROMS 0|1
#   rommancer-sync.sh status | unlink
#   rommancer-sync.sh               link if needed, then start the daemon in the background
#
#   rommancer-sync.sh sd MOUNT [link SERVER|sync|status|unlink]
#                                   an SD card from a console without network (Nintendo DS with TWiLight
#                                   Menu++...) mounted on this computer; the link lives on the card itself,
#                                   so any computer with this script can sync it. Without a command: sync.
set -u
CLIENT_VERSION=20261010
# Onion keeps curl (with TLS) and friends outside the default PATH
[ -d /mnt/SDCARD/.tmp_update/bin ] && PATH="/mnt/SDCARD/.tmp_update/bin:$PATH"

DIR="$(cd "$(dirname "$0")" && pwd)"
SD=""
if [ "${1:-}" = sd ]; then
  [ -d "${2:-}" ] || { echo "Usage: $0 sd MOUNT [link SERVER|sync|status|unlink]"; exit 2; }
  SD="$(cd "$2" && pwd)"; shift 2
  [ $# -gt 0 ] || set -- all
  # The card is the device: its link, settings and hashes travel with it
  ROMMANCER_STATE="$SD/.rommancer"; ROMMANCER_ROOT="$SD"
  ROMMANCER_FIRMWARE="${ROMMANCER_FIRMWARE:-nds-twilight}"
  ROMMANCER_MODEL="${ROMMANCER_MODEL:-Nintendo DS}"
  ROMMANCER_NAME="${ROMMANCER_NAME:-$ROMMANCER_MODEL SD}"
fi
STATE="${ROMMANCER_STATE:-$DIR/.rommancer}"
CONF="$STATE/config"
CACHE_DISK="$STATE/hashes"
LOG="$STATE/log"
# Transient files go to RAM: fewer writes to the SD card, and they survive a read-only card
WORK="${TMPDIR:-/tmp}/rommancer-$(id -u 2>/dev/null || echo 0)"
# Each card gets its own lock and progress, apart from a daemon this computer may be running
[ -n "$SD" ] && WORK="$WORK-sd-$(printf '%s' "$SD" | cksum | cut -d' ' -f1)"
LOCK="$WORK/lock"
# The sync lock holds its owner's pid: a lock left by a process that died (power cut, killed run) is taken over
take_lock() {
  if mkdir "$LOCK" 2>/dev/null; then echo $$ > "$LOCK/pid"; return 0; fi
  owner="$(cat "$LOCK/pid" 2>/dev/null)"
  if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null && echo $$ > "$LOCK/pid" && return 0; fi
  return 1
}
drop_lock() { rm -rf "$LOCK" 2>/dev/null; }
WATCH_SECONDS="${ROMMANCER_WATCH_SECONDS:-15}"
FULL_SECONDS="${ROMMANCER_FULL_SECONDS:-300}"
# Roms up to this size are hashed (once, cached) so games are recognised whatever their file name
HASH_MAX="${ROMMANCER_HASH_MAX:-67108864}"
TAB="$(printf '\t')"
mkdir -p "$STATE" "$WORK"
# Hashes are cached in RAM while syncing and written to the card once at the end: a console
# switched off during thousands of small writes is how FAT cards end up read-only
CACHE="$WORK/hashes"
[ -f "$CACHE" ] || cp "$CACHE_DISK" "$CACHE" 2>/dev/null || : > "$CACHE"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG" 2>/dev/null; }
say() { printf '%s\n' "$*"; log "$*"; }
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
sha1() { sha1sum "$1" 2>/dev/null | cut -d' ' -f1; }

SERVER=""
TOKEN=""
USER=""
[ -f "$CONF" ] && . "$CONF"
USER_NAME="$USER"
# Per-device preferences kept apart from the link: AUTO_ROMS=1 downloads the lists' roms by itself
SETTINGS="$STATE/settings"
AUTO_ROMS=1
# ALLOW_PULL=1 lets the server fetch roms it lacks from this device (only when asked from the web app)
ALLOW_PULL=1
# ALLOW_SSH=1 adds the server's key to this console's SSH server, so the server can sync it while the
# daemon is not running (asleep, not started yet); 0 removes the key
ALLOW_SSH=1
[ -f "$SETTINGS" ] && . "$SETTINGS"
set_setting() { grep -v "^$1=" "$SETTINGS" 2>/dev/null > "$WORK/settings"; echo "$1=$2" >> "$WORK/settings"; mv "$WORK/settings" "$SETTINGS"; }
# Installer packages bring the server address (and a one-time enrolment token) next to the script
[ -z "$SERVER" ] && [ -f "$DIR/server.txt" ] && SERVER="$(head -n 1 "$DIR/server.txt" | tr -d '\r ')"

# http METHOD URL BODYFILE OUTFILE [HEADER...]; BODYFILE "-" = no body, OUTFILE "-" = stdout.
# One retry: home routers drop the odd DNS lookup and a whole sync should not fail for it
http() {
  http_once "$@" && return 0
  sleep 2
  http_once "$@"
}

http_once() {
  m="$1"; u="$2"; body="$3"; out="$4"; shift 4
  [ -n "$TOKEN" ] && set -- "$@" "X-Device-Token: $TOKEN"
  # The card may be mounted somewhere else than last time: the server rewrites its paths
  [ -n "$SD" ] && [ -n "$TOKEN" ] && set -- "$@" "X-Device-Root-B64: $(b64 "$SD")"
  n=$#
  if command -v curl >/dev/null 2>&1; then
    while [ "$n" -gt 0 ]; do set -- "$@" -H "$1"; shift; n=$((n - 1)); done
    # Some firmwares (Onion) ship curl without root certificates: use the bundle next to the script
    [ -f "$DIR/cacert.pem" ] && set -- "$@" --cacert "$DIR/cacert.pem"
    [ "$body" != "-" ] && set -- "$@" --data-binary "@$body"
    if [ "$out" = "-" ]; then curl -fsS --globoff --connect-timeout 5 --max-time "${HTTP_MAX:-120}" -X "$m" "$@" "$u"
    else curl -fsS --globoff --connect-timeout 5 --max-time "${HTTP_MAX:-1800}" -X "$m" "$@" -o "$out" "$u"; fi
  else
    # busybox wget: POST when there is a body, GET otherwise
    while [ "$n" -gt 0 ]; do set -- "$@" "--header=$1"; shift; n=$((n - 1)); done
    if [ "$body" != "-" ]; then set -- "$@" "--post-file=$body"
    elif [ "$m" = POST ]; then set -- "$@" "--post-data="; fi
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
  [ -n "${ROMMANCER_MODEL:-}" ] && MODEL="$ROMMANCER_MODEL"
  [ -z "$MODEL" ] && [ -r /sys/firmware/devicetree/base/model ] && MODEL="$(tr -d '\0' < /sys/firmware/devicetree/base/model)"
  [ -z "$MODEL" ] && [ -r /sys/class/dmi/id/product_name ] && MODEL="$(cat /sys/class/dmi/id/product_name)"
  NAME="${ROMMANCER_NAME:-$(hostname 2>/dev/null || echo device)}"
}

# Onion dialogs fit about 40 characters per line and turn a literal \n into a line break
wrap() { printf '%s' "$1" | awk -v w=36 '{ n = split($0, a, " "); for (i = 1; i <= n; i++) { if (length(l) > 0 && length(l) + 1 + length(a[i]) > w) { if (o != "") o = o "\\n"; o = o l; l = a[i] } else if (l == "") l = a[i]; else l = l " " a[i] } } END { if (o != "") o = o "\\n"; o = o l; printf "%s", o }'; }

# On-screen message on Onion (infoPanel); "wait" blocks until a button, otherwise it stays until dismissed
panel() {
  ip=/mnt/SDCARD/.tmp_update/bin/infoPanel
  [ -x "$ip" ] || return 0
  touch /tmp/dismiss_info_panel; sleep 0.2; rm -f /tmp/dismiss_info_panel
  msg="$(wrap "$2")"
  # A waiting panel opened right after a menu choice would take that same button press and close
  if [ "${3:-}" = wait ]; then sleep 0.6; (cd /mnt/SDCARD/.tmp_update && "$ip" -t "$1" -m "$msg" >/dev/null 2>&1)
  else (cd /mnt/SDCARD/.tmp_update && "$ip" -t "$1" -m "$msg" --persistent >/dev/null 2>&1 &) fi
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
  # rom, path, sha1, headerless sha1, size (big files go unhashed, with their size)
  if [ "${size:-0}" -gt "$HASH_MAX" ]; then printf 'rom\t%s\t\t\t%s\n' "$f" "$size"; return 0; fi
  full="$(cached_sha1 "$f")"; hs="$(header_size "$f")"; hl=""
  [ "$hs" -gt 0 ] && hl="$(cached_sha1 "$f" "$hs")"
  printf 'rom\t%s\t%s\t%s\t%s\n' "$f" "$full" "$hl" "$size"
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
# Progress for the setup screens: "phase<TAB>done<TAB>total" in RAM
progress() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" > "$WORK/progress.tmp" && mv "$WORK/progress.tmp" "$WORK/progress"; }

# Writes the sync request: every rom plus every save file with its sha1
build_request() {
  out="$1"; : > "$out"
  progress connecting 0 0
  roots="$(http GET "$SERVER/api/v1/agent/roots" - -)" || return 1
  ROMS="$(field roms "$roots")"; EXTS="$(field exts "$roots")"
  find "$ROMS" -mindepth 2 -maxdepth 2 -type f 2>/dev/null > "$WORK/roms"
  total="$(wc -l < "$WORK/roms")"; i=0
  while IFS= read -r f; do
    i=$((i + 1)); [ $((i % 10)) -eq 0 ] && progress roms "$i" "$total"
    case "$f" in */.*|*"$TAB"*) continue ;; esac
    is_rom "$f" && rom_line "$f" >> "$out"
  done < "$WORK/roms"
  printf '%s\n' "$roots" | sed -n "s/^saves$TAB//p" | while IFS= read -r d; do find "$d" -type f 2>/dev/null; done > "$WORK/saves"
  total="$(wc -l < "$WORK/saves")"; i=0
  while IFS= read -r f; do
    i=$((i + 1)); [ $((i % 10)) -eq 0 ] && progress saves "$i" "$total"
    case "$f" in */.*|*"$TAB"*) continue ;; esac
    is_save "$f" || continue
    s="$(cached_sha1 "$f")" && printf 'file\t%s\t%s\n' "$f" "$s" >> "$out"
  done < "$WORK/saves"
  save_cache
}

save_cache() {
  cmp -s "$CACHE" "$CACHE_DISK" 2>/dev/null && return 0
  cp "$CACHE" "$CACHE_DISK.new" 2>/dev/null && mv "$CACHE_DISK.new" "$CACHE_DISK"
}

cmd_sync() {
  need_link
  # A sync asked for on screen goes first: background passes step aside while it waits
  if [ -z "${VERBOSE:-}" ] && [ -f "$WORK/priority" ]; then log "background sync skipped (one was asked for on screen)"; return 0; fi
  if ! take_lock; then
    [ -n "${VERBOSE:-}" ] || { log "sync already running"; return 0; }
    touch "$WORK/priority"
    progress waiting 0 0
    n=0; while ! take_lock; do sleep 1; n=$((n + 1)); [ "$n" -lt 600 ] || { rm -f "$WORK/priority"; return 1; }; done
  fi
  rm -f "$WORK/priority"
  trap 'drop_lock' EXIT
  trap 'drop_lock; exit 1' INT TERM
  req="$WORK/request"; plan="$WORK/plan"
  if ! touch "$STATE/.write-test" 2>/dev/null; then
    log "storage is read-only, skipping sync"; drop_lock; return 1
  fi
  rm -f "$STATE/.write-test"
  fix_clock
  build_request "$req" || { log "server unreachable"; drop_lock; return 1; }
  progress server 0 0
  # Free and total bytes of the roms' storage: the server copies list roms only while a reserve is kept
  space="$(df -k "$ROMS" 2>/dev/null | awk 'NR == 2 { printf "%.0f %.0f", $4 * 1024, $2 * 1024 }')"
  http POST "$SERVER/api/v1/agent/sync" "$req" "$plan" "X-Allow-Pull: $ALLOW_PULL" "X-Ssh: $(ssh_offer)" "X-Client-Path-B64: $(b64 "$DIR/$(basename "$0")")" "X-Space: ${space:-}" "X-Wifi-Bands: $(wifi_bands)" || { log "sync request failed"; drop_lock; return 1; }
  ups=0; downs=0; errs=0; moved=0; total="$(grep -c . "$plan")"
  while IFS="$TAB" read -r action p a b; do
    moved=$((moved + 1)); progress transfer "$moved" "$total"
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
  progress finished "$ups" "$downs"
  log "sync: $ups up, $downs down, $errs errors"
  # The last log lines go to the server so problems can be seen without access to the device
  { tail -n 40 "$LOG"; [ -f "$DIR/last-run.txt" ] && { echo "--- last-run.txt"; tail -n 20 "$DIR/last-run.txt"; }; } > "$WORK/report" 2>/dev/null
  http POST "$SERVER/api/v1/agent/log" "$WORK/report" - "X-Client-Version: $CLIENT_VERSION" >/dev/null 2>&1
  [ -n "${VERBOSE:-}" ] && printf 'sync: %s up, %s down, %s errors\n' "$ups" "$downs" "$errs"
  drop_lock
  trap - EXIT INT TERM
  return 0
}

# What the WiFi chip can use ("dual" or "2.4"), so the server only hands it networks it can see
wifi_bands() {
  [ -n "$SD" ] && return 0
  [ -n "${ROMMANCER_WIFI_BANDS+set}" ] && { printf '%s' "$ROMMANCER_WIFI_BANDS"; return 0; }
  if command -v iw >/dev/null 2>&1; then
    f="$(iw list 2>/dev/null)"
  elif command -v iwlist >/dev/null 2>&1; then
    f="$(iwlist wlan0 freq 2>/dev/null | sed -n 's/.*: \([0-9]\)\.\([0-9]\{3\}\).* GHz.*/* \1\2 MHz/p')"
  else return 0; fi
  if printf '%s\n' "$f" | grep -q '\* 5[0-9][0-9][0-9]'; then echo dual
  elif printf '%s\n' "$f" | grep -q '\* 24[0-9][0-9]'; then echo 2.4; fi
}

# Configuration work from the server (copies, settings, restores): send the files it names, write what it
# sends back. Never while a game runs.
# ROMMANCER_SYSROOT: where the console's own filesystem is (tests, or a mounted image)
cfg_path() { case "$1" in /*) printf '%s%s' "${ROMMANCER_SYSROOT:-}" "$1" ;; *) printf '%s/%s' "${ROOT%/}" "$1" ;; esac; }
cfg_send() {
  cf="$(cfg_path "$2")"
  if [ -f "$cf" ]; then http POST "$SERVER/api/v1/agent/config/file/$1" "$cf" - "X-Path-B64: $(b64 "$2")" "Content-Type: application/octet-stream" >/dev/null
  else http POST "$SERVER/api/v1/agent/config/file/$1" - - "X-Path-B64: $(b64 "$2")" "X-Missing: 1" >/dev/null; fi
}
cmd_config() {
  need_link
  if playing; then log "config: a game is running, later"; return 0; fi
  [ -n "${ROOT:-}" ] || detect
  chan=agent; [ -n "$SD" ] && chan=sd
  rounds=0
  while [ "$rounds" -lt 5 ]; do
    rounds=$((rounds + 1))
    cplan="$WORK/config-plan"; cput="$WORK/config-put"
    http GET "$SERVER/api/v1/agent/config/plan" - "$cplan" "X-Channel: $chan" || return 0
    op="$(awk -F"$TAB" '$1 == "op" { print $2; exit }' "$cplan")"
    [ -n "$op" ] || return 0
    while IFS="$TAB" read -r kind cp _; do
      case "$kind" in
        get) cfg_send "$op" "$cp" ;;
        dir)
          base="$(cfg_path "$cp")"
          find "$base" -type f 2>/dev/null | head -n 200 | while IFS= read -r cf2; do cfg_send "$op" "$cp${cf2#"$base"}"; done ;;
      esac
    done < "$cplan"
    http POST "$SERVER/api/v1/agent/config/ready/$op" - "$cput" || return 1
    [ -s "$cput" ] || { log "config: $op done, nothing to change"; continue; }
    cerr=""
    while IFS="$TAB" read -r kind n cp mode; do
      dest="$(cfg_path "$cp")"
      case "$kind" in
        del) rm -f "$dest" || cerr="$cp" ;;
        put)
          mkdir -p "$(dirname "$dest")" 2>/dev/null
          if http GET "$SERVER/api/v1/agent/config/out/$op/$n" - "$dest.rommancer-tmp" && { [ -z "$mode" ] || chmod "$mode" "$dest.rommancer-tmp"; } && mv "$dest.rommancer-tmp" "$dest"; then :
          else rm -f "$dest.rommancer-tmp"; cerr="$cp"; fi ;;
      esac
    done < "$cput"
    sync
    if [ -z "$cerr" ]; then printf 'ok' > "$WORK/config-done"; else printf 'error\twriteFailed:%s' "$cerr" > "$WORK/config-done"; fi
    http POST "$SERVER/api/v1/agent/config/done/$op" "$WORK/config-done" - "Content-Type: text/plain" >/dev/null
    log "config: $op applied${cerr:+ (failed: $cerr)}"
  done
}

# "user@address:port" when an SSH server listens here and the server's key is installed, "0" otherwise
ssh_offer() {
  [ -z "$SD" ] || return 0
  home="$(awk -F: -v u="$(id -u)" '$3 == u { print $6; exit }' /etc/passwd 2>/dev/null)"; home="${home:-${HOME:-/root}}"
  keys="$home/.ssh/authorized_keys"
  if [ "$ALLOW_SSH" != 1 ]; then
    grep -q rommancer-server "$keys" 2>/dev/null && { grep -v rommancer-server "$keys" > "$WORK/keys"; cat "$WORK/keys" > "$keys"; }
    echo 0; return 0
  fi
  # Port 22 listening (0016 in hex, state 0A)
  awk '$4 == "0A" && $2 ~ /:0016$/ { f = 1 } END { exit !f }' /proc/net/tcp /proc/net/tcp6 2>/dev/null || { echo 0; return 0; }
  key="$(HTTP_MAX=10 http GET "$SERVER/api/v1/agent/ssh-key" - - 2>/dev/null)"
  case "$key" in
    ssh-*" rommancer-server")
      # Replaces a key left by an earlier server
      if ! grep -qxF "$key" "$keys" 2>/dev/null; then
        mkdir -p "$home/.ssh" 2>/dev/null && chmod 700 "$home/.ssh" 2>/dev/null
        { grep -v rommancer-server "$keys" 2>/dev/null; printf '%s\n' "$key"; } > "$WORK/keys" && cat "$WORK/keys" > "$keys" && chmod 600 "$keys" && log "ssh: server key added to $keys"
      fi ;;
  esac
  addr="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n 1)"
  [ -n "$addr" ] || addr="$(hostname -i 2>/dev/null | cut -d' ' -f1)"
  case "$addr" in ""|127.*) echo 0 ;; *) printf '%s@%s:22\n' "$(id -un 2>/dev/null || echo root)" "$addr" ;; esac
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
  # One daemon per device: a second one would keep taking the sync lock from the first
  if [ -f "$STATE/pid" ]; then
    other="$(cat "$STATE/pid")"
    if [ "$other" != $$ ] && kill -0 "$other" 2>/dev/null && grep -q "rommancer-sync" "/proc/$other/cmdline" 2>/dev/null; then exit 0; fi
  fi
  echo $$ > "$STATE/pid"
  cmd_install > /dev/null 2>&1
  last=""; since=$FULL_SECONDS
  while :; do
    # Each full pass also checks for a newer client and restarts into it
    if [ "$since" -ge "$FULL_SECONDS" ] && [ "$(cmd_update 2>/dev/null)" = restart ]; then
      exec sh "$DIR/$(basename "$0")" daemon
    fi
    if [ -z "${SAVE_DIRS:-}" ]; then
      roots="$(http GET "$SERVER/api/v1/agent/roots" - -)" && { SAVE_DIRS="$(printf '%s\n' "$roots" | sed -n "s/^saves$TAB//p")"; EXTS="$(field exts "$roots")"; }
    fi
    # The web app can ask for a sync now or for roms: a tiny request on every watch tick
    asked="$(HTTP_MAX=5 http_once GET "$SERVER/api/v1/agent/poll" - - 2>/dev/null)"
    case "$asked" in *sync*) since=$FULL_SECONDS ;; esac
    # Roms for the server go in the background: saves keep syncing while a long copy runs
    case "$asked" in *pull*) pulls_running || (nohup sh "$DIR/$(basename "$0")" pulls > /dev/null 2>&1 &) ;; esac
    fp="$(fingerprint)"
    # A game may still be writing its save: go ahead only once the files stay unchanged for a moment
    if [ "$fp" != "$last" ] && [ -n "$last" ]; then
      sleep 3; since=$((since + 3))
      [ "$(fingerprint)" = "$fp" ] || fp="$last"
    fi
    if [ "$fp" != "$last" ] || [ "$since" -ge "$FULL_SECONDS" ]; then
      full=$since
      cmd_sync && { last="$(fingerprint)"; since=0; }
      [ "$full" -ge "$FULL_SECONDS" ] && cmd_config > /dev/null 2>&1
      [ "$full" -ge "$FULL_SECONDS" ] && [ "$AUTO_ROMS" = 1 ] && cmd_roms > /dev/null 2>&1
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
      # Our lines in custom.sh are replaced on every install so updates change them too
      [ -f "$boot" ] || printf '#!/bin/sh\n' > "$boot"
      grep -v "rommancer-sync" "$boot" > "$WORK/custom.sh"
      printf '[ "$1" = start ] && sh "%s" boot # rommancer-sync\n' "$self" >> "$WORK/custom.sh"
      cmp -s "$WORK/custom.sh" "$boot" || { cat "$WORK/custom.sh" > "$boot"; chmod +x "$boot"; }
      mkdir -p /userdata/system/scripts
      # Batocera calls this with gameStart/gameStop, the system, emulator, core and rom; gameStart waits for us
      printf '#!/bin/sh\n# rommancer-sync: fetch the save before a game, upload saves after it\ncase "$1" in\n  gameStart) sh "%s" game-start "$5" >/dev/null 2>&1 ;;\n  gameStop) nohup sh "%s" game-stop >/dev/null 2>&1 & ;;\nesac\nexit 0\n' "$self" "$self" > "$WORK/hook.sh"
      cmp -s "$WORK/hook.sh" /userdata/system/scripts/rommancer-sync.sh || cat "$WORK/hook.sh" > /userdata/system/scripts/rommancer-sync.sh
      chmod +x /userdata/system/scripts/rommancer-sync.sh
      # Knulli has a Tools section; the shared Knulli/Batocera installer puts the launcher in Ports
      if [ "$FW" = knulli ] && [ -f "/userdata/roms/ports/Rommancer Sync.sh" ]; then
        mkdir -p /userdata/roms/tools && mv "/userdata/roms/ports/Rommancer Sync.sh" /userdata/roms/tools/ && log "launcher moved to Tools"
      fi
      say "Installed: sync at boot ($boot), save fetched before each game and uploaded after it" ;;
    onion)
      boot=/mnt/SDCARD/.tmp_update/startup/rommancer-sync.sh
      mkdir -p "$(dirname "$boot")"
      # Onion runs startup scripts one after another before its menu: "boot" waits for the first sync
      printf '#!/bin/sh\n[ -f "%s" ] && (cd "%s" && sh "%s" boot >/dev/null 2>&1)\n' "$self" "$DIR" "$self" > "$WORK/boot.sh"
      cmp -s "$WORK/boot.sh" "$boot" || cat "$WORK/boot.sh" > "$boot"
      say "Installed: daemon at boot ($boot)" ;;
    *) say "No automatic install for $FW yet; run '$self daemon' at startup" ;;
  esac
}

# ---------- roms of the lists assigned to this device ----------

free_bytes() {
  d="$1"; while [ ! -d "$d" ]; do d="$(dirname "$d")"; done
  echo $(( $(df -k "$d" 2>/dev/null | awk 'NR == 2 { print $4 }') * 1024 ))
}

# Downloads the roms the server plans for this device and that are not here yet; never deletes
cmd_roms() {
  need_link
  progress roms-plan 0 0
  http GET "$SERVER/api/v1/agent/roms" - "$WORK/romplan" || { log "roms: server unreachable"; return 1; }
  total="$(grep -c . "$WORK/romplan")"; i=0; got=0; fail=0; have=0
  while IFS="$TAB" read -r kind dest size ref; do
    [ "$kind" = rom ] || continue
    i=$((i + 1))
    # Extra fields for the screens: file size, partial file being written and rom name
    printf 'roms-download\t%s\t%s\t%s\t%s\t%s\n' "$i" "$total" "$size" "$dest.part" "$(basename "$dest")" > "$WORK/progress.tmp" && mv "$WORK/progress.tmp" "$WORK/progress"
    if [ -f "$dest" ] && { [ "$size" = 0 ] || [ "$(stat -c %s "$dest" 2>/dev/null)" = "$size" ]; }; then have=$((have + 1)); continue; fi
    if [ "$size" -gt 0 ] && [ "$(free_bytes "$(dirname "$dest")")" -lt $((size + 52428800)) ]; then
      log "roms: not enough space for $(basename "$dest")"; fail=$((fail + 1)); break
    fi
    mkdir -p "$(dirname "$dest")"
    if http GET "$SERVER/api/v1/agent/rom?f=$ref" - "$dest.part" && { [ "$size" = 0 ] || [ "$(stat -c %s "$dest.part")" = "$size" ]; }; then
      mv "$dest.part" "$dest"; got=$((got + 1))
    else
      rm -f "$dest.part"; fail=$((fail + 1))
    fi
  done < "$WORK/romplan"
  progress roms-finished "$got" "$fail"
  log "roms: $got downloaded, $have already here, $fail failed"
  [ -n "${VERBOSE:-}" ] && printf 'roms: %s downloaded, %s already here, %s failed\n' "$got" "$have" "$fail"
  return 0
}

# Right before a game starts (Knulli/Batocera event): fetch the server's saves for that rom only
cmd_game_start() {
  touch "$WORK/playing"
  rom="$1"; [ -n "$TOKEN" ] && [ -f "$rom" ] || return 0
  fix_clock
  HTTP_MAX=10
  rh="X-Rom-B64: $(b64 "$rom")"
  http GET "$SERVER/api/v1/agent/manifest" - "$WORK/gs-manifest" "$rh" || { log "game-start: offline, playing local save"; return 0; }
  : > "$WORK/gs-present"
  while IFS= read -r p; do [ -f "$p" ] && printf '%s\t%s\n' "$p" "$(sha1 "$p")" >> "$WORK/gs-present"; done < "$WORK/gs-manifest"
  http POST "$SERVER/api/v1/agent/start" "$WORK/gs-present" "$WORK/gs-plan" "$rh" || return 0
  while IFS="$TAB" read -r action p v; do
    [ "$action" = get ] || continue
    mkdir -p "$(dirname "$p")"
    http GET "$SERVER/api/v1/agent/file?v=$v" - "$p.rommancer-tmp" "$rh" "X-Path-B64: $(b64 "$p")" && mv "$p.rommancer-tmp" "$p" && log "game-start: got $(basename "$p")"
    rm -f "$p.rommancer-tmp"
  done < "$WORK/gs-plan"
  return 0
}

cmd_all() { cmd_sync; cmd_config; [ "$AUTO_ROMS" = 1 ] && cmd_roms; return 0; }

# A copy for the server is under way (a lock whose process died does not count)
pulls_running() { [ -f "$WORK/pull-lock/pid" ] && kill -0 "$(cat "$WORK/pull-lock/pid")" 2>/dev/null; }

# A game is running: the firmware's game events set the flag, and an emulator must really be running
# (a crashed game may never send its end event)
playing() {
  [ -f "$WORK/playing" ] || return 1
  ps 2>/dev/null | grep -q '[e]mulatorlauncher\|[r]etroarch' && return 0
  rm -f "$WORK/playing"; return 1
}

# Sends the roms the server asked for (streamed, one at a time); only with ALLOW_PULL=1. A copy cut
# halfway is simply sent again next time: the server keeps the request open until a whole file arrives.
cmd_pulls() {
  need_link
  [ "$ALLOW_PULL" = 1 ] || return 0
  pulls_running && return 0
  rm -rf "$WORK/pull-lock"; mkdir "$WORK/pull-lock" 2>/dev/null || return 0
  echo $$ > "$WORK/pull-lock/pid"
  trap 'rm -rf "$WORK/pull-lock"' EXIT
  trap 'rm -rf "$WORK/pull-lock"; exit 1' INT TERM
  http GET "$SERVER/api/v1/agent/pulls" - "$WORK/pulls" || { rm -rf "$WORK/pull-lock"; return 1; }
  total="$(grep -c '^pull' "$WORK/pulls")"; i=0; sent=0
  while IFS="$TAB" read -r kind id p; do
    [ "$kind" = pull ] || continue
    i=$((i + 1)); progress pulls "$i" "$total"
    # Never compete with a game for the network and the card: wait until it ends
    while playing; do sleep 20; done
    if [ ! -f "$p" ]; then
      http POST "$SERVER/api/v1/agent/pull/$id" - - "X-Missing: 1" >/dev/null 2>&1
      continue
    fi
    if command -v curl >/dev/null 2>&1; then
      # A stalled transfer (under 1 KB/s for a minute) is dropped and sent again later
      # --globoff: rom names often carry [brackets] that curl would read as a pattern
      set -- -fsS --globoff --connect-timeout 5 --max-time 7200 --speed-limit 1024 --speed-time 60 -X POST -H "X-Device-Token: $TOKEN" -T "$p"
      [ -f "$DIR/cacert.pem" ] && set -- "$@" --cacert "$DIR/cacert.pem"
      curl "$@" "$SERVER/api/v1/agent/pull/$id" > "$WORK/pull-result" 2>/dev/null
    else
      wget -q -T 60 -O "$WORK/pull-result" --header="X-Device-Token: $TOKEN" --post-file="$p" "$SERVER/api/v1/agent/pull/$id"
    fi && { sent=$((sent + 1)); log "sent $(basename "$p"): $(head -n 1 "$WORK/pull-result")"; }
  done < "$WORK/pulls"
  log "pulls: $sent of $total sent"
  [ -n "${VERBOSE:-}" ] && printf 'sent to server: %s of %s\n' "$sent" "$total"
  rm -rf "$WORK/pull-lock"
  trap - EXIT INT TERM
  return 0
}

# conflict<TAB>id<TAB>game<TAB>kind<TAB>this device's date<TAB>server date<TAB>server's device
cmd_conflicts() { need_link; http GET "$SERVER/api/v1/agent/conflicts" - -; }

cmd_resolve() {
  need_link
  printf 'keep=%s' "$2" > "$WORK/resolve"
  http POST "$SERVER/api/v1/agent/conflicts/$1" "$WORK/resolve" - "Content-Type: application/x-www-form-urlencoded" >/dev/null || return 1
  log "conflict $1: kept $2"
  VERBOSE=1 cmd_sync
}

# ---------- setup screens with Onion's own menu (prompt) and on-screen keyboard (kbinput) ----------

ONION_BIN="${ROMMANCER_ONION_BIN:-/mnt/SDCARD/.tmp_update/bin}"
# Onion's tools load their theme and fonts relative to its system folder, like Onion's own scripts do
onion_ui() {
  bin="$1"; shift
  ( cd "$ONION_BIN/.." 2>/dev/null || :; LD_PRELOAD=/mnt/SDCARD/miyoo/lib/libpadsp.so "$ONION_BIN/$bin" "$@" )
  rc=$?; log "ui: $bin -> $rc"; return $rc
}

# Menu: prints nothing, returns the index of the chosen item (255 = back)
menu() { title="$1"; msg="$(wrap "$2")"; shift 2; onion_ui prompt -t "$title" -m "$msg" "$@"; }

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
      connected) echo "Conectado como ${USER_NAME:-?} a ${SERVER#*://}" ;; notlinked) echo "Esta consola no esta vinculada" ;;
      badserver) echo "No hay un Rommancer en esa direccion" ;; badlogin) echo "Usuario o contrasena incorrectos" ;;
      closed) echo "Este servidor no permite crear cuentas" ;; finished) echo "Listo. Sincronizacion automatica activada." ;;
      syncing) echo "Sincronizando..." ;; roms) echo "Sincronizar roms" ;; autoroms) echo "Roms automaticas: $2" ;;
      allowpull) echo "Servidor puede traer juegos: $2" ;; allowssh) echo "Acceso SSH del servidor: $2" ;; p_pulls) echo "Enviando juegos al servidor" ;;
      yes) echo "si" ;; no) echo "no" ;; conflicts) echo "Conflictos ($2)" ;; noconflicts) echo "No hay conflictos" ;;
      keepdevice) echo "Quedarme con el de esta consola" ;; keepserver) echo "Usar el del servidor" ;;
      conflictinfo) echo "$2: esta consola $3, servidor $4 ($5)" ;;
      p_waiting) echo "Esperando a la sincronizacion en curso" ;; p_connecting) echo "Conectando" ;; p_roms) echo "Comprobando roms" ;;
      p_saves) echo "Comprobando saves" ;; p_server) echo "Preguntando al servidor" ;; p_transfer) echo "Transfiriendo saves" ;;
      p_roms-plan) echo "Preguntando que roms tocan" ;; p_roms-download) echo "Descargando roms" ;; p_*) echo "Trabajando..." ;; *) echo "$1" ;;
    esac
  else
    case "$1" in
      server) echo "Server" ;; login) echo "Log in" ;; signup) echo "Create account" ;; quit) echo "Exit" ;;
      user) echo "USERNAME OR EMAIL" ;; username) echo "USERNAME" ;; email) echo "EMAIL" ;; password) echo "PASSWORD" ;;
      sync) echo "Sync now" ;; status) echo "Status" ;; unlink) echo "Unlink this console" ;;
      connected) echo "Connected as ${USER_NAME:-?} to ${SERVER#*://}" ;; notlinked) echo "This console is not linked" ;;
      badserver) echo "No Rommancer at that address" ;; badlogin) echo "Wrong username or password" ;;
      closed) echo "This server does not allow new accounts" ;; finished) echo "Done. Automatic sync is on." ;;
      syncing) echo "Syncing..." ;; roms) echo "Sync roms" ;; autoroms) echo "Automatic roms: $2" ;;
      allowpull) echo "Server may fetch games: $2" ;; allowssh) echo "Server SSH access: $2" ;; p_pulls) echo "Sending games to the server" ;;
      yes) echo "yes" ;; no) echo "no" ;; conflicts) echo "Conflicts ($2)" ;; noconflicts) echo "No conflicts" ;;
      keepdevice) echo "Keep this console's save" ;; keepserver) echo "Use the server's save" ;;
      conflictinfo) echo "$2: this console $3, server $4 ($5)" ;;
      p_waiting) echo "Waiting for the running sync" ;; p_connecting) echo "Connecting" ;; p_roms) echo "Checking roms" ;;
      p_saves) echo "Checking saves" ;; p_server) echo "Asking the server" ;; p_transfer) echo "Transferring saves" ;;
      p_roms-plan) echo "Asking which roms belong here" ;; p_roms-download) echo "Downloading roms" ;; p_*) echo "Working..." ;; *) echo "$1" ;;
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

# Runs a command in the background and keeps an Onion panel updated with its phase and percentage
with_progress() {
  title="$1"; shift
  rm -f "$WORK/progress"
  ( VERBOSE=1; "$@" > "$WORK/run-out" 2>&1 ) &
  job=$!
  shown=""
  while kill -0 "$job" 2>/dev/null; do
    line="$(cat "$WORK/progress" 2>/dev/null)"
    phase="$(printf '%s' "$line" | cut -f1)"; done_n="$(printf '%s' "$line" | cut -f2)"; total="$(printf '%s' "$line" | cut -f3)"
    text="$(t "p_$phase")"
    if [ "$phase" = roms-download ] && [ "${total:-0}" -gt 0 ] 2>/dev/null; then
      # Overall share counts the finished roms plus what the current file has written so far
      fsize="$(printf '%s' "$line" | cut -f4)"; part="$(printf '%s' "$line" | cut -f5)"; name="$(printf '%s' "$line" | cut -f6)"
      cur="$(stat -c %s "$part" 2>/dev/null || echo 0)"; filepct=0
      [ "${fsize:-0}" -gt 0 ] 2>/dev/null && filepct=$((cur * 100 / fsize))
      pct=$(( ((done_n - 1) * 100 + filepct) / total ))
      bar="["; k=0; while [ "$k" -lt 10 ]; do if [ "$k" -lt $((pct / 10)) ]; then bar="$bar#"; else bar="$bar-"; fi; k=$((k + 1)); done; bar="$bar]"
      text="$text $done_n/$total $bar $pct% $(printf '%s' "$name" | cut -c1-30) ($filepct%)"
    elif [ -n "$total" ] && [ "$total" -gt 0 ] 2>/dev/null; then
      text="$text $done_n/$total ($((done_n * 100 / total))%)"
    fi
    [ "$text" != "$shown" ] && { panel "$title" "$text"; shown="$text"; }
    sleep 2
  done
  wait "$job" 2>/dev/null
  panel_close
  panel "$title" "$(tail -n 1 "$WORK/run-out")" wait
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

# Conflicts menu: pick one, then keep this console's save or the server's
setup_conflicts() {
  while :; do
    grep '^conflict' "$WORK/conflicts" > "$WORK/conflicts.list" 2>/dev/null
    n="$(grep -c . "$WORK/conflicts.list")"
    [ "$n" -gt 0 ] || { panel "Rommancer Sync" "$(t noconflicts)" wait; return 0; }
    set --
    while IFS="$TAB" read -r _ id game rest; do set -- "$@" "$(printf '%s' "$game" | cut -c1-34)"; done < "$WORK/conflicts.list"
    menu "$(t conflicts "$n")" "" "$@"; pick=$?
    [ "$pick" -lt "$n" ] || return 0
    line="$(sed -n "$((pick + 1))p" "$WORK/conflicts.list")"
    id="$(printf '%s' "$line" | cut -f2)"; game="$(printf '%s' "$line" | cut -f3)"
    mine="$(printf '%s' "$line" | cut -f5 | cut -c1-16 | tr T ' ')"; theirs="$(printf '%s' "$line" | cut -f6 | cut -c1-16 | tr T ' ')"; dev="$(printf '%s' "$line" | cut -f7)"
    menu "$(t conflicts "$n")" "$(t conflictinfo "$game" "$mine" "$theirs" "$dev")" "$(t keepdevice)" "$(t keepserver)"; rc=$?
    case $rc in
      0) panel "Rommancer Sync" "$(t syncing)"; cmd_resolve "$id" device > "$WORK/sync" 2>&1; panel_close ;;
      1) panel "Rommancer Sync" "$(t syncing)"; cmd_resolve "$id" server > "$WORK/sync" 2>&1; panel_close ;;
    esac
    cmd_conflicts > "$WORK/conflicts" 2>/dev/null || : > "$WORK/conflicts"
  done
}

cmd_setup() {
  [ -x "$ONION_BIN/prompt" ] && [ -x "$ONION_BIN/kbinput" ] || { say "setup needs Onion's prompt and kbinput"; exit 2; }
  fix_clock
  # An installer package links by itself with its token
  if [ -z "$TOKEN" ] && [ -f "$DIR/enroll.txt" ] && cmd_enroll > /dev/null 2>&1; then setup_after_link; fi
  [ -n "$SERVER" ] || SERVER="https://"
  while :; do
    if [ -n "$TOKEN" ]; then
      cmd_conflicts > "$WORK/conflicts" 2>/dev/null || : > "$WORK/conflicts"
      nconf="$(grep -c '^conflict' "$WORK/conflicts")"
      if [ "$AUTO_ROMS" = 1 ]; then auto="$(t yes)"; else auto="$(t no)"; fi
      if [ "$ALLOW_PULL" = 1 ]; then pull="$(t yes)"; else pull="$(t no)"; fi
      if [ "$ALLOW_SSH" = 1 ]; then ssh="$(t yes)"; else ssh="$(t no)"; fi
      menu "Rommancer Sync" "$(t connected)" "$(t sync)" "$(t roms)" "$(t autoroms "$auto")" "$(t allowpull "$pull")" "$(t allowssh "$ssh")" "$(t conflicts "$nconf")" "$(t status)" "$(t unlink)" "$(t quit)"; rc=$?
      case $rc in
        0) with_progress "$(t sync)" cmd_all ;;
        1) with_progress "$(t roms)" cmd_roms ;;
        2) if [ "$AUTO_ROMS" = 1 ]; then AUTO_ROMS=0; else AUTO_ROMS=1; fi; set_setting AUTO_ROMS "$AUTO_ROMS" ;;
        3) if [ "$ALLOW_PULL" = 1 ]; then ALLOW_PULL=0; else ALLOW_PULL=1; fi; set_setting ALLOW_PULL "$ALLOW_PULL" ;;
        4) if [ "$ALLOW_SSH" = 1 ]; then ALLOW_SSH=0; else ALLOW_SSH=1; fi; set_setting ALLOW_SSH "$ALLOW_SSH" ;;
        5) setup_conflicts ;;
        6) panel "$(t status)" "$(tail -n 4 "$LOG" 2>/dev/null | cut -c21- | tr '\n' ' ')" wait ;;
        7) keep="$SERVER"; cmd_unlink > /dev/null; TOKEN=""; USER_NAME=""; SERVER="$keep" ;;
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
  rm -f "$CONF" "$STATE/pid" "$CACHE" "$CACHE_DISK"
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
  roms) VERBOSE=1 cmd_roms ;;
  config) VERBOSE=1 cmd_config ;;
  # What "Sync now" does on screen: saves, then the lists' roms when AUTO_ROMS is on
  all)
    VERBOSE=1
    if [ -n "$SD" ] && [ -z "$TOKEN" ]; then echo "This card is not linked yet. Run: $0 sd $SD link http://server:port"; exit 2; fi
    # A card only meets the server now and then: also send what the server asked for meanwhile
    cmd_all; [ -n "$SD" ] && cmd_pulls
    [ -n "$SD" ] && sync ;;
  game-start) cmd_game_start "${2:-}" ;;
  # After a game: copies for the server may go on, and the game's saves go up
  game-stop) rm -f "$WORK/playing"; cmd_sync ;;
  conflicts) cmd_conflicts ;;
  resolve) cmd_resolve "${2:-}" "${3:-}" ;;
  set) set_setting "${2:-}" "${3:-}" ;;
  pulls) VERBOSE=1; cmd_pulls ;;
  boot)
    # At power-on: start syncing and give the first pass up to BOOT_WAIT seconds, so saves are
    # current before a game can be opened; never asks anything
    [ -n "$TOKEN" ] || cmd_enroll > /dev/null 2>&1 || exit 0
    rm -f "$WORK/progress"
    nohup sh "$DIR/$(basename "$0")" daemon >/dev/null 2>&1 &
    n=0; while [ "$n" -lt "${BOOT_WAIT:-25}" ]; do
      grep -q '^finished' "$WORK/progress" 2>/dev/null && break
      sleep 1; n=$((n + 1))
    done ;;
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
