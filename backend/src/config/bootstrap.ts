/**
 * What the server needs before it has a database: where its data lives, its own secrets and how to reach the
 * database. The secrets are generated on the first start into DATA_DIR/secrets; the database is the one the
 * installer chose (DATA_DIR/config/database.json): the deployment's own MySQL, whose password its container generated
 * into the same secrets folder, or the user's. An environment variable of the same name always wins, so development,
 * tests and installations from before the installer keep working as they were.
 * Applied on import, before anything reads the environment.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
const secretsDir = path.join(dataDir, 'secrets');
const databaseFile = path.join(dataDir, 'config', 'database.json');

/** The deployment's own MySQL ("mysql:3306"), when it ships one; set by compose, Quadlet and rommancer.sh */
export const bundledDatabase = process.env.ROMMANCER_BUNDLED_DB ?? '';

export interface DatabaseConfig {
  mode: 'bundled' | 'external';
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
}

const readText = (file: string) => {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
};

/** A secret kept in DATA_DIR/secrets, created the first time it is asked for */
function secret(name: string, make: () => string): string {
  const file = path.join(secretsDir, name);
  const kept = readText(file);
  if (kept) return kept;
  fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file, make() + '\n', { mode: 0o600, flag: 'wx' });
  } catch (e) {
    // Another process made it first: theirs is the one
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  return readText(file);
}

/** The bundled MySQL's password for the app's user, as its container generated it */
export const bundledPassword = () => readText(path.join(secretsDir, 'mysql-password'));

export function readDatabaseConfig(): DatabaseConfig | null {
  const text = readText(databaseFile);
  return text ? (JSON.parse(text) as DatabaseConfig) : null;
}

export function writeDatabaseConfig(c: DatabaseConfig) {
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(databaseFile, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
}

/** The database's URL for a configuration (null: not usable yet, e.g. the bundled MySQL has not made its password) */
export function databaseUrl(c: DatabaseConfig | null): string | null {
  if (!c) return null;
  const e = encodeURIComponent;
  if (c.mode === 'bundled') {
    const password = bundledPassword();
    return bundledDatabase && password ? `mysql://rommancer:${e(password)}@${bundledDatabase}/rommancer` : null;
  }
  if (!c.host || !c.database || !c.user) return null;
  return `mysql://${e(c.user)}:${e(c.password ?? '')}@${c.host}:${c.port ?? 3306}/${e(c.database)}`;
}

/** Fills the environment with the secrets and the database URL; true when a database is configured */
export function applyBootstrap(): boolean {
  process.env.JWT_SECRET ||= secret('jwt-secret', () => crypto.randomBytes(48).toString('base64url'));
  process.env.ENCRYPTION_KEY ||= secret('encryption-key', () => crypto.randomBytes(32).toString('hex'));
  process.env.DATABASE_URL ||= databaseUrl(readDatabaseConfig()) ?? '';
  return !!process.env.DATABASE_URL;
}

applyBootstrap();
