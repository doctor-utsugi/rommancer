import { prisma } from '../lib/prisma.js';
import { seed } from './seed.js';

await seed();
await prisma.$disconnect();
console.log('Seed done');
