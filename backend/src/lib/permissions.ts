export const PERMISSIONS = [
  // View games, entries, missing files and romhacks
  'collection.view',
  // Own lists, sharing, cloning, sublists, export/import
  'lists',
  // Own saves and device sync
  'saves',
  // List zips, rom and patched-rom downloads, copy to devices
  'roms.download',
  // Uploads whose checksum matches the database
  'roms.upload',
  // Uploads without a match and creation of new games
  'roms.uploadUnverified',
  // Media for the items in their lists, with their own account
  'scrape.lists',
  // Scraping of whole systems or collections
  'scrape.bulk',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const DEFAULT_PERMISSIONS: Permission[] = ['collection.view', 'lists', 'saves', 'scrape.lists'];

export function normalizePermissions(value: unknown): Permission[] {
  if (!Array.isArray(value)) return [...DEFAULT_PERMISSIONS];
  return value.filter((p): p is Permission => (PERMISSIONS as readonly string[]).includes(p));
}

export function hasPermission(user: { role: string; permissions?: string[] }, perm: Permission): boolean {
  return user.role === 'ADMIN' || !!user.permissions?.includes(perm);
}
