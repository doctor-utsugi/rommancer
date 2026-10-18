import { useEffect, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { CircleAlert, CircleCheck, Loader2 } from 'lucide-react'
import { get } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { UpdateProgress } from '@/components/update-progress'

interface Version {
  version: string
  updating: { step: string; from: string; to: string; at?: string | null } | null
}

// The update this browser saw start: kept through the restart and a reload of the page
const KEY = 'rommancer-updating'
const seen = (): { from: string; to: string } | null => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? 'null')
  } catch {
    return null
  }
}
const remember = (v: { from: string; to: string } | null) => {
  try {
    if (v) sessionStorage.setItem(KEY, JSON.stringify(v))
    else sessionStorage.removeItem(KEY)
  } catch {
    // Without storage the screen still shows while the server says an update runs
  }
}

/**
 * While Rommancer updates, the whole web app is this one screen: nothing can be changed half way through, and what was
 * done after the backup would be lost if the update went back. It ends with the result and a button to carry on.
 */
export function UpdateGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const [started, setStarted] = useState(seen)
  const q = useQuery({
    queryKey: ['version'],
    queryFn: () => get<Version>('/version'),
    retry: false,
    refetchInterval: (query) => (query.state.data?.updating || seen() ? 3000 : 30_000),
  })
  const updating = q.data?.updating ?? null
  if (updating && started?.to !== updating.to) setStarted({ from: updating.from, to: updating.to })
  useEffect(() => remember(started), [started])
  const log = useQuery({
    queryKey: ['update-log'],
    queryFn: () => get<string>('/admin/update/log'),
    enabled: user?.role === 'ADMIN' && !!started,
    refetchInterval: 3000,
    retry: false,
  })

  if (!started && !updating) return children
  const restarting = !!started && !!q.error
  const finished = !!started && !updating && !q.error && !!q.data
  const ok = finished && q.data!.version === started!.to
  const carryOn = () => {
    remember(null)
    location.reload()
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-lg space-y-6 rounded-2xl border bg-card p-8 shadow-sm">
        <div className="flex items-center gap-2 text-lg font-semibold">
          <img src="/logo.png" alt="" className="size-7" />
          {t('app.name')}
        </div>
        {!finished ? (
          <>
            <div className="flex items-start gap-3">
              <Loader2 className="mt-1 size-5 shrink-0 animate-spin" />
              <div className="space-y-2">
                <h1 className="text-xl font-semibold">{t('update.gate.title', { to: (updating ?? started)!.to })}</h1>
                <p className="text-sm text-muted-foreground">{restarting ? t('update.restarting') : t(`update.steps.${updating?.step ?? 'queued'}`, { defaultValue: updating?.step })}</p>
                <p className="text-sm text-muted-foreground">{t('update.gate.wait')}</p>
              </div>
            </div>
            <UpdateProgress step={restarting ? 'start' : (updating?.step ?? 'queued')} at={updating?.at ?? null} />
          </>
        ) : (
          <div className="flex items-start gap-3">
            {ok ? <CircleCheck className="mt-1 size-5 shrink-0 text-primary" /> : <CircleAlert className="mt-1 size-5 shrink-0 text-destructive" />}
            <div className="space-y-2">
              <h1 className="text-xl font-semibold">{ok ? t('update.gate.done', { version: q.data!.version }) : t('update.gate.back', { to: started!.to, version: q.data!.version })}</h1>
              <p className="text-sm text-muted-foreground">{ok ? t('update.gate.doneHelp') : t('update.gate.backHelp', { version: q.data!.version })}</p>
              <Button onClick={carryOn}>{t('update.gate.continue')}</Button>
            </div>
          </div>
        )}
        {log.data && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">{t('update.log')}</summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-3 font-mono text-xs break-all whitespace-pre-wrap">{log.data}</pre>
          </details>
        )}
      </div>
    </div>
  )
}
