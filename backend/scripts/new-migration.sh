#!/bin/sh
# Creates a new migration by diffing the existing migrations against schema.prisma, named m041_name, m042_name...
# (prisma/migration-rules.ts), and says if it does anything but add.
# Usage: npm run migration:new -w backend -- name
set -e
NAME="$1"
[ -n "$NAME" ] || { echo "Usage: npm run migration:new -- <name>"; exit 1; }
. ../.env 2>/dev/null || true
SHADOW="${SHADOW_DATABASE_URL:-${DATABASE_URL%/*}/rommancer_shadow}"
N=$(npx tsx -e "import { nextNumber } from './prisma/migration-rules.ts'; console.log(String(nextNumber()).padStart(3, '0'))")
DIR="prisma/migrations/m${N}_${NAME}"
TMP=$(mktemp)
npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$SHADOW" --script > "$TMP"
mkdir -p "$DIR" && mv "$TMP" "$DIR/migration.sql"
echo "Created $DIR/migration.sql (review it before applying with npm run db:migrate)"
# A migration only adds (prisma/migration-rules.ts): say what in this one would break the previous version
npx tsx -e "import fs from 'node:fs'; import { breakingChanges } from './prisma/migration-rules.ts'; const p = breakingChanges(fs.readFileSync('$DIR/migration.sql', 'utf8')); if (p.length) { console.error('It would break the previous version:\\n  ' + p.join('\\n  ')); process.exit(1) }"
