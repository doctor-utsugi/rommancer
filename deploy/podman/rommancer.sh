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

[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE"; exit 1; }
# shellcheck disable=SC1090
. "$ENV_FILE"

case "${1:-}" in
  build)
    podman build -t rommancer-api -f "$SRC/backend/Containerfile" "$SRC"
    podman build -t rommancer-web -f "$SRC/frontend/Containerfile" "$SRC" ;;
  up)
    mkdir -p "$DATA/app" "$DATA/mysql" "$ROMS"
    podman network exists "$NET" || podman network create "$NET"
    podman rm -f rommancer-web rommancer-api rommancer-mysql >/dev/null 2>&1 || true
    podman run -d --name rommancer-mysql --network "$NET" --network-alias mysql --restart=always \
      -e MYSQL_ROOT_PASSWORD="$MYSQL_ROOT_PASSWORD" -e MYSQL_DATABASE=rommancer -e MYSQL_USER=rommancer -e MYSQL_PASSWORD="$MYSQL_PASSWORD" \
      -v "$DATA/mysql:/var/lib/mysql:Z" docker.io/library/mysql:8.4 --character-set-server=utf8mb4 --collation-server=utf8mb4_0900_ai_ci
    until podman exec rommancer-mysql mysqladmin ping -h127.0.0.1 -uroot -p"$MYSQL_ROOT_PASSWORD" --silent 2>/dev/null; do sleep 2; done
    podman run -d --name rommancer-api --network "$NET" --network-alias api --restart=always --env-file "$ENV_FILE" \
      -e DATABASE_URL="mysql://rommancer:$MYSQL_PASSWORD@mysql:3306/rommancer" -e DATA_DIR=/data -e SEED_DIR=/seed \
      -v "$DATA/app:/data:Z" -v "$SRC/seed:/seed:Z" -v "$ROMS:/roms:z" localhost/rommancer-api:latest
    podman run -d --name rommancer-web --network "$NET" --restart=always -p "127.0.0.1:$WEB_PORT:80" localhost/rommancer-web:latest
    systemctl --user enable --now podman-restart.service >/dev/null 2>&1 || true
    echo "Web on http://127.0.0.1:$WEB_PORT" ;;
  down) podman rm -f rommancer-web rommancer-api rommancer-mysql ;;
  logs) podman logs --tail 100 -f "rommancer-${2:-api}" ;;
  status) podman ps -a --filter name=rommancer --format '{{.Names}}\t{{.Status}}' ;;
  *) echo "Usage: $0 build|up|down|logs [api|web|mysql]|status"; exit 2 ;;
esac
