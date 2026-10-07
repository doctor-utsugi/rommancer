import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Check, ImageOff, Trash2, Trophy, X } from 'lucide-react'
import { toast } from 'sonner'
import { authUrl, del, get, post, put } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Empty, Field, JobProgress, NativeSelect, PageHeader, errMsg, useJob, useSystems } from '@/components/common'
import { VerifiedUpload } from '@/pages/upload'
import { ListFormDialog } from './lists'
import { useRegions } from './games'

type DialogKind = 'edit' | 'share' | 'derive' | 'zip' | 'device' | null

export function ListPage() {
  const { id } = useParams()
  const { t } = useTranslation()
  const { user, can } = useAuth()
  const nav = useNavigate()
  const qc = useQueryClient()
  const { data: list, refetch } = useQuery({ queryKey: ['list', String(id)], queryFn: () => get(`/lists/${id}`) })
  const [dialog, setDialog] = useState<DialogKind>(null)
  const [jobId, setJobId] = useState<number | null>(null)
  const job = useJob(jobId, [['list', String(id)]])
  if (!list) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
  const isOwner = list.ownerId === user?.id

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
  const remove = () =>
    run(async () => {
      if (!confirm(t('common.confirmDelete'))) return
      await del(`/lists/${list.id}`)
      void qc.invalidateQueries({ queryKey: ['lists'] })
      nav('/lists')
    })
  const refreshDerived = () =>
    run(async () => {
      const r = await post(`/lists/${list.id}/refresh`)
      toast.success(`${t('lists.added', { count: r.added })} · ${t('lists.skipped', { count: r.skipped.length })}`)
    })
  const scrape = async () => setJobId((await post('/scrape', { listId: list.id })).id)

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {list.name}
            <Badge variant="outline">{t(`lists.${list.visibility}`)}</Badge>
          </span>
        }
      >
        {list.canEdit && (
          <Button variant="outline" size="sm" onClick={() => setDialog('edit')}>
            {t('common.edit')}
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
        {(isOwner || user?.role === 'ADMIN') && (
          <Button variant="destructive" size="sm" onClick={() => void remove()}>
            <Trash2 className="size-4" />
          </Button>
        )}
      </PageHeader>
      <div className="mb-4 space-y-1 text-sm text-muted-foreground">
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
        {list.derivedFilter && <p className="font-mono text-xs">{JSON.stringify(list.derivedFilter)}</p>}
      </div>
      {jobId && (
        <div className="mb-4 max-w-md">
          <JobProgress job={job} />
        </div>
      )}
      {/* Dropped roms: stored if new, discarded if already owned, and added to this list either way */}
      {(isOwner || list.isCollaborative) && can('roms.upload') && (
        <div className="mb-4">
          <p className="mb-2 text-sm text-muted-foreground">{t('more.listUpload.help')}</p>
          <VerifiedUpload
            compact
            onResolved={(r) =>
              void run(async () => {
                await post(`/lists/${list.id}/items`, r.hackId ? { hackId: r.hackId } : { romId: r.romId })
              })
            }
          />
        </div>
      )}
      {!list.items.length ? (
        <Empty />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12" />
              <TableHead>{t('common.title')}</TableHead>
              <TableHead>{t('common.type')}</TableHead>
              <TableHead>{t('common.system')}</TableHead>
              <TableHead>{t('lists.selected')}</TableHead>
              <TableHead>{t('common.owned')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.items.map((i: any, idx: number) => (
              <TableRow key={i.id}>
                <TableCell>
                  <div className="flex h-12 w-9 items-center justify-center overflow-hidden rounded bg-muted">
                    {i.cover ? <img src={authUrl(i.cover)} alt="" className="h-full w-full object-cover" loading="lazy" /> : <ImageOff className="size-4 text-muted-foreground" />}
                  </div>
                </TableCell>
                <TableCell className="max-w-md">
                  <Link className="font-medium hover:underline" to={i.kind === 'work' ? `/works/${i.workId}` : `/games/${i.gameId}`}>
                    {i.title}
                  </Link>
                  {i.pendingMedia && (
                    <Badge variant="outline" className="ml-2">
                      {t('more.lists.pendingMedia')}
                    </Badge>
                  )}
                  {i.kind === 'work' && i.platforms?.length > 0 && <p className="text-xs text-muted-foreground">{i.platforms.join(', ')}</p>}
                  {i.ra && (
                    <Badge variant="secondary" className="ml-2">
                      <Trophy className="size-3" />
                    </Badge>
                  )}
                  {i.note && <p className="text-xs text-muted-foreground">{i.note}</p>}
                </TableCell>
                <TableCell>{i.kind === 'work' ? t('more.lists.work') : t(`lists.kind.${i.kind}`)}</TableCell>
                <TableCell>{i.system?.name}</TableCell>
                <TableCell className="max-w-xs truncate text-xs text-muted-foreground">{i.selectedRom?.name ?? '-'}</TableCell>
                <TableCell>{i.owned ? <Check className="size-4 text-green-600" /> : <X className="size-4 text-muted-foreground" />}</TableCell>
                <TableCell>
                  {list.canEdit && (
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon-sm" onClick={() => void move(idx, -1)} title={t('lists.moveUp')}>
                        <ArrowUp className="size-4" />
                      </Button>
                      <Button variant="ghost" size="icon-sm" onClick={() => void move(idx, 1)} title={t('lists.moveDown')}>
                        <ArrowDown className="size-4" />
                      </Button>
                      <Button variant="ghost" size="icon-sm" onClick={() => void run(() => del(`/lists/${list.id}/items/${i.id}`))} title={t('common.remove')}>
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {dialog === 'edit' && <ListFormDialog list={list} onClose={() => setDialog(null)} onSaved={() => void refetch()} />}
      {dialog === 'share' && <ShareDialog list={list} onClose={() => setDialog(null)} onSaved={() => void refetch()} />}
      {dialog === 'derive' && <DeriveDialog list={list} onClose={() => setDialog(null)} />}
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

const LANGS = ['Es', 'En', 'Fr', 'De', 'It', 'Ja', 'Pt']

function DeriveDialog({ list, onClose }: { list: any; onClose(): void }) {
  const { t } = useTranslation()
  const nav = useNavigate()
  const regions = useRegions()
  const [name, setName] = useState(`${list.name} (EU/USA)`)
  const [pref, setPref] = useState<string[]>(['Europe', 'USA'])
  const [langs, setLangs] = useState<string[]>([])
  const [strict, setStrict] = useState(false)
  const [raOnly, setRaOnly] = useState(false)
  const [ownedOnly, setOwnedOnly] = useState(false)
  const [next, setNext] = useState('')
  const systems = useSystems()
  const [platforms, setPlatforms] = useState<string[]>([])
  const hasWorks = list.items.some((i: any) => i.kind === 'work')
  const submit = async () => {
    try {
      const r = await post(`/lists/${list.id}/derive`, { name, regions: pref, languages: langs, strictRegions: strict, raOnly, ownedOnly, ...(platforms.length ? { platforms } : {}) })
      toast.success(`${t('lists.added', { count: r.added })} · ${t('lists.skipped', { count: r.skipped.length })}`)
      nav(`/lists/${r.id}`)
      onClose()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('lists.derive')}</DialogTitle>
          <DialogDescription>{t('lists.deriveHelp')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label={t('common.name')}>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t('lists.regionsPref')}>
            <div className="flex flex-wrap gap-1">
              {pref.map((r, i) => (
                <Badge key={r} variant="secondary" className="cursor-pointer" onClick={() => setPref(pref.filter((x) => x !== r))}>
                  {i + 1}. {r} <X className="size-3" />
                </Badge>
              ))}
            </div>
            <NativeSelect
              value={next}
              onChange={(e) => {
                if (e.target.value && !pref.includes(e.target.value)) setPref([...pref, e.target.value])
                setNext('')
              }}
            >
              <option value="">+</option>
              {regions.data?.filter((r) => !pref.includes(r)).map((r) => <option key={r}>{r}</option>)}
            </NativeSelect>
          </Field>
          <Field label={t('lists.languagesPref')}>
            <div className="flex flex-wrap gap-2">
              {LANGS.map((l) => (
                <label key={l} className="flex items-center gap-1 text-sm">
                  <Checkbox checked={langs.includes(l)} onCheckedChange={(c) => setLangs(c ? [...langs, l] : langs.filter((x) => x !== l))} />
                  {l}
                </label>
              ))}
            </div>
          </Field>
          {hasWorks && (
            <Field label={t('more.lists.platforms')}>
              <div className="flex flex-wrap gap-1">
                {platforms.map((p, i) => (
                  <Badge key={p} variant="secondary" className="cursor-pointer" onClick={() => setPlatforms(platforms.filter((x) => x !== p))}>
                    {i + 1}. {systems.data?.find((s) => s.slug === p)?.name ?? p} <X className="size-3" />
                  </Badge>
                ))}
              </div>
              <NativeSelect value="" onChange={(e) => e.target.value && setPlatforms([...platforms, e.target.value])}>
                <option value="">{t('more.lists.addPlatform')}</option>
                {systems.data
                  ?.filter((s) => s.roms > 0 && !platforms.includes(s.slug))
                  .map((s) => (
                    <option key={s.slug} value={s.slug}>
                      {s.name}
                    </option>
                  ))}
              </NativeSelect>
            </Field>
          )}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={strict} onCheckedChange={(c) => setStrict(!!c)} />
            {t('lists.strictRegions')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={raOnly} onCheckedChange={(c) => setRaOnly(!!c)} />
            {t('lists.raOnly')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={ownedOnly} onCheckedChange={(c) => setOwnedOnly(!!c)} />
            {t('lists.ownedOnly')}
          </label>
        </div>
        <DialogFooter>
          <Button onClick={() => void submit()} disabled={!name}>
            {t('common.create')}
          </Button>
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
      </DialogContent>
    </Dialog>
  )
}
