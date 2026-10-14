#!/bin/sh
# Syncs a save from one device to another and checks it arrives byte-identical.
# usage: save-roundtrip.sh SOURCE SOURCE_DIR TARGET TARGET_DIR [TIMEOUT_S]
#   a device is adb:<serial> (Rommancer Sync 0.14.0+) or ssh:<host> (console client)
#   e.g. save-roundtrip.sh adb:5d1ee37e /sdcard/PSP/SAVEDATA/ULES00496 \
#          ssh:root@192.168.1.176 /userdata/system/configs/ppsspp/PSP/SAVEDATA/ULES00496
# env: ADB_SU=1 reads adb paths as root (Android/data), RS_CLIENT is the console client's path
set -eu
[ $# -ge 4 ] || { sed -n '2,8p' "$0"; exit 2; }
RS_CLIENT=${RS_CLIENT:-/userdata/system/rommancer/rommancer-sync.sh}
hashes() {  # hashes DEVICE DIR: one "md5  ./file" line per file, sorted
  cmd="cd '$2' 2>/dev/null && find . -type f -exec md5sum {} + | sort"
  case "$1" in
    adb:*) if [ "${ADB_SU:-}" = 1 ]; then adb -s "${1#adb:}" shell su -c "\"$cmd\""
           else adb -s "${1#adb:}" shell "$cmd"; fi ;;
    ssh:*) ssh -o LogLevel=ERROR "${1#ssh:}" "$cmd" ;;
    *) echo "unknown device $1" >&2; exit 2 ;;
  esac
}

sync_on() {
  case "$1" in
    adb:*) adb -s "${1#adb:}" shell am broadcast -a com.rommancer.sync.SYNC -n com.rommancer.sync/.ShellSync >/dev/null ;;
    ssh:*) ssh -o LogLevel=ERROR "${1#ssh:}" "sh $RS_CLIENT sync" | tail -1 ;;
  esac
}

want=$(hashes "$1" "$2" || true)
[ -n "$want" ] || { echo "FAIL: no save at $1 $2" >&2; exit 1; }
echo "source: $(echo "$want" | wc -l) file(s)"
sync_on "$1"

end=$(( $(date +%s) + ${5:-180} ))
while [ "$(date +%s)" -lt "$end" ]; do
  timeout 15 tail -f /dev/null || true
  sync_on "$3"
  if [ "$(hashes "$3" "$4")" = "$want" ]; then echo "PASS: $4 on $3 matches"; exit 0; fi
done
echo "FAIL: $4 on $3 does not match after ${5:-180}s" >&2
hashes "$3" "$4" >&2 || true
exit 1
