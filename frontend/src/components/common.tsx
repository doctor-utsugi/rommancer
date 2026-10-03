import { useEffect, useState, type ReactNode, type SelectHTMLAttributes } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { get } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'

export function NativeSelect({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  )
}

export function PageHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}

export function Pagination({ page, pageSize, total, onChange }: { page: number; pageSize: number; total: number; onChange(p: number): void }) {
  const { t } = useTranslation()
  const pages = Math.max(1, Math.ceil(total / pageSize))
  if (pages <= 1) return <p className="mt-4 text-sm text-muted-foreground">{t('common.total', { count: total })}</p>
  return (
    <div className="mt-4 flex items-center gap-3 text-sm">
      <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        {t('common.prev')}
      </Button>
      <span className="text-muted-foreground">
        {t('common.page', { page, pages })} · {t('common.total', { count: total })}
      </span>
      <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onChange(page + 1)}>
        {t('common.next')}
      </Button>
    </div>
  )
}

export function Empty({ children }: { children?: ReactNode }) {
  const { t } = useTranslation()
  return <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">{children ?? t('common.none')}</div>
}

export function formatBytes(n: number) {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`
}

export function formatDate(d: string | Date | null | undefined) {
  if (!d) return '-'
  return new Date(d).toLocaleString()
}

export interface Job {
  id: number
  type: string
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED'
  total: number
  processed: number
  message: string | null
  result: any
  log?: string | null
  createdAt: string
  finishedAt: string | null
}

export function JobStatusBadge({ status }: { status: Job['status'] }) {
  const { t } = useTranslation()
  const variant = status === 'DONE' ? 'default' : status === 'FAILED' ? 'destructive' : 'secondary'
  return <Badge variant={variant}>{t(`jobs.${status}`)}</Badge>
}

/** Sigue un trabajo hasta que termina e invalida las consultas indicadas. */
export function useJob(jobId: number | null, invalidate: string[][] = [], onDone?: (j: Job) => void) {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const q = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => get<Job>(`/jobs/${jobId}`),
    enabled: !!jobId,
    refetchInterval: (query) => {
      const s = query.state.data?.status
      return s === 'DONE' || s === 'FAILED' ? false : 700
    },
  })
  const [notified, setNotified] = useState<number | null>(null)
  useEffect(() => {
    const j = q.data
    if (!j || notified === j.id) return
    if (j.status === 'DONE' || j.status === 'FAILED') {
      setNotified(j.id)
      for (const k of invalidate) void qc.invalidateQueries({ queryKey: k })
      if (j.status === 'FAILED') toast.error(`${t(`jobs.types.${j.type}`, { defaultValue: j.type })}: ${j.message ?? ''}`)
      else toast.success(`${t(`jobs.types.${j.type}`, { defaultValue: j.type })}: ${t('jobs.DONE')}`)
      onDone?.(j)
    }
  }, [q.data])
  return q.data ?? null
}

export function JobProgress({ job }: { job: Job | null }) {
  const { t } = useTranslation()
  if (!job) return null
  const pct = job.total ? Math.round((job.processed / job.total) * 100) : job.status === 'DONE' ? 100 : 0
  return (
    <div className="space-y-1 rounded-lg border p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{t(`jobs.types.${job.type}`, { defaultValue: job.type })}</span>
        <JobStatusBadge status={job.status} />
      </div>
      {job.status !== 'DONE' && <Progress value={pct} />}
      {job.message && <p className="truncate text-xs text-muted-foreground">{job.message}</p>}
      {job.status === 'DONE' && job.result && (
        <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(job.result, null, 1)}</pre>
      )}
    </div>
  )
}

export function errMsg(e: unknown) {
  return e instanceof Error ? e.message : String(e)
}

export function Field({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  )
}

export interface System {
  id: number
  slug: string
  name: string
  manufacturer: string
  games: number
  roms: number
  owned: number
  hacks: number
  files: { matched: number; hack: number; unknown: number; unverified: number }
  mediaType: string
}

export function useSystems() {
  return useQuery({ queryKey: ['systems'], queryFn: () => get<System[]>('/systems'), staleTime: 30_000 })
}

export function SystemSelect({ value, onChange, allLabel, onlyWithData = true }: { value: string; onChange(v: string): void; allLabel?: string; onlyWithData?: boolean }) {
  const { data } = useSystems()
  const { t } = useTranslation()
  return (
    <NativeSelect value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{allLabel ?? t('games.anySystem')}</option>
      {data
        ?.filter((s) => !onlyWithData || s.roms > 0)
        .map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
    </NativeSelect>
  )
}
