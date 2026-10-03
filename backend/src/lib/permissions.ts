export const PERMISSIONS = [
  // Ver juegos, fichas, faltantes y romhacks
  'collection.view',
  // Listas propias, compartir, clonar, sublistas, exportar/importar
  'lists',
  // Saves propios y sincronizacion con dispositivos
  'saves',
  // Zip de listas, descargas de roms y parcheadas, copia a dispositivos
  'roms.download',
  // Subidas cuyo checksum coincide con la base de datos
  'roms.upload',
  // Subidas sin coincidencia y creacion de juegos nuevos
  'roms.uploadUnverified',
  // Multimedia de los elementos de sus listas, con su propia cuenta
  'scrape.lists',
  // Scraping de sistemas o colecciones completas
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
