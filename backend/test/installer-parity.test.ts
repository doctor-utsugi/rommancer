/**
 * The web installer (frontend/src/pages/setup.tsx) and the console installer (deploy/install.sh) must offer the same
 * thing: every field the setup API takes, the same sync schedules, every language, every state of GET /setup.
 * A change to one that the other lacks fails here (rule in CLAUDE.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const cli = read('deploy/install.sh');
const web = read('frontend/src/pages/setup.tsx');

// Importing the server's modules makes its secrets: somewhere that is thrown away
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rommancer-parity-'));

/** The body of a shell function, up to its closing brace at the start of a line */
function shellFunction(name: string) {
  const m = cli.match(new RegExp(`^${name}\\(\\) \\{\\n([\\s\\S]*?)^\\}`, 'm'));
  assert.ok(m, `deploy/install.sh has no ${name}()`);
  return m[1];
}
/** Field names a shell function puts in its JSON (jstr/jnum/jbool NAME) */
const cliFields = (fn: string) => new Set([...shellFunction(fn).matchAll(/\bj(?:str|num|bool) (\w+)/g)].map((m) => m[1]));
/** The source of a React component, up to the next top-level function */
function webComponent(name: string) {
  const m = web.match(new RegExp(`^function ${name}\\b[\\s\\S]*?(?=^(?:export )?function |(?![\\s\\S]))`, 'm'));
  assert.ok(m, `setup.tsx has no ${name}`);
  return m[0];
}
const sorted = (s: Iterable<string>) => [...s].sort();

test('both installers send every field the setup API takes, and nothing else', async () => {
  const { databaseBody } = await import('../src/installer.js');
  const { adminBody } = await import('../src/modules/setup/routes.js');
  const dbKeys = new Set(databaseBody.options.flatMap((o) => Object.keys(o.shape)));
  const adminKeys = new Set(Object.keys(adminBody.shape));

  assert.deepEqual(sorted(cliFields('db_body')), sorted(dbKeys), 'install.sh db_body() against POST /setup/database');
  assert.deepEqual(sorted(cliFields('admin_body')), sorted(adminKeys), 'install.sh admin_body() against POST /setup/admin');
  for (const mode of databaseBody.options.map((o) => o.shape.mode.value)) {
    assert.match(shellFunction('db_body'), new RegExp(`jstr mode ${mode}\\b`), `install.sh offers the ${mode} database`);
    assert.match(webComponent('DatabaseStep'), new RegExp(`'${mode}'`), `setup.tsx offers the ${mode} database`);
  }
  for (const k of dbKeys) assert.match(webComponent('DatabaseStep'), new RegExp(`\\b${k}\\b`), `setup.tsx DatabaseStep sends ${k}`);
  for (const k of adminKeys) assert.match(webComponent('AdminStep'), new RegExp(`\\b${k}\\b`), `setup.tsx AdminStep sends ${k}`);
});

test('the same languages and setup states', async () => {
  const { LOCALE_CODES } = await import('../src/lib/locales.js');
  const webLocales = [...read('frontend/src/i18n/locales.ts').matchAll(/code: '(\w+)'/g)].map((m) => m[1]);
  const cliLocales = cli.match(/^LOCALES='([^']*)'$/m)![1].split(' ').map((l) => l.split(':')[0]);
  assert.deepEqual(sorted(cliLocales), sorted(LOCALE_CODES), 'install.sh LOCALES against the server');
  assert.deepEqual(sorted(webLocales), sorted(LOCALE_CODES), 'the web app against the server');
  // Every language has all the console's texts
  const blocks = cli.match(/^t\(\) \{\n([\s\S]*?)^\}/m)![1].split(/^ {2}else$/m);
  const keys = blocks.map((b) => sorted(new Set([...b.matchAll(/^ {6}(\w+)\) echo/gm)].map((m) => m[1]))));
  for (const k of keys) assert.deepEqual(k, keys[0], 'install.sh t() has the same texts in every language');
  assert.equal(blocks.length, cliLocales.length, 'install.sh t() has one block per language');

  const states = [...web.match(/interface SetupState \{([\s\S]*?)\}/)![1].matchAll(/^\s*(\w+): boolean/gm)].map((m) => m[1]);
  assert.deepEqual(sorted(states), ['bundledDatabase', 'needsAdmin', 'needsDatabase']);
  for (const s of states) assert.match(cli, new RegExp(`"${s}":(true|false)`), `install.sh reads ${s}`);
});

// Console texts (t() in install.sh) that are the web's own words, by their key in the frontend's locale files
const SHARED_TEXTS: Record<string, string> = {
  dbTitle: 'setup.dbTitle', dbBundled: 'setup.dbBundled', dbBundledHint: 'setup.dbBundledHint', dbBundledMissing: 'setup.dbBundledMissing',
  dbExternal: 'setup.dbExternal', dbExternalHint: 'setup.dbExternalHint', dbHost: 'setup.dbHost', dbPort: 'setup.dbPort', dbName: 'setup.dbName',
  dbUser: 'setup.dbUser', dbConnecting: 'setup.dbConnecting', details: 'setup.details', adminTitle: 'setup.adminTitle', adminHint: 'setup.adminHint',
  username: 'setup.username', usernameHint: 'setup.usernameHint', passwordMin: 'setup.passwordMin', confirm: 'setup.confirm',
  invalidUsername: 'setup.invalidUsername', invalidEmail: 'setup.invalidEmail', tooShort: 'setup.tooShort', mismatch: 'setup.mismatch',
  badPort: 'setup.badPort', creating: 'setup.creating', password: 'common.password', email: 'common.email',
};

/** install.sh t() as { language: { key: text } }; its blocks follow LOCALES' order reversed (es first, then the else) */
function cliTexts() {
  const [es, en] = cli.match(/^t\(\) \{\n([\s\S]*?)^\}/m)![1].split(/^ {2}else$/m);
  const parse = (b: string) => Object.fromEntries([...b.matchAll(/^ {6}(\w+)\) echo "(.*)" ;;$/gm)].map((m) => [m[1], m[2].replace(/\\"/g, '"')]));
  return { es: parse(es), en: parse(en) } as Record<string, Record<string, string>>;
}
const webText = (lang: string, key: string) => key.split('.').reduce((o: any, k) => o?.[k], JSON.parse(read(`frontend/src/i18n/locales/${lang}.json`)));

test('the console says what the web says, in every language, and translates every database error', async () => {
  const texts = cliTexts();
  for (const lang of ['en', 'es']) {
    for (const [cliKey, webKey] of Object.entries(SHARED_TEXTS)) {
      assert.equal(texts[lang][cliKey], webText(lang, webKey), `${lang}: install.sh t ${cliKey} against ${webKey}`);
    }
    assert.equal(texts[lang].required.replace('$2', '{{field}}'), webText(lang, 'setup.required'), `${lang}: required`);
  }
  const { DB_ERROR_CODES } = await import('../src/installer.js');
  for (const code of DB_ERROR_CODES) {
    for (const lang of ['en', 'es']) {
      assert.ok(texts[lang][code], `install.sh translates ${code} in ${lang}`);
      assert.equal(texts[lang][code], webText(lang, `setup.errors.${code}`), `${lang}: ${code}`);
    }
  }
});

// Every field of the setup API can also come with the command (unattended installs), by these options
const CLI_OPTIONS: Record<string, string> = {
  mode: '--db', host: '--db-host', port: '--db-port', database: '--db-name', user: '--db-user', password: '--db-password',
  username: '--admin', email: '--email', locale: '--lang',
};

test('the console takes every field as an option too', async () => {
  const { databaseBody } = await import('../src/installer.js');
  const { adminBody } = await import('../src/modules/setup/routes.js');
  const usage = shellFunction('usage');
  const fields = [...databaseBody.options.flatMap((o) => Object.keys(o.shape)), ...Object.keys(adminBody.shape)];
  for (const f of new Set(fields)) {
    const opt = f === 'password' ? ['--db-password', '--password'] : [CLI_OPTIONS[f]];
    for (const o of opt) {
      assert.ok(o, `install.sh has an option for ${f} (CLI_OPTIONS)`);
      assert.match(usage, new RegExp(`${o}\\b`), `install.sh --help lists ${o}`);
      assert.match(cli, new RegExp(`^ {4}${o}\\)`, 'm'), `install.sh reads ${o}`);
    }
  }
});
