#!/bin/sh
# Rommancer Sync for Linux handhelds (Onion, muOS, Knulli, Batocera, ROCKNIX, ArkOS, NextUI) and PCs.
# POSIX sh for busybox: needs curl or wget, sha1sum and base64.
#
#   rommancer-sync.sh link SERVER   pair this device (shows a code to approve in the web app)
#   rommancer-sync.sh enroll        pair with the one-time token of an installer package (enroll.txt)
#   rommancer-sync.sh sync          one sync pass
#   rommancer-sync.sh daemon        sync whenever a save changes, and every few minutes
#   rommancer-sync.sh setup         on-screen setup with the gamepad (Onion)
#   rommancer-sync.sh install       start the daemon at boot and sync around each game (Knulli, Batocera, ArkOS, NextUI)
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
CLIENT_VERSION=20261063
# A clock before this date is surely wrong (no battery-backed clock); kept apart from the version, which may run ahead
CLOCK_MIN=20261001
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
# GAME_SYNC=1 fetches a game's saves right before it starts; GAME_ASK=1 then settles its conflicts on screen
GAME_SYNC=1
GAME_ASK=1
# PRUNE_ROMS=1 deletes roms that are in none of the lists the console has (cmd_prune). The console owns it:
# a change made here or an answer to one made in the web app leaves $STATE/prune-set until the server hears it
PRUNE_ROMS=0
[ -f "$SETTINGS" ] && . "$SETTINGS"
set_setting() { grep -v "^$1=" "$SETTINGS" 2>/dev/null > "$WORK/settings"; echo "$1=$2" >> "$WORK/settings"; mv "$WORK/settings" "$SETTINGS"; }
# Installer packages bring the server address (and a one-time enrolment token) next to the script
[ -z "$SERVER" ] && [ -f "$DIR/server.txt" ] && SERVER="$(head -n 1 "$DIR/server.txt" | tr -d '\r ')"

# http METHOD URL BODYFILE OUTFILE [HEADER...]; BODYFILE "-" = no body, OUTFILE "-" = stdout.
# One retry: home routers drop the odd DNS lookup and a whole sync should not fail for it
# A certificate refused (curl 60, or a TLS handshake that failed: 35) is most often the console's clock: set from the
# server's and tried again at once
http() {
  http_once "$@" && return 0
  # A rom download stopped on screen is not tried again
  [ -f "$WORK/roms-stop" ] && return 1
  case "$(cut -f1 "$WORK/last-error" 2>/dev/null)" in 35|60) clock_from_server ;; *) sleep 2 ;; esac
  http_once "$@"
}

# The server's clock without checking its certificate (a clock far off is what makes the check fail; only the time is
# read from it, nothing is sent): the console's clock set by it
clock_from_server() {
  command -v curl >/dev/null 2>&1 || return 0
  c="$(curl -fsSk --connect-timeout 5 --max-time 15 "$SERVER/api/v1/link/client/manifest" 2>/dev/null | sed -n "s/^clock$TAB//p")"
  [ -n "$c" ] && set_clock "$c"
  return 0
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
    # A failure leaves why in last-error ("curl code<TAB>url<TAB>message"), for the screens' details
    if [ "$out" = "-" ]; then curl -fsS --globoff --connect-timeout 5 --max-time "${HTTP_MAX:-120}" -X "$m" "$@" "$u" 2> "$WORK/http-err"
    else curl -fsS --globoff --connect-timeout 5 --max-time "${HTTP_MAX:-1800}" -X "$m" "$@" -o "$out" "$u" 2> "$WORK/http-err"; fi
    rc=$?
    [ "$rc" = 0 ] || printf '%s\t%s\t%s\n' "$rc" "${u%%\?*}" "$(head -n 1 "$WORK/http-err" 2>/dev/null)" > "$WORK/last-error"
    return "$rc"
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
  [ "$(date +%Y%m%d)" -ge "$CLOCK_MIN" ] && return 0
  command -v ntpdate >/dev/null 2>&1 && ntpdate -u pool.ntp.org >/dev/null 2>&1 && log "clock set by NTP: $(date)"
  return 0
}

# ---------- detection ----------

detect() {
  FW=""; ROOT=""; MODEL=""
  # NextUI also has the .tmp_update folder Onion is told by
  if [ "${IS_NEXT:-}" = yes ] || head -c 6 /mnt/SDCARD/.system/version.txt 2>/dev/null | grep -q '^NextUI' || ls /mnt/SDCARD/.system/*/bin/nextui.elf >/dev/null 2>&1; then
    FW=nextui; ROOT=/mnt/SDCARD
    case "${DEVICE:-}" in brick) MODEL="TrimUI Brick" ;; brickpro) MODEL="TrimUI Brick Pro" ;; smartpro) MODEL="TrimUI Smart Pro" ;; smartpros) MODEL="TrimUI Smart Pro S" ;; esac
  elif grep -qs ArkOS /usr/share/plymouth/themes/text.plymouth; then
    # With "Switch to SD2 for Roms" the systems point at the second card
    FW=arkos; ROOT=/roms
    grep -qs '/roms2/' /etc/emulationstation/es_systems.cfg && ROOT=/roms2
    case "$(cat /home/ark/.config/.DEVICE 2>/dev/null)" in
      RG353V) MODEL="Anbernic RG353V" ;; RG353M) MODEL="Anbernic RG353M" ;; RG503) MODEL="Anbernic RG503" ;; RG351MP) MODEL="Anbernic RG351MP" ;;
      RGB30) MODEL="Powkiddy RGB30" ;; RGB20PRO) MODEL="Powkiddy RGB20 Pro" ;; RGB10) MODEL="Powkiddy RGB10" ;; ?*) MODEL="$(cat /home/ark/.config/.DEVICE)" ;;
    esac
  elif [ -d /mnt/SDCARD/.tmp_update ]; then
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

# Onion dialogs fit about 40 characters per line and turn a literal \n into a line break; each line of the text is
# wrapped on its own (one fact per line stays one per line)
wrap() { printf '%s\n' "$1" | awk -v w=36 'function add(s) { o = (started ? o "\\n" : "") s; started = 1 } { l = ""; n = split($0, a, " "); for (i = 1; i <= n; i++) { if (length(l) > 0 && length(l) + 1 + length(a[i]) > w) { add(l); l = a[i] } else if (l == "") l = a[i]; else l = l " " a[i] } add(l) } END { printf "%s", o }'; }

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

# Hash with cache keyed by size and mtime; SKIP > 0 hashes without that many leading bytes (rom headers).
# Saves (SKIP "save") add the inode: a file swapped in with mv (a memory card the server sent) keeps its size
# and may keep the second of the one it replaced
cached_sha1() {
  f="$1"; skip="${2:-0}"; fmt='%s %Y'
  [ "$skip" = save ] && { skip=0; fmt='%s %Y %i'; }
  meta="$(stat -c "$fmt" "$f" 2>/dev/null)" || return 1
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
    *.png|*.jpg|*.jpeg|*.mp4|*.xml|*.txt|*.json|*.cfg|*.db|*.ini|*.pdf|*.srm|*.sav|*.state*|*.ss[0-9]|*.mcd|*.mcr|*.dsv|*.cht|*.log|*.sh|*.lpl|*.pem) return 1 ;;
  esac
  is_save "$1" && return 1
  return 0
}

# Progress for the setup screens: "phase<TAB>done<TAB>total" in RAM
progress() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" > "$WORK/progress.tmp" && mv "$WORK/progress.tmp" "$WORK/progress"; }
# The same with the file being worked on (its name is shown): "phase<TAB>done<TAB>total<TAB><TAB><TAB>name"
progress_file() { printf '%s\t%s\t%s\t\t\t%s\n' "$1" "$2" "$3" "$(basename "$4")" > "$WORK/progress.tmp" && mv "$WORK/progress.tmp" "$WORK/progress"; }
# The step of "Sync now" under way, for the screens: "n<TAB>of<TAB>key" (saves, settings, prune, roms, pulls)
step() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" > "$WORK/step"; }

# Summary lines for the screens, printed next to the English lines when run on screen (VERBOSE):
# "sum<TAB>key<TAB>n[<TAB>extra]", only for keys that are not zero (docs/clients-ux.md, docs/sync.md)
sum_line() {
  [ -n "${VERBOSE:-}" ] && [ "${2:-0}" != 0 ] || return 0
  printf 'sum\t%s\t%s%s\n' "$1" "$2" "${3:+$TAB$3}"
}
# A savestate (.state, .state1, .state.auto, .ss0, NextUI's .st0); every other file a sync moves is a save
is_state() { case "$1" in *.[Ss][Tt][Aa][Tt][Ee]*|*.[Ss][Ss][0-9]|*.[Ss][Tt][0-9]) return 0 ;; esac; return 1; }

# "meta<TAB>path" for every file under the given find arguments, META being stat's FMT. One stat call for
# many files where find can (-exec ... +): a fork per file is what makes a big rom folder slow on a handheld
stat_files() {
  fmt="$1"; shift
  find "$@" -type f -exec stat -c "$fmt$TAB%n" {} + > "$WORK/stat" 2>/dev/null
  [ -s "$WORK/stat" ] || find "$@" -type f 2>/dev/null | while IFS= read -r f; do stat -c "$fmt$TAB%n" "$f" 2>/dev/null; done > "$WORK/stat"
  cat "$WORK/stat"
}

# Splits "meta<TAB>path" lines (stdin) against the hash cache: request lines for what the cache already
# knows go to stdout, the files still to hash to MISS as "meta<TAB>header bytes<TAB>path". KIND "rom" also filters what is not a rom and adds
# the headerless hash where DATs leave a header out (the same rules as is_rom, is_save and header_size).
known_lines() {
  awk -F"$TAB" -v OFS="$TAB" -v kind="$1" -v miss="$2" -v max="$HASH_MAX" -v exts="$EXTS" -v dir="$DIR/" -v cache="$CACHE" '
    function is_save(n,   i, e, k, rest) {
      for (i = 1; i <= ne; i++) {
        e = ex[i]; k = index(n, e)
        while (k > 0) {
          rest = substr(n, k + length(e))
          if (rest == "" || rest ~ /^[0-9]$/ || rest == ".auto") return 1
          k2 = index(substr(n, k + 1), e); k = k2 ? k + k2 : 0
        }
      }
      return 0
    }
    BEGIN {
      ne = split(tolower(exts), ex, " ")
      while ((getline l < cache) > 0) if (split(l, a, FS) == 3) c[a[1] FS a[2]] = a[3]
    }
    NF != 2 || index($2, "/.") { next }
    {
      f = $2; n = tolower(f)
      if (kind == "file") {
        if (!is_save(n)) next
        if ((f FS $1) in c) { split($1, m, " "); print "file", f, c[f FS $1], m[2] } else print $1, 0, f > miss
        next
      }
      if (index(f, dir) == 1) next
      if (n ~ /\.(png|jpg|jpeg|mp4|xml|txt|json|cfg|db|ini|pdf|srm|sav|mcd|mcr|dsv|cht|log|sh|lpl|pem)$/ || n ~ /\.state/ || n ~ /\.ss[0-9]$/ || is_save(n)) next
      split($1, m, " "); size = m[1]
      if (size + 0 > max + 0) { print "rom", f, "", "", size; next }
      hs = 0
      if (n ~ /\.(nes|fds)$/) hs = 16; else if (n ~ /\.lnx$/) hs = 64; else if (n ~ /\.a78$/) hs = 128
      else if (n ~ /\.(smc|sfc|swc|fig)$/ && size % 1024 == 512) hs = 512
      if (!((f FS $1) in c) || (hs && !((f "#" hs FS $1) in c))) { print $1, hs, f > miss; next }
      print "rom", f, c[f FS $1], (hs ? c[f "#" hs FS $1] : ""), size
    }'
}

# Hashes a file the cache does not know (META as stat gave it), SKIP leading bytes left out, and caches it
fresh_sha1() {
  if [ "${3:-0}" -gt 0 ]; then s="$(tail -c +$(($3 + 1)) "$1" | sha1sum | cut -d' ' -f1)"; k="$1#$3"; else s="$(sha1 "$1")"; k="$1"; fi
  [ -n "$s" ] || return 1
  printf '%s\t%s\t%s\n' "$k" "$2" "$s" >> "$CACHE"
  printf '%s' "$s"
}

# Writes the sync request: every rom plus every save file with its sha1. Files the hash cache knows (same
# size and time) are settled in one pass; only new or changed ones are hashed one by one.
build_request() {
  out="$1"; : > "$out"
  progress connecting 0 0
  roots="$(http GET "$SERVER/api/v1/agent/roots" - -)" || return 1
  ROMS="$(field roms "$roots")"; EXTS="$(field exts "$roots")"
  progress roms 0 0
  : > "$WORK/roms"
  stat_files '%s %Y' "$ROMS" -mindepth 2 -maxdepth 2 | known_lines rom "$WORK/roms" >> "$out"
  total="$(wc -l < "$WORK/roms")"; i=0
  while IFS="$TAB" read -r meta hs f; do
    i=$((i + 1)); progress_file hashing "$i" "$total" "$f"
    full="$(fresh_sha1 "$f" "$meta")" || continue; hl=""
    [ "$hs" -gt 0 ] && hl="$(fresh_sha1 "$f" "$meta" "$hs")"
    printf 'rom\t%s\t%s\t%s\t%s\n' "$f" "$full" "$hl" "${meta%% *}" >> "$out"
  done < "$WORK/roms"
  progress saves 0 0
  : > "$WORK/saves"
  printf '%s\n' "$roots" | sed -n "s/^saves$TAB//p" | while IFS= read -r d; do stat_files '%s %Y %i' "$d"; done | known_lines file "$WORK/saves" >> "$out"
  total="$(wc -l < "$WORK/saves")"; i=0
  while IFS="$TAB" read -r meta hs f; do
    i=$((i + 1)); progress_file hashing "$i" "$total" "$f"
    mt="${meta#* }"; mt="${mt%% *}"
    s="$(fresh_sha1 "$f" "$meta")" && printf 'file\t%s\t%s\t%s\n' "$f" "$s" "$mt" >> "$out"
  done < "$WORK/saves"
  nested_lines "$out" > "$WORK/nested" && cat "$WORK/nested" >> "$out"
  core_lines >> "$out" 2>/dev/null
  save_cache
}

# Roms kept in a folder of their own under their system (roms/snes/CURADA/game.smc): sent as "srom<TAB>path" when a
# save or state of the same name is in the request (REQ), so those saves sync. They stay out of the device's
# inventory, and so out of any deletion of roms in no list
nested_lines() {
  stat_files '%s' "$ROMS" -mindepth 3 -maxdepth 4 | awk -F"$TAB" -v OFS="$TAB" '
    function base(p, b) { b = p; sub(/.*\//, "", b); return b }
    FNR == NR {
      if ($1 == "file") { b = base($2); if (!sub(/\.[Ss][Tt][Aa][Tt][Ee][0-9]*(\.auto)?$/, "", b)) sub(/\.[^.]*$/, "", b); want[b] = 1 }
      next
    }
    NF != 2 || index($2, "/.") { next }
    {
      f = $2; n = tolower(f)
      if (n ~ /\.(png|jpg|jpeg|mp4|xml|txt|json|cfg|db|ini|pdf|srm|sav|mcd|mcr|dsv|cht|log|sh|lpl|pem)$/ || n ~ /\.state/) next
      b = base(f); sub(/\.[^.]*$/, "", b)
      if (b in want) print "srom", f
    }' "$1" -
}

# Folders with RetroArch's core info files: the one its config names, then the usual ones
info_dirs() {
  [ -n "${ROOT:-}" ] || detect
  for c in "${ROOT%/}/RetroArch/.retroarch/retroarch.cfg" /userdata/system/configs/retroarch/retroarchcustom.cfg /storage/.config/retroarch/retroarch.cfg \
    /opt/muos/share/info/config/retroarch.cfg /home/ark/.config/retroarch/retroarch.cfg "${HOME:-/root}/.config/retroarch/retroarch.cfg"; do
    [ -f "$c" ] || continue
    # "~/..." is the home folder, ":/..." RetroArch's own folder
    sed -n 's/^[[:space:]]*libretro_info_path[[:space:]]*=[[:space:]]*"\(.*\)"[[:space:]]*$/\1/p' "$c" | sed "s#^~#${HOME:-/root}#; s#^:#$(dirname "$c")#"
  done
  printf '%s\n' /usr/share/libretro/info /usr/lib/libretro /tmp/cores "${ROOT%/}/RetroArch/.retroarch/info" "${ROOT%/}/RetroArch/.retroarch/cores"
}

# "core<TAB>name<TAB>version" per installed core: the server dates each savestate with the version that made it
core_lines() {
  [ -z "$SD" ] || return 0
  info_dirs | while IFS= read -r d; do
    [ -d "$d" ] || continue
    set -- "$d"/*.info
    [ -f "$1" ] && awk -F'"' '
      FNR == 1 { if (n != "" && v != "") printf "core\t%s\t%s\n", n, v; n = ""; v = "" }
      /^[[:space:]]*corename[[:space:]]*=/ { n = $2 }
      /^[[:space:]]*display_version[[:space:]]*=/ { v = $2 }
      END { if (n != "" && v != "") printf "core\t%s\t%s\n", n, v }' "$@"
  done | awk -F"$TAB" '!seen[$2]++'
}

save_cache() {
  cmp -s "$CACHE" "$CACHE_DISK" 2>/dev/null && return 0
  cp "$CACHE" "$CACHE_DISK.new" 2>/dev/null && mv "$CACHE_DISK.new" "$CACHE_DISK"
}

# A savestate's screenshot, sent after the state ("tput" from the server) or written beside it ("tget")
thumb_put() {
  [ -f "$1" ] && [ "$(stat -c %s "$1" 2>/dev/null || echo 0)" -le 4194304 ] || return 0
  http POST "$SERVER/api/v1/agent/thumb?v=$2" "$1" - >/dev/null 2>&1 || log "screenshot not sent: $1"
}
thumb_get() {
  mkdir -p "$(dirname "$1")"
  http GET "$SERVER/api/v1/agent/thumb?v=$2" - "$1.rommancer-tmp" && mv "$1.rommancer-tmp" "$1" || rm -f "$1.rommancer-tmp"
}

# An emulator process is up (whatever the game events said): memory cards are only swapped while none runs,
# because emulators keep the card in memory and write it back whole
emu_running() {
  # Every process (busybox ps lists them all and has no -e)
  { ps -e -o args= 2>/dev/null || ps 2>/dev/null; } | grep -q '[r]etroarch\|[d]olphin-emu\|[m]inarch\|[d]uckstation\|[e]mulatorlauncher\|[p]csx\|[s]wanstation\|[e]psxe\|[r]etrorun'
}

# A memory card with the server's newer saves put in ("cget"): swapped in only if the file is still the one
# the server read (EXPECT, "-" for none) and no emulator runs; otherwise the next sync tries again.
# START: right before a game launches, when its emulator has not loaded the card yet
# Puts a save the server sent in place. What it overwrites is kept first in the state folder (never beside the
# saves, where an emulator could load it): the last copies the server's setting says, at most 256 MB of them
replace_save() {
  if [ -f "$2" ] && ! cmp -s "$1" "$2"; then
    mkdir -p "$STATE/backups"
    cp "$2" "$STATE/backups/$(date +%Y%m%d-%H%M%S)-$(basename "$2")" 2>/dev/null || log "backup of $(basename "$2") failed"
    trim_backups
  fi
  mv "$1" "$2"
}
# The last copies the server's setting says, at most 256 MB of them
trim_backups() {
  bd="$STATE/backups"
  keep="$(cat "$STATE/backups-keep" 2>/dev/null)"; case "$keep" in ''|*[!0-9]*) keep=20 ;; esac
  ls -1t "$bd" | while IFS= read -r old; do
    keep=$((keep - 1)); sz="$(stat -c %s "$bd/$old" 2>/dev/null || echo 0)"; used=$((${used:-0} + sz))
    [ "$keep" -lt 0 ] || [ "$used" -gt 268435456 ] && rm -f "$bd/$old"
  done
}
# A newer save is arriving: the game's resume state (its old memory, its old save inside) goes with the copies,
# so the next start, or Onion's resume at boot, opens the game with the save that arrived
set_aside() {
  [ -f "$1" ] || return 0
  mkdir -p "$STATE/backups"
  mv "$1" "$STATE/backups/$(date +%Y%m%d-%H%M%S)-$(basename "$1")" 2>/dev/null || cp "$1" "$STATE/backups/$(date +%Y%m%d-%H%M%S)-$(basename "$1")" && rm -f "$1"
  log "resume state put aside: $(basename "$1")"
  trim_backups
}

card_get() {
  cp_="$1"; ce_="$2"; cr_="$3"; cw_="${4:-}"
  if [ -z "$SD" ] && [ "$cw_" != start ] && emu_running; then log "card: an emulator is running, $(basename "$cp_") later"; return 1; fi
  mkdir -p "$(dirname "$cp_")"
  rm -f "$cp_.rommancer-tmp"
  http_once GET "$SERVER/api/v1/agent/card?expect=$ce_" - "$cp_.rommancer-tmp" "X-Path-B64: $(b64 "$cp_")" "X-Rom-B64: $(b64 "$cr_")" || { rm -f "$cp_.rommancer-tmp"; return 1; }
  [ -s "$cp_.rommancer-tmp" ] || { rm -f "$cp_.rommancer-tmp"; return 1; }
  cn_=-; [ -f "$cp_" ] && cn_="$(sha1 "$cp_")"
  if [ "$cn_" != "$ce_" ] || { [ -z "$SD" ] && [ "$cw_" != start ] && emu_running; }; then
    rm -f "$cp_.rommancer-tmp"; log "card: $(basename "$cp_") changed meanwhile, later"; return 1
  fi
  replace_save "$cp_.rommancer-tmp" "$cp_"
  # Tell the server at once: a game saved on this card before the next sync is then this console's newer save
  http_once POST "$SERVER/api/v1/agent/card/ack?sha=$(sha1 "$cp_")" - - "X-Path-B64: $(b64 "$cp_")" >/dev/null 2>&1 || log "card: $(basename "$cp_") written, server not told yet"
}

# A short note on screen when saves arrived: EmulationStation's popup (Knulli, Batocera), the desktop's
# notifications (PCs). Onion, muOS, ArkOS and NextUI have nothing to show it with; never during a game
notify_received() {
  [ -z "$SD" ] && [ -z "${ROMMANCER_NO_NOTIFY:-}" ] && [ -s "$WORK/received" ] || return 0
  playing && return 0
  n="$(grep -c . "$WORK/received")"; first="$(head -n 1 "$WORK/received")"
  if [ "$n" -eq 1 ]; then msg="Save received: $first"; else msg="$n saves received: $first and more"; fi
  notify "$msg"
}

# A popup on the console: EmulationStation's on Knulli/Batocera, the desktop's on PCs
notify() {
  [ -n "${FW:-}" ] || detect
  case "$FW" in
    knulli|batocera) printf 'Rommancer · %s' "$1" > "$WORK/notify" && curl -fsS -m 3 -X POST -H 'Content-Type: text/plain' --data-binary "@$WORK/notify" "${ROMMANCER_ES_NOTIFY:-http://127.0.0.1:1234/notify}" >/dev/null 2>&1 ;;
    retroarch-desktop) command -v notify-send >/dev/null 2>&1 && notify-send -a Rommancer -i media-floppy Rommancer "$1" 2>/dev/null ;;
  esac
  return 0
}

# "version<TAB>date" of the first sync this version made (clock set by then), for the Status screens
VERSION_FILE="$STATE/version"
mark_version() {
  was="$(cut -f1 "$VERSION_FILE" 2>/dev/null)"
  [ "$was" = "$CLIENT_VERSION" ] && return 0
  when="$(cat "$WORK/server-now" 2>/dev/null)"; [ -n "$when" ] || when="$(date '+%Y-%m-%d %H:%M')"
  printf '%s\t%s\n' "$CLIENT_VERSION" "$when" > "$VERSION_FILE" 2>/dev/null
  # Said on screen when it updated itself (not on a first install, the setup already shows it)
  [ -n "$was" ] && [ -z "$SD" ] && [ -z "${ROMMANCER_NO_NOTIFY:-}" ] && ! playing || return 0
  notify "Updated to version $CLIENT_VERSION"
}
# When the last sync went through, as seconds since 1970 (time zones differ between the daemon and the menus): in RAM
# at every sync, on the card at most every ten minutes (it survives a reboot without a write per sync)
synced_now() {
  now="$(date +%s)"; echo "$now" > "$WORK/last-sync"
  kept="$(cat "$STATE/last-sync" 2>/dev/null || echo 0)"
  [ $((now - ${kept:-0})) -ge 600 ] 2>/dev/null && echo "$now" > "$STATE/last-sync"
  return 0
}
synced_at() { cat "$WORK/last-sync" 2>/dev/null || cat "$STATE/last-sync" 2>/dev/null; }
# "Synced: today, 18:52" / "Synced: 12 Oct, 18:52" (the last sync that went through), on the home screen
synced_line() {
  at="$(synced_at)"
  m="Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec"; w="Synced:"; td="today"; never="Not synced yet"
  [ -n "$at" ] || { printf '%s' "$never"; return 0; }
  date -d "@$at" '+%m %d %H:%M %Y%m%d' 2>/dev/null | awk -v m="$m" -v w="$w" -v td="$td" -v today="$(date +%Y%m%d)" '{ split(m, n, " "); if ($4 == today) printf "%s %s, %s", w, td, $3; else printf "%s %d %s, %s", w, $2, n[$1 + 0], $3 }'
}
# "Actualizado el 11 oct 2026, 19:07": when this client arrived (the status screen)
updated_line() {
  since="$(cut -f2 "$VERSION_FILE" 2>/dev/null)"
  [ -n "$since" ] || return 0
  m="Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec"; w="Updated"
  printf '%s\n' "$since" | awk -v m="$m" -v w="$w" '{ split($1, d, "-"); split(m, n, " "); printf "%s %d %s %s, %s", w, d[3], n[d[2] + 0], d[1], $2 }'
}
version_line() {
  since="$(cut -f2 "$VERSION_FILE" 2>/dev/null)"
  printf 'Version %s%s' "$CLIENT_VERSION" "${since:+, installed $since}"
}

# Why a sync asked for on screen failed: one line in words, and the details behind it in fail-details (the network,
# the name lookup, the clock and the error itself), which the screens offer with a "details" button
sync_failed() {
  host="${SERVER#*://}"; host="${host%%/*}"
  IFS="$TAB" read -r code url err < "$WORK/last-error" 2>/dev/null
  if ! ip route 2>/dev/null | grep -q '^default'; then
    why="No network: connect the WiFi"
  else
    case "${code:-}" in
      6) why="Cannot find $host (DNS): check the WiFi network" ;;
      35|60) why="Secure connection refused: usually the console's clock ($(date '+%Y-%m-%d %H:%M'))" ;;
      22) why="$host answered with an error: $(printf '%s' "$err" | sed 's/.*error: //')" ;;
      28) why="$host does not answer in time: check the WiFi network" ;;
      *) why="Cannot reach $host: check the WiFi network" ;;
    esac
  fi
  # The same failure is logged once; the details (a name lookup can take seconds) only when asked on screen
  if [ "$why" != "$(cat "$WORK/last-why" 2>/dev/null)" ]; then log "failed: $why"; printf '%s\n' "$why" > "$WORK/last-why"; fi
  [ -n "${VERBOSE:-}" ] || return 0
  {
    echo "$why"
    echo "Server: $SERVER"
    echo "Error: ${code:+curl $code: }${err:-?} (${url:-?})"
    echo "Clock (UTC): $(date -u '+%Y-%m-%d %H:%M:%S')"
    echo "Route: $(ip route 2>/dev/null | sed -n 's/^default via \([^ ]*\).*/\1/p' | head -n 1)"
    echo "Address: $(ip -4 addr 2>/dev/null | sed -n 's/.*inet \([0-9.]*\).*/\1/p' | grep -v '^127\.' | tr '\n' ' ')"
    echo "WiFi: $( (iw dev wlan0 link 2>/dev/null || iwconfig wlan0 2>/dev/null) | sed -n 's/.*SSID[:=] *"\{0,1\}\([^"]*\)"\{0,1\}.*/\1/p; s/.*signal: *\(.*\)/signal \1/p' | tr '\n' ' ')"
    echo "DNS $host: $(nslookup "$host" 2>/dev/null | sed -n 's/^Address[^:]*: *\([0-9.]*\).*/\1/p' | tail -n +2 | tr '\n' ' ')"
    echo "Client: $CLIENT_VERSION (${FW:-?})"
  } > "$WORK/fail-details" 2>/dev/null
  echo "$why"
  return 0
}

# ---- Sync state on the console's screens: in the game (RetroArch's on-screen messages), in the menus (EmulationStation's
# popups on Knulli/Batocera, the app's name in Onion's Apps) ----

# A game is on screen, whatever started it (Onion has no game events)
game_running() { ps 2>/dev/null | grep -q '[r]etroarch\|[m]inarch\|[d]rastic\|[p]pssppSDL\|[m]upen64plus\|[d]uckstation\|[r]etrorun'; }

# One command to RetroArch's network command port; REPLY: wait for its answer (fails when it does not answer)
ra_send() {
  if [ -x /mnt/SDCARD/.tmp_update/bin/sendUDP ]; then
    if [ "${2:-}" = reply ]; then [ -n "$(timeout 2 /mnt/SDCARD/.tmp_update/bin/sendUDP -r 64 "$1" 2>/dev/null)" ]
    else /mnt/SDCARD/.tmp_update/bin/sendUDP "$1" >/dev/null 2>&1; fi
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$1" "${2:-}" <<'PY' 2>/dev/null
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(1.5)
s.sendto(sys.argv[1].encode(), ("127.0.0.1", 55355))
if sys.argv[2] == "reply":
    try:
        s.recv(64)
    except Exception:
        sys.exit(1)
PY
  else return 1; fi
}

# A message on the game's screen, once RetroArch answers (it may still be starting); gone quietly when it never does
ra_msg() {
  ( n=0
    while [ "$n" -lt 15 ]; do
      if ra_send VERSION reply; then ra_send "SHOW_MSG $1"; exit 0; fi
      sleep 2; n=$((n + 1))
    done ) >/dev/null 2>&1 &
}

# HH:MM of an epoch (busybox date takes @epoch)
hhmm() { date -d "@$1" '+%H:%M' 2>/dev/null || echo "?"; }

# What the screens show now: "ok", "offline" (since offline-since) or "conflicts" (N in conflicts-open)
sync_state() {
  if [ -f "$WORK/offline-since" ]; then echo offline
  elif [ "$(cat "$WORK/conflicts-open" 2>/dev/null || echo 0)" -gt 0 ] 2>/dev/null; then echo conflicts
  else echo ok; fi
}
state_text() {
  n="$(cat "$WORK/conflicts-open" 2>/dev/null || echo 0)"; since="$(hhmm "$(cat "$WORK/offline-since" 2>/dev/null || echo 0)")"
  case "$1" in
    start-ok) t s_start_ok ;;
    start-offline) t s_start_offline "$since" ;;
    offline) t s_offline "$since" ;;
    online) t s_online ;;
    conflicts) t s_conflicts "$n" ;;
    uploaded) t s_uploaded ;;
    kept) t s_kept ;;
  esac
}

# The state changed (EVENT: offline, online, conflicts): said in the game when one is on screen, else in the menu
state_changed() {
  [ -n "${FW:-}" ] || detect
  msg="Rommancer: $(state_text "$1")"
  if game_running; then ra_msg "$msg"
  else case "$FW" in knulli|batocera) notify "$(state_text "$1")" ;; esac; fi
  app_label
  log "state: $1"
}

# Onion lists the app by its config.json label: it says when the console is offline or has conflicts to settle. The
# label lives on the card and the state in RAM: it is set again from the state at every daemon start and every tick
# (a write only when it differs), so it never outlives the state it tells
app_label() {
  [ -f "$DIR/config.json" ] || return 0
  case "$(sync_state)" in
    offline) label="$(t l_offline)" ;;
    conflicts) label="$(t l_conflicts "$(cat "$WORK/conflicts-open")")" ;;
    *) label="Rommancer Sync" ;;
  esac
  grep -qF "\"label\": \"$label\"" "$DIR/config.json" && return 0
  sed "s#\"label\" *: *\"[^\"]*\"#\"label\": \"$label\"#" "$DIR/config.json" > "$DIR/config.json.new" && mv "$DIR/config.json.new" "$DIR/config.json"
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
  mark_version
  build_request "$req" || { log "server unreachable"; sync_failed; drop_lock; return 1; }
  progress server 0 0
  # Free and total bytes of the roms' storage: the server copies list roms only while a reserve is kept
  space="$(df -k "$ROMS" 2>/dev/null | awk 'NR == 2 { printf "%.0f %.0f", $4 * 1024, $2 * 1024 }')"
  pset=0; [ -f "$STATE/prune-set" ] && pset=1
  http POST "$SERVER/api/v1/agent/sync" "$req" "$plan" "X-Prune: $PRUNE_ROMS" "X-Prune-Set: $pset" "X-Allow-Pull: $ALLOW_PULL" "X-Ssh: $(ssh_offer)" "X-Client-Path-B64: $(b64 "$DIR/$(basename "$0")")" "X-Space: ${space:-}" "X-Wifi-Bands: $(wifi_bands)" "X-Clock-Sync: $(clock_sync_state)" "X-Probe: 1" || { log "sync request failed"; sync_failed; drop_lock; return 1; }
  # How many copies of overwritten saves to keep
  sed -n "s/^backups$TAB//p" "$plan" > "$WORK/keep" && [ -s "$WORK/keep" ] && mv "$WORK/keep" "$STATE/backups-keep"
  [ "$pset" = 1 ] && rm -f "$STATE/prune-set"
  prune_answer "$(grep "^prune$TAB" "$plan" | head -n 1)"
  ups=0; downs=0; errs=0; moved=0; sup=0; stup=0; sdown=0; stdown=0; total="$(grep -vc "^probe$TAB\|^backups$TAB\|^prune$TAB\|^clocksync$TAB" "$plan")"
  : > "$WORK/received"
  # A running game keeps its save in memory and writes it back over whatever arrived: downloads wait for it to end
  ingame=0; game_running && ingame=1
  while IFS="$TAB" read -r action p a b; do
    case "$action" in probe|backups|prune) continue ;; clocksync) clock_sync_on; continue ;; esac
    case "$ingame$action" in 1get|1cget|1aside) log "after the game: $(basename "$p")"; continue ;; esac
    moved=$((moved + 1)); progress transfer "$moved" "$total"
    case "$action" in
      put)
        rh="$(grep -F "rom$TAB$a$TAB" "$req" | head -n 1 | cut -f3,4 | tr '\t' ',')"
        if http POST "$SERVER/api/v1/agent/upload" "$p" "$WORK/uploaded" "X-Rom-B64: $(b64 "$a")" "X-Path-B64: $(b64 "$p")" "X-Rom-Sha1: $rh" "X-Save-Exact: ${b:-0}"; then
          ups=$((ups + 1)); if is_state "$p"; then stup=$((stup + 1)); else sup=$((sup + 1)); fi
          # A new savestate: the server asks for its screenshot; a memory card may come back with the server's saves in it
          while IFS="$TAB" read -r tk tp tv tr; do
            case "$tk" in
              tput) thumb_put "$tp" "$tv" ;;
              cget) card_get "$tp" "$tv" "$tr" && { downs=$((downs + 1)); sdown=$((sdown + 1)); rn="$(basename "$tp")"; printf '%s\n' "${rn%.*}" >> "$WORK/received"; } ;;
            esac
          done < "$WORK/uploaded"
        else errs=$((errs + 1)); fi ;;
      get)
        mkdir -p "$(dirname "$p")"
        if http GET "$SERVER/api/v1/agent/file?v=$a" - "$p.rommancer-tmp" "X-Rom-B64: $(b64 "$b")" "X-Path-B64: $(b64 "$p")" && replace_save "$p.rommancer-tmp" "$p"; then
          downs=$((downs + 1)); if is_state "$p"; then stdown=$((stdown + 1)); else sdown=$((sdown + 1)); fi
          rn="$(basename "$b")"; printf '%s\n' "${rn%.*}" >> "$WORK/received"
        else rm -f "$p.rommancer-tmp"; errs=$((errs + 1)); fi ;;
      tput) thumb_put "$p" "$a" ;;
      tget) thumb_get "$p" "$a" ;;
      aside) set_aside "$p" ;;
      cget) if card_get "$p" "$a" "$b"; then downs=$((downs + 1)); sdown=$((sdown + 1)); rn="$(basename "$p")"; printf '%s\n' "${rn%.*}" >> "$WORK/received"; fi ;;
    esac
  done < "$plan"
  # Roms no hash or name identified: the server reads their product code from the blocks it asks for
  probes="$(grep -c "^probe$TAB" "$plan")"
  n=0
  grep "^probe$TAB" "$plan" > "$WORK/probes"
  while IFS="$TAB" read -r _ p a; do
    n=$((n + 1)); progress_file identify "$n" "$probes" "$p"
    probe_file "$p" "$a"
  done < "$WORK/probes"
  progress finished "$ups" "$downs"
  # One line per game: its save and its states count once
  sort -u "$WORK/received" -o "$WORK/received" 2>/dev/null
  notify_received
  log "sync: $ups up, $downs down, $errs errors"
  synced_now
  if [ -n "${VERBOSE:-}" ]; then
    # Files that failed: why, for the screens' details
    [ "$errs" -gt 0 ] && sync_failed > /dev/null
    # Conflicts still open, counted for the summary (and kept for Onion's menu)
    nconf=0
    if HTTP_MAX=10 http_once GET "$SERVER/api/v1/agent/conflicts" - "$WORK/conflicts.new" 2>/dev/null; then
      nconf="$(grep -c "^conflict$TAB" "$WORK/conflicts.new")"; mv "$WORK/conflicts.new" "$WORK/conflicts"
    fi
  fi
  # The last log lines go to the server so problems can be seen without access to the device (a line repeated
  # in a row counted once, so a run of failures does not push everything else out)
  { log_tail; lists_report; [ -f "$DIR/last-run.txt" ] && { echo "--- last-run.txt"; tail -n 20 "$DIR/last-run.txt"; }; } > "$WORK/report" 2>/dev/null
  http POST "$SERVER/api/v1/agent/log" "$WORK/report" - "X-Client-Version: $CLIENT_VERSION" >/dev/null 2>&1
  sum_line saves-up "$sup"; sum_line states-up "$stup"; sum_line saves-down "$sdown"; sum_line states-down "$stdown"
  sum_line conflicts "${nconf:-0}"; sum_line errors "$errs"
  [ -n "${VERBOSE:-}" ] && printf 'sync: %s up, %s down, %s errors\n' "$ups" "$downs" "$errs"
  drop_lock
  trap - EXIT INT TERM
  return 0
}

# The last 40 log lines, with a message repeated in a row kept once as "... (xN)"; the plain tail when that fails
# (old BusyBox awks read "name (" as a function call)
log_tail() {
  tail -n 400 "$LOG" 2>/dev/null | awk '
    function out() { s = last; if (n > 0) s = s " (x" (n + 1) ")"; print s }
    { m = substr($0, 21) }
    NR > 1 && m == pm { n++; last = $0; next }
    NR > 1 { out() }
    { pm = m; last = $0; n = 0 }
    END { if (NR > 0) out() }' > "$WORK/log-tail" 2>/dev/null
  if [ -s "$WORK/log-tail" ]; then tail -n 40 "$WORK/log-tail"; else tail -n 40 "$LOG" 2>/dev/null; fi
}

# Onion's game lists as the menu will read them: refreshes still due, the menu running, and per system folder with
# files: how many, its list cache, what else is in it (not a rom: caches, lists, folders, hidden files) and the
# list window the menu keeps for it
lists_report() {
  [ "${FW:-}" = onion ] || return 0
  echo "--- lists"
  [ -f "$STATE/lists-refreshed4" ] && echo "catch-up done"
  [ -s "$STATE/lists-changed" ] && echo "pending: $(sed -n 's#^\(.*/Roms/[^/]*\)/.*#\1#p' "$STATE/lists-changed" | sort -u | sed 's#.*/##' | tr '\n' ' ')"
  ps 2>/dev/null | grep -q '[M]ainUI' && echo "menu running"
  for d in "$ROOT"/Roms/*/; do
    d="${d%/}"; b="$(basename "$d")"
    n="$(ls -A "$d" 2>/dev/null | wc -l)"; [ "$n" -gt 0 ] || continue
    c="$(stat -c '%s@%y' "$d/${b}_cache6.db" 2>/dev/null | cut -c1-28)"
    x="$(ls -Ap "$d" 2>/dev/null | grep -E '/$|^\.|\.(db|xml|json|txt|journal)$|-journal$' | head -n 8 | tr '\n' ' ')"
    printf '%s: %s files, cache %s%s\n' "$b" "$n" "${c:-none}" "${x:+, other: $x}"
    onion_list_paths "$d" | grep -q . || echo "  no emulator installed for $b"
    onion_list_paths "$d" | while IFS= read -r lp; do grep -A3 -F "$lp" /appconfigs/romwinidx.json 2>/dev/null | tr -d ' \t\n' | cut -c1-160; echo; done
  done | grep -v '^$' | head -n 40
}

# One header probe: the blocks of 4 KiB the server names ("start:count,..."), sent until it has what it needs
probe_file() {
  pf="$1"; ask="$2"; rounds=0
  psize="$(stat -c %s "$pf" 2>/dev/null)" || return 0
  while [ -n "$ask" ] && [ "$rounds" -lt 12 ]; do
    rounds=$((rounds + 1))
    : > "$WORK/probe-body"
    for r in $(printf '%s' "$ask" | tr ',' ' '); do
      dd if="$pf" bs=4096 skip="${r%%:*}" count="${r#*:}" 2>/dev/null >> "$WORK/probe-body"
    done
    http POST "$SERVER/api/v1/agent/probe" "$WORK/probe-body" "$WORK/probe-reply" "X-Path-B64: $(b64 "$pf")" "X-Size: $psize" "X-Ranges: $ask" "Content-Type: application/octet-stream" || return 0
    ask="$(sed -n "s/^need$TAB//p" "$WORK/probe-reply")"
  done
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
# RetroArch writes a game's save only when the game closes while its autosave is off (Onion ships it so): a save made
# in the game then waits in memory, is lost if the console powers off, and reaches other consoles late. Turned to 10
# seconds once per device, while no game runs (RetroArch rewrites its file on exit); Batocera/Knulli set it themselves
autosave_on() {
  [ -f "$STATE/autosave-set" ] && return 0
  game_running && return 0
  [ -n "${ROOT:-}" ] || detect
  for c in "${ROOT%/}/RetroArch/.retroarch/retroarch.cfg" /storage/.config/retroarch/retroarch.cfg /opt/muos/share/info/config/retroarch.cfg \
    /home/ark/.config/retroarch/retroarch.cfg "${HOME:-/root}/.config/retroarch/retroarch.cfg"; do
    [ -f "$c" ] || continue
    if grep -q '^[[:space:]]*autosave_interval[[:space:]]*=' "$c"; then
      grep -q '^[[:space:]]*autosave_interval[[:space:]]*=[[:space:]]*"\{0,1\}0"\{0,1\}[[:space:]]*$' "$c" || continue
      sed 's/^[[:space:]]*autosave_interval[[:space:]]*=.*/autosave_interval = "10"/' "$c" > "$c.rommancer" && mv "$c.rommancer" "$c"
    else printf 'autosave_interval = "10"\n' >> "$c"; fi
    log "RetroArch saves games every 10 seconds ($c)"
  done
  touch "$STATE/autosave-set"
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
          # Running as root (ArkOS) must not leave the user's own files root-owned (RetroArch could no longer save them)
          own="$(stat -c %u:%g "$dest" 2>/dev/null)"
          if http GET "$SERVER/api/v1/agent/config/out/$op/$n" - "$dest.rommancer-tmp" && { [ -z "$mode" ] || chmod "$mode" "$dest.rommancer-tmp"; } && { [ -z "$own" ] || chown "$own" "$dest.rommancer-tmp" 2>/dev/null || :; } && mv "$dest.rommancer-tmp" "$dest"; then :
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
# (one stat for many files and one awk for the save rule: it runs every few seconds, a fork per file kept a weak
# handheld busy and slowed its downloads)
fingerprint() {
  [ -n "${SAVE_DIRS:-}" ] || return 0
  printf '%s\n' "$SAVE_DIRS" | while IFS= read -r d; do
    find "$d" -type f -exec stat -c "%s %Y$TAB%n" {} + 2>/dev/null ||
      find "$d" -type f 2>/dev/null | while IFS= read -r f; do stat -c "%s %Y$TAB%n" "$f" 2>/dev/null; done
  done | awk -F"$TAB" -v exts="$EXTS" '
    BEGIN { ne = split(exts, ex, " ") }
    {
      n = tolower($2); keep = 0
      for (i = 1; i <= ne && !keep; i++) {
        e = ex[i]; l = length(n); m = length(e)
        if (m && l >= m && substr(n, l - m + 1) == e) keep = 1
        else if (m && l > m && substr(n, l - m, m) == e && substr(n, l) ~ /[0-9]/) keep = 1
        else if (m && l >= m + 5 && substr(n, l - m - 4) == e ".auto") keep = 1
      }
      if (keep) print
    }' | cksum
}

# Onion sets its clock from the internet when its Tweaks say so (.ntpState), and waits for it at power-on (.ntpWait):
# "1" or "0" for the web app, which suggests turning it on; nothing on other firmwares (they keep their own time)
ONION_CONFIG=/mnt/SDCARD/.tmp_update/config
clock_sync_state() {
  [ -n "${FW:-}" ] || detect
  [ "$FW" = onion ] && [ -d "$ONION_CONFIG" ] || return 0
  if [ -f "$ONION_CONFIG/.ntpState" ]; then echo 1; else echo 0; fi
}
clock_sync_on() {
  [ -d "$ONION_CONFIG" ] || return 0
  touch "$ONION_CONFIG/.ntpState" "$ONION_CONFIG/.ntpWait" && log "clock: Onion sets it from the internet, waited for at power-on"
}

# The console's clock set from the server's ("epoch<TAB>YYYY-MM-DD HH:MM:SS", UTC) when they differ by more than two
# minutes: a handheld whose clock does not keep time, or drifted, dates saves wrongly. Consoles only (a computer, or a
# card synced from one, keeps its own); the hardware clock too where there is one
set_clock() {
  epoch="${1%%"$TAB"*}"; utc="${1#*"$TAB"}"
  [ -n "$epoch" ] && [ "$epoch" -gt 0 ] 2>/dev/null && [ "$utc" != "$1" ] || return 0
  [ -z "$SD" ] || return 0
  [ -n "${FW:-}" ] || detect
  case "$FW" in retroarch-desktop) return 0 ;; esac
  off=$(( $(date +%s) - epoch )); [ "$off" -lt 0 ] && off=$(( -off ))
  [ "$off" -gt 120 ] || return 0
  su=""; [ "$(id -u)" = 0 ] || su="sudo -n"
  $su date -u -s "$utc" >/dev/null 2>&1 || { log "clock is ${off}s off, could not set it"; return 0; }
  command -v hwclock >/dev/null 2>&1 && $su hwclock -w -u >/dev/null 2>&1
  log "clock was ${off}s off, set from the server: $(date)"
}

# Self-update from the server: files whose sha1 differs from the server's copy are replaced.
# rename() keeps the running shell on the old inode; prints "restart" when this script changed.
cmd_update() {
  need_link
  man="$(http GET "$SERVER/api/v1/link/client/manifest" - -)" || return 1
  # The server's clock ("YYYY-MM-DD HH:MM", its time zone): handhelds without a clock that keeps time say when
  # they were updated by it
  printf '%s\n' "$man" | sed -n "s/^now$TAB//p" > "$WORK/server-now"
  set_clock "$(printf '%s\n' "$man" | sed -n "s/^clock$TAB//p")"
  # Onion apps installed before the app had its own icon point at one of Onion's
  if [ -f "$DIR/config.json" ] && ! grep -q '"icon" *: *"icon.png"' "$DIR/config.json"; then
    sed 's#"icon" *: *"[^"]*"#"icon": "icon.png"#' "$DIR/config.json" > "$DIR/config.json.new" && mv "$DIR/config.json.new" "$DIR/config.json"
  fi
  printf '%s\n' "$man" | while IFS="$TAB" read -r kind name hash; do
    [ "$kind" = file ] || continue
    case "$name" in */*|.*|"") continue ;; esac
    target="$DIR/$name"
    # Only what this device uses: the script always, the setup app's files where the app is installed
    case "$name" in
      rommancer-sync.sh|cacert.pem) ;;
      # The app's icon (Onion, whose app folder has a config.json) and its picture in EmulationStation
      icon.png) [ -f "$target" ] || [ -f "$DIR/config.json" ] || [ -f "$DIR/rommancer-ui.py" ] || continue ;;
      rommancer-art.png) [ -f "$target" ] || [ -f "$DIR/rommancer-ui.py" ] || continue ;;
      *) [ -f "$DIR/rommancer-ui.py" ] || continue ;;
    esac
    [ -f "$target" ] && [ "$(sha1 "$target")" = "$hash" ] && continue
    http GET "$SERVER/api/v1/link/client/file/$name" - "$WORK/update.tmp" || continue
    [ "$(sha1 "$WORK/update.tmp")" = "$hash" ] || { log "update: bad download of $name"; continue; }
    cp "$WORK/update.tmp" "$target.new" && chmod +x "$target.new" 2>/dev/null; mv "$target.new" "$target" && log "updated $name"
    [ "$name" = rommancer-sync.sh ] && echo restart
  done
  # Reached the server (the daemon tells this from a check that could not)
  return 0
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
  last=""; since=$FULL_SECONDS; update_due=1; started="$(date +%s)"
  rm -f "$WORK/offline-since"
  app_label
  while :; do
    # Each full pass also checks for a newer client and restarts into it. At power-on the WiFi may not be up yet:
    # a check that could not reach the server is tried again at the next tick, not a full pass later
    if [ "$since" -ge "$FULL_SECONDS" ] || [ "$update_due" = 1 ]; then
      up="$(cmd_update 2>/dev/null)" && update_due=0 || update_due=1
      [ "$up" = restart ] && exec sh "$DIR/$(basename "$0")" daemon
    fi
    if [ -z "${SAVE_DIRS:-}" ]; then
      roots="$(http GET "$SERVER/api/v1/agent/roots" - -)" && { SAVE_DIRS="$(printf '%s\n' "$roots" | sed -n "s/^saves$TAB//p")"; EXTS="$(field exts "$roots")"; }
    fi
    # The web app can ask for a sync now or for roms: a tiny request on every watch tick
    if asked="$(HTTP_MAX=5 http_once GET "$SERVER/api/v1/agent/poll" - - 2>/dev/null)"; then
      date +%s > "$WORK/last-ok"; nfail=0
      [ -f "$WORK/offline-since" ] && { rm -f "$WORK/offline-since"; state_changed online; }
      n="$(printf '%s\n' "$asked" | sed -n "s/^conflicts$TAB//p")"; n="${n:-0}"
      old="$(cat "$WORK/conflicts-open" 2>/dev/null || echo 0)"
      echo "$n" > "$WORK/conflicts-open"
      if [ "$n" -gt "$old" ]; then state_changed conflicts; else app_label; fi
    else
      # Offline once two polls in a row failed (a lost packet is not news), dated from the first; not in the first
      # minute and a half after power-on, while the WiFi comes up
      nfail=$((${nfail:-0} + 1))
      [ "$nfail" = 1 ] && date +%s > "$WORK/fail-first"
      if [ "$nfail" -ge 2 ] && [ ! -f "$WORK/offline-since" ] && [ $(( $(date +%s) - started )) -ge 90 ]; then
        mv "$WORK/fail-first" "$WORK/offline-since"; state_changed offline
      fi
    fi
    # A game starts: where its saves stand, on its screen
    ended=0
    if game_running; then
      [ "${in_game:-0}" = 1 ] || { in_game=1; warned=0; if [ -f "$WORK/offline-since" ]; then ra_msg "Rommancer: $(state_text start-offline)"; else ra_msg "Rommancer: $(state_text start-ok)"; fi; }
    else [ "${in_game:-0}" = 1 ] && ended=1; in_game=0; fi
    case "$asked" in *sync*) since=$FULL_SECONDS ;; esac
    # Another device sent a save this one should have, or a game ended (the saves held back during it): a saves pass now
    nudged=$ended; case "$asked" in *saves*) nudged=1 ;; esac
    # Roms for the server go in the background: saves keep syncing while a long copy runs
    case "$asked" in *pull*) pulls_running || (nohup sh "$DIR/$(basename "$0")" pulls > /dev/null 2>&1 &) ;; esac
    fp="$(fingerprint)"
    # A game may still be writing its save: go ahead only once the files stay unchanged for a moment
    if [ "$fp" != "$last" ] && [ -n "$last" ]; then
      sleep 3; since=$((since + 3))
      [ "$(fingerprint)" = "$fp" ] || fp="$last"
    fi
    if [ "$fp" != "$last" ] || [ "$since" -ge "$FULL_SECONDS" ] || [ "$nudged" = 1 ]; then
      # Not "full": rom_line (inside cmd_sync) uses that name for a hash
      full_pass=0; [ "$since" -ge "$FULL_SECONDS" ] && full_pass=1
      if cmd_sync; then
        last="$(fingerprint)"; since=0
        # A save made during the game reached the server
        [ "${in_game:-0}" = 1 ] && [ "${ups:-0}" -gt 0 ] && ra_msg "Rommancer: $(state_text uploaded)"
      elif [ "${in_game:-0}" = 1 ] && [ "${warned:-0}" = 0 ] && [ "$fp" != "$last" ]; then
        # Saved with no connection: once per game, where the save stays
        warned=1; ra_msg "Rommancer: $(state_text kept)"
      fi
      [ "$full_pass" = 1 ] && lists_scan
      [ "$full_pass" = 1 ] && cmd_config > /dev/null 2>&1
      [ "$full_pass" = 1 ] && autosave_on
      [ "$full_pass" = 1 ] && cmd_prune > /dev/null 2>&1
      cmd_collections > /dev/null 2>&1
    fi
    # Game lists still to reload (a download or deletion ended during a game)
    refresh_lists
    sleep "$WATCH_SECONDS"; since=$((since + WATCH_SECONDS))
  done
}

# The launcher's picture in EmulationStation: an entry in the folder's gamelist.xml, added once (an entry the
# user already has is left alone). Knulli/Batocera reload their lists; ArkOS shows it after a restart
es_picture() {
  folder="$1"; launcher="$2"
  [ -f "$folder/$launcher" ] && [ -f "$DIR/rommancer-art.png" ] || return 0
  mkdir -p "$folder/images"
  cmp -s "$DIR/rommancer-art.png" "$folder/images/rommancer-sync.png" || cp "$DIR/rommancer-art.png" "$folder/images/rommancer-sync.png"
  list="$folder/gamelist.xml"
  grep -qF "<path>./$launcher</path>" "$list" 2>/dev/null && return 0
  [ -s "$list" ] && grep -q '</gameList>' "$list" || printf '<?xml version="1.0"?>\n<gameList>\n</gameList>\n' > "$list"
  entry="\t<game>\n\t\t<path>./$launcher</path>\n\t\t<name>Rommancer Sync</name>\n\t\t<desc>Sync saves, savestates and roms with your Rommancer server.</desc>\n\t\t<image>./images/rommancer-sync.png</image>\n\t</game>"
  awk -v e="$entry" '/<\/gameList>/ && !done { gsub(/\\t/, "\t", e); gsub(/\\n/, "\n", e); print e; done = 1 } { print }' "$list" > "$WORK/gamelist.xml" && cat "$WORK/gamelist.xml" > "$list"
  case "$FW" in knulli|batocera) curl -fsS -m 3 http://127.0.0.1:1234/reloadgames >/dev/null 2>&1 ;; esac
  log "picture added to $list"
}

# Boot and game-end hooks where the firmware offers them
# Onion has no game start event: a line in launch_game of its runtime.sh (every launch passes there: menu, recents,
# Game Switcher) fetches the game's saves right before it starts. Put back at every daemon start, as Onion's updates
# replace that file; Onion reads it at power-on, so it works from the next one
onion_hook() {
  rt=/mnt/SDCARD/.tmp_update/runtime.sh
  AT='        playActivity start "$rompath"'
  L="        [ -f \"$1\" ] && sh \"$1\" game-start \"\$rompath\" >/dev/null 2>&1"
  [ -f "$rt" ] && ! grep -qxF "$L" "$rt" || return 0
  grep -qxF "$AT" "$rt" || { log "game-start hook: Onion's runtime.sh has no launch line we know, not hooked"; return 0; }
  AT="$AT" L="$L" awk '{ print } $0 == ENVIRON["AT"] && !done { print ENVIRON["L"]; done = 1 }' "$rt" > "$rt.rommancer"
  if grep -qxF "$L" "$rt.rommancer" && sh -n "$rt.rommancer"; then
    chmod +x "$rt.rommancer" && mv "$rt.rommancer" "$rt" && log "game-start hook added to Onion's runtime.sh" && touch "$STATE/hook-restart"
  else rm -f "$rt.rommancer"; log "game-start hook: could not add it to Onion's runtime.sh"; fi
}

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
      for f in /userdata/roms/tools /userdata/roms/ports; do es_picture "$f" "Rommancer Sync.sh"; done
      say "Installed: sync at boot ($boot), save fetched before each game and uploaded after it" ;;
    onion)
      boot=/mnt/SDCARD/.tmp_update/startup/rommancer-sync.sh
      mkdir -p "$(dirname "$boot")"
      # Onion runs startup scripts one after another before its menu: "boot" waits for the first sync
      printf '#!/bin/sh\n[ -f "%s" ] && (cd "%s" && sh "%s" boot >/dev/null 2>&1)\n' "$self" "$DIR" "$self" > "$WORK/boot.sh"
      cmp -s "$WORK/boot.sh" "$boot" || cat "$WORK/boot.sh" > "$boot"
      onion_hook "$self"
      say "Installed: daemon at boot ($boot), save fetched before each game" ;;
    arkos)
      # Everything runs as root (passwordless sudo): NetworkManager's files need it, and the game events share one lock
      su=""; [ "$(id -u)" = 0 ] || su="sudo -n"
      printf '[Unit]\nDescription=Rommancer Sync\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=/bin/sh "%s" daemon\nRestart=on-failure\nRestartSec=30\n\n[Install]\nWantedBy=multi-user.target\n' "$self" > "$WORK/unit"
      if ! cmp -s "$WORK/unit" /etc/systemd/system/rommancer-sync.service; then
        $su cp "$WORK/unit" /etc/systemd/system/rommancer-sync.service && $su systemctl daemon-reload && $su systemctl enable rommancer-sync.service >/dev/null 2>&1
      fi
      # EmulationStation runs these as ark before and after each game, the rom as an escaped path
      for ev in game-start game-end; do
        d=/home/ark/.emulationstation/scripts/$ev; mkdir -p "$d"
        if [ "$ev" = game-start ]; then
          printf '#!/bin/sh\n# rommancer-sync: fetch the save before the game\nrom="$1"; [ -e "$rom" ] || rom="$(printf %%s "$1" | sed "s/\\\\\\\\\\\\(.\\\\)/\\\\1/g")"\nsudo -n sh "%s" game-start "$rom" >/dev/null 2>&1\nexit 0\n' "$self" > "$WORK/hook.sh"
        else
          printf '#!/bin/sh\n# rommancer-sync: upload saves after the game\n(sudo -n nohup sh "%s" game-stop >/dev/null 2>&1 &)\nexit 0\n' "$self" > "$WORK/hook.sh"
        fi
        cmp -s "$WORK/hook.sh" "$d/rommancer-sync.sh" || cat "$WORK/hook.sh" > "$d/rommancer-sync.sh"
        chmod +x "$d/rommancer-sync.sh"; chown ark:ark "$d" "$d/rommancer-sync.sh" 2>/dev/null
      done
      for f in /roms/tools /roms2/tools; do es_picture "$f" "Rommancer Sync.sh"; chown -R ark:ark "$f/images" "$f/gamelist.xml" 2>/dev/null; done
      say "Installed: daemon at boot (rommancer-sync.service), save fetched before each game and uploaded after it" ;;
    nextui)
      # Hooks live per platform; the folder is created at every boot
      found=""
      for h in /mnt/SDCARD/.userdata/*/.hooks "/mnt/SDCARD/.userdata/${PLATFORM:-none}/.hooks"; do
        [ -d "$(dirname "$h")" ] && [ "$h" != "/mnt/SDCARD/.userdata/shared/.hooks" ] || continue
        case "$h" in *"/*/"*) continue ;; esac
        mkdir -p "$h/boot.d" "$h/pre-launch.d" "$h/post-launch.d" && found=1
        # boot.d waits for its scripts before the menu: the daemon goes to the background
        printf '#!/bin/sh\n[ -f "%s" ] && (cd "%s" && nohup sh "%s" boot >/dev/null 2>&1 &)\nexit 0\n' "$self" "$DIR" "$self" > "$WORK/hook.sh"
        cmp -s "$WORK/hook.sh" "$h/boot.d/rommancer-sync.sh" || cat "$WORK/hook.sh" > "$h/boot.d/rommancer-sync.sh"
        # *.sync.sh runs before the game starts, so its save is in place; HOOK_ROM_PATH breaks on apostrophes
        printf '#!/bin/sh\n[ "$HOOK_TYPE" = rom ] || exit 0\neval "set -- $HOOK_CMD"\nsh "%s" game-start "$2" >/dev/null 2>&1\nexit 0\n' "$self" > "$WORK/hook.sh"
        cmp -s "$WORK/hook.sh" "$h/pre-launch.d/rommancer-sync.sync.sh" || cat "$WORK/hook.sh" > "$h/pre-launch.d/rommancer-sync.sync.sh"
        printf '#!/bin/sh\n[ "$HOOK_TYPE" = rom ] || exit 0\n(nohup sh "%s" game-stop >/dev/null 2>&1 &)\nexit 0\n' "$self" > "$WORK/hook.sh"
        cmp -s "$WORK/hook.sh" "$h/post-launch.d/rommancer-sync.sh" || cat "$WORK/hook.sh" > "$h/post-launch.d/rommancer-sync.sh"
        chmod +x "$h"/*/rommancer-sync*.sh
      done
      if [ -n "$found" ]; then say "Installed: daemon at boot, save fetched before each game and uploaded after it"
      else say "NextUI hooks folder not found: start NextUI once and run install again"; fi ;;
    *) say "No automatic install for $FW yet; run '$self daemon' at startup" ;;
  esac
}

# ---------- roms of the lists assigned to this device ----------

# The web app changed the deletion of roms in no list ("prune<TAB>value<TAB>files<TAB>bytes"): the same switch on
# both sides, applied at once either way (the user already said so there)
prune_answer() {
  rm -f "$STATE/prune-ask"
  [ -n "$1" ] || return 0
  prune_set "$(printf '%s' "$1" | cut -f2)"
}
prune_set() { PRUNE_ROMS="$1"; set_setting PRUNE_ROMS "$1"; touch "$STATE/prune-set"; [ "$1" = 1 ] || rm -f "$STATE/prune-hold"; }

# Deletes the roms the server names as in no list of this console (only with PRUNE_ROMS=1, never during a game,
# only inside the roms folder). A deletion of more than half of the roms waits in $STATE/prune-hold for the user
# ("prune confirm"). Deleted paths are kept in $STATE/pruned for the saves clean-up ("prune clean").
# A lock of its own for NAME: a directory holding its owner's pid (one left by a process that died is taken over)
own_lock() {
  l="$WORK/$1-lock"
  if mkdir "$l" 2>/dev/null; then echo $$ > "$l/pid"; return 0; fi
  o="$(cat "$l/pid" 2>/dev/null)"
  if [ -n "$o" ] && ! kill -0 "$o" 2>/dev/null; then rm -rf "$l"; mkdir "$l" 2>/dev/null && echo $$ > "$l/pid" && return 0; fi
  return 1
}

# One deletion at a time: the daemon's pass and a sync started at power-on or on screen can meet, and the second one
# leaves it to the first
cmd_prune() {
  need_link
  [ "$PRUNE_ROMS" = 1 ] && [ ! -f "$STATE/prune-ask" ] || return 0
  playing && return 0
  own_lock prune || return 0
  prune_run; rc=$?
  rm -rf "$WORK/prune-lock"
  return $rc
}
prune_run() {
  if [ -z "${ROMS:-}" ]; then roots="$(http GET "$SERVER/api/v1/agent/roots" - -)" || return 1; ROMS="$(field roms "$roots")"; fi
  [ -n "$ROMS" ] || return 1
  http GET "$SERVER/api/v1/agent/prune" - "$WORK/pruneplan" || { log "prune: server unreachable"; return 1; }
  hold="$(grep "^hold$TAB" "$WORK/pruneplan" | head -n 1)"
  if [ -n "$hold" ]; then
    printf '%s\t%s\n' "$(printf '%s' "$hold" | cut -f2)" "$(printf '%s' "$hold" | cut -f3)" > "$STATE/prune-hold"
    log "prune: $(printf '%s' "$hold" | cut -f2) roms to delete, waiting for confirmation"; return 0
  fi
  rm -f "$STATE/prune-hold"
  n=0; i=0; pn="$(grep -c "^del$TAB" "$WORK/pruneplan")"
  while IFS="$TAB" read -r kind p _; do
    [ "$kind" = del ] || continue
    i=$((i + 1)); progress_file prune "$i" "$pn" "$p"
    case "$p" in "${ROMS%/}"/*/*) ;; *) continue ;; esac
    [ -f "$p" ] || continue
    rm -f "$p" && { n=$((n + 1)); printf '%s\n' "$p" >> "$STATE/pruned"; roms_changed "$p"; }
  done < "$WORK/pruneplan"
  refresh_lists
  [ "$n" -gt 0 ] && log "prune: $n roms in no list deleted"
  sum_line games-deleted "$n"
  [ -n "${VERBOSE:-}" ] && printf 'deleted: %s roms in no list\n' "$n"
  return 0
}

# Saves and states of the roms deleted for being in no list: removed once a sync went through (they are on the server)
cmd_prune_clean() {
  need_link
  [ -s "$STATE/pruned" ] || { echo "cleaned: 0 files"; return 0; }
  VERBOSE=1 cmd_sync > "$WORK/clean-sync" 2>&1 || { echo "cleaned: 0 files (no sync)"; return 1; }
  grep -q ', 0 errors' "$WORK/clean-sync" || { grep "^sum$TAB" "$WORK/clean-sync"; echo "cleaned: 0 files (sync errors)"; return 1; }
  http POST "$SERVER/api/v1/agent/prune/saves" "$STATE/pruned" "$WORK/prunesaves" || { echo "cleaned: 0 files (no server)"; return 1; }
  n=0
  while IFS="$TAB" read -r kind f; do
    [ "$kind" = file ] && [ -f "$f" ] || continue
    rm -f "$f" && n=$((n + 1))
  done < "$WORK/prunesaves"
  rm -f "$STATE/pruned"
  log "prune: $n save files of deleted roms removed"
  # The summary: the sync that went first, then what went
  grep "^sum$TAB" "$WORK/clean-sync"
  [ "$n" = 0 ] || printf 'sum\tsaves-cleaned\t%s\n' "$n"
  echo "cleaned: $n files"
}

free_bytes() {
  d="$1"; while [ ! -d "$d" ]; do d="$(dirname "$d")"; done
  echo $(( $(df -k "$d" 2>/dev/null | awk 'NR == 2 { print $4 }') * 1024 ))
}

# Roms Rommancer added or deleted (one path per argument): the firmware's game lists must show the change. Kept on the
# card, so a refresh that has to wait (Onion's menu open, a game running) still happens after a reboot
roms_changed() { printf '%s\n' "$@" >> "$STATE/lists-changed"; }

# The firmware's menus read their game lists again after roms came or went, whoever changed them (a download asked
# on screen, a deletion of roms in no list):
# - Onion: its own reset_list.sh, as its game list options do: the folder's list cache goes and the list window starts
#   at the top (a cache rebuilt under an old window position shows blank rows). MainUI writes its state when it
#   closes, so only while it is not running (the Rommancer app, a game, the boot before the menu)
# - EmulationStation (Knulli, Batocera, ROCKNIX): its local API, never during a game or the Rommancer app (done when
#   it closes, or at a daemon tick)
# - ArkOS: its EmulationStation has no API and reads its lists when it starts: restarted right after a game or the
#   Rommancer app closes (AFTER-GAME), never under the user's feet
# - MinUI/NextUI list their folders as they are; for the others (muOS) no list cache is known
ONION_RESET=/mnt/SDCARD/.tmp_update/script/reset_list.sh
# Onion: rom folders changed by anyone else (the server over SSH, the desktop app on the card, files copied by
# hand) are seen here too: a print of each folder (entries and their name lengths, the menu's own caches left out)
# compared with the last one; a folder that changed has its list refreshed. Its first run only records.
lists_scan() {
  [ "${FW:-}" = onion ] && [ -d "$ROOT/Roms" ] || return 0
  find "$ROOT/Roms" -mindepth 2 -maxdepth 2 ! -name '*_cache[0-9].db' ! -name '*.db-journal' 2>/dev/null |
    awk -F/ '{ d = substr($0, 1, length($0) - length($NF) - 1); c[d]++; l[d] += length($NF) } END { for (d in c) print c[d] " " l[d] " " d }' |
    sort -k3 > "$WORK/romdirs"
  if [ -f "$STATE/romdirs" ]; then
    # Lines new or different since the last print: their folders (a folder emptied drops out, and is refreshed too)
    { sort "$WORK/romdirs" "$STATE/romdirs" | uniq -u | cut -d' ' -f3-; } | sort -u | while IFS= read -r d; do
      [ -d "$d" ] && printf '%s/-\n' "$d" >> "$STATE/lists-changed"
    done
  fi
  cat "$WORK/romdirs" > "$STATE/romdirs"
}
# Onion's menu lists the systems whose emulator is installed (from its Package Manager, App/PackageManager/data/Emu:
# each package is a tree copied onto the card). As its Package Manager does in its "auto" selection, for the folders
# Rommancer changed: a folder with roms gets its emulator installed, one Rommancer emptied has it removed
ONION_PM="${ROMMANCER_ONION_PM:-/mnt/SDCARD/App/PackageManager/data/Emu}"
ONION_PACMAN="${ROMMANCER_ONION_PACMAN:-/mnt/SDCARD/.tmp_update/script/pacman_install.sh}"

# Packages whose emulator lists a rom folder: "package<TAB>emulator folder name<TAB>extensions", one per line
onion_packages() {
  for pkg in "$ONION_PM"/*/; do
    cfg="$(ls "$pkg"Emu/*/config.json 2>/dev/null | head -n 1)"; [ -n "$cfg" ] || continue
    rp="$(sed -n 's/.*"rompath"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$cfg" | head -n 1)"
    case "$rp" in ../../*) ;; *) continue ;; esac
    [ "$ROOT/${rp#../../}" = "$1" ] || continue
    ext="$(sed -n 's/.*"extlist"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$cfg" | head -n 1)"
    printf '%s\t%s\t%s\n' "$(basename "$pkg")" "$(basename "$(dirname "$cfg")")" "$ext"
  done
}

# Onion's own test (its Package Manager's cartridge icon): a file with one of the emulator's extensions in the
# folder or one folder down, hidden names left out
onion_has_roms() {
  find "$1" -mindepth 1 -maxdepth 2 -type f 2>/dev/null | awk -v root="$1" -v ext="$2" '
    BEGIN { n = split(tolower(ext), e, "|"); for (i = 1; i <= n; i++) ok[e[i]] = 1 }
    { rel = substr($0, length(root) + 2); if (rel ~ /(^|\/)\./) next
      f = rel; sub(/.*\//, "", f); x = tolower(f); if (x !~ /\./) next; sub(/.*\./, "", x)
      if (x == "miyoocmd") next
      if (ext == "" || (x in ok)) { found = 1; exit } }
    END { exit !found }'
}

# D: a rom folder; EMPTIED: Rommancer deleted roms there
onion_emulator() {
  onion_packages "$1" > "$WORK/pkgs"; [ -s "$WORK/pkgs" ] || return 0
  installed=""; while IFS="$TAB" read -r pkg name ext; do [ -f "$ROOT/Emu/$name/config.json" ] && installed="$installed$pkg$TAB$name$TAB$ext
"; done < "$WORK/pkgs"
  IFS="$TAB" read -r pkg name ext < "$WORK/pkgs"
  if onion_has_roms "$1" "$ext"; then
    [ -z "$installed" ] || return 0
    [ -f "$ONION_PACMAN" ] || return 0
    sh "$ONION_PACMAN" "$ONION_PM" "$pkg" >/dev/null 2>&1
    [ -f "$ROOT/Emu/$name/install.sh" ] && (cd "$ROOT/Emu/$name" && sh ./install.sh >/dev/null 2>&1)
    log "onion: emulator $pkg installed for $(basename "$1")"
  elif [ "$2" = 1 ] && [ -n "$installed" ]; then
    printf '%s' "$installed" | while IFS="$TAB" read -r pkg name ext; do
      [ -n "$pkg" ] || continue
      [ -f "$ROOT/Emu/$name/uninstall.sh" ] && (cd "$ROOT/Emu/$name" && sh ./uninstall.sh >/dev/null 2>&1)
      # The package's files leave the card, then its folders when nothing else is in them (deepest first)
      (cd "$ONION_PM/$pkg" && find . -type f) | while IFS= read -r f; do rm -f "$ROOT/${f#./}"; done
      (cd "$ONION_PM/$pkg" && find . -mindepth 1 -type d) | sort -r | while IFS= read -r f; do rmdir "$ROOT/${f#./}" 2>/dev/null; done
      log "onion: emulator $pkg removed, $(basename "$1") has no roms left"
    done
  fi
}

# A rom folder as Onion's menu names its list: each emulator (or app) whose config.json "rompath" leads there,
# as "<emulator folder>/<rompath>"
onion_list_paths() {
  real="$(cd "$1" 2>/dev/null && pwd -P)" || return 0
  for cfg in "$ROOT"/Emu/*/config.json "$ROOT"/RApp/*/config.json; do
    [ -f "$cfg" ] || continue
    rp="$(sed -n 's/.*"rompath"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$cfg" | head -n 1)"
    [ -n "$rp" ] || continue
    e="$(dirname "$cfg")"
    [ "$(cd "$e/$rp" 2>/dev/null && pwd -P)" = "$real" ] && printf '%s/%s\n' "$e" "$rp"
  done
}
refresh_lists() {
  [ -n "${FW:-}" ] || detect
  # Once: roms copied before lists were refreshed this way, every system folder read again
  r="${ROMS:-}"; [ -z "$r" ] && [ "$FW" = onion ] && r="$ROOT/Roms"
  if [ ! -f "$STATE/lists-refreshed4" ] && [ -n "$r" ] && [ -d "$r" ]; then
    find "$r" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sed 's#$#/-#' >> "$STATE/lists-changed"
    touch "$STATE/lists-refreshed4"
  fi
  [ -s "$STATE/lists-changed" ] || return 0
  case "$FW" in
    onion)
      ps 2>/dev/null | grep -q '[M]ainUI' && return 0
      sed -n 's#^\(.*/Roms/[^/]*\)/.*#\1#p' "$STATE/lists-changed" | sort -u | while IFS= read -r d; do
        [ -d "$d" ] || continue
        # Emptied by Rommancer: a rom of it deleted here (a deletion pass, or a change naming a file of it)
        emptied=0
        { grep -qF "$d/" "$STATE/pruned" 2>/dev/null || grep -v '/[-+]$' "$STATE/lists-changed" | grep -qF "$d/"; } && emptied=1
        onion_emulator "$d" "$emptied"
        # The menu keeps a list's window under its emulator's path ("/mnt/SDCARD/Emu/GB/../../Roms/GB"), the one
        # Onion's own options hand to reset_list.sh: with the plain path the cache went but the old window stayed
        onion_list_paths "$d" > "$WORK/list-paths"; [ -s "$WORK/list-paths" ] || echo "$d" > "$WORK/list-paths"
        while IFS= read -r lp; do
          if [ -f "$ONION_RESET" ] && [ -f /tmp/state.json ]; then sh "$ONION_RESET" "$lp" >/dev/null 2>&1
          else
            # Before the menu ever ran (boot): no window state yet, only the saved index and the caches
            [ -f /appconfigs/romwinidx.json ] && awk -v search="$lp" '$0 ~ search { n = 4 }; n { n--; next }; 1' /appconfigs/romwinidx.json > "$WORK/romwinidx" && cat "$WORK/romwinidx" > /appconfigs/romwinidx.json
            rm -f "$d/$(basename "$d")_cache2.db" "$d/$(basename "$d")_cache6.db"
          fi
        done < "$WORK/list-paths"
        log "game list of $(basename "$d") refreshed ($(head -n 1 "$WORK/list-paths"))"
      done ;;
    knulli|batocera|rocknix)
      playing && return 0
      curl -fsS -m 10 "${ROMMANCER_ES_API:-http://127.0.0.1:1234}/reloadgames" >/dev/null 2>&1 || return 0
      log "game lists reloaded" ;;
    arkos)
      [ "${1:-}" = after-game ] || return 0
      rm -f "$STATE/lists-changed"; log "game lists: restarting EmulationStation"
      systemctl restart emulationstation >/dev/null 2>&1 || sudo -n systemctl restart emulationstation >/dev/null 2>&1
      return 0 ;;
    *)
      # A card synced elsewhere may hold Onion's caches all the same
      sed 's#/[^/]*$##' "$STATE/lists-changed" | sort -u | while IFS= read -r d; do
        for c in "$d"/*_cache6.db; do [ -f "$c" ] && rm -f "$c"; done
      done ;;
  esac
  rm -f "$STATE/lists-changed"
  return 0
}

# curl's config syntax: a value between quotes, with its backslashes and quotes escaped
curl_quote() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }

# The missing roms of the plan with a single curl: one connection for all of them (a new connection, TLS handshake
# and certificate bundle per rom cost more than a small rom's transfer). A partial file goes on where it stopped
# (plain files; entries of archives, of unknown size, start again), and a transfer is only dropped when it stalls
# (under 1 KB/s for a minute), never for taking long. Sets got, fail, have and stopped for cmd_roms
roms_fetch() {
  : > "$WORK/romget"; : > "$WORK/romcfg"
  free=""
  while IFS="$TAB" read -r kind dest size ref; do
    [ "$kind" = rom ] || continue
    if [ -f "$dest" ] && { [ "$size" = 0 ] || [ "$(stat -c %s "$dest" 2>/dev/null)" = "$size" ]; }; then have=$((have + 1)); continue; fi
    part="$dest.part"; ps=0; ip=-1
    if [ -f "$part" ]; then
      ps="$(stat -c %s "$part" 2>/dev/null || echo 0)"
      if [ "$size" = 0 ] || [ "$ps" -gt "$size" ]; then rm -f "$part"; ps=0; fi
    fi
    # Already whole (stopped right before it was renamed)
    if [ "$size" -gt 0 ] && [ "$ps" = "$size" ]; then mv "$part" "$dest" && { got=$((got + 1)); roms_changed "$dest"; printf '%s\t%s\n' "$(date +%s)" "$dest" >> "$STATE/received-roms"; }; continue; fi
    # The card's free space, read once and counted down
    [ -n "$free" ] || free="$(free_bytes "$(dirname "$dest")")"
    if [ "$size" -gt 0 ] && [ "$free" -lt $((size - ps + 52428800)) ]; then
      log "roms: not enough space for $(basename "$dest")"; nospace="$(basename "$dest")"; fail=$((fail + 1)); break
    fi
    free=$((free - size + ps))
    [ -f "$part" ] && ip="$ps"
    printf '%s\t%s\t%s\n' "$dest" "$size" "$ip" >> "$WORK/romget"
    { printf 'url = %s\n' "$(curl_quote "$SERVER/api/v1/agent/rom?f=$ref")"; printf 'output = %s\n' "$(curl_quote "$part")"; } >> "$WORK/romcfg"
  done < "$WORK/romplan"
  n="$(grep -c . "$WORK/romget")"
  [ "$n" -gt 0 ] || return 0
  {
    printf 'header = %s\n' "$(curl_quote "X-Device-Token: $TOKEN")"
    [ -n "$SD" ] && printf 'header = %s\n' "$(curl_quote "X-Device-Root-B64: $(b64 "$SD")")"
    [ -f "$DIR/cacert.pem" ] && printf 'cacert = %s\n' "$(curl_quote "$DIR/cacert.pem")"
  } > "$WORK/romcfg.head"
  # Each finished transfer prints its line: whether each file arrived whole (read once curl ends: it writes these
  # lines out in one go at the end, so they cannot tell how far the run is)
  # A server restarting (502/503 for a minute) is waited for, instead of failing every file left
  curl -K "$WORK/romcfg.head" -K "$WORK/romcfg" -f -s -S --globoff --create-dirs -C - --connect-timeout 10 --speed-limit 1024 --speed-time 60 --retry 6 --retry-delay 15 --retry-connrefused \
    -w '%{http_code}\n' > "$WORK/romdone" 2> "$WORK/roms-err" &
  cpid=$!; echo "$cpid" > "$WORK/roms-lock/curl"
  cur=1
  while kill -0 "$cpid" 2>/dev/null; do
    # How far the run is: curl takes the files in order and opens each one's .part as its data starts, so the file
    # under way is the furthest of the next few whose .part is there (a part left by an earlier cut run counts once
    # it grows; a file the server refused leaves none, hence a few ahead)
    sed -n "$((cur + 1)),$((cur + 5))p" "$WORK/romget" > "$WORK/romnext"
    j=$cur
    while IFS="$TAB" read -r dest size ip; do
      j=$((j + 1))
      ps="$(stat -c %s "$dest.part" 2>/dev/null || echo -1)"
      [ "$ps" -ge 0 ] && { [ "$ip" -lt 0 ] || [ "$ps" -gt "$ip" ]; } && cur=$j
    done < "$WORK/romnext"
    IFS="$TAB" read -r dest size _ <<EOR
$(sed -n "${cur}p" "$WORK/romget")
EOR
    printf 'roms-download\t%s\t%s\t%s\t%s\t%s\n' "$((have + got + cur))" "$total" "$size" "$dest.part" "$(basename "$dest")" > "$WORK/progress.tmp" && mv "$WORK/progress.tmp" "$WORK/progress"
    if [ -f "$WORK/roms-stop" ]; then kill "$cpid" 2>/dev/null; stopped=1; fi
    sleep 1
  done
  wait "$cpid" 2>/dev/null; crc=$?
  rm -f "$WORK/roms-lock/curl"
  cat "$WORK/roms-err" >> "$LOG" 2>/dev/null
  # Why files failed, for the screens' details (as http leaves it)
  [ "$crc" = 0 ] || [ "$stopped" = 1 ] || printf '%s\t%s\t%s\n' "$crc" "$SERVER/api/v1/agent/rom" "$(grep . "$WORK/roms-err" | tail -n 1)" > "$WORK/last-error"
  k=0
  while IFS="$TAB" read -r dest size _; do
    k=$((k + 1))
    code="$(sed -n "${k}p" "$WORK/romdone")"
    ps="$(stat -c %s "$dest.part" 2>/dev/null || echo -1)"
    # Whole: its size, or (unknown size) a transfer that ended with the server's OK; one cut by a stop printed nothing
    if { [ "$size" -gt 0 ] && [ "$ps" = "$size" ]; } || { [ "$size" = 0 ] && [ "$code" = 200 ] && [ "$ps" -ge 0 ]; }; then
      mv "$dest.part" "$dest" && { got=$((got + 1)); roms_changed "$dest"; }
      # For the "new" collection: what arrived, and when
      printf '%s\t%s\n' "$(date +%s)" "$dest" >> "$STATE/received-roms"
    elif [ "$stopped" = 0 ]; then
      fail=$((fail + 1))
      # An entry of an archive cut halfway cannot go on: start again next time
      [ "$size" = 0 ] && rm -f "$dest.part"
    fi
  done < "$WORK/romget"
  return 0
}

# A rom download is under way (a lock whose process died does not count)
roms_running() { [ -f "$WORK/roms-lock/pid" ] && kill -0 "$(cat "$WORK/roms-lock/pid")" 2>/dev/null; }

# Downloads the roms the server plans for this device and that are not here yet; never deletes. One download at a
# time: a second one asked on screen waits for the running one (both fetching every file made it twice as slow).
# Stopped on screen (roms-stop), the background passes leave the roms alone until a copy is asked for again.
cmd_roms() {
  need_link
  if [ -z "${VERBOSE:-}" ]; then [ -f "$STATE/roms-stopped" ] && return 0; else rm -f "$STATE/roms-stopped"; fi
  if roms_running; then
    [ -n "${VERBOSE:-}" ] || return 0
    # On screen while the daemon downloads: its progress is shown, and a stop ends both
    while roms_running; do sleep 1; done
    if [ -f "$STATE/roms-stopped" ]; then progress roms-finished 0 0; sum_line games-stopped 1; echo "roms: stopped"; return 0; fi
  fi
  rm -rf "$WORK/roms-lock"; mkdir -p "$WORK" && mkdir "$WORK/roms-lock" 2>/dev/null || return 0
  rm -f "$WORK/roms-stop"
  # This shell's own pid ($$ is the parent's inside a subshell): the parent of a child sh
  sh -c 'echo $PPID' > "$WORK/roms-lock/pid"
  progress roms-plan 0 0
  if ! http GET "$SERVER/api/v1/agent/roms" - "$WORK/romplan"; then
    log "roms: server unreachable"; rm -rf "$WORK/roms-lock"
    [ -n "${VERBOSE:-}" ] && { sync_failed > /dev/null; sum_line errors 1; }
    return 1
  fi
  total="$(grep -c . "$WORK/romplan")"; i=0; got=0; fail=0; have=0; stopped=0; nospace=""
  if command -v curl >/dev/null 2>&1; then roms_fetch; else
  while IFS="$TAB" read -r kind dest size ref; do
    [ "$kind" = rom ] || continue
    [ -f "$WORK/roms-stop" ] && { stopped=1; break; }
    i=$((i + 1))
    # Extra fields for the screens: file size, partial file being written and rom name
    printf 'roms-download\t%s\t%s\t%s\t%s\t%s\n' "$i" "$total" "$size" "$dest.part" "$(basename "$dest")" > "$WORK/progress.tmp" && mv "$WORK/progress.tmp" "$WORK/progress"
    if [ -f "$dest" ] && { [ "$size" = 0 ] || [ "$(stat -c %s "$dest" 2>/dev/null)" = "$size" ]; }; then have=$((have + 1)); continue; fi
    if [ "$size" -gt 0 ] && [ "$(free_bytes "$(dirname "$dest")")" -lt $((size + 52428800)) ]; then
      log "roms: not enough space for $(basename "$dest")"; nospace="$(basename "$dest")"; fail=$((fail + 1)); break
    fi
    mkdir -p "$(dirname "$dest")"
    if http GET "$SERVER/api/v1/agent/rom?f=$ref" - "$dest.part" && { [ "$size" = 0 ] || [ "$(stat -c %s "$dest.part")" = "$size" ]; }; then
      mv "$dest.part" "$dest"; got=$((got + 1)); roms_changed "$dest"
      # For the "new" collection: what arrived, and when
      printf '%s\t%s\n' "$(date +%s)" "$dest" >> "$STATE/received-roms"
    else
      rm -f "$dest.part"
      [ -f "$WORK/roms-stop" ] && { stopped=1; break; }
      fail=$((fail + 1))
    fi
  done < "$WORK/romplan"
  fi
  rm -rf "$WORK/roms-lock"
  refresh_lists
  if [ "$stopped" = 1 ]; then
    rm -f "$WORK/roms-stop"
    progress roms-finished "$got" "$fail"
    log "roms: stopped, $got downloaded"
    sum_line games-down "$got"; sum_line games-stopped 1
    [ -n "${VERBOSE:-}" ] && printf 'roms: stopped, %s downloaded\n' "$got"
    return 0
  fi
  progress roms-finished "$got" "$fail"
  log "roms: $got downloaded, $have already here, $fail failed"
  rerr="$fail"; [ -n "$nospace" ] && rerr=$((rerr - 1))
  [ -n "${VERBOSE:-}" ] && [ "$rerr" -gt 0 ] && sync_failed > /dev/null
  sum_line games-down "$got"; sum_line games-nospace "${nospace:+1}" "$nospace"; sum_line errors "$rerr"
  [ -n "${VERBOSE:-}" ] && printf 'roms: %s downloaded, %s already here, %s failed\n' "$got" "$have" "$fail"
  return 0
}

# Stops a rom download (the daemon's or one asked on screen): the transfer under way is cut and its partial file
# dropped. The background passes leave the roms alone until a copy is asked for on screen.
cmd_roms_stop() {
  touch "$STATE/roms-stopped"
  roms_running || { echo "roms: nothing to stop"; return 0; }
  touch "$WORK/roms-stop"
  [ -f "$WORK/roms-lock/curl" ] && kill "$(cat "$WORK/roms-lock/curl")" 2>/dev/null
  n=0
  while roms_running && [ "$n" -lt 30 ]; do
    for c in /proc/[0-9]*/cmdline; do
      grep -q 'agent/rom?f=' "$c" 2>/dev/null && { p="${c#/proc/}"; kill "${p%/cmdline}" 2>/dev/null; }
    done
    sleep 1; n=$((n + 1))
  done
  echo "roms: stopped"
}

# "done<TAB>total<TAB>file" of the rom download under way, for the menus (nothing when there is none)
roms_status() {
  roms_running || return 0
  s="$(sed -n "s/^roms-download$TAB\([0-9]*\)$TAB\([0-9]*\)$TAB.*$TAB\([^$TAB]*\)$/\1$TAB\2$TAB\3/p" "$WORK/progress" 2>/dev/null)"
  if [ -n "$s" ]; then printf '%s\n' "$s"; else printf '\t\t\n'; fi
}

# EmulationStation collections (Knulli, Batocera): games whose save is synced, and roms Rommancer copied in the
# last two weeks. Only Rommancer's own collection files are written, and only when their content changes;
# EmulationStation shows them once they are ticked in its collection settings and reads them when it starts
cmd_collections() {
  need_link
  [ -n "${FW:-}" ] || detect
  case "$FW" in knulli|batocera) ;; *) return 0 ;; esac
  dir="${ROMMANCER_SYSROOT:-}/userdata/system/configs/emulationstation/collections"
  mkdir -p "$dir" || return 1
  saves_name="Rommancer - With saves"; new_name="Rommancer - New"
  http GET "$SERVER/api/v1/agent/collections" - "$WORK/collections" || return 1
  sed -n "s/^saves$TAB//p" "$WORK/collections" | sort -u > "$WORK/coll-saves"
  # The last two weeks' arrivals that are still there, the newest first; older lines are dropped from the record
  since=$(( $(date +%s) - 14 * 86400 ))
  if [ -f "$STATE/received-roms" ]; then
    awk -F"$TAB" -v since="$since" '$1 >= since' "$STATE/received-roms" > "$WORK/received-roms"
    cmp -s "$WORK/received-roms" "$STATE/received-roms" || cp "$WORK/received-roms" "$STATE/received-roms"
    sort -t "$TAB" -k1,1nr "$WORK/received-roms" | cut -f2- | awk '!seen[$0]++' | while IFS= read -r f; do [ -f "$f" ] && printf '%s\n' "$f"; done > "$WORK/coll-new"
  else : > "$WORK/coll-new"; fi
  for c in saves new; do
    eval "name=\$${c}_name"
    cmp -s "$WORK/coll-$c" "$dir/custom-$name.cfg" 2>/dev/null || cp "$WORK/coll-$c" "$dir/custom-$name.cfg"
  done
  return 0
}

# What the server says about the files of the game in ROM (rh: its header), into gs-plan
gs_plan() {
  : > "$WORK/gs-present"
  while IFS= read -r p; do [ -f "$p" ] && printf '%s\t%s\n' "$p" "$(sha1 "$p")" >> "$WORK/gs-present"; done < "$WORK/gs-manifest"
  http POST "$SERVER/api/v1/agent/start" "$WORK/gs-present" "$WORK/gs-plan" "$rh"
}

# One conflict on screen (a "conflict" line of the server: conflictLine), the newer save first; START: before its game,
# with a way to decide later. Returns 0 to keep this console's save, 1 the server's, 255 none chosen
conflict_ask() {
  IFS="$TAB" read -r _ _ c_game c_kind _ _ c_dev _ c_mine c_theirs c_tz c_base c_newer <<EOF2
$1
EOF2
  if [ -f "$DIR/rommancer-ui.py" ] && [ ! -x "$ONION_BIN/prompt" ] && command -v python3 >/dev/null 2>&1; then
    tm=""; command -v timeout >/dev/null 2>&1 && [ -n "${2:-}" ] && tm="timeout 180"
    # The answer is what it prints, never its exit code (a failure must not read as a choice)
    ans="$(cd "$DIR" && $tm python3 rommancer-ui.py conflict "$1" ${2:+start} 2> "$WORK/ui-ask.err" | tail -n 1)"
    case "$ans" in device) return 0 ;; server) return 1 ;; esac
    return 255
  fi
  [ -x "$ONION_BIN/prompt" ] || return 255
  c_what="$(t savekind)"; [ "$c_kind" = STATE ] && c_what="$(t savestate)"
  c_here="$(t thisconsole)"; [ "$c_newer" = device ] && c_here="$c_here  ·  $(t newer)"
  c_there="$c_dev"; [ "$c_newer" = server ] && c_there="$c_there  ·  $(t newer)"
  c_msg="$c_game ($c_what)
■ $c_here: $c_mine
■ $c_there: $c_theirs
$(t conflictfoot "$c_tz" "$c_base")"
  keep_here="$(t keephere "${c_mine##* }")"; keep_there="$(t keepthere "$c_dev" "${c_theirs##* }")"
  if [ "$c_newer" = server ]; then
    menu "$(t gsconflict)" "$c_msg" "$keep_there" "$keep_here" ${2:+"$(t decidelater)"}
    case $? in 0) return 1 ;; 1) return 0 ;; esac
  else
    menu "$(t gsconflict)" "$c_msg" "$keep_here" "$keep_there" ${2:+"$(t decidelater)"}
    case $? in 0) return 0 ;; 1) return 1 ;; esac
  fi
  return 255
}

# Right before a game starts (Onion's runtime, EmulationStation's event): sends what changed here, settles its
# conflicts on screen and fetches the server's saves, for that rom only
cmd_game_start() {
  touch "$WORK/playing"
  rom="$1"; [ -n "$TOKEN" ] && [ -f "$rom" ] && [ "$GAME_SYNC" = 1 ] || return 0
  # Known to be offline: the game starts at once with its local save
  [ -f "$WORK/offline-since" ] && { log "game-start: offline, playing local save"; return 0; }
  fix_clock
  HTTP_MAX=10
  rh="X-Rom-B64: $(b64 "$rom")"
  # Offline only when the server could not be reached: a refusal (a game it cannot place) says so
  if ! http GET "$SERVER/api/v1/agent/manifest" - "$WORK/gs-manifest" "$rh"; then
    case "$(cut -f1 "$WORK/last-error" 2>/dev/null)" in
      22) log "game-start: the server does not sync saves for $(basename "$rom") ($(cut -f3 "$WORK/last-error" | sed 's/.*returned error: //'))" ;;
      *) log "game-start: offline, playing local save" ;;
    esac
    return 0
  fi
  gs_plan || return 0
  # Saves changed here since the last sync go up first (savestates wait for the sync: big, and the game does not
  # need them sent): one that clashes with the server's becomes a conflict
  if grep -q "^put$TAB" "$WORK/gs-plan"; then
    grep "^put$TAB" "$WORK/gs-plan" | while IFS="$TAB" read -r _ p; do
      is_state "$p" && continue
      http POST "$SERVER/api/v1/agent/upload" "$p" - "$rh" "X-Path-B64: $(b64 "$p")" >/dev/null && log "game-start: sent $(basename "$p")"
    done
    gs_plan || return 0
  fi
  # Conflicts are settled on screen before the game starts; unanswered (or no screen) they wait, the local save plays
  if [ "$GAME_ASK" = 1 ] && grep -q "^conflict$TAB" "$WORK/gs-plan"; then
    rm -f "$WORK/gs-resolved"
    grep "^conflict$TAB" "$WORK/gs-plan" > "$WORK/gs-conflicts"
    while IFS= read -r cline; do
      id="$(printf '%s' "$cline" | cut -f2)"
      conflict_ask "$cline" start < /dev/null
      case $? in
        0) keep=device ;; 1) keep=server ;; *) log "game-start: conflict $id left for later"; continue ;;
      esac
      printf 'keep=%s' "$keep" > "$WORK/resolve"
      http POST "$SERVER/api/v1/agent/conflicts/$id" "$WORK/resolve" - "Content-Type: application/x-www-form-urlencoded" >/dev/null && log "conflict $id: kept $keep" && touch "$WORK/gs-resolved"
    done < "$WORK/gs-conflicts"
    [ -f "$WORK/gs-resolved" ] && { gs_plan || return 0; }
  fi
  while IFS="$TAB" read -r action p v; do
    [ "$action" = tget ] && { thumb_get "$p" "$v"; continue; }
    [ "$action" = aside ] && { set_aside "$p"; continue; }
    [ "$action" = cget ] && { card_get "$p" "$v" "$rom" start && log "game-start: card $(basename "$p")"; continue; }
    [ "$action" = get ] || continue
    mkdir -p "$(dirname "$p")"
    http GET "$SERVER/api/v1/agent/file?v=$v" - "$p.rommancer-tmp" "$rh" "X-Path-B64: $(b64 "$p")" && replace_save "$p.rommancer-tmp" "$p" && log "game-start: got $(basename "$p")"
    rm -f "$p.rommancer-tmp"
  done < "$WORK/gs-plan"
  return 0
}

# "Sync now" on the console's screen: saves, settings, roms in no list, the lists' roms and the roms the server asked
# for, each a numbered step for the screens (a sync that could not reach the server ends it: each step would wait for
# the network again). Deleting roms in no list is a step only when it is on, sending roms only when the server asked
# for some and no copy runs already (a running one is watched from the menu)
cmd_all() {
  rm -f "$WORK/step"
  a_pulls=0
  if [ "$ALLOW_PULL" = 1 ] && [ -n "$TOKEN" ] && ! pulls_running && HTTP_MAX=10 http_once GET "$SERVER/api/v1/agent/pulls" - "$WORK/pulls-ask" 2>/dev/null; then
    grep -q '^pull' "$WORK/pulls-ask" && a_pulls=1
  fi
  a_m=3; [ "$PRUNE_ROMS" = 1 ] && a_m=$((a_m + 1)); a_m=$((a_m + a_pulls)); a_n=1
  step "$a_n" "$a_m" saves
  cmd_sync || { rm -f "$WORK/step"; return 0; }
  a_n=$((a_n + 1)); step "$a_n" "$a_m" settings; progress settings 0 0
  cmd_config
  if [ "$PRUNE_ROMS" = 1 ]; then a_n=$((a_n + 1)); step "$a_n" "$a_m" prune; progress prune 0 0; cmd_prune; fi
  a_n=$((a_n + 1)); step "$a_n" "$a_m" roms
  cmd_roms
  if [ "$a_pulls" = 1 ]; then a_n=$((a_n + 1)); step "$a_n" "$a_m" pulls; progress pulls 0 0; cmd_pulls; fi
  cmd_collections > /dev/null 2>&1
  rm -f "$WORK/step"
  return 0
}

# A copy for the server is under way (a lock whose process died does not count)
pulls_running() { [ -f "$WORK/pull-lock/pid" ] && kill -0 "$(cat "$WORK/pull-lock/pid")" 2>/dev/null; }

# A game is running: the firmware's game events set the flag, and an emulator must really be running
# (a crashed game may never send its end event)
playing() {
  [ -f "$WORK/playing" ] || return 1
  ps 2>/dev/null | grep -q '[e]mulatorlauncher\|[r]etroarch\|[m]inarch\|[d]rastic\|[p]pssppSDL\|[m]upen64plus\|[d]uckstation\|[r]etrorun' && return 0
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
  total="$(grep -c '^pull' "$WORK/pulls")"; i=0; sent=0; missing=0
  while IFS="$TAB" read -r kind id p; do
    [ "$kind" = pull ] || continue
    i=$((i + 1))
    # "done<TAB>total<TAB>size<TAB>name" for the app's screens, apart from the sync's progress
    psz="$(stat -c %s "$p" 2>/dev/null || echo 0)"
    printf '%s\t%s\t%s\t%s\n' "$i" "$total" "$psz" "$(basename "$p")" > "$WORK/pull-progress.tmp" && mv "$WORK/pull-progress.tmp" "$WORK/pull-progress"
    # A step of "Sync now": its progress as the roms' ("phase<TAB>done<TAB>total<TAB>size<TAB><TAB>name")
    [ -n "${VERBOSE:-}" ] && printf 'pulls\t%s\t%s\t%s\t\t%s\n' "$i" "$total" "$psz" "$(basename "$p")" > "$WORK/progress.tmp" && mv "$WORK/progress.tmp" "$WORK/progress"
    # Never compete with a game for the network and the card: wait until it ends
    while playing; do sleep 20; done
    if [ ! -f "$p" ]; then
      http POST "$SERVER/api/v1/agent/pull/$id" - - "X-Missing: 1" >/dev/null 2>&1
      missing=$((missing + 1)); continue
    fi
    if command -v curl >/dev/null 2>&1; then
      # A stalled transfer (under 1 KB/s for a minute) is dropped and sent again later
      # --globoff: rom names often carry [brackets] that curl would read as a pattern
      # The progress bar (-#) goes to a file the app's screens read for the file's share
      # No time limit (a big rom over a slow WiFi takes hours), only a stall ends it; no "Expect: 100-continue" wait
      set -- -f -S -# --globoff --connect-timeout 5 --speed-limit 1024 --speed-time 120 -X POST -H "X-Device-Token: $TOKEN" -H "Expect:" -T "$p"
      [ -f "$DIR/cacert.pem" ] && set -- "$@" --cacert "$DIR/cacert.pem"
      curl "$@" "$SERVER/api/v1/agent/pull/$id" > "$WORK/pull-result" 2> "$WORK/pull-curl"
    else
      wget -q -T 60 -O "$WORK/pull-result" --header="X-Device-Token: $TOKEN" --post-file="$p" "$SERVER/api/v1/agent/pull/$id"
    fi && { sent=$((sent + 1)); log "sent $(basename "$p"): $(head -n 1 "$WORK/pull-result")"; }
  done < "$WORK/pulls"
  rm -f "$WORK/pull-progress" "$WORK/pull-curl"
  log "pulls: $sent of $total sent"
  sum_line games-sent "$sent"; sum_line errors $((total - sent - missing))
  [ -n "${VERBOSE:-}" ] && printf 'sent to server: %s of %s\n' "$sent" "$total"
  rm -rf "$WORK/pull-lock"
  trap - EXIT INT TERM
  return 0
}

# conflict<TAB>id<TAB>game<TAB>kind<TAB>this device's date<TAB>server date<TAB>server's device
cmd_conflicts() { need_link; http GET "$SERVER/api/v1/agent/conflicts" - -; }

# The lists the console's owner may give it, as the server says: "prune<TAB>0|1", then
# "list<TAB>id<TAB>on<TAB>items<TAB>name<TAB>owner" each (owner empty for one's own), the console's own first
cmd_lists() { need_link; http GET "$SERVER/api/v1/agent/lists" - -; }
# "lists-preview ID..." (what having just those lists would delete here) and "lists-set ID..." (having just those)
lists_post() {
  need_link; path="$1"; shift
  printf '%s\n' "$@" > "$WORK/lists-body"
  http POST "$SERVER/api/v1/agent/$path" "$WORK/lists-body" - "Content-Type: text/plain"
}

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

# Every text the console shows (vocabulary in docs/clients-ux.md: save,
# savestate, game); counts of one take the singular
t() {
    case "$1" in
      server) echo "Server" ;; login) echo "Log in" ;; signup) echo "Create account" ;; quit) echo "Exit" ;;
      user) echo "USERNAME OR EMAIL" ;; username) echo "USERNAME" ;; email) echo "EMAIL" ;; password) echo "PASSWORD" ;;
      sync) echo "Sync now" ;; status) echo "Status" ;; settings) echo "Settings" ;; unlink) echo "Disconnect this console" ;;
      account) echo "Account: $2 @ $3" ;; notlinked) echo "This console is not linked" ;;
      badserver) echo "No Rommancer at that address" ;; badlogin) echo "Wrong username or password" ;;
      exists) echo "That username or email already exists" ;; signupfail) echo "Could not create the account: check the details" ;; closed) echo "This server does not allow new accounts" ;;
      finished) echo "Done. Automatic sync is on." ;; syncing) echo "Syncing..." ;;
      allowpull) echo "The server may request games: $2" ;; allowssh) echo "Server SSH access: $2" ;;
      prune) echo "Delete games in no list: $2" ;; pruneclean) echo "Delete saves of deleted games ($2)" ;;
      settingsinfo) echo "Before each game: its saves are fetched, and save conflicts asked about. Request games: the server copies the ones it lacks. SSH: syncs even while the app is closed. No list: deletes the games that are in none." ;;
      gamesync) echo "Sync before each game: $2" ;; gameask) echo "Ask about conflicts before a game: $2" ;;
      unlinkask) echo "Disconnect this console from $2? Its saves stay on it, but it stops syncing." ;; unlinkgo) echo "Disconnect" ;;
      restarttitle) echo "Restart to finish" ;; restartnow) echo "Restart now" ;; restarting) echo "Restarting..." ;;
      restartask) echo "Rommancer fetches each game's save right before the game starts. Onion turns this on after a restart." ;;
      yes) echo "yes" ;; no) echo "no" ;; conflicts) echo "Conflicts ($2)" ;; noconflicts) echo "No conflicts" ;;
      thisconsole) echo "This console" ;; newer) echo "newer" ;; savekind) echo "save" ;;
      keephere) echo "Keep this console's ($2)" ;; keepthere) echo "Keep $2's ($3)" ;;
      conflictfoot) if [ "$3" = - ]; then echo "Times in $2. The one you don't keep stays in the save's history on the web."; else echo "Times in $2. Both changed after $3. The one you don't keep stays in the save's history on the web."; fi ;;
      gsconflict) echo "Save conflict" ;; decidelater) echo "Decide later (play this console's)" ;; savestate) echo "savestate" ;;
      conflictsline) if [ "$2" = 1 ]; then echo "1 save in conflict"; else echo "$2 saves in conflict"; fi ;;
      offlinesince) echo "Offline since $2" ;;
      w_roms) echo "Downloading games $2" ;; w_pulls) echo "Sending games to the server $2" ;;
      romswatch) echo "Watch game download" ;; pullswatch) echo "Watch games being sent to the server" ;;
      romsnow) echo "Download the lists' games now" ;;
      step) echo "Step $2 of $3 · $4" ;; of) echo "of" ;;
      st_saves) echo "Saves" ;; st_settings) echo "Settings" ;; st_prune) echo "Games in no list" ;; st_roms) echo "List games" ;; st_pulls) echo "Sending to the server" ;;
      p_waiting) echo "Waiting for the sync under way" ;; p_connecting) echo "Contacting the server" ;;
      p_roms) echo "Checking games" ;; p_saves) echo "Checking saves" ;; p_hashing) echo "Reading new or changed files" ;;
      p_server) echo "Asking the server" ;; p_transfer) echo "Passing saves" ;; p_identify) echo "Identifying games by their header" ;;
      p_finished) echo "Saves up to date" ;; p_settings) echo "Applying the server's settings" ;; p_prune) echo "Deleting games in no list" ;;
      p_roms-plan) echo "Asking which games belong here" ;; p_roms-download) echo "Downloading games" ;; p_roms-finished) echo "Games up to date" ;;
      p_pulls) echo "Sending games to the server" ;; p_*) echo "Working..." ;;
      stophint) echo "B to stop" ;; backhint) echo "B goes back to the menu; sending goes on" ;; stopping) echo "Stopping the download..." ;;
      details) echo "Show details" ;; uptodate) echo "All up to date" ;; lastresult) echo "Last result:" ;; log) echo "Log:" ;;
      f_saves-up) if [ "$2" = 1 ]; then echo "${UP}1 save uploaded to the server"; else echo "$UP$2 saves uploaded to the server"; fi ;;
      f_saves-down) if [ "$2" = 1 ]; then echo "${DOWN}1 save received"; else echo "$DOWN$2 saves received"; fi ;;
      f_states-up) if [ "$2" = 1 ]; then echo "${UP}1 savestate uploaded to the server"; else echo "$UP$2 savestates uploaded to the server"; fi ;;
      f_states-down) if [ "$2" = 1 ]; then echo "${DOWN}1 savestate received"; else echo "$DOWN$2 savestates received"; fi ;;
      f_games-down) if [ "$2" = 1 ]; then echo "${DOWN}1 game downloaded"; else echo "$DOWN$2 games downloaded"; fi ;;
      f_games-sent) if [ "$2" = 1 ]; then echo "${UP}1 game sent to the server"; else echo "$UP$2 games sent to the server"; fi ;;
      f_games-deleted) if [ "$2" = 1 ]; then echo "1 game deleted (in no list)"; else echo "$2 games deleted (in no list)"; fi ;;
      f_saves-cleaned) if [ "$2" = 1 ]; then echo "1 save of deleted games removed"; else echo "$2 saves of deleted games removed"; fi ;;
      f_games-stopped) echo "Game download stopped" ;; f_games-nospace) echo "No room for \"$3\": not enough space" ;;
      f_conflicts) if [ "$2" = 1 ]; then echo "${WARN}1 save in conflict"; else echo "$WARN$2 saves in conflict"; fi ;;
      f_errors) if [ "$2" = 1 ]; then echo "${WARN}1 error"; else echo "$WARN$2 errors"; fi ;;
      s_start_ok) echo "saves up to date" ;; s_start_offline) echo "offline since $2. This save may not be the latest" ;;
      s_offline) echo "no connection to the server since $2. Saves stay on the console and go up when the network is back" ;;
      s_online) echo "connected again, saves synced" ;; s_conflicts) echo "$2 saves in conflict: choose which one counts in the app" ;;
      s_uploaded) echo "save stored on the server" ;; s_kept) echo "offline: the save stays on the console and goes up when the network is back" ;;
      clockask) echo "This console does not set its own clock. Rommancer needs the right time to reach the server and date your saves. Set the time from the internet (and wait for it at power-on)?" ;;
      clockon) echo "Turn on (recommended)" ;; later) echo "Not now" ;;
      l_offline) echo "Rommancer (offline)" ;; l_conflicts) echo "Rommancer ($2 conflicts)" ;;
      lists) echo "Game lists" ;; listsinfo) echo "$2 lists on this console. A adds or removes one; on leaving, their games download or go." ;;
      nolists) echo "No lists yet. Create them in Rommancer's web app." ;; listsfail) echo "Could not reach the server" ;; back) echo "Back" ;;
      listdrop) echo "Removing \"$2\" deletes $3 games from this console ($4)." ;; listdropup) echo "$2 the server lacks are sent to it first." ;;
      listdropgo) echo "Remove and delete $2 games" ;; cancel) echo "Cancel" ;;
      pruneintro) echo "Rommancer can delete from this console the games that are in none of its lists (the ones the server lacks are sent to it first). Saves stay. You can change it later in Settings or on the web. Turn it on?" ;;
      pruneyes) echo "Yes, turn it on" ;; pruneno) echo "No, leave it off" ;;
      pruneask) echo "Deleting games in no list was turned on from the server. If you keep it, $2 games ($3) will be deleted. Keep this option?" ;;
      prunekeep) echo "Yes, keep it" ;; pruneoff) echo "No, turn it off" ;;
      prunehold) echo "$2 of the $3 games on this console (more than half) would be deleted for being in no list. A list may have been emptied. Delete them?" ;;
      prunedelete) echo "Yes, delete them" ;; prunelater) echo "Not now" ;;
      *) echo "$1" ;;
    esac
}
# The summary's marks on Onion's screens: its theme fonts are not known to carry arrows or a warning sign, so no
# arrows and a plain "!"
UP=""; DOWN=""; WARN="! "

# POST a device form to /link/login or /link/signup and keep the token
link_with() {
  detect
  form="name=$(urlenc "$NAME")&firmware=$(urlenc "$FW")&root=$(urlenc "$ROOT")&model=$(urlenc "$MODEL")$1"
  printf '%s' "$form" > "$WORK/form"
  TOKEN=""
  rm -f "$WORK/last-error"
  resp="$(http POST "$SERVER/api/v1/link/$2" "$WORK/form" - "Content-Type: application/x-www-form-urlencoded")" || return 1
  TOKEN="$(field token "$resp")"; USER_NAME="$(field user "$resp")"
  [ -n "$TOKEN" ] || return 1
  save_link
}
# Why a log in or sign-up failed, in words: the server's answer (curl prints its HTTP status) or no answer at all
link_failed() {
  case "$(cut -f3 "$WORK/last-error" 2>/dev/null)" in
    *" 401"*) t badlogin ;; *" 409"*) t exists ;; *" 403"*) t closed ;;
    *) if [ "$(cut -f1 "$WORK/last-error" 2>/dev/null)" != 22 ]; then t listsfail; elif [ "$1" = login ]; then t badlogin; else t signupfail; fi ;;
  esac
}

# The B button while a progress panel shows (Onion's panels take no input). One 16-byte input event at a time (the
# Miyoo's 32-bit layout: time, type, code, value); B is KEY_LEFTCTRL (29)
key_watch() {
  [ -r /dev/input/event0 ] || return 0
  while :; do
    set -- $(dd if=/dev/input/event0 bs=16 count=1 2>/dev/null | od -An -tu2)
    [ "${5:-}" = 1 ] && [ "${6:-}" = 29 ] && [ "${7:-}" = 1 ] && touch "$WORK/key-b"
  done
}
key_watch_end() {
  kill "$1" 2>/dev/null
  for c in /proc/[0-9]*/cmdline; do grep -q 'if=/dev/input/event0' "$c" 2>/dev/null && { p="${c#/proc/}"; kill "${p%/cmdline}" 2>/dev/null; }; done
}

# Human size of a byte count
human() {
  h="$(awk -v b="${1:-0}" 'BEGIN { split("B KB MB GB TB", u, " "); i = 1; while (b >= 1024 && i < 5) { b /= 1024; i++ } printf (i > 2 ? "%.1f %s" : "%d %s"), b, u[i] }')"
  printf '%s' "$h"
}

# A file name cut to fit one line of a panel
short() { if [ "${#1}" -gt 34 ]; then printf '%s...' "$(printf '%s' "$1" | cut -c1-31)"; else printf '%s' "$1"; fi; }

# A bar of 20 for a percent: [#########-----------]
bar() { awk -v p="$1" 'BEGIN { s = "["; for (i = 0; i < 20; i++) s = s (i < p / 5 ? "#" : "-"); printf "%s]", s }'; }

# The lines of a progress panel from a "progress" line (PHASE, done, total, file size, partial file, name): the step
# of "Sync now" (unless NOSTEP), what it does now with its count, the bar with its percent, the current file with its
# own percent and size, and the button's hint last
progress_text() {
  pl="$1"
  phase="$(printf '%s' "$pl" | cut -f1)"; dn="$(printf '%s' "$pl" | cut -f2)"; tt="$(printf '%s' "$pl" | cut -f3)"
  fsize="$(printf '%s' "$pl" | cut -f4)"; part="$(printf '%s' "$pl" | cut -f5)"; name="$(printf '%s' "$pl" | cut -f6)"
  [ -n "$phase" ] || phase=connecting
  if [ -z "${2:-}" ] && [ -s "$WORK/step" ]; then
    IFS="$TAB" read -r sn sm sk < "$WORK/step"
    t step "$sn" "$sm" "$(t "st_$sk")"
  fi
  case "$phase" in *finished) tt=0 ;; esac
  case "$tt" in ''|*[!0-9]*) tt=0 ;; esac
  case "$dn" in ''|*[!0-9]*) dn=0 ;; esac
  case "$fsize" in ''|*[!0-9]*) fsize=0 ;; esac
  if [ "$tt" -gt 0 ]; then
    t "p_$phase" | sed "s#\$# $dn/$tt#"
    pct=$((dn * 100 / tt)); file=""; extra=""
    case "$phase" in
      roms-download)
        cur="$(stat -c %s "$part" 2>/dev/null || echo 0)"; fp=0
        [ "$fsize" -gt 0 ] && fp=$((cur * 100 / fsize))
        [ "$fp" -gt 100 ] && fp=100
        pct=$(( ((dn - 1) * 100 + fp) / tt ))
        file="$(short "$name")"
        if [ "$fsize" -gt 0 ]; then extra="$fp% $(t of) $(human "$fsize")"; else extra="$(human "$cur")"; fi ;;
      pulls)
        # The file's share: the last figure of curl's progress bar
        fp="$(tr '\r' '\n' < "$WORK/pull-curl" 2>/dev/null | grep -o '[0-9.]*%' | tail -n 1)"; fp="${fp%%[.%]*}"
        case "$fp" in ''|*[!0-9]*) fp=0 ;; esac
        pct=$(( ((dn - 1) * 100 + fp) / tt ))
        file="$(short "$name")"; extra="$fp% $(t of) $(human "$fsize")" ;;
      *) [ -n "$name" ] && file="$(short "$name")" ;;
    esac
    [ "$pct" -lt 0 ] && pct=0
    printf '%s %s%%\n' "$(bar "$pct")" "$pct"
    [ -n "$file" ] && printf '%s\n' "$file"
    [ -n "$extra" ] && printf '%s\n' "$extra"
  else
    t "p_$phase"
  fi
  if [ -f "$WORK/stopping" ]; then t stopping
  else case "$phase" in roms-plan|roms-download) t stophint ;; pulls) t backhint ;; esac; fi
}

# The summary's facts in the guide's order from the "sum" lines of FILE: "key<TAB>n<TAB>extra", the same keys added up
# (conflicts: the last count; a game with no room: each one)
summary_facts() {
  awk -F"$TAB" '
    BEGIN { n = split("saves-up saves-down states-up states-down games-down games-sent games-deleted saves-cleaned games-stopped games-nospace conflicts errors", order, " ") }
    $1 != "sum" { next }
    $2 == "conflicts" { c = $3; next }
    $2 == "games-nospace" { ns[++nn] = $4; next }
    $2 == "games-stopped" { st = 1; next }
    { v[$2] += $3 }
    END {
      for (i = 1; i <= n; i++) {
        k = order[i]
        if (k == "conflicts") { if (c > 0) print k "\t" c }
        else if (k == "games-nospace") { for (j = 1; j <= nn; j++) print k "\t1\t" ns[j] }
        else if (k == "games-stopped") { if (st) print k "\t1" }
        else if (v[k] > 0) print k "\t" v[k]
      }
    }' "$1" 2>/dev/null
}
# One translated fact per line; what failed last (the reason the details explain); "All up to date" when nothing
summary_text() {
  summary_facts "$1" > "$WORK/facts"
  while IFS="$TAB" read -r fk fn fx; do t "f_$fk" "$fn" "$fx"; done < "$WORK/facts"
  [ -s "$WORK/fail-details" ] && head -n 1 "$WORK/fail-details"
  [ -s "$WORK/facts" ] || [ -s "$WORK/fail-details" ] || t uptodate
}
# The result of an action run on screen (its output in FILE), titled with the action: OK, and the details of a failure
# when there was one. Kept as the last result for the Status screen
show_summary() {
  grep "^sum$TAB" "$2" > "$WORK/last-summary" 2>/dev/null
  head -n 1 "$WORK/fail-details" 2>/dev/null | sed "s/^/fail$TAB/" >> "$WORK/last-summary"
  msg="$(summary_text "$2")"
  if [ -s "$WORK/fail-details" ]; then
    menu "$1" "$msg" "OK" "$(t details)"
    [ $? = 1 ] && panel "$(t details)" "$(tail -n +2 "$WORK/fail-details")" wait
  else
    menu "$1" "$msg" "OK"
  fi
  return 0
}

# Runs a command in the background and keeps an Onion panel updated with its progress; B stops a game download, or
# leaves the sending of games to the server going on behind the menu. Its summary at the end
with_progress() {
  title="$1"; shift
  # A download under way keeps its progress on screen from the start
  roms_running || rm -f "$WORK/progress"
  rm -f "$WORK/fail-details" "$WORK/step" "$WORK/stopping"
  ( VERBOSE=1; "$@" > "$WORK/run-out" 2>&1 ) &
  job=$!
  rm -f "$WORK/key-b"; key_watch & kw=$!
  shown=""; left=0
  while kill -0 "$job" 2>/dev/null; do
    line="$(cat "$WORK/progress" 2>/dev/null)"
    if [ -f "$WORK/key-b" ]; then
      rm -f "$WORK/key-b"
      case "$(printf '%s' "$line" | cut -f1)" in
        roms-plan|roms-download) [ -f "$WORK/stopping" ] || { touch "$WORK/stopping"; (sh "$DIR/$(basename "$0")" roms-stop > /dev/null 2>&1 &); } ;;
        pulls) left=1; break ;;
      esac
    fi
    text="$(progress_text "$line")"
    [ "$text" != "$shown" ] && { panel "$title" "$text"; shown="$text"; }
    sleep 2
  done
  key_watch_end "$kw"
  panel_close
  rm -f "$WORK/stopping"
  [ "$left" = 1 ] && return 0
  wait "$job" 2>/dev/null
  show_summary "$title" "$WORK/run-out"
}

# Once, on Onion: its clock set from the internet is suggested (a wrong clock refuses the server's certificate and
# dates saves wrongly); the web app suggests it too while it is off
setup_clock() {
  [ "$(clock_sync_state)" = 0 ] && [ ! -f "$STATE/clock-asked" ] || return 0
  touch "$STATE/clock-asked"
  menu "Rommancer Sync" "$(t clockask)" "$(t clockon)" "$(t later)"
  [ $? = 0 ] && clock_sync_on
  return 0
}

# What the deletion of roms in no list needs from the user: the choice offered once after linking, a change made
# in the web app (keep it or turn it off) and a deletion held for being more than half of the roms
setup_prune() {
  if [ ! -f "$STATE/prune-intro" ]; then
    menu "Rommancer Sync" "$(t pruneintro)" "$(t pruneno)" "$(t pruneyes)"; rc=$?
    [ "$rc" = 1 ] && v=1 || v=0
    panel "Rommancer Sync" "$(t syncing)"; sh "$DIR/$(basename "$0")" prune set "$v" > /dev/null 2>&1; panel_close
  fi
  if [ -f "$STATE/prune-ask" ]; then
    menu "Rommancer Sync" "$(t pruneask "$(cut -f1 "$STATE/prune-ask")" "$(human "$(cut -f2 "$STATE/prune-ask")")")" "$(t prunekeep)" "$(t pruneoff)"; rc=$?
    case $rc in 0) v=1 ;; 1) v=0 ;; *) v="" ;; esac
    [ -n "$v" ] && { panel "Rommancer Sync" "$(t syncing)"; sh "$DIR/$(basename "$0")" prune set "$v" > /dev/null 2>&1; panel_close; }
  fi
  if [ -f "$STATE/prune-hold" ] && [ "$PRUNE_ROMS" = 1 ]; then
    menu "Rommancer Sync" "$(t prunehold "$(cut -f1 "$STATE/prune-hold")" "$(cut -f2 "$STATE/prune-hold")")" "$(t prunedelete)" "$(t pruneoff)" "$(t prunelater)"; rc=$?
    case $rc in
      0) with_progress "$(t p_prune)" sh "$DIR/$(basename "$0")" prune confirm ;;
      1) panel "Rommancer Sync" "$(t syncing)"; sh "$DIR/$(basename "$0")" prune set 0 > /dev/null 2>&1; panel_close ;;
    esac
  fi
  [ -f "$SETTINGS" ] && . "$SETTINGS"
}

# "done<TAB>total<TAB>name<TAB>file percent" of the copy the server asked for, nothing when none runs
pulls_status() {
  pulls_running || return 0
  IFS="$TAB" read -r pd pt ps pn < "$WORK/pull-progress" 2>/dev/null || return 0
  fp="$(tr '\r' '\n' < "$WORK/pull-curl" 2>/dev/null | grep -o '[0-9.]*%' | tail -n 1)"
  printf '%s\t%s\t%s\t%s\n' "$pd" "$pt" "$pn" "${fp%%%}"
}
# The copy the server asked for, on screen while it lasts (B goes back to the menu, the copy goes on)
watch_pulls() {
  pulls_running || return 0
  rm -f "$WORK/key-b"; key_watch & kw=$!
  shown=""
  while pulls_running && [ ! -f "$WORK/key-b" ]; do
    IFS="$TAB" read -r pd pt ps pn < "$WORK/pull-progress" 2>/dev/null
    text="$(progress_text "pulls$TAB${pd:-0}$TAB${pt:-0}$TAB${ps:-0}$TAB$TAB${pn:-}" nostep)"
    [ "$text" != "$shown" ] && { panel "$(t st_pulls)" "$text"; shown="$text"; }
    sleep 2
  done
  key_watch_end "$kw"; rm -f "$WORK/key-b"
  panel_close
}

setup_after_link() {
  panel "Rommancer Sync" "$(t syncing)"
  rm -f "$WORK/fail-details"
  VERBOSE=1 cmd_sync > "$WORK/first-sync" 2>&1
  cmd_install > /dev/null 2>&1
  if ! { [ -f "$STATE/pid" ] && kill -0 "$(cat "$STATE/pid")" 2>/dev/null; }; then
    nohup sh "$DIR/$(basename "$0")" daemon >/dev/null 2>&1 &
  fi
  panel_close
  # The first sync's summary, under the news that sync is on
  menu "Rommancer Sync" "$(t finished)
$(summary_text "$WORK/first-sync")" "OK"
  setup_prune
  ask_restart
}

# The game-start hook works once Onion reads its runtime.sh again, at power-on: asked until the console restarts
ask_restart() {
  [ -f "$STATE/hook-restart" ] || return 0
  menu "$(t restarttitle)" "$(t restartask)" "$(t restartnow)" "$(t later)"
  [ $? = 0 ] || return 0
  panel "Rommancer Sync" "$(t restarting)"
  sync; reboot
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
    id="$(printf '%s' "$line" | cut -f2)"
    conflict_ask "$line"
    case $? in
      0) with_progress "$(t conflicts "$n")" cmd_resolve "$id" device ;;
      1) with_progress "$(t conflicts "$n")" cmd_resolve "$id" server ;;
    esac
    cmd_conflicts > "$WORK/conflicts" 2>/dev/null || : > "$WORK/conflicts"
  done
}

# The console's lists: each ticked or not, A adds or removes one (a removal that deletes roms says how many first, a
# single question); leaving after a change brings the console in line with its lists at once, on screen. The last
# item downloads the lists' roms now
setup_lists() {
  l_changed=0; l_at=""
  while :; do
    panel "Rommancer Sync" "$(t p_connecting)"
    HTTP_MAX=20 cmd_lists > "$WORK/lists" 2>/dev/null; l_rc=$?
    panel_close
    [ "$l_rc" = 0 ] || { panel "$(t lists)" "$(t listsfail)" wait; break; }
    # Onion's menu takes up to 100 entries: the two last items among them
    grep "^list$TAB" "$WORK/lists" | head -n 97 > "$WORK/lists.rows"
    l_n="$(grep -c . "$WORK/lists.rows")"
    [ "$l_n" -gt 0 ] || { panel "$(t lists)" "$(t nolists)" wait; break; }
    l_on="$(awk -F"$TAB" '$3 == 1' "$WORK/lists.rows" | grep -c .)"
    set --
    while IFS="$TAB" read -r _ l_id l_o l_items l_name l_owner; do
      if [ "$l_o" = 1 ]; then l_mark="[x]"; else l_mark="[ ]"; fi
      # Someone else's list says whose
      l_who=""; [ -n "$l_owner" ] && l_who=" @$(printf '%s' "$l_owner" | cut -c1-8)"
      set -- "$@" "$l_mark $(printf '%s' "$l_name" | cut -c1-24)$l_who ($l_items)"
    done < "$WORK/lists.rows"
    # The cursor stays on the list just changed (the console's own lists come first, so it moves)
    l_sel="$(awk -F"$TAB" -v id="$l_at" '$2 == id { print NR - 1; exit }' "$WORK/lists.rows")"
    menu "$(t lists)" "$(t listsinfo "$l_on")" -s "${l_sel:-0}" "$@" "$(t romsnow)" "$(t back)"; l_pick=$?
    if [ "$l_pick" = "$l_n" ]; then
      # A change made here goes with it (the whole sync); otherwise just the download
      if [ "$l_changed" = 1 ]; then l_changed=0; with_progress "$(t sync)" cmd_all; else with_progress "$(t romsnow)" cmd_roms; fi
      continue
    fi
    [ "$l_pick" -lt "$l_n" ] || break
    l_line="$(sed -n "$((l_pick + 1))p" "$WORK/lists.rows")"
    l_id="$(printf '%s' "$l_line" | cut -f2)"; l_at="$l_id"; l_o="$(printf '%s' "$l_line" | cut -f3)"; l_name="$(printf '%s' "$l_line" | cut -f5)"
    # The lists the console keeps after this choice
    l_ids="$(awk -F"$TAB" -v id="$l_id" '$3 == 1 && $2 != id { print $2 }' "$WORK/lists.rows")"
    [ "$l_o" = 1 ] || l_ids="$l_ids $l_id"
    if [ "$l_o" = 1 ] && [ "$(sed -n "s/^prune$TAB//p" "$WORK/lists")" = 1 ]; then
      panel "Rommancer Sync" "$(t p_server)"
      # shellcheck disable=SC2086
      HTTP_MAX=60 lists_post lists/preview $l_ids > "$WORK/lists-preview" 2>/dev/null
      panel_close
      l_del="$(sed -n "s/^delete$TAB//p" "$WORK/lists-preview" | cut -f1)"; l_bytes="$(sed -n "s/^delete$TAB//p" "$WORK/lists-preview" | cut -f2)"
      l_up="$(sed -n "s/^upload$TAB//p" "$WORK/lists-preview" | cut -f1)"; l_upb="$(sed -n "s/^upload$TAB//p" "$WORK/lists-preview" | cut -f2)"
      l_all=$(( ${l_del:-0} + ${l_up:-0} ))
      if [ "$l_all" -gt 0 ]; then
        l_msg="$(t listdrop "$l_name" "$l_all" "$(human $(( ${l_bytes:-0} + ${l_upb:-0} )))")"
        [ "${l_up:-0}" -gt 0 ] && l_msg="$l_msg $(t listdropup "$l_up")"
        menu "$(t lists)" "$l_msg" "$(t listdropgo "$l_all")" "$(t cancel)"
        [ $? = 0 ] || continue
      fi
    fi
    panel "Rommancer Sync" "$(t p_server)"
    # shellcheck disable=SC2086
    if HTTP_MAX=20 lists_post lists $l_ids > /dev/null 2>&1; then l_changed=1; panel_close
    else panel_close; panel "$(t lists)" "$(t listsfail)" wait; fi
  done
  [ "$l_changed" = 1 ] && with_progress "$(t sync)" cmd_all
  return 0
}

# Settings: the toggles (what they do in the menu's message: Onion's menu has no line per item), deleting the saves of
# deleted roms, the account and disconnecting (asked first). Returns 1 when the console was disconnected
setup_settings() {
  s_sel=0
  while :; do
    if [ "$ALLOW_PULL" = 1 ]; then s_pull="$(t yes)"; else s_pull="$(t no)"; fi
    if [ "$ALLOW_SSH" = 1 ]; then s_ssh="$(t yes)"; else s_ssh="$(t no)"; fi
    if [ "$GAME_SYNC" = 1 ]; then s_gsync="$(t yes)"; else s_gsync="$(t no)"; fi
    if [ "$GAME_ASK" = 1 ]; then s_gask="$(t yes)"; else s_gask="$(t no)"; fi
    if [ "$PRUNE_ROMS" = 1 ]; then s_prune="$(t yes)"; else s_prune="$(t no)"; fi
    s_clean="$(cat "$STATE/pruned" 2>/dev/null | grep -c .)"
    s_host="${SERVER#*://}"; s_host="${s_host%%/*}"
    menu "$(t settings)" "$(t settingsinfo)" -s "$s_sel" "$(t gamesync "$s_gsync")" "$(t gameask "$s_gask")" "$(t allowpull "$s_pull")" \
      "$(t allowssh "$s_ssh")" "$(t prune "$s_prune")" "$(t pruneclean "$s_clean")" "$(t account "${USER_NAME:-?}" "$s_host")" "$(t unlink)..." "$(t back)"; rc=$?
    s_sel="$rc"
    case $rc in
      0) if [ "$GAME_SYNC" = 1 ]; then GAME_SYNC=0; else GAME_SYNC=1; fi; set_setting GAME_SYNC "$GAME_SYNC" ;;
      1) if [ "$GAME_ASK" = 1 ]; then GAME_ASK=0; else GAME_ASK=1; fi; set_setting GAME_ASK "$GAME_ASK" ;;
      2) if [ "$ALLOW_PULL" = 1 ]; then ALLOW_PULL=0; else ALLOW_PULL=1; fi; set_setting ALLOW_PULL "$ALLOW_PULL" ;;
      3) if [ "$ALLOW_SSH" = 1 ]; then ALLOW_SSH=0; else ALLOW_SSH=1; fi; set_setting ALLOW_SSH "$ALLOW_SSH" ;;
      4) if [ "$PRUNE_ROMS" = 1 ]; then v=0; else v=1; fi
         panel "Rommancer Sync" "$(t syncing)"; sh "$DIR/$(basename "$0")" prune set "$v" > /dev/null 2>&1; panel_close; PRUNE_ROMS="$v" ;;
      5) with_progress "$(t pruneclean "$s_clean")" sh "$DIR/$(basename "$0")" prune clean ;;
      6) ;;
      7) menu "$(t unlink)" "$(t unlinkask "$s_host")" "$(t unlinkgo)" "$(t cancel)"
         if [ $? = 0 ]; then
           keep="$SERVER"; cmd_unlink > /dev/null; TOKEN=""; USER_NAME=""; SERVER="$keep"; PRUNE_ROMS=0
           return 1
         fi ;;
      *) return 0 ;;
    esac
  done
}

# Status: version and install date, account and server, the last result, the last log lines (the only screen that
# shows them as they are)
setup_status() {
  host="${SERVER#*://}"; host="${host%%/*}"
  {
    version_line; echo
    t account "${USER_NAME:-?}" "$host"
    echo "$(t server): $SERVER"
    synced_line; echo
    if [ -f "$WORK/last-summary" ]; then
      printf '%s ' "$(t lastresult)"
      { summary_facts "$WORK/last-summary" | while IFS="$TAB" read -r fk fn fx; do t "f_$fk" "$fn" "$fx"; done
        sed -n "s/^fail$TAB//p" "$WORK/last-summary"; } > "$WORK/status-facts"
      if [ -s "$WORK/status-facts" ]; then tr '\n' ';' < "$WORK/status-facts" | sed 's/;$//; s/;/; /g'; else t uptodate; fi
      echo
    fi
    t log
    tail -n 3 "$LOG" 2>/dev/null | cut -c12-16,20-70
  } > "$WORK/status-text"
  panel "$(t status)" "$(cat "$WORK/status-text")" wait
}

# The home screen's text: the state, the most urgent first (conflicts, offline, last sync), and the work under way
home_text() {
  if [ -f "$WORK/conflicts" ]; then h_conf="$(grep -c '^conflict' "$WORK/conflicts")"; else h_conf=0; fi
  if [ "$h_conf" -gt 0 ]; then printf '%s%s\n' "$WARN" "$(t conflictsline "$h_conf")"
  elif [ -f "$WORK/offline-since" ]; then t offlinesince "$(hhmm "$(cat "$WORK/offline-since")")"
  else synced_line; echo; fi
  rs="$(roms_status)"
  [ -n "$rs" ] && t w_roms "$(printf '%s' "$rs" | awk -F"$TAB" '$2 { printf "%s/%s", $1, $2 }')"
  if pulls_running; then
    IFS="$TAB" read -r pd pt _ < "$WORK/pull-progress" 2>/dev/null
    t w_pulls "${pd:+$pd/$pt}"
  fi
}

cmd_setup() {
  [ -x "$ONION_BIN/prompt" ] && [ -x "$ONION_BIN/kbinput" ] || { say "setup needs Onion's prompt and kbinput"; exit 2; }
  fix_clock
  # An installer package links by itself with its token
  if [ -z "$TOKEN" ] && [ -f "$DIR/enroll.txt" ] && cmd_enroll > /dev/null 2>&1; then setup_after_link; fi
  [ -n "$SERVER" ] || SERVER="https://"
  # Opened while the server fetches roms from this console: that copy's progress first
  [ -n "$TOKEN" ] && watch_pulls
  [ -n "$TOKEN" ] && ask_restart
  while :; do
    if [ -n "$TOKEN" ]; then
      # The menu never waits for the network: the conflicts are the last ones fetched (a fetch runs meanwhile for
      # the next time the menu shows; the conflicts screen fetches its own)
      ( HTTP_MAX=10 cmd_conflicts > "$WORK/conflicts.new" 2>/dev/null && mv "$WORK/conflicts.new" "$WORK/conflicts" ) &
      setup_clock
      setup_prune
      nconf=0; [ -f "$WORK/conflicts" ] && nconf="$(grep -c '^conflict' "$WORK/conflicts")"
      # Items that only show while they mean something: conflicts to settle, a download or a copy to watch
      set -- "$(t sync)"; acts="sync"
      [ "$nconf" -gt 0 ] && { set -- "$@" "$(t conflicts "$nconf")"; acts="$acts conflicts"; }
      roms_running && { set -- "$@" "$(t romswatch)"; acts="$acts romswatch"; }
      pulls_running && { set -- "$@" "$(t pullswatch)"; acts="$acts pullswatch"; }
      set -- "$@" "$(t lists)" "$(t settings)" "$(t status)" "$(t quit)"; acts="$acts lists settings status quit"
      menu "Rommancer Sync $CLIENT_VERSION" "$(home_text)" "$@"; rc=$?
      case "$(printf '%s\n' $acts | sed -n "$((rc + 1))p")" in
        sync) with_progress "$(t sync)" cmd_all ;;
        conflicts) panel "Rommancer Sync" "$(t p_connecting)"; cmd_conflicts > "$WORK/conflicts" 2>/dev/null || : > "$WORK/conflicts"; panel_close; setup_conflicts ;;
        # On screen until done; B stops the download
        romswatch) with_progress "$(t st_roms)" cmd_roms ;;
        pullswatch) watch_pulls ;;
        lists) setup_lists ;;
        settings) setup_settings ;;
        status) setup_status ;;
        *) return 0 ;;
      esac
    else
      menu "Rommancer Sync $CLIENT_VERSION" "$(t notlinked)." "$(t server): $SERVER" "$(t login)" "$(t signup)" "$(t quit)"; rc=$?
      case $rc in
        0) v="$(ask "$(t server)" "$SERVER")" && SERVER="${v%/}" ;;
        1|2)
          info="$(http GET "$SERVER/api/v1/link/info" - -)" || { panel "Rommancer Sync" "$(t badserver)" wait; continue; }
          if [ "$rc" -eq 1 ]; then
            u="$(ask "$(t user)" "")" || continue
            p="$(ask "$(t password)" "")" || continue
            if link_with "&username=$(urlenc "$u")&password=$(urlenc "$p")" login; then setup_after_link; else panel "Rommancer Sync" "$(link_failed login)" wait; fi
          else
            [ "$(field signup "$info")" = 1 ] || { panel "Rommancer Sync" "$(t closed)" wait; continue; }
            u="$(ask "$(t username)" "")" || continue
            e="$(ask "$(t email)" "")" || continue
            p="$(ask "$(t password)" "")" || continue
            if link_with "&username=$(urlenc "$u")&email=$(urlenc "$e")&password=$(urlenc "$p")" signup; then setup_after_link; else panel "Rommancer Sync" "$(link_failed signup)" wait; fi
          fi ;;
        *) return 0 ;;
      esac
    fi
  done
}

cmd_status() {
  version_line; echo
  if [ -n "$TOKEN" ]; then echo "Linked to $SERVER"; else echo "Not linked"; fi
  if [ -f "$STATE/pid" ] && kill -0 "$(cat "$STATE/pid")" 2>/dev/null; then echo "Daemon running (pid $(cat "$STATE/pid"))"; else echo "Daemon stopped"; fi
  tail -n 5 "$LOG" 2>/dev/null
}

cmd_unlink() {
  [ -f "$STATE/pid" ] && kill "$(cat "$STATE/pid")" 2>/dev/null
  rm -f "$CONF" "$STATE/pid" "$CACHE" "$CACHE_DISK"
  # Another account's lists are not this one's: the deletion of roms in no list starts off and is offered again
  set_setting PRUNE_ROMS 0
  rm -f "$STATE/prune-set" "$STATE/prune-ask" "$STATE/prune-hold" "$STATE/prune-intro" "$STATE/pruned"
  rm -f "$WORK/offline-since" "$WORK/conflicts-open"; app_label
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
  roms) VERBOSE=1 cmd_roms; cmd_collections > /dev/null 2>&1 ;;
  roms-stop) cmd_roms_stop ;;
  # What the server runs over SSH and the daemon's full pass: everything but the lists' roms, which only download
  # when asked for on the console's screen
  background) cmd_sync; cmd_config; cmd_prune; cmd_collections > /dev/null 2>&1 ;;
  roms-status) roms_status ;;
  fail-details) cat "$WORK/fail-details" 2>/dev/null ;;
  pulls-status) pulls_status ;;
  collections) cmd_collections ;;
  config) VERBOSE=1 cmd_config ;;
  # What "Sync now" does on screen: saves, then the lists' roms when AUTO_ROMS is on
  all)
    VERBOSE=1
    if [ -n "$SD" ] && [ -z "$TOKEN" ]; then echo "This card is not linked yet. Run: $0 sd $SD link http://server:port"; exit 2; fi
    # A card only meets the server now and then: what the server asked for meanwhile goes too (a step of cmd_all)
    cmd_all
    [ -z "$SD" ] || sync ;;
  game-start) cmd_game_start "${2:-}" ;;
  # After a game: copies for the server may go on, and the game's saves go up
  game-stop) rm -f "$WORK/playing"; cmd_sync; refresh_lists after-game ;;
  conflicts) cmd_conflicts ;;
  lists) cmd_lists ;;
  lists-preview) shift; lists_post lists/preview "$@" ;;
  lists-set) shift; lists_post lists "$@" ;;
  resolve) cmd_resolve "${2:-}" "${3:-}" ;;
  set) set_setting "${2:-}" "${3:-}" ;;
  # Deleting roms in no list: "prune set 0|1" (a change on screen, or the answer to one made in the web app),
  # "prune confirm" (a held deletion of more than half of the roms), "prune clean" (their saves), "prune" (state)
  prune)
    case "${2:-}" in
      # The server hears it at this sync, or at the daemon's when one is running (never waited for: the menus stay quick)
      set) prune_set "${3:-0}"; rm -f "$STATE/prune-ask"; touch "$STATE/prune-intro"; cmd_sync > /dev/null 2>&1; echo ok ;;
      confirm)
        [ -f "$STATE/prune-hold" ] || exit 0
        http POST "$SERVER/api/v1/agent/prune/confirm" - - "X-Count: $(cut -f1 "$STATE/prune-hold")" > /dev/null || exit 1
        rm -f "$STATE/prune-hold"; VERBOSE=1 cmd_prune ;;
      clean) cmd_prune_clean ;;
      run) VERBOSE=1 cmd_prune ;;
      *)
        # on<TAB>0|1, then ask<TAB>files<TAB>bytes, hold<TAB>files<TAB>roms, intro<TAB>0|1 (the choice was offered), cleanable<TAB>roms
        printf 'on\t%s\n' "$PRUNE_ROMS"
        [ -f "$STATE/prune-ask" ] && printf 'ask\t%s\n' "$(cat "$STATE/prune-ask")"
        [ -f "$STATE/prune-hold" ] && printf 'hold\t%s\n' "$(cat "$STATE/prune-hold")"
        if [ -f "$STATE/prune-intro" ]; then printf 'intro\t1\n'; else printf 'intro\t0\n'; fi
        printf 'cleanable\t%s\n' "$(cat "$STATE/pruned" 2>/dev/null | grep -c .)" ;;
    esac ;;
  pulls) VERBOSE=1; cmd_pulls ;;
  boot)
    # At power-on: start syncing and give the first pass up to BOOT_WAIT seconds, so saves are
    # current before a game can be opened; never asks anything
    [ -n "$TOKEN" ] || cmd_enroll > /dev/null 2>&1 || exit 0
    # Onion read its runtime.sh before this: a hook already there works now (one the daemon adds next waits again)
    rm -f "$WORK/progress" "$STATE/hook-restart"
    nohup sh "$DIR/$(basename "$0")" daemon >/dev/null 2>&1 &
    n=0; while [ "$n" -lt "${BOOT_WAIT:-25}" ]; do
      grep -q '^finished' "$WORK/progress" 2>/dev/null && break
      sleep 1; n=$((n + 1))
    done
    # Before the menu starts: game lists still to refresh (Onion's could not while its menu was open), and the
    # folders changed while the console was off
    lists_scan; refresh_lists ;;
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
