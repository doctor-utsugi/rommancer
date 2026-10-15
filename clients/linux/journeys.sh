#!/bin/sh
# Sourced by rommancer-sync.sh; all persistent state is isolated by server and account token.
j_uuid() {
  if [ -r /proc/sys/kernel/random/uuid ]; then cat /proc/sys/kernel/random/uuid; else
    od -An -N16 -tx1 /dev/urandom | tr -d ' \n' | sed 's/^\(.\{8\}\)\(.\{4\}\)\(.\{4\}\)\(.\{4\}\)\(.\{12\}\)$/\1-\2-\3-\4-\5/'
  fi
}
j_decode() { printf '%s' "$1" | base64 -d; }
j_runtime() {
  jprocesses="$(ps -A -o comm= 2>/dev/null)" || jprocesses=""
  if [ -n "$jprocesses" ]; then
    if printf '%s\n' "$jprocesses" | grep -qiE 'retroarch|minarch|drastic|ppsspp|mupen64|duckstation|retrorun|azahar|citra|lime3ds'; then printf 'running\n'; else printf 'stopped\n'; fi
  elif game_running; then printf 'running\n'
  else printf 'unknown\n'; fi
}
j_init() {
  JROOT="$STATE/journeys/$(printf '%s\n%s' "$SERVER" "$TOKEN" | sha1sum | cut -d' ' -f1)"
  mkdir -p "$JROOT/blobs"
}
j_api() { http "$1" "$SERVER/api/v1/agent/journeys/$2" "$3" "$4" "${5:-X-Journeys: 1}" "${6:-X-Journeys: 1}"; }
j_layout() { awk -F '\t' -v k="$1" '$1 == "layout" && $2 == k { print $3 }' "$JD/binding" | base64 -d; }
j_load() {
  case "$1" in *[!a-f0-9]*|'') return 1 ;; esac
  [ ${#1} = 40 ] || return 1
  JD="$JROOT/$1"
  [ -f "$JD/active" ] && [ -f "$JD/binding" ] || return 1
  JB="$(awk -F '\t' '$1 == "binding" { print $2 }' "$JD/binding")"
  JIDENT="$1"
  read -r JA JGEN < "$JD/active"
  JEMU="$(j_layout emulator)"; JSAVE="$(j_layout savePath)"; JSTATE="$(j_layout statePath)"
  JSA="$(j_layout saveAdapter)"; [ -n "$JSA" ] || JSA="$JEMU"
  JSTA="$(j_layout stateAdapter)"; [ -n "$JSTA" ] || JSTA="$JEMU"
}
j_room() {
  jvolume="$1"; jneed="$2"
  while [ ! -d "$jvolume" ] && [ "$jvolume" != / ]; do jvolume="$(dirname "$jvolume")"; done
  set -- $(df -k "$jvolume" | awk 'NR == 2 { printf "%.0f %.0f", $4*1024, $2*1024 }')
  [ $# = 2 ] || return 1
  jreserve=$(( $2 / 20 )); [ "$jreserve" -ge 134217728 ] || jreserve=134217728
  [ "$jreserve" -le 1073741824 ] || jreserve=1073741824
  [ "${JRECOVER:-0}" != 1 ] || jreserve=0
  [ $(( $1 - jreserve )) -ge "$jneed" ] || { printf 'Not enough space; need %s bytes plus storage reserve\n' "$jneed" >&2; return 1; }
}
j_blob() {
  jf="$1"
  [ -f "$jf" ] && [ ! -L "$jf" ] || return 1
  jh="$(sha1 "$jf")"; jsize="$(stat -c %s "$jf")"
  [ -n "$jh" ] || return 1
  if [ ! -f "$JROOT/blobs/$jh" ]; then
    j_room "$JROOT" "$jsize" || return 1
    cp "$jf" "$JROOT/blobs/$jh.tmp" && [ "$(sha1 "$JROOT/blobs/$jh.tmp")" = "$jh" ] && [ "$(sha1 "$jf")" = "$jh" ] || return 1
    mv "$JROOT/blobs/$jh.tmp" "$JROOT/blobs/$jh" || return 1
  fi
  printf '%s\t%s\t%s\n' "$2" "$jh" "$jsize"
}
j_scan() {
  [ -d "$(dirname "$JSAVE")" ] && [ -r "$(dirname "$JSAVE")" ] && [ -d "$(dirname "$JSTATE")" ] && [ -r "$(dirname "$JSTATE")" ] || { printf 'Save folders unavailable\n' >&2; return 1; }
  [ ! -f "$JSAVE" ] || j_blob "$JSAVE" "$JSA/save/0" || return 1
  for jf in "$JSTATE"*; do
    [ -f "$jf" ] || continue
    jsuffix="${jf#"$JSTATE"}"; jkind=state
    case "$jsuffix" in *.png) jsuffix="${jsuffix%.png}"; jkind=thumb ;; esac
    case "$jsuffix" in '') jslot=0 ;; .auto) jslot=-1 ;; *[!0-9]*) continue ;; *) jslot="$jsuffix" ;; esac
    j_blob "$jf" "$JSTA/$jkind/$jslot" || return 1
  done
}
j_capture() {
  mkdir -p "$JD/$JA"
  [ ! -f "$JD/$JA/conflict" ] || { printf 'Journey has conflicting progress; resolve it before changing\n' >&2; return 1; }
  j_scan > "$JD/scan1" || return 1
  awk -F '\t' 'seen[$1]++ { exit 1 }' "$JD/scan1" || { printf 'Ambiguous duplicate state slots\n' >&2; return 1; }
  sleep "${ROMMANCER_JOURNEY_SETTLE:-1}"
  j_scan > "$JD/scan2" || return 1
  cmp -s "$JD/scan1" "$JD/scan2" || { printf 'Game is still writing; try again after closing it\n' >&2; return 1; }
  { [ ! -f "$JD/$JA/manifest" ] || awk -F '\t' -v s="$JSA/save/" -v p="$JSTA/" 'index($1,p) != 1 && index($1,s) != 1' "$JD/$JA/manifest"; cat "$JD/scan2"; } | sort > "$JD/$JA/new"
  if ! cmp -s "$JD/$JA/new" "$JD/$JA/manifest"; then
    mv "$JD/$JA/new" "$JD/$JA/manifest" || return 1
    : > "$JD/$JA/dirty"
  else rm -f "$JD/$JA/new"; fi
  sync
}
j_path() {
  jk="$1"; je="${jk%%/*}"; jr="${jk#*/}"; jkind="${jr%%/*}"; jslot="${jr##*/}"
  case "$jkind" in
    save) [ "$je" = "$JSA" ] || return 1; printf '%s' "$JSAVE" ;;
    state|thumb)
      [ "$je" = "$JSTA" ] || return 1
      case "$jslot" in -1) jsuffix=.auto ;; 0) jsuffix='' ;; *[!0-9]*|'') return 1 ;; *) jsuffix="$jslot" ;; esac
      printf '%s%s' "$JSTATE" "$jsuffix"; [ "$jkind" != thumb ] || printf '.png' ;;
    *) return 1 ;;
  esac
}
j_apply() {
  jmanifest="$1"; jold="$2"
  if [ "${JRECOVER:-0}" != 1 ]; then
    jtotal="$(awk -F '\t' -v s="$JSA/save/" -v p="$JSTA/" 'index($1,s) == 1 || index($1,p) == 1 { n += $3 } END { printf "%.0f", n }' "$jmanifest")"
    j_room "$(dirname "$JSAVE")" "$jtotal" && j_room "$(dirname "$JSTATE")" "$jtotal" || return 1
  fi
  while IFS="$TAB" read -r jk jh jsize; do
    [ -n "$jk" ] || continue
    jp="$(j_path "$jk")" || continue
    [ ! -L "$jp" ] || return 1
    if ! awk -F '\t' -v k="$jk" '$1 == k { found=1 } END { exit !found }' "$jmanifest"; then rm -f "$jp" || return 1; fi
  done < "$jold"
  while IFS="$TAB" read -r jk jh jsize; do
    [ -n "$jk" ] || continue
    jp="$(j_path "$jk")" || continue
    [ -f "$JROOT/blobs/$jh" ] && [ "$(sha1 "$JROOT/blobs/$jh")" = "$jh" ] && [ ! -L "$jp" ] || return 1
    j_room "$(dirname "$jp")" "$jsize" || return 1
    mkdir -p "$(dirname "$jp")" && cp "$JROOT/blobs/$jh" "$jp.journey-tmp" && [ "$(sha1 "$jp.journey-tmp")" = "$jh" ] && mv "$jp.journey-tmp" "$jp" || return 1
  done < "$jmanifest"
  sync
}
j_finish() {
  rm -rf "$JD/journal-complete"
  mv "$JD/journal" "$JD/journal-complete" || return 1
  sync
  rm -rf "$JD/journal-complete"
  sync
}
j_recover() {
  [ -d "$JD/journal" ] || return 0
  if [ -f "$JD/journal/done" ]; then j_finish; return $?; fi
  JRECOVER=1 j_apply "$JD/journal/old" "$JD/journal/target" || { printf 'Journey recovery needs attention; do not launch this game\n' >&2; return 1; }
  cp "$JD/journal/active" "$JD/active.tmp" && mv "$JD/active.tmp" "$JD/active" || return 1
  if [ -f "$JD/journal/selection" ]; then cp "$JD/journal/selection" "$JD/selection"; else rm -f "$JD/selection"; fi
  if [ -f "$JD/journal/restore-journey" ]; then
    jrj="$(cat "$JD/journal/restore-journey")"
    cp "$JD/journal/manifest" "$JD/$jrj/manifest"
    cp "$JD/journal/base" "$JD/$jrj/base"
    cp "$JD/journal/baseline" "$JD/$jrj/baseline"
  fi
  j_finish || return 1
  sync
  read -r JA JGEN < "$JD/active"
}
j_publish() {
  jj="$1"; jbase="$(cat "$JD/$jj/base" 2>/dev/null || printf 0)"
  if [ -f "$JD/$jj/create" ]; then
    j_api POST create "$JD/$jj/create" "$JD/created" || return 1
    rm -f "$JD/$jj/create"
  fi
  if [ -f "$JD/$jj/rename" ]; then j_api POST "rename/$jj" "$JD/$jj/rename" "$JD/renamed" && rm -f "$JD/$jj/rename" || return 1; fi
  [ -f "$JD/$jj/dirty" ] || return 0
  [ ! -f "$JD/$jj/conflict" ] || return 1
  if [ ! -f "$JD/$jj/outbox" ]; then
    cp "$JD/$jj/manifest" "$JD/$jj/outbox"
    printf '%s %s\n' "$jbase" "$(j_uuid)" > "$JD/$jj/operation"
  fi
  while IFS="$TAB" read -r jk jh jsize; do
    [ -n "$jk" ] || continue
    j_api POST "blob/$jh" "$JROOT/blobs/$jh" "$JD/blob-result" || return 1
  done < "$JD/$jj/outbox"
  read -r jbase jop < "$JD/$jj/operation"
  j_api POST "commit/$jj" "$JD/$jj/outbox" "$JD/committed" "X-Journey-Base: $jbase" "X-Journey-Operation: $jop" || return 1
  IFS="$TAB" read -r jr jrev jop < "$JD/committed"
  if [ "$jr" = conflict ]; then cp "$JD/committed" "$JD/$jj/conflict"; printf 'Journey conflict: both checkpoints kept\n' >&2; return 1; fi
  [ "$jr" = committed ] || return 1
  printf '%s\n' "$jrev" > "$JD/$jj/base"
  cp "$JD/$jj/outbox" "$JD/$jj/baseline"
  cmp -s "$JD/$jj/outbox" "$JD/$jj/manifest" && rm -f "$JD/$jj/dirty"
  rm -f "$JD/$jj/outbox" "$JD/$jj/operation"
}
j_refresh() {
  rm -f "$JD/refused"
  if ! j_api GET "list/$JIDENT" - "$JD/list.new"; then
    [ "$(cut -f1 "$WORK/last-error" 2>/dev/null)" != 22 ] || touch "$JD/refused"
    return 1
  fi
  if [ -f "$JD/list" ]; then
    awk -F '\t' 'NR == FNR { ids[$2]=1; next } !ids[$2] { print }' "$JD/list.new" "$JD/list" > "$JD/local-list"
    cat "$JD/local-list" >> "$JD/list.new"
  fi
  mv "$JD/list.new" "$JD/list"
  while IFS="$TAB" read -r jt jj jrev jname jtime; do
    [ "$jt" = journey ] || continue
    mkdir -p "$JD/$jj"
    [ ! -f "$JD/$jj/dirty" ] && [ ! -f "$JD/$jj/conflict" ] || continue
    j_api GET "manifest/$jj/$jrev" - "$JD/$jj/incoming" || continue
    jok=1
    while IFS="$TAB" read -r jk jh jsize; do
      [ -n "$jk" ] || continue
      if [ ! -f "$JROOT/blobs/$jh" ]; then
        j_room "$JROOT" "$jsize" && j_api GET "blob/$jh" - "$JROOT/blobs/$jh.tmp" && [ "$(sha1 "$JROOT/blobs/$jh.tmp")" = "$jh" ] && mv "$JROOT/blobs/$jh.tmp" "$JROOT/blobs/$jh" || { jok=0; break; }
      fi
    done < "$JD/$jj/incoming"
    if [ "$jok" = 1 ]; then
      if [ "$jj" = "$JA" ] && ! cmp -s "$JD/$jj/incoming" "$JD/$jj/manifest"; then
        [ "${JCLOSED:-0}" = 1 ] && ! game_running || continue
        mkdir -p "$JD/preparing"
        cp "$JD/$JA/manifest" "$JD/preparing/old"; cp "$JD/$jj/incoming" "$JD/preparing/target"; cp "$JD/active" "$JD/preparing/active"
        printf '%s\n' "$jj" > "$JD/preparing/restore-journey"
        cp "$JD/$jj/manifest" "$JD/preparing/manifest"
        cp "$JD/$jj/base" "$JD/preparing/base"
        cp "$JD/$jj/baseline" "$JD/preparing/baseline"
        [ ! -f "$JD/selection" ] || cp "$JD/selection" "$JD/preparing/selection"
        sync; mv "$JD/preparing" "$JD/journal" || return 1
        j_apply "$JD/journal/target" "$JD/journal/old" || { j_recover; return 1; }
      fi
      mv "$JD/$jj/incoming" "$JD/$jj/manifest"; cp "$JD/$jj/manifest" "$JD/$jj/baseline"; printf '%s\n' "$jrev" > "$JD/$jj/base"
      if [ -d "$JD/journal" ]; then touch "$JD/journal/done"; sync; j_finish || return 1; fi
    fi
  done < "$JD/list"
}
j_switch() {
  JSWITCH_TARGET="$1"; jt="$1"
  case "$jt" in *[!a-f0-9-]*|'') return 1 ;; esac
  [ "$jt" != "$JA" ] || return 0
  [ -f "$JD/$jt/manifest" ] || { printf 'Download required; connect before selecting this journey\n' >&2; return 1; }
  if game_running; then printf '%s\n' "$jt" > "$JD/pending"; printf 'Close the game to switch journeys. Change pending.\n'; return 0; fi
  [ "${JCLOSED:-0}" = 1 ] || { printf 'Confirm the game is closed before switching\n' >&2; return 1; }
  j_capture || return 1
  if ! j_refresh; then
    [ ! -f "$JD/refused" ] || { printf 'Server refused Journey sync; check emulator paths, core version and credentials before switching\n' >&2; return 1; }
    printf 'Offline: using the cached journey. Changes will sync when connected.\n'
  fi
  jt="$JSWITCH_TARGET"
  mkdir -p "$JD/preparing"
  cp "$JD/$JA/manifest" "$JD/preparing/old" && cp "$JD/$jt/manifest" "$JD/preparing/target" && cp "$JD/active" "$JD/preparing/active" || return 1
  [ ! -f "$JD/selection" ] || cp "$JD/selection" "$JD/preparing/selection"
  sync
  mv "$JD/preparing" "$JD/journal" || return 1
  if ! j_apply "$JD/journal/target" "$JD/journal/old"; then j_recover; return 1; fi
  jgen=$((JGEN + 1)); printf '%s %s\n' "$jt" "$jgen" > "$JD/active.tmp"
  printf '%s\t%s\t%s\t%s\n' "$jt" "$jgen" "$(j_uuid)" "${JCOMMAND_ID:--}" > "$JD/selection.tmp"
  sync
  mv "$JD/active.tmp" "$JD/active" && mv "$JD/selection.tmp" "$JD/selection" || return 1
  sync
  touch "$JD/journal/done"; sync
  j_finish || return 1
  rm -f "$JD/pending" "$CACHE" "$CACHE_DISK"
  : > "$CACHE"
  JA="$jt"; JGEN="$jgen"
  jdisplay="$(awk -F '\t' -v id="$jt" '$2 == id { print $4 }' "$JD/list" | base64 -d)"
  printf 'Current journey: %s. Close and reopen any emulator that was already running. New saves affect this journey.\n' "$jdisplay" > "$JD/notice"
  printf 'Current slot: %s · Progress kept on this console; waiting to sync\n' "$jdisplay"
}
j_run() (
  j_init
  jaction="${1:-games}"; shift || true
  if [ "$jaction" = runtime ]; then printf 'runtime\t%s\n' "$(j_runtime)"; exit 0; fi
  if [ "$jaction" = games ]; then
    j_api GET games - "$JROOT/games.new" && mv "$JROOT/games.new" "$JROOT/games"
    cat "$JROOT/games" 2>/dev/null
    for jd in "$JROOT"/*/binding; do
      [ -f "$jd" ] || continue
      jrom64="$(cat "$(dirname "$jd")/rom")"
      printf 'enrolled\t%s\t%s\n' "$(basename "$(dirname "$jd")")" "$jrom64"
      if ! awk -F '\t' -v p="$jrom64" '$1 == "game" && $2 == p { found=1 } END { exit !found }' "$JROOT/games" 2>/dev/null; then
        jsystem="$(awk -F '\t' '$1 == "layout" && $2 == "platform" { print $3 }' "$jd" | base64 -d)"
        printf 'game\t%s\t%s\t%s\n' "$jrom64" "$(b64 "$(basename "$(j_decode "$jrom64")")")" "${jsystem:-unknown}"
      fi
    done
    exit 0
  fi
  if [ "$jaction" = enroll ]; then
    game_running && { printf 'Close the emulator before setting up journeys\n' >&2; exit 1; }
    jr="$(j_decode "$1")"; [ -f "$jr" ] && [ ! -L "$jr" ] || exit 1
    jop="$(j_uuid)"; printf '%s\t%s\t%s\n' "$1" "$(sha1 "$jr")" "$jop" > "$JROOT/enroll"
    j_api POST register "$JROOT/enroll" "$JROOT/registered" || exit 1
    ji="$(awk -F '\t' '$1 == "binding" { print $3 }' "$JROOT/registered")"
    JD="$JROOT/$ji"; mkdir -p "$JD"
    cp "$JROOT/registered" "$JD/binding"; printf '%s\n' "$1" > "$JD/rom"
    jj="$(awk -F '\t' '$1 == "binding" { print $4 }' "$JD/binding")"
    [ -f "$JD/active" ] || printf '%s 0\n' "$jj" > "$JD/active"
    j_load "$ji" && j_capture || exit 1
    j_publish "$JA" && j_refresh || true
    printf 'enrolled\t%s\n' "$ji"; exit 0
  fi
  j_load "$1" || exit 1; shift
  j_recover || exit 1
  case "$jaction" in
    list)
      if [ "${1:-}" != cached ] && ! j_refresh >/dev/null 2>&1; then
        [ ! -f "$JD/refused" ] || { printf 'Server refused Journey sync; check Status for adapter or account changes\n' >&2; exit 1; }
        printf 'Offline: showing cached journeys\n' >&2
      fi
      printf 'active\t%s\t%s\n' "$JA" "$JGEN"
      [ -f "$JD/slots" ] || printf '%s\t1\n' "$JA" > "$JD/slots"
      [ ! -f "$JD/pending" ] || printf 'pending\t%s\n' "$(cat "$JD/pending")"
      while IFS="$TAB" read -r jtype jid jrevision jlabel jdate; do
        [ ! -f "$JD/$jid/rename" ] || jlabel="$(cat "$JD/$jid/rename")"
        printf '%s\t%s\t%s\t%s\t%s\n' "$jtype" "$jid" "$jrevision" "$jlabel" "$jdate"
        jnumber="$(awk -F '\t' -v id="$jid" '$1 == id { print $2 }' "$JD/slots")"
        if [ -z "$jnumber" ]; then
          jnumber="$(awk -F '\t' '$2 > max { max=$2 } END { print max+1 }' "$JD/slots")"
          printf '%s\t%s\n' "$jid" "$jnumber" >> "$JD/slots"
        fi
        printf 'slot\t%s\t%s\n' "$jid" "$jnumber"
      done < "$JD/list"
      for jm in "$JD"/*/manifest; do
        [ -f "$jm" ] || continue
        jslotid="$(basename "$(dirname "$jm")")"
        printf 'cached\t%s\n' "$jslotid"
        printf 'content\t%s\t%s\n' "$jslotid" "$(awk -F '\t' '$1 !~ /\/thumb\// { n++ } END { print n+0 }' "$jm")"
        [ ! -f "$(dirname "$jm")/conflict" ] || printf 'conflict\t%s\n' "$jslotid"
        jincompatible="$(awk -F '\t' -v s="$JSA/save/" -v p="$JSTA/" 'index($1,s) != 1 && index($1,p) != 1 { n++ } END { print n+0 }' "$jm")"
        [ "$jincompatible" = 0 ] || printf 'incompatible\t%s\t%s\n' "$jslotid" "$jincompatible"
      done ;;
    switch) JCLOSED="${2:-0}"; j_switch "$1" ;;
    rename)
      case "$1" in *[!a-f0-9-]*|'') exit 1 ;; esac
      [ ${#1} = 36 ] && [ -d "$JD/$1" ] && [ -n "$2" ] && [ ${#2} -le 80 ] || exit 1
      jrname="$(b64 "$2")"; printf '%s\n' "$jrname" > "$JD/$1/rename"
      awk -F '\t' -v OFS='\t' -v id="$1" -v name="$jrname" '$2 == id { $4=name } { print }' "$JD/list" > "$JD/list.rename"
      mv "$JD/list.rename" "$JD/list"
      printf 'Journey name saved on this console; waiting to sync\n' ;;
    new|duplicate|keep-both)
      [ ${#1} -le 80 ] || { printf 'Journey names must be 80 characters or fewer\n' >&2; exit 1; }
      if [ "$jaction" = keep-both ]; then
        [ -f "$JD/$JA/conflict" ] || exit 1
        game_running && exit 1
        rm -f "$JD/$JA/conflict"
      fi
      JCLOSED="${2:-0}"; j_capture || exit 1
      if [ "$jaction" = duplicate ]; then
        j_refresh || { [ ! -f "$JD/refused" ] || exit 1; }
        jhead="$(awk -F '\t' -v id="$JA" '$2 == id { print $3 }' "$JD/list")"
        jbase="$(cat "$JD/$JA/base" 2>/dev/null || printf 0)"
        [ "${jhead:-0}" -le "$jbase" ] || { printf 'New server progress is available. Apply it or resolve the conflict before duplicating.\n' >&2; exit 1; }
      fi
      jj="$(j_uuid)"; mkdir -p "$JD/$jj"
      if [ "$jaction" != new ]; then cp "$JD/$JA/manifest" "$JD/$jj/manifest"; else : > "$JD/$jj/manifest"; fi
      printf '%s\t%s\t%s\n' "$jj" "$JIDENT" "$(b64 "${1:-New journey}")" > "$JD/$jj/create"
      printf '0\n' > "$JD/$jj/base"; : > "$JD/$jj/dirty"
      printf 'journey\t%s\t0\t%s\tlocal\n' "$jj" "$(b64 "${1:-New journey}")" >> "$JD/list"
      if [ "$jaction" = keep-both ]; then rm -f "$JD/$JA/outbox" "$JD/$JA/operation" "$JD/$JA/dirty"; fi
      j_switch "$jj" ;;
    sync)
      JCLOSED="${1:-0}"
      j_capture || exit 1
      for jm in "$JD"/*/manifest; do [ ! -f "$jm" ] || j_publish "$(basename "$(dirname "$jm")")" || exit 1; done
      if [ -f "$JD/selection" ]; then j_api POST "select/$JB" "$JD/selection" "$JD/selected" && rm -f "$JD/selection" || exit 1; fi
      j_refresh || exit 1
      if [ -f "$JD/pending" ] && [ "$JCLOSED" = 1 ] && ! game_running; then j_switch "$(cat "$JD/pending")" || exit 1; fi
      if j_api GET commands - "$JD/commands"; then
        while IFS="$TAB" read -r jt jcmd jbinding jtarget jexpected; do
          [ "$jt" = command ] && [ "$jbinding" = "$JB" ] || continue
          jstatus=waiting
          if [ "$jexpected" != "$JGEN" ]; then jstatus=superseded
          elif [ "$JCLOSED" = 1 ] && ! game_running && JCOMMAND_ID="$jcmd" j_switch "$jtarget"; then
            if [ -f "$JD/selection" ]; then j_api POST "select/$JB" "$JD/selection" "$JD/selected" && rm -f "$JD/selection" || continue; fi
            jstatus=applied
          fi
          printf '%s\n' "$jstatus" > "$JD/command-result"
          j_api POST "commands/$jcmd" "$JD/command-result" "$JD/command-ack" || true
        done < "$JD/commands"
      fi ;;
    recover) : ;;
    *) exit 2 ;;
  esac
)

j_all() (
  j_init
  jerrors=0
  for jbinding in "$JROOT"/*/binding; do
    [ -f "$jbinding" ] || continue
    jidentity="$(basename "$(dirname "$jbinding")")"
    j_run sync "$jidentity" "${1:-0}" || { jerrors=$((jerrors + 1)); log "Journey sync needs attention: $jidentity"; }
  done
  printf '%s\n' "$jerrors" > "$WORK/journey-errors"
)

j_before_start() (
  j_init
  jrom="$(b64 "$1")"
  for jbfile in "$JROOT"/*/binding; do
    [ -f "$jbfile" ] || continue
    jd="$(dirname "$jbfile")"
    [ "$(cat "$jd/rom")" = "$jrom" ] || continue
    jn=0
    until take_lock; do sleep 1; jn=$((jn + 1)); [ "$jn" -lt 30 ] || { panel "Journeys" "Sync is busy. Close the game and try again." wait; exit 1; }; done
    trap 'drop_lock' EXIT
    j_run recover "$(basename "$jd")" || { panel "Journeys" "Recovery needs attention. Do not start this game." wait; exit 1; }
    j_run sync "$(basename "$jd")" 1 || log "Journey starts from local progress (offline or needs attention)"
    if [ -f "$jd/notice" ]; then
      if command -v notify-send >/dev/null 2>&1; then notify-send -a Rommancer "Journey selected" "$(cat "$jd/notice")" || true; fi
      log "$(cat "$jd/notice")"
      rm -f "$jd/notice"
    fi
    exit 0
  done
)

cmd_journeys() {
  need_link
  take_lock || { printf 'Sync is busy; try again\n' >&2; return 1; }
  trap 'drop_lock' EXIT
  j_run "$@"; jresult=$?
  drop_lock; trap - EXIT
  return "$jresult"
}
