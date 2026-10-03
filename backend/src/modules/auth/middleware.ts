import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { HttpError } from '../../lib/http.js';

export interface AuthUser {
  id: number;
  username: string;
  role: 'ADMIN' | 'USER';
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signAccess(user: AuthUser): string {
  return jwt.sign({ sub: user.id, username: user.username, role: user.role }, env.jwtSecret, { expiresIn: '1h' });
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  // ?token= permite descargas directas desde el navegador (zip, media, saves)
  const token = h?.startsWith('Bearer ') ? h.slice(7) : typeof req.query.token === 'string' ? req.query.token : null;
  if (!token) return next(new HttpError(401, 'Unauthorized'));
  try {
    const p = jwt.verify(token, env.jwtSecret) as unknown as { sub: number; username: string; role: AuthUser['role'] };
    req.user = { id: Number(p.sub), username: p.username, role: p.role };
    next();
  } catch {
    next(new HttpError(401, 'Unauthorized'));
  }
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== 'ADMIN') return next(new HttpError(403, 'Forbidden'));
  next();
}

export function me(req: Request): AuthUser {
  if (!req.user) throw new HttpError(401, 'Unauthorized');
  return req.user;
}
