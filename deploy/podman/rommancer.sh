#!/bin/sh
# Rootless Podman deployment for a host whose Podman lacks Quadlet (Debian 12 ships 4.3).
# Containers use --restart=always and come back at boot through podman-restart.service.
#   rommancer.sh build | up | down | logs [api|web|mysql] | status
set -eu
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${ROMMANCER_ENV:-$HOME/.config/rommancer/rommancer.env}"
DATA="${ROMMANCER_DATA:-$HOME/rommancer-data}"
ROMS="${ROMMANCER_ROMS:-$HOME/rommancer-roms}"
WEB_PORT="${ROMMANCER_WEB_PORT:-8096}"
NET=rommancer

# Optional: overrides for the API (see .env.example). An installation from before the installer keeps its database
# passwords there; they are handed to MySQL, which keeps them in data/secrets
envval() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1; }
MYSQL_ROOT_PASSWORD="$(envval MYSQL_ROOT_PASSWORD || true)"
MYSQL_PASSWORD="$(envval MYSQL_PASSWORD || true)"

case "${1:-}" in
  build)
    podman build -t rommancer-mysql -f "$SRC/deploy/mysql/Containerfile" "$SRC"
    podman build -t rommancer-api -f "$SRC/backend/Containerfile" "$SRC"
    podman build -t rommancer-web -f "$SRC/frontend/Containerfile" "$SRC" ;;
  up)
    mkdir -p "$DATA/app/secrets" "$DATA/mysql" "$ROMS"
    podman network exists "$NET" || podman network create "$NET"
    podman rm -f rommancer-web rommancer-api rommancer-mysql >/dev/null 2>&1 || true
    set --
    [ -n "$MYSQL_ROOT_PASSWORD" ] && set -- "$@" -e MYSQL_ROOT_PASSWORD="$MYSQL_ROOT_PASSWORD"
    [ -n "$MYSQL_PASSWORD" ] && set -- "$@" -e MYSQL_PASSWORD="$MYSQL_PASSWORD"
    podman run -d --name rommancer-mysql --network "$NET" --network-alias mysql --restart=always "$@" \
      -v "$DATA/mysql:/var/lib/mysql:Z" -v "$DATA/app/secrets:/secrets:z" localhost/rommancer-mysql:latest
    until podman exec rommancer-mysql mysqladmin ping -h127.0.0.1 --silent 2>/dev/null; do sleep 2; done
    set --
    [ -f "$ENV_FILE" ] && set -- "$@" --env-file "$ENV_FILE"
    # Chosen before the installer existed: the database the passwords above open
    [ -n "$MYSQL_PASSWORD" ] && [ ! -f "$DATA/app/config/database.json" ] && set -- "$@" -e DATABASE_URL="mysql://rommancer:$MYSQL_PASSWORD@mysql:3306/rommancer"
    podman run -d --name rommancer-api --network "$NET" --network-alias api --restart=always "$@" \
      -e DATA_DIR=/data -e SEED_DIR=/seed -e ROMMANCER_BUNDLED_DB=mysql:3306 \
      -e TZ="${TZ:-$(timedatectl show -p Timezone --value 2>/dev/null || echo UTC)}" \
      -v "$DATA/app:/data:z" -v "$SRC/seed:/seed:Z" -v "$ROMS:/roms:z" -v "$SRC/clients:/app/clients:ro,Z" localhost/rommancer-api:latest
    podman run -d --name rommancer-web --network "$NET" --restart=always -p "127.0.0.1:$WEB_PORT:80" localhost/rommancer-web:latest
    systemctl --user enable --now podman-restart.service >/dev/null 2>&1 || true
    echo "Web on http://127.0.0.1:$WEB_PORT" ;;
  down) podman rm -f rommancer-web rommancer-api rommancer-mysql ;;
  logs) podman logs --tail 100 -f "rommancer-${2:-api}" ;;
  status) podman ps -a --filter name=rommancer --format '{{.Names}}\t{{.Status}}' ;;
  *) echo "Usage: $0 build|up|down|logs [api|web|mysql]|status"; exit 2 ;;
esac
