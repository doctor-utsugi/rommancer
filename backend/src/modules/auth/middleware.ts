import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { HttpError } from '../../lib/http.js';
import { hasPermission, normalizePermissions, type Permission } from '../../lib/permissions.js';

export interface AuthUser {
  id: number;
  username: string;
  role: 'ADMIN' | 'USER';
  permissions: Permission[];
  mustChangePassword: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

interface TokenUser {
  id: number;
  username: string;
  role: 'ADMIN' | 'USER';
  permissions: unknown;
  mustChangePassword: boolean;
}

const ACCESS_TTL = '15m';
// Token para descargas e imagenes por URL (?token=): solo GET y solo rutas de ficheros
const FILES_TTL = '12h';

export function signAccess(user: TokenUser): string {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role, perms: normalizePermissions(user.permissions), pwc: user.mustChangePassword },
    env.jwtSecret,
    { expiresIn: ACCESS_TTL },
  );
}

export function signFiles(user: TokenUser): string {
  return jwt.sign({ sub: user.id, username: user.username, role: user.role, perms: normalizePermissions(user.permissions), scope: 'files' }, env.jwtSecret, {
    expiresIn: FILES_TTL,
  });
}

interface Claims {
  sub: number;
  username: string;
  role: AuthUser['role'];
  perms?: string[];
  pwc?: boolean;
  scope?: string;
}

function toUser(p: Claims): AuthUser {
  return { id: Number(p.sub), username: p.username, role: p.role, permissions: normalizePermissions(p.perms), mustChangePassword: !!p.pwc };
}

// Rutas que aceptan el token de ficheros en la URL
const FILE_ROUTES = [/^\/media\/\d+$/, /^\/lists\/\d+\/(download|export)$/, /^\/saves\/\d+\/versions\/\d+\/download$/, /^\/hacks\/\d+\/download$/, /^\/roms\/\d+\/download$/, /^\/link\/package\/[a-z]+$/, /^\/devices\/\d+\/config\/versions\/\d+\/(zip|file)$/];

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  try {
    if (h?.startsWith('Bearer ')) {
      const p = jwt.verify(h.slice(7), env.jwtSecret) as unknown as Claims;
      if (p.scope) return next(new HttpError(401, 'Unauthorized'));
      req.user = toUser(p);
    } else if (typeof req.query.token === 'string' && req.method === 'GET' && FILE_ROUTES.some((r) => r.test(req.path))) {
      const p = jwt.verify(req.query.token, env.jwtSecret) as unknown as Claims;
      if (p.scope !== 'files') return next(new HttpError(401, 'Unauthorized'));
      req.user = toUser(p);
    } else {
      return next(new HttpError(401, 'Unauthorized'));
    }
  } catch {
    return next(new HttpError(401, 'Unauthorized'));
  }
  // Mientras haya que cambiar la contrasena solo se permite consultar y editar el propio perfil
  if (req.user.mustChangePassword && !(req.path === '/users/me' && (req.method === 'GET' || req.method === 'PATCH'))) {
    return next(new HttpError(403, 'PASSWORD_CHANGE_REQUIRED'));
  }
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== 'ADMIN') return next(new HttpError(403, 'Forbidden'));
  next();
}

export function requirePerm(...perms: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !perms.some((p) => hasPermission(req.user!, p))) return next(new HttpError(403, 'Forbidden'));
    next();
  };
}

export function can(req: Request, perm: Permission) {
  return !!req.user && hasPermission(req.user, perm);
}

export function me(req: Request): AuthUser {
  if (!req.user) throw new HttpError(401, 'Unauthorized');
  return req.user;
}
