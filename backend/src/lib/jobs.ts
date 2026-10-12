import type { Job, Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

export interface JobContext {
  job: Job;
  params: Record<string, any>;
  progress(processed: number, total?: number, message?: string): Promise<void>;
  log(line: string): void;
}

type Handler = (ctx: JobContext) => Promise<unknown>;

const handlers = new Map<string, Handler>();
// Running jobs the user cancelled: they stop at their next progress report
const cancelled = new Set<number>();
export class JobCancelled extends Error {
  constructor() {
    super('Cancelled by the user');
  }
}
const running = new Set<string>();
let timer: NodeJS.Timeout | null = null;
const MAX_CONCURRENT = 3;

export function registerJob(type: string, handler: Handler) {
  handlers.set(type, handler);
}

export async function enqueue(type: string, params: Record<string, unknown>, userId?: number, runAfter?: Date): Promise<Job> {
  const job = await prisma.job.create({ data: { type, params: params as Prisma.InputJsonValue, userId: userId ?? null, runAfter: runAfter ?? null } });
  setImmediate(tick);
  return job;
}

async function runJob(job: Job) {
  const handler = handlers.get(job.type);
  const lines: string[] = [];
  let lastFlush = 0;
  const flush = async (data: Prisma.JobUpdateInput = {}) => {
    await prisma.job.update({ where: { id: job.id }, data: { ...data, log: lines.slice(-2000).join('\n') } });
  };
  const ctx: JobContext = {
    job,
    params: (job.params ?? {}) as Record<string, any>,
    async progress(processed, total, message) {
      if (cancelled.has(job.id)) throw new JobCancelled();
      const now = Date.now();
      if (now - lastFlush < 500 && processed !== total) return;
      lastFlush = now;
      await flush({ processed, ...(total != null ? { total } : {}), ...(message ? { message: message.slice(0, 512) } : {}) });
    },
    log(line) {
      lines.push(`[${new Date().toISOString()}] ${line}`);
    },
  };
  try {
    if (!handler) throw new Error(`Unknown job type ${job.type}`);
    const result = await handler(ctx);
    await flush({ status: 'DONE', finishedAt: new Date(), result: (result ?? null) as Prisma.InputJsonValue });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.log(`ERROR: ${msg}`);
    console.error(`Job ${job.id} (${job.type}) failed:`, e);
    await flush({ status: 'FAILED', finishedAt: new Date(), message: msg.slice(0, 512) });
  } finally {
    cancelled.delete(job.id);
  }
}

/** A queued job is dropped (failed, "cancelled"); a running one stops at its next progress report */
export async function cancelJob(id: number) {
  const queued = await prisma.job.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'FAILED', message: 'Cancelled by the user', finishedAt: new Date() } });
  if (queued.count) return 'cancelled';
  const job = await prisma.job.findUnique({ where: { id }, select: { status: true } });
  if (job?.status !== 'RUNNING') return 'finished';
  cancelled.add(id);
  return 'stopping';
}

async function tick() {
  if (running.size >= MAX_CONCURRENT) return;
  const pending = await prisma.job.findMany({
    where: { status: 'PENDING', OR: [{ runAfter: null }, { runAfter: { lte: new Date() } }] },
    orderBy: { id: 'asc' },
    take: 10,
  });
  for (const job of pending) {
    if (running.size >= MAX_CONCURRENT) break;
    // Un trabajo de cada tipo a la vez para no saturar disco ni APIs externas
    if (running.has(job.type)) continue;
    const claimed = await prisma.job.updateMany({ where: { id: job.id, status: 'PENDING' }, data: { status: 'RUNNING', startedAt: new Date() } });
    if (!claimed.count) continue;
    running.add(job.type);
    runJob(job).finally(() => {
      running.delete(job.type);
      setImmediate(tick);
    });
  }
}

export async function startJobRunner() {
  await prisma.job.updateMany({ where: { status: 'RUNNING' }, data: { status: 'FAILED', message: 'Interrupted by restart', finishedAt: new Date() } });
  timer = setInterval(() => void tick().catch((e) => console.error(e)), 2000);
}

export function stopJobRunner() {
  if (timer) clearInterval(timer);
}

export async function waitJob(id: number, timeoutMs = 600_000): Promise<Job> {
  const start = Date.now();
  for (;;) {
    const j = await prisma.job.findUniqueOrThrow({ where: { id } });
    if (j.status === 'DONE' || j.status === 'FAILED') return j;
    if (Date.now() - start > timeoutMs) throw new Error('Job timeout');
    await new Promise((r) => setTimeout(r, 300));
  }
}
