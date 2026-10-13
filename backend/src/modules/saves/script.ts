/**
 * Generator of the event scripts for devices. POSIX sh, compatible with busybox and toybox.
 * Uses curl if present, else wget. Never blocks the game: short timeouts, and failures are retried at the next event.
 */

export type ScriptFlavor = 'esde' | 'batocera';

export function syncScript(server: string, token: string, deviceName: string) {
  return `#!/bin/sh
# Rommancer: save sync for "${deviceName.replace(/["`$\\]/g, '')}"
# Usage: rommancer-sync.sh start|end <rom path>
SERVER="${server.replace(/\/+$/, '')}"
TOKEN="${token}"
DIR="$(cd "$(dirname "$0")" && pwd)"
STATE="$DIR/.rommancer"
mkdir -p "$STATE"
EVENT="$1"
ROM="$2"
[ -n "$ROM" ] || exit 0
API="$SERVER/api/v1/agent"
b64() { printf '%s' "$1" | base64 | tr -d '\\n'; }
sha1() { if command -v sha1sum >/dev/null 2>&1; then sha1sum "$1" | cut -d' ' -f1; else shasum "$1" | cut -d' ' -f1; fi; }
ROMH="X-Rom-B64: $(b64 "$ROM")"

# http METHOD URL [body_file] [extra_header] -> output on stdout
http() {
  if command -v curl >/dev/null 2>&1; then
    if [ -n "$3" ]; then curl -fsS --connect-timeout 3 --max-time 60 -X "$1" -H "X-Device-Token: $TOKEN" -H "$ROMH" \${4:+-H "$4"} --data-binary "@$3" "$2"
    else curl -fsS --connect-timeout 3 --max-time 60 -X "$1" -H "X-Device-Token: $TOKEN" -H "$ROMH" \${4:+-H "$4"} "$2"; fi
  else
    if [ -n "$3" ]; then wget -q -T 10 -O - --header="X-Device-Token: $TOKEN" --header="$ROMH" \${4:+--header="$4"} --post-file="$3" "$2"
    else wget -q -T 10 -O - --header="X-Device-Token: $TOKEN" --header="$ROMH" \${4:+--header="$4"} "$2"; fi
  fi
}

upload() {
  http POST "$API/upload" "$1" "X-Path-B64: $(b64 "$1")" >/dev/null || return 1
}

# Uploads pending from offline runs
retry_pending() {
  [ -f "$STATE/pending" ] || return 0
  mv "$STATE/pending" "$STATE/pending.run"
  while IFS='	' read -r p r; do
    [ -f "$p" ] || continue
    ROMH="X-Rom-B64: $(b64 "$r")"
    upload "$p" || printf '%s\\t%s\\n' "$p" "$r" >> "$STATE/pending"
  done < "$STATE/pending.run"
  rm -f "$STATE/pending.run"
  ROMH="X-Rom-B64: $(b64 "$ROM")"
}

# Games closed offline: their end event is replayed (once, not nested)
retry_roms() {
  [ -z "$ROMMANCER_RETRY" ] && [ -f "$STATE/pending_roms" ] || return 0
  mv "$STATE/pending_roms" "$STATE/pending_roms.run"
  sort -u "$STATE/pending_roms.run" | while read -r r; do
    [ "$r" = "$ROM" ] && [ "$EVENT" = end ] && continue
    ROMMANCER_RETRY=1 sh "$0" end "$r"
  done
  rm -f "$STATE/pending_roms.run"
}

MANIFEST="$STATE/manifest"
if ! http GET "$API/manifest" > "$MANIFEST" 2>/dev/null; then
  # Offline (or server down): queued for the next event with network
  if [ "$EVENT" = end ] && ! http GET "$SERVER/api/v1/health" >/dev/null 2>&1; then printf '%s\n' "$ROM" >> "$STATE/pending_roms"; fi
  exit 0
fi
retry_pending

case "$EVENT" in
  start)
    : > "$STATE/present"
    while read -r p; do
      [ -n "$p" ] && [ -f "$p" ] && printf '%s\\t%s\\n' "$p" "$(sha1 "$p")" >> "$STATE/present"
    done < "$MANIFEST"
    http POST "$API/start" "$STATE/present" > "$STATE/actions" 2>/dev/null || exit 0
    while IFS='	' read -r action p v; do
      case "$action" in
        get)
          mkdir -p "$(dirname "$p")"
          http GET "$API/file?v=$v" "" "X-Path-B64: $(b64 "$p")" > "$p.rommancer" && mv "$p.rommancer" "$p" || rm -f "$p.rommancer"
          ;;
        put)
          upload "$p" || printf '%s\\t%s\\n' "$p" "$ROM" >> "$STATE/pending"
          ;;
      esac
    done < "$STATE/actions"
    ;;
  end)
    while read -r p; do
      [ -n "$p" ] && [ -f "$p" ] || continue
      upload "$p" || printf '%s\\t%s\\n' "$p" "$ROM" >> "$STATE/pending"
    done < "$MANIFEST"
    ;;
esac
retry_roms
exit 0
`;
}

/** Files to install on the device for the given frontend. */
export function scriptFiles(flavor: ScriptFlavor, server: string, token: string, deviceName: string): { path: string; content: string; mode: number }[] {
  const sync = { path: 'rommancer/rommancer-sync.sh', content: syncScript(server, token, deviceName), mode: 0o755 };
  if (flavor === 'esde') {
    // ES-DE (Android and Linux): ES-DE/scripts/game-start and game-end get the rom path in $1
    return [
      { ...sync, path: 'scripts/rommancer/rommancer-sync.sh' },
      { path: 'scripts/game-start/rommancer.sh', content: '#!/bin/sh\n"$(dirname "$0")/../rommancer/rommancer-sync.sh" start "$1"\n', mode: 0o755 },
      { path: 'scripts/game-end/rommancer.sh', content: '#!/bin/sh\n"$(dirname "$0")/../rommancer/rommancer-sync.sh" end "$1"\n', mode: 0o755 },
      { path: 'scripts/rommancer/README.txt', content: 'Copy the scripts folder into the ES-DE data folder (ES-DE/scripts) and enable\nMain menu > Other settings > Enable custom event scripts.\n', mode: 0o644 },
    ];
  }
  // Batocera / Knulli: /userdata/system/scripts/*.sh with $1 = gameStart|gameStop and $5 = rom path
  return [
    { ...sync, path: 'system/scripts/rommancer/rommancer-sync.sh' },
    {
      path: 'system/scripts/rommancer.sh',
      content: '#!/bin/sh\nS="$(dirname "$0")/rommancer/rommancer-sync.sh"\ncase "$1" in\n  gameStart) "$S" start "$5" ;;\n  gameStop) "$S" end "$5" ;;\nesac\n',
      mode: 0o755,
    },
    { path: 'system/scripts/rommancer/README.txt', content: 'Copy the system folder into /userdata (it ends up as /userdata/system/scripts/rommancer.sh).\n', mode: 0o644 },
  ];
}
