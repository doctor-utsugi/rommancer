import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Check, ImageOff, Loader2, Star, Trash2, Trophy, X } from 'lucide-react'
import { toast } from 'sonner'
import { authUrl, del, get, post, put } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Empty, Field, JobProgress, NativeSelect, PageHeader, errMsg, useJob, formatBytes } from '@/components/common'
import { VerifiedUpload } from '@/pages/upload'
import { ListFormDialog } from './lists'
import { DeriveWizard } from '@/components/derive-wizard'
import { BulkAddDialog } from '@/components/bulk-add'

type DialogKind = 'edit' | 'bulk' | 'share' | 'derive' | 'zip' | 'device' | null

export function ListPage() {
  const { id } = useParams()
  const { t } = useTranslation()
  const { user, can } = useAuth()
  const nav = useNavigate()
  const qc = useQueryClient()
  const { data: list, refetch } = useQuery({ queryKey: ['list', String(id)], queryFn: () => get(`/lists/${id}`) })
  const [dialog, setDialog] = useState<DialogKind>(null)
  const [jobId, setJobId] = useState<number | null>(null)
  const [q, setQ] = useState('')
  const job = useJob(jobId, [['list', String(id)]])
  const [dragging, setDragging] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [incoming, setIncoming] = useState<File[]>([])
  if (!list) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
  const isOwner = list.ownerId === user?.id
  const isFavorites = list.kind === 'favorites'

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      await refetch()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  const move = (idx: number, dir: -1 | 1) =>
    run(async () => {
      const ids = list.items.map((i: any) => i.id)
      const j = idx + dir
      if (j < 0 || j >= ids.length) return
      ;[ids[idx], ids[j]] = [ids[j], ids[idx]]
      await put(`/lists/${list.id}/order`, { itemIds: ids })
    })
  const clone = () =>
    run(async () => {
      const c = await post(`/lists/${list.id}/clone`, {})
      void qc.invalidateQueries({ queryKey: ['lists'] })
      nav(`/lists/${c.id}`)
    })
  // A big list takes a while to delete: the button says so until it is gone
  const remove = async () => {
    if (!confirm(t('common.confirmDelete'))) return
    setDeleting(true)
    try {
      await del(`/lists/${list.id}`)
      void qc.invalidateQueries({ queryKey: ['lists'] })
      nav('/lists')
    } catch (e) {
      toast.error(errMsg(e))
      setDeleting(false)
    }
  }
  const refreshDerived = () =>
    run(async () => {
      const r = await post(`/lists/${list.id}/refresh`)
      toast.success(`${t('lists.added', { count: r.added })} · ${t('lists.skipped', { count: r.skipped.length })}`)
    })
  const scrape = async () => setJobId((await post('/scrape', { listId: list.id })).id)

  const canDrop = (isOwner || list.isCollaborative) && can('roms.upload')
  const onPageDrop = (e: React.DragEvent) => {
    if (!canDrop || !e.dataTransfer.files.length) return
    e.preventDefault()
    setDragging(false)
    setIncoming([...e.dataTransfer.files])
  }
  return (
    // The whole page takes dropped roms; the box below stays as a hint and a file picker
    <div
      className="relative min-h-[calc(100vh-4rem)]"
      onDragOver={(e) => {
        if (!canDrop || !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
      }}
      onDrop={onPageDrop}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/80 text-lg font-medium">
          {t('more.listUpload.dropHere')}
        </div>
      )}
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {isFavorites && <Star className="size-6 fill-amber-400 text-amber-500" />}
            {isFavorites ? t('more.fav.listName') : list.name}
            <Badge variant="outline">{t(`lists.${list.visibility}`)}</Badge>
          </span>
        }
      >
        {list.canEdit && !isFavorites && (
          <Button variant="outline" size="sm" onClick={() => setDialog('edit')}>
            {t('common.edit')}
          </Button>
        )}
        {list.canEdit && !list.parentListId && (
          <Button variant="outline" size="sm" onClick={() => setDialog('bulk')}>
            {t('more.bulk.button')}
          </Button>
        )}
        {isOwner && (
          <Button variant="outline" size="sm" onClick={() => setDialog('share')}>
            {t('lists.share')}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => void clone()}>
          {t('lists.clone')}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setDialog('derive')}>
          {t('lists.derive')}
        </Button>
        {list.parentListId && list.canEdit && (
          <Button variant="outline" size="sm" onClick={() => void refreshDerived()}>
            {t('lists.refreshDerived')}
          </Button>
        )}
        <Button variant="outline" size="sm" nativeButton={false} render={<a href={authUrl(`/lists/${list.id}/export`)} />}>
          {t('lists.export')} {t('lists.exportJson')}
        </Button>
        <Button variant="outline" size="sm" nativeButton={false} render={<a href={authUrl(`/lists/${list.id}/export?format=txt`)} />}>
          {t('lists.exportTxt')}
        </Button>
        {can('roms.download') && (
          <Button variant="outline" size="sm" onClick={() => setDialog('zip')}>
            {t('lists.downloadZip')}
          </Button>
        )}
        {can('scrape.bulk') && (
          <Button variant="outline" size="sm" onClick={() => void scrape()}>
            {t('lists.scrape')}
          </Button>
        )}
        {can('roms.download') && (
          <Button size="sm" onClick={() => setDialog('device')}>
            {t('lists.sendToDevice')}
          </Button>
        )}
        {(isOwner || user?.role === 'ADMIN') && !isFavorites && (
          <Button variant="destructive" size="sm" onClick={() => void remove()} disabled={deleting}>
            {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            {deleting && t('more.list.deleting')}
          </Button>
        )}
      </PageHeader>
      <div className="mb-4 space-y-1 text-sm text-muted-foreground">
        {isFavorites && <p>{t('more.fav.listHelp')}</p>}
        {list.description && <p>{list.description}</p>}
        <p>
          {t('lists.owner')}: {list.owner.username} · {t('lists.items', { count: list.items.length })}
          {list.parent && (
            <>
              {' · '}
              {t('lists.derivedFrom')}{' '}
              <Link className="underline" to={`/lists/${list.parent.id}`}>
                {list.parent.name}
              </Link>
            </>
          )}
        </p>
        {list.derivedFilter && <DerivedSummary spec={list.derivedFilter} />}
        <ListDevicesProgress listId={list.id} />
      </div>
      {jobId && (
        <div className="mb-4 max-w-md">
          <JobProgress job={job} />
        </div>
      )}
      {/* Dropped roms: stored if new, discarded if already owned, and added to this list either way */}
      {canDrop && (
        <div className="mb-4">
          <p className="mb-2 text-sm text-muted-foreground">{t('more.listUpload.help')}</p>
          <VerifiedUpload
            compact
            incoming={incoming}
            onResolved={(r) =>
              void run(async () => {
                // As a game, so the list picks the best owned version; a specific rom only when the game is unknown
                await post(`/lists/${list.id}/items`, r.hackId ? { hackId: r.hackId } : r.gameId ? { gameId: r.gameId } : { romId: r.romId })
              })
            }
          />
        </div>
      )}
      {list.items.length > 0 && <Input className="mb-3 w-72" value={q} placeholder={t('common.search')} onChange={(e) => setQ(e.target.value)} />}
      {!list.items.length ? (
        <Empty />
      ) : (
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-14" />
              <TableHead>{t('common.title')}</TableHead>
              <TableHead className="w-24">{t('common.type')}</TableHead>
              <TableHead className="w-36">{t('common.system')}</TableHead>
              <TableHead className="w-24">{t('common.owned')}</TableHead>
              <TableHead className="w-28" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.items.map((i: any, idx: number) => {
              const needle = q.trim().toLowerCase()
              if (needle && !`${i.gameTitle ?? ''} ${i.title ?? ''} ${i.system?.name ?? ''} ${i.note ?? ''}`.toLowerCase().includes(needle)) return null
              return (
              <TableRow key={i.id}>
                <TableCell>
                  <div className="flex h-12 w-9 items-center justify-center overflow-hidden rounded bg-muted">
                    {i.cover ? <img src={authUrl(i.cover)} alt="" className="h-full w-full object-cover" loading="lazy" /> : <ImageOff className="size-4 text-muted-foreground" />}
                  </div>
                </TableCell>
                <TableCell>
                  {/* A file nobody identified links to the game it is a hack of, when that is known */}
                  {i.kind === 'unknown' && !i.gameId ? (
                    <span className="block truncate font-medium" title={i.title}>
                      {i.title}
                    </span>
                  ) : (
                    <Link className="block truncate font-medium hover:underline" title={i.title} to={i.kind === 'work' ? `/works/${i.workId}` : `/games/${i.gameId}`}>
                      {i.gameTitle ?? i.title}
                    </Link>
                  )}
                  {i.kind === 'unknown' && i.gameId && (
                    <p className="truncate text-xs text-muted-foreground" title={i.title}>
                      {i.title}
                    </p>
                  )}
                  {i.kind === 'rom' && (
                    <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                      <span className="truncate" title={i.title}>
                        {i.title}
                      </span>
                      {i.regions?.map((x: string) => (
                        <Badge key={x} variant="outline">
                          {x}
                        </Badge>
                      ))}
                    </p>
                  )}
                  {/* Badges go under the title so they never cover the next columns */}
                  {(i.pendingMedia || i.ra) && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {i.pendingMedia && <Badge variant="outline">{t('more.lists.pendingMedia')}</Badge>}
                      {i.ra && (
                        <Badge variant="secondary">
                          <Trophy className="size-3" />
                        </Badge>
                      )}
                    </div>
                  )}
                  {i.kind === 'work' && i.platforms?.length > 0 && <p className="truncate text-xs text-muted-foreground">{i.platforms.join(', ')}</p>}
                  {i.note && <p className="truncate text-xs text-muted-foreground">{i.note}</p>}
                </TableCell>
                <TableCell>{i.kind === 'work' ? t('more.lists.work') : t(`lists.kind.${i.kind}`)}</TableCell>
                <TableCell className="truncate" title={i.system?.name}>{i.system?.name}</TableCell>
                <TableCell>{i.owned ? <Check className="size-4 text-green-600" /> : <X className="size-4 text-muted-foreground" />}</TableCell>
                <TableCell>
                  {list.canEdit && (
                    <div className="flex gap-1">
                      {/* Moving among search results would put entries next to hidden ones */}
                      {!q.trim() && (
                        <>
                          <Button variant="ghost" size="icon-sm" onClick={() => void move(idx, -1)} title={t('lists.moveUp')}>
                            <ArrowUp className="size-4" />
                          </Button>
                          <Button variant="ghost" size="icon-sm" onClick={() => void move(idx, 1)} title={t('lists.moveDown')}>
                            <ArrowDown className="size-4" />
                          </Button>
                        </>
                      )}
                      <Button variant="ghost" size="icon-sm" onClick={() => void run(() => del(`/lists/${list.id}/items/${i.id}`))} title={t('common.remove')}>
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
      {dialog === 'edit' && <ListFormDialog list={list} onClose={() => setDialog(null)} onSaved={() => void refetch()} />}
      {dialog === 'share' && <ShareDialog list={list} onClose={() => setDialog(null)} onSaved={() => void refetch()} />}
      {dialog === 'bulk' && <BulkAddDialog listId={list.id} onClose={() => {
        setDialog(null)
        void refetch()
      }} />}
      {dialog === 'derive' && <DeriveWizard list={{ id: list.id, name: isFavorites ? t('more.fav.listName') : list.name }} onClose={() => setDialog(null)} />}
      {dialog === 'zip' && <ZipDialog list={list} onClose={() => setDialog(null)} />}
      {dialog === 'device' && <DeviceDialog list={list} onClose={() => setDialog(null)} />}
    </div>
  )
}

function ShareDialog({ list, onClose, onSaved }: { list: any; onClose(): void; onSaved(): void }) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const users = useQuery({ queryKey: ['directory'], queryFn: () => get<{ id: number; username: string }[]>('/users/directory') })
  const [shares, setShares] = useState<Record<number, { on: boolean; canEdit: boolean }>>(
    Object.fromEntries(list.shares.map((s: any) => [s.userId, { on: true, canEdit: s.canEdit }])),
  )
  const save = async () => {
    try {
      await put(
        `/lists/${list.id}/shares`,
        Object.entries(shares)
          .filter(([, v]) => v.on)
          .map(([userId, v]) => ({ userId: Number(userId), canEdit: v.canEdit })),
      )
      onSaved()
      onClose()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('lists.share')}</DialogTitle>
          <DialogDescription>{t('lists.shareWith')}</DialogDescription>
        </DialogHeader>
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {users.data
            ?.filter((u) => u.id !== user?.id)
            .map((u) => {
              const s = shares[u.id] ?? { on: false, canEdit: false }
              return (
                <div key={u.id} className="flex items-center justify-between gap-2 text-sm">
                  <label className="flex items-center gap-2">
                    <Checkbox checked={s.on} onCheckedChange={(c) => setShares({ ...shares, [u.id]: { ...s, on: !!c } })} />
                    {u.username}
                  </label>
                  <label className="flex items-center gap-2 text-muted-foreground">
                    <Checkbox checked={s.canEdit} disabled={!s.on} onCheckedChange={(c) => setShares({ ...shares, [u.id]: { ...s, canEdit: !!c } })} />
                    {t('lists.canEdit')}
                  </label>
                </div>
              )
            })}
        </div>
        <DialogFooter>
          <Button onClick={() => void save()}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}


function useFirmwares() {
  return useQuery({ queryKey: ['firmwares'], queryFn: () => get<any[]>('/devices/firmwares'), staleTime: 300_000 })
}

function ZipDialog({ list, onClose }: { list: any; onClose(): void }) {
  const { t } = useTranslation()
  const fws = useFirmwares()
  const [fw, setFw] = useState('')
  const url = authUrl(`/lists/${list.id}/download${fw ? `?firmware=${fw}` : ''}`)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('lists.downloadZip')}</DialogTitle>
        </DialogHeader>
        <Field label={t('lists.zipLayout')}>
          <NativeSelect value={fw} onChange={(e) => setFw(e.target.value)}>
            <option value="">{t('lists.plainLayout')}</option>
            {fws.data?.map((f) => (
              <option key={f.slug} value={f.slug}>
                {f.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <DialogFooter>
          <Button nativeButton={false} render={<a href={url} onClick={onClose} />}>{t('common.download')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeviceDialog({ list, onClose }: { list: any; onClose(): void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => get<any[]>('/devices') })
  const assigned = useQuery({ queryKey: ['list-devices', list.id], queryFn: () => get<number[]>(`/devices/by-list/${list.id}`) })
  const agents = devices.data?.filter((d) => d.connType === 'AGENT') ?? []
  const others = devices.data?.filter((d) => d.connType !== 'AGENT') ?? []
  const [picked, setPicked] = useState<number[] | null>(null)
  const chosen = picked ?? assigned.data ?? []
  const [deviceId, setDeviceId] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const [dryRun, setDryRun] = useState(false)
  const [jobId, setJobId] = useState<number | null>(null)
  const job = useJob(jobId)
  const saveConsoles = async () => {
    try {
      await put(`/devices/by-list/${list.id}`, { deviceIds: chosen })
      void qc.invalidateQueries({ queryKey: ['list-devices', list.id] })
      toast.success(t('more.listDevices.saved'))
      // Before anything is copied: say where it does not fit, with the way to choose what to leave out
      for (const id of chosen) {
        const plan = await get<{ fits: boolean | null; missingBytes: number; budget: number | null }>(`/devices/${id}/plan`).catch(() => null)
        const d = agents.find((x) => x.id === id)
        if (plan?.fits === false)
          toast.warning(t('more.space.listNoFit', { device: d?.name ?? id, over: formatBytes(plan.missingBytes - (plan.budget ?? 0)) }), {
            duration: 15000,
            action: { label: t('more.space.choose'), onClick: () => (window.location.href = `/devices/${id}`) },
          })
      }
      onClose()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  const start = async () => {
    try {
      const j = await post(`/devices/${deviceId}/transfer`, { listId: list.id, overwrite, dryRun })
      setJobId(j.id)
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('lists.sendToDevice')}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          {/* Sync clients keep the list and fetch what they lack by themselves */}
          {agents.length > 0 && (
            <div className="grid gap-2">
              <p className="text-sm text-muted-foreground">{t('more.listDevices.help')}</p>
              {agents.map((d) => (
                <label key={d.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={chosen.includes(d.id)}
                    onCheckedChange={(c) => setPicked(c ? [...chosen, d.id] : chosen.filter((x) => x !== d.id))}
                  />
                  {d.name} <span className="text-muted-foreground">({d.console.name} · {d.firmware.name})</span>
                </label>
              ))}
              <div className="flex justify-end">
                <Button onClick={() => void saveConsoles()}>{t('common.save')}</Button>
              </div>
            </div>
          )}
          {/* SD card or SSH devices: one-off copy */}
          {others.length > 0 && (
            <div className="grid gap-3 border-t pt-4">
              <p className="text-sm text-muted-foreground">{t('more.listDevices.copyHelp')}</p>
              <Field label={t('lists.device')}>
                <NativeSelect value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
                  <option value="">-</option>
                  {others.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} ({d.console.name} · {d.firmware.name})
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={overwrite} onCheckedChange={(c) => setOverwrite(!!c)} />
                {t('lists.overwrite')}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={dryRun} onCheckedChange={(c) => setDryRun(!!c)} />
                {t('lists.dryRun')}
              </label>
              <JobProgress job={job} />
              <div className="flex justify-end">
                <Button onClick={() => void start()} disabled={!deviceId || (!!job && job.status === 'RUNNING')}>
                  {t('common.apply')}
                </Button>
              </div>
            </div>
          )}
        </div>
        <DialogFooter cancel="close" />
      </DialogContent>
    </Dialog>
  )
}

/** How much of the list each console that keeps it already has */
function ListDevicesProgress({ listId }: { listId: number }) {
  const { t } = useTranslation()
  const progress = useQuery({ queryKey: ['list-progress', listId], queryFn: () => get<{ deviceId: number; name: string; have: number; total: number }[]>(`/devices/by-list/${listId}/progress`) })
  if (!progress.data?.length) return null
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {progress.data.map((p) => (
        <Link key={p.deviceId} to={`/devices/${p.deviceId}`}>
          <Badge variant={p.total && p.have === p.total ? 'default' : 'outline'}>
            {p.name}: {t('more.device.listProgress', { have: p.have, total: p.total, pct: p.total ? Math.round((100 * p.have) / p.total) : 0 })}
          </Badge>
        </Link>
      ))}
    </div>
  )
}

/** A sublist's filters and decisions in words */
function DerivedSummary({ spec }: { spec: any }) {
  const { t } = useTranslation()
  const f = spec?.v === 2 ? spec.filters : spec
  const parts = [
    f?.regions?.length ? f.regions.join(', ') : null,
    f?.languages?.length ? f.languages.join(', ') : null,
    f?.raOnly ? t('more.derive.raOnly') : null,
    f?.ownedOnly ? t('more.derive.ownedOnly') : null,
    f?.verifiedOnly ? t('more.derive.verifiedOnly') : null,
  ].filter(Boolean)
  const decisions = spec?.v === 2 ? Object.keys(spec.perGame ?? {}).length : 0
  return (
    <p className="text-xs">
      {t('more.derive.summary', { filters: parts.join(' · ') || t('more.derive.noFilters') })}
      {decisions > 0 && ` · ${t('more.derive.summaryDecisions', { count: decisions })}`}
      {spec?.v === 2 && spec.rest?.mode === 'like' && ` · ${t('more.derive.reviewRuleLike')}`}
    </p>
  )
}
