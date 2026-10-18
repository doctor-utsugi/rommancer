/**
 * Every new migration only adds (prisma/migration-rules.ts), so the previous version keeps working on a migrated
 * database and an update can always go back. No database needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { breakingChanges, LEGACY, MIGRATIONS_DIR, migrationNames, NAME, nextNumber } from '../prisma/migration-rules.js';

test('migrations: new ones are named m041_x, m042_x... and are applied after every older one', () => {
  const names = migrationNames();
  for (const l of LEGACY) assert.ok(names.includes(l), `${l} is gone: a released migration is never removed or renamed`);
  const added = names.filter((n) => !LEGACY.has(n));
  for (const n of added) assert.match(n, NAME, `${n}: name new migrations with npm run migration:new (m041_name, m042_name...)`);
  const numbers = added.map((n) => Number(NAME.exec(n)![1])).sort((a, b) => a - b);
  assert.deepEqual(numbers, numbers.map((_, i) => 41 + i), `numbers must follow on from 041 with no gaps or repeats: ${numbers.join(', ')}`);
  // Prisma applies them in the order of their names as text
  const sorted = [...names].sort();
  for (const n of added) assert.ok(sorted.indexOf(n) > Math.max(...[...LEGACY].map((l) => sorted.indexOf(l))), `${n} would be applied before an older migration`);
  assert.equal(nextNumber(names), 41 + added.length);
});

test('migrations: new ones only add', () => {
  for (const n of migrationNames().filter((x) => !LEGACY.has(x))) {
    const problems = breakingChanges(fs.readFileSync(path.join(MIGRATIONS_DIR, n, 'migration.sql'), 'utf8'));
    assert.deepEqual(problems, [], `${n} would break the previous version:\n  ${problems.join('\n  ')}`);
  }
});

test('migrations: the check tells adding from breaking', () => {
  const ok = [
    'CREATE TABLE `A` (`id` INTEGER NOT NULL AUTO_INCREMENT, `name` VARCHAR(10) NOT NULL, PRIMARY KEY (`id`))',
    'ALTER TABLE `Rom` ADD COLUMN `note` VARCHAR(191) NULL',
    'ALTER TABLE `Rom` ADD COLUMN `count` INTEGER NOT NULL DEFAULT 0, ADD COLUMN `x` BOOLEAN NULL',
    'CREATE INDEX `Rom_note_idx` ON `Rom`(`note`)',
    'ALTER TABLE `Rom` DROP INDEX `Rom_old_idx`',
    'ALTER TABLE `Rom` ADD CONSTRAINT `Rom_a_fkey` FOREIGN KEY (`a`) REFERENCES `A`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
    '-- rommancer: widens kind with a new value\nALTER TABLE `Save` MODIFY `kind` ENUM(\'SAVE\', \'STATE\', \'CARD\') NOT NULL',
    '-- rommancer: contract nothing reads GameOpen since 1.90\nDROP TABLE `GameOpen`',
  ];
  for (const sql of ok) assert.deepEqual(breakingChanges(sql), [], sql);
  const bad = [
    'DROP TABLE `GameOpen`',
    'ALTER TABLE `RomPath` DROP COLUMN `isUploadTarget`',
    'ALTER TABLE `Device` DROP `old`',
    'ALTER TABLE `Device` RENAME COLUMN `excludedSystems` TO `systemFilter`',
    'ALTER TABLE `Device` CHANGE `a` `b` INTEGER NULL',
    'ALTER TABLE `User` MODIFY `email` VARCHAR(50) NOT NULL',
    'ALTER TABLE `Rom` ADD COLUMN `required` INTEGER NOT NULL',
    'ALTER TABLE `Rom` ADD COLUMN `x` INTEGER NULL, ADD COLUMN `y` VARCHAR(5) NOT NULL',
  ];
  for (const sql of bad) assert.notDeepEqual(breakingChanges(sql), [], sql);
});
