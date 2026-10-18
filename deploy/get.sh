#!/bin/sh
# Rommancer in one command, on Linux and macOS:
#   curl -fsSL https://github.com/doctor-utsugi/rommancer/releases/latest/download/get.sh | sh
# Downloads the newest release into ~/rommancer (ROMMANCER_DIR elsewhere), starts it with its ready-made images and
# as a service (so it starts with the computer and Administration > Update works), asking nothing, and ends with the
# address where the installer in the browser finishes: database, account, web address. The roms go in
# ~/rommancer-roms unless ROMMANCER_ROMS says otherwise. Options after "sh -s --" go to rommancer.sh install.
set -eu
REPO=doctor-utsugi/rommancer
DIR="${ROMMANCER_DIR:-$HOME/rommancer}"

case "${LANG:-}" in
  es*) have="Rommancer ya está en %s. Para actualizarlo: sh %s/deploy/podman/rommancer.sh update\n"
    need="Rommancer necesita curl y tar."
    get="Descargando Rommancer en %s…\n" ;;
  *) have="Rommancer is already in %s. To update it: sh %s/deploy/podman/rommancer.sh update\n"
    need="Rommancer needs curl and tar."
    get="Downloading Rommancer into %s…\n" ;;
esac

for c in curl tar; do command -v "$c" >/dev/null 2>&1 || { echo "$need" >&2; exit 1; }; done
# shellcheck disable=SC2059
if [ -f "$DIR/deploy/podman/rommancer.sh" ]; then printf "$have" "$DIR" "$DIR" >&2; exit 1; fi

# shellcheck disable=SC2059
printf "$get" "$DIR" >&2
mkdir -p "$DIR"
curl -fsSL "https://github.com/$REPO/releases/latest/download/rommancer.tar.gz" | tar -xz -C "$DIR" --strip-components=1
exec sh "$DIR/deploy/podman/rommancer.sh" install --web --service yes "$@" </dev/null
