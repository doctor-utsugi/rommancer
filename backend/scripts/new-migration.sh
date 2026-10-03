#!/bin/sh
# Crea una migracion nueva comparando las migraciones existentes con schema.prisma.
# Uso: npm run migration:new -w backend -- nombre
set -e
NAME="$1"
[ -n "$NAME" ] || { echo "Uso: npm run migration:new -- <nombre>"; exit 1; }
. ../.env 2>/dev/null || true
SHADOW="${SHADOW_DATABASE_URL:-${DATABASE_URL%/*}/rommancer_shadow}"
N=$(ls prisma/migrations | grep -c '^[0-9]')
DIR="prisma/migrations/${N}_${NAME}"
TMP=$(mktemp)
npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$SHADOW" --script > "$TMP"
mkdir -p "$DIR" && mv "$TMP" "$DIR/migration.sql"
echo "Creada $DIR/migration.sql (revisala antes de aplicar con npm run db:migrate)"
