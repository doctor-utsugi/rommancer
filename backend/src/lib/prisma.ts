import { PrismaClient } from '@prisma/client';
// The database URL the installer chose, when the environment gives none
import '../config/bootstrap.js';

export const prisma = new PrismaClient();
