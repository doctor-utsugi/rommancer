import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, Download, Pause } from 'lucide-react'
import { toast } from 'sonner'
import { get } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { formatBytes } from '@/components/common'

interface Copy {
  deviceId: number
  name: string
  active: boolean
  total: number
  done: number
  failed: number
  open: number
  paused: number
  bytesTotal: number
  bytesDone: number
  current: { name: string; received: number; size: number } | null
  online: boolean
}

const isPaused = (c: Copy) => c.paused > 0 && c.paused === c.open - (c.current ? 1 : 0)

/**
 * Copies from consoles keep running on the server and the consoles whatever page is open: this panel shows
 * them on every page (except the console's own page, which has the full view) and asks before the tab closes.
 */
export function ActivityDock() {
  const { t } = useTranslation()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(false)
  const { data } = useQuery({
    queryKey: ['activity'],
    queryFn: () => get<Copy[]>('/devices/activity'),
    refetchInterval: (q) => (q.state.data?.length ? 3_000 : 20_000),
  })
  const copies = (data ?? []).filter((c) => c.active)
  const running = copies.some((c) => !isPaused(c))

  // Closing the tab does not stop a copy, but the user asked to be warned while one runs
  useEffect(() => {
    if (!running) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [running])

  // A copy that leaves the list has finished: say so wherever the user is
  const seen = useRef(new Map<number, string>())
  useEffect(() => {
    if (!data) return
    const now = new Map(copies.map((c) => [c.deviceId, c.name]))
    for (const [id, name] of seen.current) if (!now.has(id)) toast.success(t('more.activity.finished', { name }))
    seen.current = now
  }, [data])

  const here = location.pathname.match(/^\/devices\/(\d+)/)?.[1]
  const shown = copies.filter((c) => String(c.deviceId) !== here)
  if (!shown.length) return null
  return (
    <div className="fixed right-4 bottom-4 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-xl border bg-popover text-popover-foreground shadow-lg">
      <button type="button" className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-sm font-medium" onClick={() => setCollapsed((v) => !v)}>
        <span className="flex items-center gap-2">
          <Download className="size-4" />
          {t('more.activity.title', { count: shown.length })}
        </span>
        {collapsed ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
      </button>
      {!collapsed && (
        <div className="max-h-80 space-y-3 overflow-y-auto border-t px-4 py-3">
          {shown.map((c) => {
            const files = c.done + c.failed
            const share = c.bytesTotal ? (c.bytesDone / c.bytesTotal) * 100 : c.total ? (files / c.total) * 100 : 0
            const state = isPaused(c) ? t('more.activity.paused') : !c.online && !c.current ? t('more.activity.offline') : c.current ? c.current.name : t('more.activity.waiting')
            return (
              <div key={c.deviceId} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-medium">{c.name}</p>
                  <Button size="sm" variant="ghost" className="h-7 px-2" nativeButton={false} render={<Link to={`/devices/${c.deviceId}`} />}>
                    {t('more.activity.open')}
                  </Button>
                </div>
                <Progress value={share} />
                <p className="flex items-center gap-1 truncate text-xs text-muted-foreground" title={state}>
                  {isPaused(c) && <Pause className="size-3 shrink-0" />}
                  {t('more.hero.progressFiles', { done: files, total: c.total })}
                  {c.bytesTotal > 0 && ` · ${formatBytes(c.bytesDone)} / ${formatBytes(c.bytesTotal)}`} · {state}
                </p>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
