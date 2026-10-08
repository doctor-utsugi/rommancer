import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Check, Download, RefreshCw, Send, Terminal, X } from 'lucide-react'
import { toast } from 'sonner'
import { get, post, type Paged } from '@/lib/api'
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
import { Empty, NativeSelect, PageHeader, errMsg, formatDate } from '@/components/common'

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
}

// One console seen from the panel: what it has, what it keeps, what the server asked of it
export function DevicePage() {
  const { id } = useParams()
  const { t } = useTranslation()
  const { can, user } = useAuth()
  const qc = useQueryClient()
  const device = useQuery({ queryKey: ['device', id], queryFn: () => get<any>(`/devices/${id}`) })
  const inventory = useQuery({ queryKey: ['device-inventory', id], queryFn: () => get<{ allowPull: boolean; inventoryAt: string | null; items: InventoryItem[] }>(`/devices/${id}/inventory`), refetchInterval: 15_000 })
  const lists = useQuery({ queryKey: ['device-lists', id], queryFn: () => get<{ id: number; name: string; have: number; total: number }[]>(`/devices/${id}/lists-progress`) })
  const pulls = useQuery({ queryKey: ['device-pulls', id], queryFn: () => get<any[]>(`/devices/${id}/pulls`), refetchInterval: 10_000 })
  const [q, setQ] = useState('')
  const [system, setSystem] = useState('')
  const [onlyMissing, setOnlyMissing] = useState(false)
  const [sending, setSending] = useState(false)

  const items = inventory.data?.items ?? []
  const systems = useMemo(() => [...new Map(items.filter((i) => i.system).map((i) => [i.system!, i.systemName ?? i.system!])).entries()], [items])
  const shown = items.filter(
    (i) => (!system || i.system === system) && (!onlyMissing || !i.onServer) && (!q || `${i.name} ${i.gameTitle ?? ''}`.toLowerCase().includes(q.toLowerCase())),
  )
  const missing = items.filter((i) => !i.onServer).length
  const allowPull = !!inventory.data?.allowPull && can('roms.upload')

  const act = async (fn: () => Promise<any>, ok?: (r: any) => string) => {
    try {
      const r = await fn()
      if (ok) toast.success(ok(r))
      void qc.invalidateQueries({ queryKey: ['device-inventory', id] })
      void qc.invalidateQueries({ queryKey: ['device-pulls', id] })
      void qc.invalidateQueries({ queryKey: ['device-lists', id] })
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
        {allowPull && missing > 0 && (
          <Button size="sm" onClick={() => void pull({})}>
            <Download className="size-4" />
            {t('more.device.pullAll', { count: missing })}
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
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={onlyMissing} onCheckedChange={(c) => setOnlyMissing(!!c)} />
              {t('more.device.onlyMissing')}
            </label>
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
                    <TableCell className="truncate">{i.systemName ?? '-'}</TableCell>
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
