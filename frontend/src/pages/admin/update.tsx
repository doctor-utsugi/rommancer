import { Fragment, useEffect, useRef, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { CircleAlert, CircleCheck, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { get, post, put } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { PageHeader, errMsg, formatDate } from '@/components/common'

interface Entry {
  version: string
  date: string | null
  notes: string
  url?: string
}

export interface UpdateState {
  version: string
  latest: string | null
  available: boolean
  newer: Entry[]
  current: Entry | null
  checkedAt: string | null
  checkError: string | null
  checks: boolean
  updater: 'watcher' | 'command' | 'none'
  requested: boolean
  status: { state: 'running' | 'done' | 'failed' | 'rolledback'; step: string; from: string; to: string; at: string } | null
  repo: string
}

export const fetchUpdate = () => get<UpdateState>('/admin/update')

/** `code` inside a line of the notes */
function inline(text: string): ReactNode {
  return text.split(/(`[^`]+`)/).map((part, i) =>
    part.startsWith('`') && part.endsWith('`') ? (
      <code key={i} className="rounded bg-muted px-1 font-mono text-xs">
        {part.slice(1, -1)}
      </code>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  )
}

/** A changelog entry's Markdown: its "- " items (lines after one that start with spaces carry on), other lines as text */
function Notes({ text }: { text: string }) {
  const blocks: { item: boolean; text: string }[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    if (/^[-*] /.test(line)) blocks.push({ item: true, text: line.slice(2).trim() })
    else if (/^\s/.test(line) && blocks.length) blocks[blocks.length - 1].text += ` ${line.trim()}`
    else blocks.push({ item: false, text: line.trim() })
  }
  return (
    <div className="space-y-1 text-sm">
      {blocks.map((b, i) =>
        b.item ? (
          <p key={i} className="relative pl-4 before:absolute before:left-0 before:content-['•']">
            {inline(b.text)}
          </p>
        ) : (
          <p key={i}>{inline(b.text)}</p>
        ),
      )}
    </div>
  )
}

/**
 * Administration > Update: the version installed, the newer ones with what each changes, and the button that has the
 * host update Rommancer (rommancer.sh update: backup, new version, back to this one by itself if it fails).
 */
export function AdminUpdatePage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  // While an update runs the API restarts: the page keeps asking, and a failed answer then means "restarting"
  const waiting = useRef(false)
  const q = useQuery({
    queryKey: ['update'],
    queryFn: fetchUpdate,
    retry: false,
    refetchInterval: (query) => {
      const d = query.state.data
      waiting.current = (!!query.state.error && waiting.current) || !!d?.requested || d?.status?.state === 'running'
      return waiting.current ? 3000 : false
    },
  })
  const loadedWith = useRef<string | null>(null)
  useEffect(() => {
    if (q.data && !loadedWith.current) loadedWith.current = q.data.version
  }, [q.data])
  const log = useQuery({
    queryKey: ['update-log'],
    queryFn: () => get<string>('/admin/update/log'),
    enabled: !!q.data?.status && q.data.status.state !== 'done',
    refetchInterval: q.data?.status?.state === 'running' ? 3000 : false,
  })
  const d = q.data
  const set = (data: UpdateState) => qc.setQueryData(['update'], data)
  const act = async (f: () => Promise<UpdateState>) => {
    try {
      set(await f())
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  if (!d) return null
  const restarting = !!q.error && waiting.current
  const running = restarting || !!d?.requested || d?.status?.state === 'running'
  // The page was loaded with the old version: the browser needs the new web app once the update is done
  const updatedHere = !!d && !!loadedWith.current && d.version !== loadedWith.current
  const command = 'sh deploy/podman/rommancer.sh update'
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title={t('update.title')}>
        <Button variant="outline" onClick={() => void act(() => post('/admin/update/check'))} disabled={running}>
          {t('update.check')}
        </Button>
      </PageHeader>

      {running && (
        <Card>
          <CardContent className="flex items-start gap-3 text-sm">
            <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />
            <div className="space-y-1">
              <p className="font-medium">{t('update.running', { to: d?.status?.to || d?.latest || '' })}</p>
              <p className="text-muted-foreground">{restarting ? t('update.restarting') : t(`update.steps.${d?.status?.step ?? 'queued'}`, { defaultValue: d?.status?.step })}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {!running && d.status && d.status.state !== 'running' && d.status.to !== d.version && (
        <Card>
          <CardContent className="flex items-start gap-3 text-sm">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="space-y-1">
              <p className="font-medium">{t(`update.result.${d.status.state}`, { to: d.status.to, from: d.status.from })}</p>
              <p className="text-muted-foreground">{t('update.resultHelp')}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {updatedHere && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3 text-sm">
            <CircleCheck className="size-4 text-primary" />
            <span className="flex-1">{t('update.updated', { version: d!.version })}</span>
            <Button size="sm" onClick={() => location.reload()}>
              {t('update.reload')}
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            {d.version === 'dev' ? t('update.dev') : t('update.installed', { version: d.version })}
            {!d.available && d.latest && d.version !== 'dev' && <Badge variant="secondary">{t('update.upToDate')}</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            {d.checkedAt ? t('update.checkedAt', { date: formatDate(d.checkedAt) }) : t('update.neverChecked')}
            {d.checkError && ` ${t('update.checkError', { error: d.checkError })}`}
          </p>
          {d.version === 'dev' && <p className="text-muted-foreground">{t('update.devHelp')}</p>}
          <label className="flex items-center gap-3">
            <Switch checked={d.checks} onCheckedChange={(v) => void act(() => put('/admin/update/settings', { checks: v }))} />
            <span>{t('update.daily')}</span>
          </label>
        </CardContent>
      </Card>

      {d?.available && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('update.available', { version: d.latest })}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <p className="text-muted-foreground">{t('update.safety')}</p>
            {d.updater === 'watcher' ? (
              <Button onClick={() => confirm(t('update.confirm', { from: d.version, to: d.latest })) && void act(() => post<UpdateState>('/admin/update', { to: d.latest }).finally(() => void qc.invalidateQueries({ queryKey: ['version'] })))} disabled={running}>
                {t('update.button', { version: d.latest })}
              </Button>
            ) : (
              <div className="space-y-2">
                <p>{t(d.updater === 'command' ? 'update.noWatcher' : 'update.noUpdater')}</p>
                <code className="block rounded-md bg-muted px-3 py-2 font-mono text-xs break-all">{command}</code>
                {d.updater === 'command' && <p className="text-muted-foreground">{t('update.serviceHint')}</p>}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {d && d.newer.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('update.changes', { count: d.newer.length })}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {d.newer.map((e) => (
              <section key={e.version} className="space-y-1.5">
                <h3 className="text-sm font-semibold">
                  {e.version}
                  {e.date && <span className="ml-2 font-normal text-muted-foreground">{e.date}</span>}
                </h3>
                {e.notes ? <Notes text={e.notes} /> : <p className="text-sm text-muted-foreground">{t('update.noNotes')}</p>}
              </section>
            ))}
          </CardContent>
        </Card>
      )}

      {d?.current && d.current.notes && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('update.thisVersion', { version: d.current.version })}</CardTitle>
          </CardHeader>
          <CardContent>
            <Notes text={d.current.notes} />
          </CardContent>
        </Card>
      )}

      {log.data && (d?.status?.state === 'running' || d?.status?.state === 'failed' || d?.status?.state === 'rolledback') && (
        <details className="rounded-xl border p-4 text-sm" open={d.status.state !== 'running'}>
          <summary className="cursor-pointer font-medium">{t('update.log')}</summary>
          <pre className="mt-3 max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap">{log.data}</pre>
        </details>
      )}
    </div>
  )
}
