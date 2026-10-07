import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodType } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`);
export const forbidden = () => new HttpError(403, 'Forbidden');
export const badRequest = (msg: string) => new HttpError(400, msg);

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  return schema.parse(data);
}

export function intParam(req: Request, name = 'id'): number {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n)) throw badRequest(`Invalid ${name}`);
  return n;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Validation error', issues: err.issues });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  const e = err as { code?: string; message?: string; status?: number; type?: string };
  // body-parser errors (malformed JSON, payload too large) carry their own 4xx status
  if (e?.type && e.status && e.status >= 400 && e.status < 500) {
    res.status(e.status).json({ error: e.message ?? 'Bad request' });
    return;
  }
  if (e?.code === 'P2002') {
    res.status(409).json({ error: 'Already exists' });
    return;
  }
  if (e?.code === 'P2025') {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Internal error' });
}

// BigInt -> number en JSON
export function jsonReplacer(_k: string, v: unknown) {
  return typeof v === 'bigint' ? Number(v) : v;
}
