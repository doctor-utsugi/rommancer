import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { consoles, emulators, firmwares, systems } from './data.js';
import { PERMISSIONS } from '../lib/permissions.js';

// Idempotente: crea o actualiza datos de referencia. No toca datos de usuario.
export async function seed() {
  for (const [i, s] of systems.entries()) {
    const data = {
      name: s.name,
      manufacturer: s.manufacturer,
      datName: s.datName,
      datAliases: s.aliases ?? [],
      extensions: s.extensions,
      headerType: s.headerType ?? 'none',
      mediaType: s.mediaType ?? 'rom',
      raConsoleId: s.raConsoleId ?? null,
      ssSystemId: s.ssSystemId ?? null,
      sortOrder: i,
    };
    await prisma.system.upsert({ where: { slug: s.slug }, create: { slug: s.slug, ...data }, update: data });
  }
  for (const e of emulators) {
    const data = { name: e.name, core: e.core ?? null, saveFormat: e.saveFormat ?? 'raw', saveExt: e.saveExt, stateExt: e.stateExt ?? null };
    await prisma.emulator.upsert({ where: { slug: e.slug }, create: { slug: e.slug, ...data }, update: data });
  }
  for (const f of firmwares) {
    const { slug, ...data } = f;
    await prisma.firmware.upsert({ where: { slug }, create: f, update: data });
  }
  for (const c of consoles) {
    await prisma.console.upsert({ where: { name: c.name }, create: c, update: c });
  }
  if ((await prisma.user.count()) === 0 && env.admin.password) {
    await prisma.user.create({
      data: {
        username: env.admin.username,
        email: env.admin.email,
        role: 'ADMIN',
        passwordHash: await bcrypt.hash(env.admin.password, 10),
        permissions: [...PERMISSIONS],
        mustChangePassword: true,
      },
    });
    console.log(`Admin user "${env.admin.username}" created (password change required on first login)`);
  }
  // Administradores que siguen con la contrasena inicial de .env o con una debil conocida
  if (env.admin.password) {
    for (const u of await prisma.user.findMany({ where: { role: 'ADMIN', mustChangePassword: false } })) {
      if (await bcrypt.compare(env.admin.password, u.passwordHash)) await prisma.user.update({ where: { id: u.id }, data: { mustChangePassword: true } });
    }
  }
}
