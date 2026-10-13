#!/bin/sh
# Creates a new migration by diffing the existing migrations against schema.prisma.
# Usage: npm run migration:new -w backend -- name
set -e
NAME="$1"
[ -n "$NAME" ] || { echo "Usage: npm run migration:new -- <name>"; exit 1; }
. ../.env 2>/dev/null || true
SHADOW="${SHADOW_DATABASE_URL:-${DATABASE_URL%/*}/rommancer_shadow}"
N=$(ls prisma/migrations | grep -c '^[0-9]')
DIR="prisma/migrations/${N}_${NAME}"
TMP=$(mktemp)
npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$SHADOW" --script > "$TMP"
mkdir -p "$DIR" && mv "$TMP" "$DIR/migration.sql"
echo "Created $DIR/migration.sql (review it before applying with npm run db:migrate)"
