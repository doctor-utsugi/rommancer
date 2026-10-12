import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ChevronDown, ChevronUp, Cog, Download, Loader2, Pause, RefreshCw, Settings2, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { del, get, post, put } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { errMsg, formatBytes } from '@/components/common'

interface Transfer {
  deviceId: number
  name: string
  active: boolean
  total: number
  done: number
  failed?: number
  open?: number
  paused?: number
  bytesTotal: number
  bytesDone: number
  current: { name: string; received: number; size: number } | null
  online: boolean
}

type Item =
  | ({ kind: 'copy'; key: string } & Transfer)
  | ({ kind: 'download'; key: string } & Transfer)
  | { kind: 'config'; key: string; opId: number; deviceId: number; name: string; op: string; status: string; online: boolean }
  | { kind: 'sync'; key: string; deviceId: number; name: string; online: boolean }
  | { kind: 'prune'; key: string; deviceId: number; name: string; held: number }
  | { kind: 'job'; key: string; id: number; type: string; status: string; processed: number; total: number; message: string | null }

const isPaused = (c: Transfer) => !!c.paused && c.paused === (c.open ?? 0) - (c.current ? 1 : 0)

/** What the user would miss: finished things worth a notice */
const told = (i: Item) => i.kind === 'copy' || i.kind === 'download' || i.kind === 'job'

const PANEL_KEY = 'activityCollapsed'

/**
 * Everything under way, on every page: copies from consoles, roms going to them, configuration changes and syncs
 * waiting for a console, deletions held for confirmation and the server's own work. It asks before the tab closes
 * while a copy runs, and says when something finishes wherever the user is.
 */
export function ActivityDock() {
  const { t } = useTranslation()
  const { user } = useAuth()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(PANEL_KEY) === '1'
    } catch {
      return false
    }
  })
  const toggle = () => {
    setCollapsed((v) => {
      try {
        localStorage.setItem(PANEL_KEY, v ? '0' : '1')
      } catch {
        /* per-viewer convenience only */
      }
      return !v
    })
  }
  const { data } = useQuery({
    queryKey: ['activity'],
    queryFn: () => get<Item[]>('/devices/activity'),
    refetchInterval: (q) => (q.state.data?.length ? 3_000 : 20_000),
  })
  const items = (data ?? []).filter((i) => i.kind !== 'copy' || i.active)
  const copying = items.some((i) => i.kind === 'copy' && !isPaused(i))

  // Closing the tab does not stop a copy, but the user asked to be warned while one runs
  useEffect(() => {
    if (!copying) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [copying])

  // Something that leaves the list has finished: say so wherever the user is
  const seen = useRef(new Map<string, Item>())
  useEffect(() => {
    if (!data) return
    const now = new Map(items.filter(told).map((i) => [i.key, i]))
    for (const [key, i] of seen.current) {
      if (now.has(key)) continue
      if (i.kind === 'job') toast.success(t('more.activity.jobFinished', { name: t(`jobs.types.${i.type}`, { defaultValue: i.type }) }))
      else if (i.kind === 'download') toast.success(t('more.activity.downloadFinished', { name: i.name }))
      else if (i.kind === 'copy') toast.success(t('more.activity.finished', { name: i.name }))
    }
    seen.current = now
  }, [data])

  // A console's own page has the full view of its copy
  const here = location.pathname.match(/^\/devices\/(\d+)/)?.[1]
  const shown = items.filter((i) => !(i.kind === 'copy' && String(i.deviceId) === here))
  if (!shown.length) return null
  const attention = shown.filter((i) => i.kind === 'prune').length
  const running = shown.length - attention
  return (
    <div className="fixed right-4 bottom-4 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-xl border bg-popover text-popover-foreground shadow-lg">
      <button type="button" className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-sm font-medium" onClick={toggle}>
        <span className="flex min-w-0 items-center gap-2">
          {running > 0 ? <Loader2 className="size-4 shrink-0 animate-spin" /> : <AlertTriangle className="size-4 shrink-0 text-amber-600" />}
          <span className="truncate">
            {running > 0 && t('more.activity.running', { count: running })}
            {running > 0 && attention > 0 && ' · '}
            {attention > 0 && <span className="text-amber-600">{t('more.activity.attention', { count: attention })}</span>}
          </span>
        </span>
        {collapsed ? <ChevronUp className="size-4 shrink-0" /> : <ChevronDown className="size-4 shrink-0" />}
      </button>
      {!collapsed && (
        <div className="max-h-96 space-y-3 overflow-y-auto border-t px-4 py-3">
          {shown.map((i) => (
            <Row key={i.key} item={i} admin={user?.role === 'ADMIN'} />
          ))}
        </div>
      )}
    </div>
  )
}

/** How to stop an entry from here, when it can be: what is asked, and whether to confirm first */
function stopOf(i: Item): { run(): Promise<unknown>; confirm?: string } | null {
  if (i.kind === 'sync') return { run: () => del(`/devices/${i.deviceId}/sync-request`) }
  if (i.kind === 'config' && i.status === 'pending') return { run: () => del(`/devices/${i.deviceId}/config/ops/${i.opId}`) }
  if (i.kind === 'copy' && (i.open ?? 0) > 0) return { run: () => del(`/devices/${i.deviceId}/pulls`), confirm: 'more.activity.stopCopy' }
  if (i.kind === 'job') return { run: () => post(`/jobs/${i.id}/cancel`), confirm: 'more.activity.stopJob' }
  return null
}

function Row({ item: i, admin }: { item: Item; admin: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const offline = 'online' in i && !i.online
  const stopper = stopOf(i)
  const stop = stopper
    ? async () => {
        if (stopper.confirm && !confirm(t(stopper.confirm))) return
        try {
          await stopper.run()
          toast.success(t('more.activity.stopped'))
        } catch (e) {
          toast.error(errMsg(e))
        }
        void qc.invalidateQueries({ queryKey: ['activity'] })
      }
    : undefined
  if (i.kind === 'copy' || i.kind === 'download') {
    const files = i.done + (i.failed ?? 0)
    const share = i.bytesTotal ? (i.bytesDone / i.bytesTotal) * 100 : i.total ? (files / i.total) * 100 : 0
    const state =
      i.kind === 'copy' && isPaused(i)
        ? t('more.activity.paused')
        : i.current
          ? i.current.name
          : offline
            ? t('more.activity.offline')
            : t('more.activity.waiting')
    return (
      <Entry
        icon={i.kind === 'copy' ? Upload : Download}
        title={t(i.kind === 'copy' ? 'more.activity.copyTitle' : 'more.activity.downloadTitle', { name: i.name })}
        to={`/devices/${i.deviceId}`}
        onStop={stop}
      >
        <Progress value={share} />
        <p className="flex items-center gap-1 truncate text-xs text-muted-foreground" title={state}>
          {i.kind === 'copy' && isPaused(i) && <Pause className="size-3 shrink-0" />}
          {t('more.hero.progressFiles', { done: files, total: i.total })}
          {i.bytesTotal > 0 && ` · ${formatBytes(i.bytesDone)} / ${formatBytes(i.bytesTotal)}`} · {state}
        </p>
      </Entry>
    )
  }
  if (i.kind === 'config')
    return (
      <Entry icon={Settings2} title={t(`more.activity.config.${i.op}`, { name: i.name, defaultValue: i.op })} to={`/devices/${i.deviceId}`} onStop={stop}>
        <Note>{offline ? t('more.activity.offline') : t(`more.activity.configStatus.${i.status}`, { defaultValue: i.status })}</Note>
      </Entry>
    )
  if (i.kind === 'sync')
    return (
      <Entry icon={RefreshCw} title={t('more.activity.syncTitle', { name: i.name })} to={`/devices/${i.deviceId}`} onStop={stop}>
        <Note>{offline ? t('more.activity.offline') : t('more.activity.waiting')}</Note>
      </Entry>
    )
  if (i.kind === 'prune') {
    const answer = async (go: boolean) => {
      if (go && !confirm(t('more.prune.heldConfirm', { count: i.held }))) return
      try {
        if (go) await post(`/devices/${i.deviceId}/prune/confirm`)
        else await put(`/devices/${i.deviceId}/prune`, { on: false })
      } catch (e) {
        toast.error(errMsg(e))
      }
      void qc.invalidateQueries({ queryKey: ['activity'] })
      void qc.invalidateQueries({ queryKey: ['device-prune', String(i.deviceId)] })
    }
    return (
      <Entry icon={AlertTriangle} title={t('more.activity.pruneTitle', { name: i.name })} to={`/devices/${i.deviceId}?tab=lists#prune`} warn>
        <Note>{t('more.activity.pruneHeld', { count: i.held })}</Note>
        <div className="flex gap-2">
          <Button size="sm" variant="destructive" className="h-7" onClick={() => void answer(true)}>
            {t('more.activity.pruneGo')}
          </Button>
          <Button size="sm" variant="outline" className="h-7" onClick={() => void answer(false)}>
            {t('more.activity.pruneKeep')}
          </Button>
        </div>
      </Entry>
    )
  }
  return (
    <Entry icon={Cog} title={t(`jobs.types.${i.type}`, { defaultValue: i.type })} to={admin ? '/admin/jobs' : undefined} onStop={stop}>
      {i.status === 'RUNNING' && i.total > 0 && <Progress value={(i.processed / i.total) * 100} />}
      <Note>
        {i.status === 'PENDING' ? t('more.activity.queued') : i.total > 0 ? `${i.processed} / ${i.total}` : t('more.activity.working')}
        {i.message && ` · ${i.message}`}
      </Note>
    </Entry>
  )
}

function Entry({ icon: Icon, title, to, warn, onStop, children }: { icon: typeof Cog; title: string; to?: string; warn?: boolean; onStop?: () => void; children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className={`flex min-w-0 items-center gap-1.5 text-sm font-medium ${warn ? 'text-amber-600' : ''}`}>
          <Icon className="size-3.5 shrink-0" />
          <span className="truncate">{title}</span>
        </p>
        <div className="flex shrink-0 items-center">
          {to && (
            <Button size="sm" variant="ghost" className="h-7 px-2" nativeButton={false} render={<Link to={to} />}>
              {t('more.activity.open')}
            </Button>
          )}
          {onStop && (
            <Button size="icon-sm" variant="ghost" title={t('more.activity.stop')} aria-label={t('more.activity.stop')} onClick={onStop}>
              <X />
            </Button>
          )}
        </div>
      </div>
      {children}
    </div>
  )
}

const Note = ({ children }: { children: React.ReactNode }) => <p className="truncate text-xs text-muted-foreground">{children}</p>
