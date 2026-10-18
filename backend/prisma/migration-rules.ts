/**
 * What a migration may do, so that no update breaks anything. A migration only adds: new tables, new columns that are
 * nullable or have a default, wider types, new indexes. Then the previous version still runs on the migrated
 * database, which is what lets rommancer.sh update go back to it.
 *
 * A step that takes something away (a DROP, a RENAME, a narrower type) is done in two releases: one stops using it, a
 * later one removes it. The removing migration says so with a line "-- rommancer: contract <why it is safe now>", and
 * a MODIFY that only widens says "-- rommancer: widens <what>".
 *
 * Migrations are applied in the order of their folder names, compared as text. The ones before this rule have
 * names like "9_x" and "10_x" that compare oddly but are applied everywhere already; every new one is "m041_name",
 * "m042_name"... which sort after them and among themselves.
 */
import fs from 'node:fs';
import path from 'node:path';

export const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');

/** The migrations from before this rule, as released in Rommancer 1.97: left as they are */
export const LEGACY = new Set(
  '0_init 1_fase2 2_datsource_priority 3_game_franchise 4_hack_identification 5_rom_description 6_device_link 7_device_log 8_device_lists 9_device_inventory 9_device_probe 9_device_prune 9_sync_speed 9_sync_state 10_device_ssh 10_session 11_device_cards 11_game_open 12_device_excluded_systems 12_drop_game_open 13_device_system_filter 14_storage_safety 15_device_space 16_device_config 17_favorites_ra_progress 18_list_kind 19_shared_saves 20_memory_cards 21_client_updated_at 22_device_system_cores 23_device_rom_cores 24_device_launcher 25_unknown_files 26_default_locale_en 26_unknown_file_folder 27_list_collections 36_device_picks 37_journeys 38_journey_provenance 39_game_base 40_optional_email'.split(' '),
);

export const NAME = /^m(\d{3})_[a-z0-9_]+$/;

export function migrationNames() {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

/** The number the next migration takes */
export function nextNumber(names = migrationNames()) {
  const used = names.map((n) => NAME.exec(n)?.[1]).filter(Boolean).map(Number);
  return Math.max(40, ...used) + 1;
}

/** What in a migration's SQL would break the previous version: one line per problem, empty when it only adds */
export function breakingChanges(sql: string): string[] {
  const marked = (kind: string) => new RegExp(`^\\s*--\\s*rommancer:\\s*${kind}\\s+\\S`, 'mi').test(sql);
  const contract = marked('contract');
  const widens = marked('widens');
  // Statements without comments, on one line each
  const statements = sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const problems: string[] = [];
  for (const s of statements) {
    const short = s.length > 120 ? `${s.slice(0, 117)}...` : s;
    if (!contract) {
      if (/\bDROP\s+(TABLE|COLUMN)\b/i.test(s) || /^ALTER\s+TABLE\s+\S+\s+DROP\s+(?!INDEX|KEY|FOREIGN|PRIMARY)\S/i.test(s)) problems.push(`removes something: ${short}`);
      if (/\bRENAME\b/i.test(s)) problems.push(`renames something: ${short}`);
      if (/\bCHANGE\s+(COLUMN\s+)?\S+\s+\S+/i.test(s)) problems.push(`renames or retypes a column: ${short}`);
    }
    if (!widens && !contract && /\bMODIFY\b/i.test(s)) problems.push(`changes a column's type: ${short} (say "-- rommancer: widens <what>" if it only widens)`);
    // A new required column: the previous version inserts rows without it
    for (const m of s.matchAll(/\bADD\s+(?:COLUMN\s+)?(`?\w+`?\s+[^,]*?)(?=,\s*ADD\b|$)/gi)) {
      const col = m[1];
      if (/\bNOT\s+NULL\b/i.test(col) && !/\bDEFAULT\b/i.test(col) && !/\bAUTO_INCREMENT\b/i.test(col)) problems.push(`adds a required column with no default: ${col.trim()}`);
    }
  }
  return problems;
}
