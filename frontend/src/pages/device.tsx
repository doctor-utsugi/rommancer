import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Check, Download, Pause, Play, RefreshCw, Send, Terminal, X } from 'lucide-react'
import { toast } from 'sonner'
import { del, get, post, type Paged } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Empty, NativeSelect, PageHeader, errMsg, formatBytes, formatDate } from '@/components/common'

interface InventoryItem {
  id: number
  path: string
  name: string
  system: string | null
  systemName: string | null
  gameId: number | null
  gameTitle: string | null
  onServer: boolean
  pullPending: boolean
  size: number
  folder: string | null
}

interface Summary {
  newGames: number
  newFiles: number
  newBytes: number
  waiting: number
  unidentified: number
  collection: { total: number; before: number; after: number }
  consoleSystems: { total: number; before: number; after: number }
}

interface PullProgress {
  active: boolean
  finishedAt: string | null
  total: number
  done: number
  failed: number
  open: number
  paused: number
  bytesTotal: number
  bytesDone: number
  current: { path: string; name: string; received: number; size: number; startedAt: number } | null
  online: boolean
  lastSeenAt: string | null
  viaSsh: boolean
  failures: { name: string; result: string | null }[]
}

// One console seen from the panel: what it has, what it keeps, what the server asked of it
export function DevicePage() {
  const { id } = useParams()
  const { t } = useTranslation()
  const { can, user } = useAuth()
  const qc = useQueryClient()
  const device = useQuery({ queryKey: ['device', id], queryFn: () => get<any>(`/devices/${id}`) })
  const inventory = useQuery({
    queryKey: ['device-inventory', id],
    queryFn: () => get<{ allowPull: boolean; inventoryAt: string | null; summary: Summary; items: InventoryItem[] }>(`/devices/${id}/inventory`),
    refetchInterval: 15_000,
  })
  const progress = useQuery({
    queryKey: ['device-pull-progress', id],
    queryFn: () => get<PullProgress>(`/devices/${id}/pull-progress`),
    refetchInterval: (q) => (q.state.data?.active ? 2_000 : 15_000),
  })
  const lists = useQuery({ queryKey: ['device-lists', id], queryFn: () => get<{ id: number; name: string; have: number; total: number }[]>(`/devices/${id}/lists-progress`) })
  const pulls = useQuery({ queryKey: ['device-pulls', id], queryFn: () => get<any[]>(`/devices/${id}/pulls`), refetchInterval: 10_000 })
  const [q, setQ] = useState('')
  const [system, setSystem] = useState('')
  const [show, setShow] = useState<'all' | 'new' | 'unidentified' | 'onServer'>('all')
  const [sending, setSending] = useState(false)

  const items = inventory.data?.items ?? []
  const systems = useMemo(() => [...new Map(items.filter((i) => i.system).map((i) => [i.system!, i.systemName ?? i.system!])).entries()], [items])
  const shown = items.filter(
    (i) =>
      (!system || i.system === system) &&
      (show === 'all' || (show === 'new' && i.gameId && !i.onServer) || (show === 'unidentified' && !i.gameId && !i.onServer) || (show === 'onServer' && i.onServer)) &&
      (!q || `${i.name} ${i.gameTitle ?? ''}`.toLowerCase().includes(q.toLowerCase())),
  )
  const allowPull = !!inventory.data?.allowPull && can('roms.upload')

  const act = async (fn: () => Promise<any>, ok?: (r: any) => string) => {
    try {
      const r = await fn()
      if (ok) toast.success(ok(r))
      void qc.invalidateQueries({ queryKey: ['device-inventory', id] })
      void qc.invalidateQueries({ queryKey: ['device-pulls', id] })
      void qc.invalidateQueries({ queryKey: ['device-lists', id] })
      void qc.invalidateQueries({ queryKey: ['device-pull-progress', id] })
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  const pull = (body: object) => act(() => post(`/devices/${id}/pull`, body), (r) => t('more.device.queued', { count: r.queued }))

  if (!device.data) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
  const d = device.data
  return (
    <div className="space-y-6">
      <PageHeader title={d.name}>
        <Button size="sm" variant="outline" onClick={() => void act(() => post(`/devices/${id}/refresh`, {}), () => t('more.device.refreshAsked'))}>
          <RefreshCw className="size-4" />
          {t('more.device.refresh')}
        </Button>
        {can('roms.download') && (
          <Button size="sm" variant="outline" onClick={() => setSending(true)}>
            <Send className="size-4" />
            {t('more.device.send')}
          </Button>
        )}
        {user?.role === 'ADMIN' && d.sshHost && d.clientPath && (
          <Button size="sm" variant="outline" onClick={() => void act(() => post(`/devices/${id}/ssh-sync`, {}), () => t('more.device.sshAsked'))}>
            <Terminal className="size-4" />
            {t('more.device.sshSync')}
          </Button>
        )}
      </PageHeader>
      <p className="text-sm text-muted-foreground">
        {d.console?.name} · {d.firmware?.name} · {t('more.device.games', { count: items.length })} · {t('more.devices.lastSeen')}: {formatDate(d.lastSeenAt)}
        {d.clientVersion && ` · ${t('more.device.client')} ${d.clientVersion}`}
        {inventory.data?.inventoryAt && ` · ${t('more.device.inventoryAt')}: ${formatDate(inventory.data.inventoryAt)}`}
      </p>
      {d.sshHost && (
        <p className="text-sm text-muted-foreground">
          {t('more.device.ssh', { address: `${d.sshUser ?? 'root'}@${d.sshHost}:${d.sshPort ?? 22}` })} · {t('more.device.sshAt')}: {formatDate(d.sshAt)}
          {d.sshError && <span className="text-destructive"> · {d.sshError}</span>}
        </p>
      )}
      {!inventory.data?.allowPull && <p className="text-sm text-muted-foreground">{t('more.device.pullDisabled')}</p>}
      {inventory.data?.summary && (
        <CollectionHero
          summary={inventory.data.summary}
          progress={progress.data}
          canPull={allowPull}
          onCopy={() => void pull({ identified: true })}
          onCopyRest={() => void pull({})}
          onCancel={() => {
            if (confirm(t('more.hero.cancelConfirm'))) void act(() => del(`/devices/${id}/pulls`), (r) => t('more.hero.cancelled', { count: r.cancelled }))
          }}
          onPause={() => void act(() => post(`/devices/${id}/pulls/pause`, {}))}
          onResume={() => void act(() => post(`/devices/${id}/pulls/resume`, {}))}
        />
      )}

      <Tabs defaultValue="games">
        <TabsList>
          <TabsTrigger value="games">{t('more.device.tabGames', { count: items.length })}</TabsTrigger>
          <TabsTrigger value="lists">{t('more.device.tabLists', { count: lists.data?.length ?? 0 })}</TabsTrigger>
          <TabsTrigger value="pulls">{t('more.device.tabPulls', { count: pulls.data?.filter((p) => p.status === 'pending').length ?? 0 })}</TabsTrigger>
        </TabsList>

        <TabsContent value="games">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Input className="w-64" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('common.search')} />
            <NativeSelect value={system} onChange={(e) => setSystem(e.target.value)}>
              <option value="">{t('games.anySystem')}</option>
              {systems.map(([slug, name]) => (
                <option key={slug} value={slug}>
                  {name}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect value={show} onChange={(e) => setShow(e.target.value as typeof show)}>
              <option value="all">{t('more.hero.showAll')}</option>
              <option value="new">{t('more.hero.showNew')}</option>
              <option value="unidentified">{t('more.hero.showUnidentified')}</option>
              <option value="onServer">{t('more.hero.showOnServer')}</option>
            </NativeSelect>
            {allowPull && system && (
              <Button size="sm" variant="outline" onClick={() => void pull({ system })}>
                <Download className="size-4" />
                {t('more.device.pullSystem')}
              </Button>
            )}
          </div>
          {!shown.length ? (
            <Empty>{inventory.data?.inventoryAt ? undefined : t('more.device.noInventory')}</Empty>
          ) : (
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead>{t('more.device.file')}</TableHead>
                  <TableHead className="w-40">{t('common.system')}</TableHead>
                  <TableHead className="w-32">{t('more.device.onServer')}</TableHead>
                  <TableHead className="w-32" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.slice(0, 1000).map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>
                      <p className="truncate font-medium" title={i.path}>
                        {i.gameId ? (
                          <Link className="hover:underline" to={`/games/${i.gameId}`}>
                            {i.gameTitle ?? i.name}
                          </Link>
                        ) : (
                          i.name
                        )}
                      </p>
                      <p className="truncate text-xs text-muted-foreground" title={i.path}>
                        {i.name}
                      </p>
                    </TableCell>
                    <TableCell className="truncate">{i.systemName ?? <span className="text-muted-foreground">{i.folder ?? '-'}</span>}</TableCell>
                    <TableCell>{i.onServer ? <Check className="size-4 text-green-600" /> : <X className="size-4 text-muted-foreground" />}</TableCell>
                    <TableCell>
                      {i.pullPending ? (
                        <Badge variant="secondary">{t('more.device.pending')}</Badge>
                      ) : (
                        allowPull &&
                        !i.onServer && (
                          <Button size="sm" variant="outline" onClick={() => void pull({ paths: [i.path] })}>
                            {t('more.device.pull')}
                          </Button>
                        )
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>

        <TabsContent value="lists">
          {!lists.data?.length ? (
            <Empty>{t('more.device.noLists')}</Empty>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {lists.data.map((l) => (
                <Card key={l.id}>
                  <CardHeader>
                    <CardTitle className="text-base">
                      <Link className="hover:underline" to={`/lists/${l.id}`}>
                        {l.name}
                      </Link>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <Progress value={l.total ? (100 * l.have) / l.total : 0} />
                    <p className="text-muted-foreground">{t('more.device.listProgress', { have: l.have, total: l.total, pct: l.total ? Math.round((100 * l.have) / l.total) : 0 })}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="pulls">
          {!pulls.data?.length ? (
            <Empty>{t('more.device.noPulls')}</Empty>
          ) : (
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead>{t('more.device.file')}</TableHead>
                  <TableHead className="w-32">{t('common.status')}</TableHead>
                  <TableHead className="w-64">{t('more.device.result')}</TableHead>
                  <TableHead className="w-44">{t('common.date')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pulls.data.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="truncate" title={p.path}>
                      {p.path.split('/').pop()}
                    </TableCell>
                    <TableCell>
                      <Badge variant={p.status === 'failed' ? 'destructive' : p.status === 'done' ? 'default' : 'secondary'}>{t(`more.device.status.${p.status}`)}</Badge>
                    </TableCell>
                    <TableCell className="truncate text-xs text-muted-foreground" title={p.result ?? ''}>
                      {p.result ?? ''}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDate(p.doneAt ?? p.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>
      </Tabs>
      {sending && <SendDialog deviceId={Number(id)} onClose={() => setSending(false)} onSent={() => void qc.invalidateQueries({ queryKey: ['device-lists', id] })} />}
    </div>
  )
}

/** Pick games of the collection and send them straight to the device */
function SendDialog({ deviceId, onClose, onSent }: { deviceId: number; onClose(): void; onSent(): void }) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<Map<number, string>>(new Map())
  const found = useQuery({
    queryKey: ['send-search', q],
    queryFn: () => get<Paged<{ id: number; title: string; system?: { name: string } }>>(`/games?status=owned&q=${encodeURIComponent(q)}&pageSize=30`),
    enabled: q.trim().length > 1,
  })
  const send = async () => {
    try {
      const r = await post(`/devices/${deviceId}/send`, { gameIds: [...picked.keys()] })
      toast.success(t('more.device.sent', { count: r.added }))
      onSent()
      onClose()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('more.device.send')}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t('more.device.sendHelp')}</p>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('more.device.searchOwned')} autoFocus />
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {found.data?.items.map((g) => (
            <label key={g.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={picked.has(g.id)}
                onCheckedChange={(c) => {
                  const next = new Map(picked)
                  if (c) next.set(g.id, g.title)
                  else next.delete(g.id)
                  setPicked(next)
                }}
              />
              <span className="truncate">{g.title}</span>
              {g.system && <span className="shrink-0 text-xs text-muted-foreground">{g.system.name}</span>}
            </label>
          ))}
        </div>
        {picked.size > 0 && <p className="text-xs text-muted-foreground">{[...picked.values()].join(' · ')}</p>}
        <DialogFooter>
          <Button onClick={() => void send()} disabled={!picked.size}>
            {t('more.device.sendCount', { count: picked.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const pct = (n: number, total: number) => (total ? (n / total) * 100 : 0)
// Small collections move in the hundredths: enough decimals for one game to show
const fmtPct = (v: number) => `${v < 1 ? v.toFixed(3) : v < 10 ? v.toFixed(2) : v.toFixed(1)} %`

/** What the console would add to the collection, and the copy of it while it runs */
function CollectionHero({
  summary,
  progress,
  canPull,
  onCopy,
  onCopyRest,
  onCancel,
  onPause,
  onResume,
}: {
  summary: Summary
  progress?: PullProgress
  canPull: boolean
  onCopy: () => void
  onCopyRest: () => void
  onCancel: () => void
  onPause: () => void
  onResume: () => void
}) {
  const { t } = useTranslation()
  const running = !!progress?.active
  // The last copy's outcome stays until closed (or for half an hour, on the server side)
  const finishedKey = progress?.finishedAt ? `copy-seen-${progress.finishedAt}` : ''
  const [closedKey, setClosedKey] = useState('')
  const stored = (() => {
    try {
      return !!finishedKey && localStorage.getItem(finishedKey) === '1'
    } catch {
      return false
    }
  })()
  const closed = !!finishedKey && (closedKey === finishedKey || stored)
  const finished = !running && !!progress?.total && !closed
  const close = () => {
    try {
      localStorage.setItem(finishedKey, '1')
    } catch {
      /* private mode: closed for this view only */
    }
    setClosedKey(finishedKey)
  }
  if (!summary.newGames && !running && !finished) return null
  const c = summary.collection
  const s = summary.consoleSystems
  const left = summary.newFiles - summary.waiting
  return (
    <Card className="border-l-4 border-l-primary">
      <CardContent className="space-y-4 py-5">
        {summary.newGames > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <p className="text-lg font-semibold">{t('more.hero.title', { count: summary.newGames })}</p>
              <p className="text-sm text-muted-foreground">
                {t('more.hero.collection')}: <span className="font-medium text-foreground">{fmtPct(pct(c.before, c.total))}</span> →{' '}
                <span className="font-semibold text-primary">{fmtPct(pct(c.after, c.total))}</span>
                {s.total > 0 && (
                  <>
                    {' · '}
                    {t('more.hero.consoleSystems')}: {fmtPct(pct(s.before, s.total))} → <span className="font-semibold text-primary">{fmtPct(pct(s.after, s.total))}</span>
                  </>
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('more.hero.files', { count: summary.newFiles })}
                {summary.newBytes > 0 && ` · ${formatBytes(summary.newBytes)}`}
                {summary.unidentified > 0 && ` · ${t('more.hero.unidentified', { count: summary.unidentified })}`}
              </p>
            </div>
            {canPull && (
              <div className="flex flex-col items-end gap-1">
                {left > 0 && (
                  <Button onClick={onCopy}>
                    <Download className="size-4" />
                    {t('more.hero.copyAll')}
                  </Button>
                )}
                {summary.unidentified > 0 && (
                  <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={onCopyRest}>
                    {t('more.hero.copyRest', { count: summary.unidentified })}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {progress && (running || finished) && <CopyProgress p={progress} onCancel={onCancel} onPause={onPause} onResume={onResume} onClose={close} divided={summary.newGames > 0} />}
      </CardContent>
    </Card>
  )
}

function CopyProgress({
  p,
  onCancel,
  onPause,
  onResume,
  onClose,
  divided,
}: {
  p: PullProgress
  onCancel: () => void
  onPause: () => void
  onResume: () => void
  onClose: () => void
  divided: boolean
}) {
  const { t, i18n } = useTranslation()
  // Paused: nothing left on offer to the console (a file under way may still be finishing)
  const paused = p.paused > 0 && p.paused === p.open - (p.current ? 1 : 0)
  const files = p.done + p.failed
  const share = p.bytesTotal ? pct(p.bytesDone, p.bytesTotal) : pct(files, p.total)
  const cur = p.current
  if (!p.active)
    return (
      <div className={`flex items-center justify-between gap-2 text-sm ${divided ? 'border-t pt-4' : ''}`}>
        <span>
          <Check className="mr-1 inline size-4 text-green-600" />
          {t('more.hero.lastCopy', { when: formatAgo(p.finishedAt, i18n.language), done: p.done, total: p.total })}
          {p.failed > 0 && (
            <span className="text-destructive" title={p.failures.map((f) => `${f.name}: ${f.result ?? ''}`).join('\n')}>
              {' · '}
              {t('more.hero.failed', { count: p.failed })}
            </span>
          )}
        </span>
        <Button size="sm" variant="ghost" onClick={onClose} title={t('common.close')}>
          <X className="size-4" />
        </Button>
      </div>
    )
  return (
    <div className={`space-y-2 ${divided ? 'border-t pt-4' : ''}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium">
          {paused ? t('more.hero.paused') : p.active ? t('more.hero.copying') : t('more.hero.copied')} · {t('more.hero.progressFiles', { done: files, total: p.total })}
          {p.bytesTotal > 0 && ` · ${formatBytes(p.bytesDone)} / ${formatBytes(p.bytesTotal)}`}
        </span>
        {p.active && (
          <div className="flex gap-1">
            {paused ? (
              <Button size="sm" onClick={onResume}>
                <Play className="size-4" />
                {t('more.hero.resume')}
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={onPause}>
                <Pause className="size-4" />
                {t('more.hero.pause')}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onCancel}>
              {t('more.hero.cancel')}
            </Button>
          </div>
        )}
      </div>
      <Progress value={share} />
      {cur && (
        <div className="space-y-1">
          <p className="truncate text-xs text-muted-foreground" title={cur.path}>
            {t('more.hero.sending', { name: cur.name })} {cur.size > 0 && `· ${Math.floor(pct(cur.received, cur.size))} %`}
          </p>
          {cur.size > 0 && <Progress value={pct(cur.received, cur.size)} className="h-1" />}
        </div>
      )}
      {cur && paused && <p className="text-xs text-muted-foreground">{t('more.hero.pausing')}</p>}
      {p.active && !cur && !paused && (
        <p className="text-xs text-muted-foreground">
          {p.online ? t('more.hero.waitingConsole') : p.viaSsh ? t('more.hero.offlineSsh', { when: formatDate(p.lastSeenAt) }) : t('more.hero.offline', { when: formatDate(p.lastSeenAt) })}
        </p>
      )}
      {p.failed > 0 && (
        <p className="text-xs text-destructive" title={p.failures.map((f) => `${f.name}: ${f.result ?? ''}`).join('\n')}>
          {t('more.hero.failed', { count: p.failed })}
        </p>
      )}
    </div>
  )
}

/** "hace 12 min" style, for recent events */
function formatAgo(d: string | null, lang: string) {
  if (!d) return ''
  const min = Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 60_000))
  return new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }).format(-min, 'minute')
}
