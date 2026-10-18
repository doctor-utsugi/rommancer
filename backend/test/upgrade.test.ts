/**
 * An update on a database with data in it: the 1.97 schema with test/fixtures/upgrade-1.97.sql loaded, then every
 * newer migration. The rows must come through, the current code must read every table, and so must code that is one
 * migration behind (what runs after rommancer.sh update goes back), shown with a migration this test adds.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { Prisma, PrismaClient } from '@prisma/client';
import { LEGACY, MIGRATIONS_DIR, migrationNames, nextNumber } from '../prisma/migration-rules.js';

const backend = path.resolve(import.meta.dirname, '..');
const url = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?.*)?$/, '/rommancer_test$1');
const fixture = fs.readFileSync(path.join(import.meta.dirname, 'fixtures/upgrade-1.97.sql'), 'utf8');
const TABLES = [...new Set([...fixture.matchAll(/^INSERT INTO `(\w+)`/gm)].map((m) => m[1]))];
let db: PrismaClient;

/** A schema folder holding these migrations, for prisma's --schema */
function schemaWith(migrations: string[], extra?: { name: string; sql: string }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rommancer-upgrade-'));
  fs.copyFileSync(path.join(backend, 'prisma/schema.prisma'), path.join(dir, 'schema.prisma'));
  fs.mkdirSync(path.join(dir, 'migrations'));
  fs.copyFileSync(path.join(MIGRATIONS_DIR, 'migration_lock.toml'), path.join(dir, 'migrations/migration_lock.toml'));
  for (const m of migrations) fs.cpSync(path.join(MIGRATIONS_DIR, m), path.join(dir, 'migrations', m), { recursive: true });
  if (extra) {
    fs.mkdirSync(path.join(dir, 'migrations', extra.name));
    fs.writeFileSync(path.join(dir, 'migrations', extra.name, 'migration.sql'), extra.sql);
  }
  return path.join(dir, 'schema.prisma');
}

const prisma = (args: string[], schema: string) =>
  execFileSync('npx', ['prisma', ...args, '--schema', schema], { cwd: backend, env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' }).toString();

async function counts() {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM \`${t}\``))[0].n);
  return out;
}

before(async () => {
  prisma(['migrate', 'reset', '--force', '--skip-seed', '--skip-generate'], schemaWith([...LEGACY]));
  db = new PrismaClient({ datasourceUrl: url });
  for (const statement of fixture.replace(/^--.*\n/gm, '').split(/;\n/).map((s) => s.trim()).filter((s) => s.startsWith('INSERT'))) await db.$executeRawUnsafe(statement);
});

after(async () => {
  // The probe migration exists only in this test: the others find the database as the repository's migrations leave it
  await db?.$executeRawUnsafe("DELETE FROM _prisma_migrations WHERE migration_name LIKE '%_upgrade_probe'").catch(() => {});
  for (const t of ['Rom', 'User']) await db?.$executeRawUnsafe(`ALTER TABLE \`${t}\` DROP COLUMN \`upgradeProbe\``).catch(() => {});
  await db?.$disconnect();
});

test('upgrade: a 1.97 database with data takes every newer migration and keeps its rows', async () => {
  const before = await counts();
  for (const t of TABLES) assert.ok(before[t] > 0, `the fixture fills ${t}`);
  prisma(['migrate', 'deploy'], schemaWith(migrationNames()));
  assert.deepEqual(await counts(), before);
  // The current code reads every table of the migrated database
  for (const m of Prisma.dmmf.datamodel.models) {
    const delegate = (db as unknown as Record<string, { findFirst(): Promise<unknown> }>)[m.name[0].toLowerCase() + m.name.slice(1)];
    await assert.doesNotReject(delegate.findFirst(), `reading ${m.name}`);
  }
  const admin = await db.user.findUniqueOrThrow({ where: { username: 'admin' } });
  assert.ok(await bcrypt.compare('probe-pass', admin.passwordHash), 'the admin still logs in');
});

test('upgrade: a migration this code does not know yet runs after the older ones, and the code still reads everything', async () => {
  const name = `m${String(nextNumber()).padStart(3, '0')}_upgrade_probe`;
  const out = prisma(['migrate', 'deploy'], schemaWith(migrationNames(), { name, sql: 'ALTER TABLE `Rom` ADD COLUMN `upgradeProbe` VARCHAR(16) NULL;\nALTER TABLE `User` ADD COLUMN `upgradeProbe` INTEGER NOT NULL DEFAULT 0;\n' }));
  assert.match(out, new RegExp(name));
  const last = await db.$queryRawUnsafe<{ migration_name: string }[]>('SELECT migration_name FROM _prisma_migrations ORDER BY started_at DESC, migration_name DESC LIMIT 1');
  assert.equal(last[0].migration_name, name);
  for (const m of Prisma.dmmf.datamodel.models) {
    const delegate = (db as unknown as Record<string, { findFirst(): Promise<unknown> }>)[m.name[0].toLowerCase() + m.name.slice(1)];
    await assert.doesNotReject(delegate.findFirst(), `reading ${m.name} with a column it does not know`);
  }
  // Writing too: the column it does not know takes its default
  await db.user.create({ data: { username: 'after-probe', passwordHash: 'x' } });
});
