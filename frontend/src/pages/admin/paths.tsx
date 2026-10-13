import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Pencil, ScanSearch, Trash2, Wand2 } from 'lucide-react'
import { toast } from 'sonner'
import { del, get, patch, post, put } from '@/lib/api'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Link } from 'react-router'
import { Empty, Field, JobProgress, NativeSelect, PageHeader, SystemSelect, errMsg, formatBytes, formatDate, useJob, useSystems } from '@/components/common'

export function AdminPathsPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['paths'], queryFn: () => get<any[]>('/admin/paths') })
  const [editing, setEditing] = useState<any | null | undefined>(undefined)
  const [organize, setOrganize] = useState<any | null>(null)
  const [jobId, setJobId] = useState<number | null>(null)
  const job = useJob(jobId, [['paths'], ['systems'], ['games']])
  const unknownFiles = useQuery({ queryKey: ['unknown-files'], queryFn: () => get<{ accept: boolean }>('/admin/settings/unknown-files') })
  const scan = async (id: number, force = false, allowMassRemoval = false) => setJobId((await post(`/admin/paths/${id}/scan`, { force, allowMassRemoval })).id)
  const relink = async (p: any) => {
    const to = prompt(t('more.storage.relinkAsk', { path: p.path }), p.path)
    if (!to) return
    try {
      await post(`/admin/paths/${p.id}/relink`, { path: to })
      void qc.invalidateQueries({ queryKey: ['paths'] })
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  const remove = async (id: number) => {
    if (!confirm(t('common.confirmDelete'))) return
    await del(`/admin/paths/${id}`)
    void qc.invalidateQueries({ queryKey: ['paths'] })
  }
  return (
    <div>
      <PageHeader title={t('admin.paths')}>
        <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/admin/storage-setup" />}>
          {t('more.setup.open')}
        </Button>
        <Button size="sm" onClick={() => setEditing(null)}>
          {t('admin.newPath')}
        </Button>
      </PageHeader>
      {jobId && (
        <div className="mb-4 max-w-xl">
          <JobProgress job={job} />
        </div>
      )}
      <Card className="mb-4">
        <CardContent className="flex items-center justify-between gap-4 pt-6">
          <div>
            <p className="font-medium">{t('more.unknownFiles.title')}</p>
            <p className="text-sm text-muted-foreground">{t('more.unknownFiles.help')}</p>
          </div>
          <Switch
            checked={!!unknownFiles.data?.accept}
            onCheckedChange={async (accept) => {
              try {
                await put('/admin/settings/unknown-files', { accept })
                void qc.invalidateQueries({ queryKey: ['unknown-files'] })
              } catch (e) {
                toast.error(errMsg(e))
              }
            }}
          />
        </CardContent>
      </Card>
      {!data?.length ? (
        <Empty />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.map((p) => (
            <Card key={p.id}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-2">
                  {p.label}
                  <span className="flex flex-wrap justify-end gap-1">
                    {p.offlineAt && <Badge variant="destructive">{t('more.storage.offline')}</Badge>}
                    {p.readOnly ? <Badge variant="outline">{t('more.storage.source')}</Badge> : <Badge>{t('more.storage.destination')}</Badge>}
                    {p.isDefaultTarget && <Badge variant="secondary">{t('more.paths.defaultTarget')}</Badge>}
                    {(p.targetSystems ?? []).length > 0 && <Badge variant="secondary">{t('more.paths.targets')}: {(p.targetSystems as string[]).join(', ')}</Badge>}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="font-mono text-xs break-all">{p.path}</p>
                {p.offlineAt && (
                  <div className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 p-2 text-xs">
                    <span className="grow">{t('more.storage.offlineWhy', { reason: t(`more.storage.reason.${p.offlineReason ?? 'missing'}`), when: formatDate(p.offlineAt) })}</span>
                    <Button size="sm" variant="outline" onClick={() => void relink(p)}>
                      {t('more.storage.relink')}
                    </Button>
                  </div>
                )}
                {p.scanWarning && (
                  <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/50 p-2 text-xs">
                    <span className="grow">{t('more.storage.heldBack', { detail: p.scanWarning })}</span>
                    <Button size="sm" variant="outline" onClick={() => confirm(t('more.storage.confirmRemoval')) && void scan(p.id, false, true)}>
                      {t('more.storage.confirm')}
                    </Button>
                  </div>
                )}
                {p.disk && (
                  <div className="space-y-1">
                    <div className="relative h-2 overflow-hidden rounded-full bg-muted">
                      <div className="absolute inset-y-0 left-0 bg-primary" style={{ width: `${Math.min(100, ((p.disk.total - p.disk.free) / Math.max(1, p.disk.total)) * 100)}%` }} />
                      {!p.readOnly && <div className="absolute inset-y-0 right-0 bg-destructive/40" style={{ width: `${p.reservePercent}%` }} />}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t('more.storage.disk', { free: formatBytes(p.disk.free), total: formatBytes(p.disk.total), here: formatBytes(p.bytes ?? 0) })}
                      {!p.readOnly && ` · ${t('more.storage.reserveIs', { pct: p.reservePercent })}`}
                    </p>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  {(['MATCHED', 'HACK', 'UNKNOWN'] as const).map((s) => (
                    <Badge key={s} variant={s === 'UNKNOWN' ? 'outline' : 'secondary'}>
                      {t(`admin.${s}`)}: {p.files[s] ?? 0}
                    </Badge>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('admin.lastScan')}: {formatDate(p.lastScanAt)}
                </p>
                <div className="flex flex-wrap gap-1">
                  <Button size="sm" onClick={() => void scan(p.id)}>
                    <ScanSearch className="size-4" />
                    {t('admin.scan')}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void scan(p.id, true)}>
                    {t('admin.rescan')}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setOrganize(p)} disabled={p.readOnly}>
                    <Wand2 className="size-4" />
                    {t('admin.organize')}
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => setEditing(p)}>
                    <Pencil className="size-4" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => void remove(p.id)}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {editing !== undefined && <PathDialog path={editing} onClose={() => setEditing(undefined)} />}
      {organize && <OrganizeDialog path={organize} onClose={() => setOrganize(null)} />}
    </div>
  )
}

function PathDialog({ path, onClose }: { path: any | null; onClose(): void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [form, setForm] = useState({
    label: path?.label ?? '',
    path: path?.path ?? '',
    systemId: path?.systemId ? String(path.systemId) : '',
    targetSystems: (path?.targetSystems ?? []) as string[],
    isDefaultTarget: path?.isDefaultTarget ?? false,
    targetScheme: path?.targetScheme ?? 'system',
    readOnly: path?.readOnly ?? true,
    reservePercent: String(path?.reservePercent ?? 5),
    priority: String(path?.priority ?? 0),
    folderSystems: Object.entries((path?.folderSystems ?? {}) as Record<string, string>).map(([folder, slug]) => ({ folder, slug })),
  })
  const systems = useSystems()
  const fws = useQuery({ queryKey: ['firmwares'], queryFn: () => get<any[]>('/devices/firmwares') })
  const submit = async () => {
    const body = {
      ...form,
      systemId: form.systemId ? Number(form.systemId) : null,
      reservePercent: Number(form.reservePercent) || 0,
      priority: Number(form.priority) || 0,
      folderSystems: form.folderSystems.filter((r) => r.folder.trim() && r.slug).length ? Object.fromEntries(form.folderSystems.filter((r) => r.folder.trim() && r.slug).map((r) => [r.folder.trim().toLowerCase(), r.slug])) : null,
    }
    try {
      if (path) await patch(`/admin/paths/${path.id}`, body)
      else await post('/admin/paths', body)
      void qc.invalidateQueries({ queryKey: ['paths'] })
      onClose()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-auto">
        <DialogHeader>
          <DialogTitle>{path ? path.label : t('admin.newPath')}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label={t('admin.label')}>
            <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          </Field>
          <Field label={t('common.path')}>
            <Input value={form.path} onChange={(e) => setForm({ ...form, path: e.target.value })} className="font-mono" placeholder="/roms/nes" />
          </Field>
          <Field label={t('admin.forcedSystem')}>
            <SystemSelect value={form.systemId} onChange={(v) => setForm({ ...form, systemId: v })} allLabel={t('admin.autoDetect')} onlyWithData={false} />
          </Field>
          <fieldset className="grid gap-2 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">{t('more.paths.targets')}</legend>
            <p className="text-xs text-muted-foreground">{t('more.paths.targetHelp')}</p>
            <span className="text-sm">{t('more.paths.targetSystems')}</span>
            <div className="grid max-h-40 grid-cols-2 gap-1 overflow-auto">
              {systems.data?.map((s) => (
                <label key={s.slug} className="flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={form.targetSystems.includes(s.slug)}
                    onCheckedChange={(c) => setForm({ ...form, targetSystems: c ? [...form.targetSystems, s.slug] : form.targetSystems.filter((x) => x !== s.slug) })}
                  />
                  {s.name}
                </label>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={form.isDefaultTarget} onCheckedChange={(c) => setForm({ ...form, isDefaultTarget: !!c })} />
              {t('more.paths.defaultTarget')}
            </label>
            <Field label={t('more.paths.scheme')}>
              <NativeSelect value={form.targetScheme} onChange={(e) => setForm({ ...form, targetScheme: e.target.value })}>
                <option value="system">{t('more.paths.schemeSystem')}</option>
                <option value="flat">{t('more.paths.schemeFlat')}</option>
                {fws.data?.map((f) => (
                  <option key={f.slug} value={f.slug}>
                    {f.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </fieldset>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={form.readOnly} onCheckedChange={(c) => setForm({ ...form, readOnly: !!c })} />
            {t('more.storage.readOnlyLabel')}
          </label>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('more.storage.reserve')}>
              <Input value={form.reservePercent} inputMode="numeric" onChange={(e) => setForm({ ...form, reservePercent: e.target.value })} disabled={form.readOnly} />
            </Field>
            <Field label={t('more.storage.priority')}>
              <Input value={form.priority} inputMode="numeric" onChange={(e) => setForm({ ...form, priority: e.target.value })} disabled={form.readOnly} />
            </Field>
          </div>
          <fieldset className="grid gap-2 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">{t('more.storage.folderSystems')}</legend>
            <p className="text-xs text-muted-foreground">{t('more.storage.folderSystemsHelp')}</p>
            {form.folderSystems.map((r, i) => (
              <div key={i} className="flex gap-2">
                <Input
                  className="font-mono"
                  value={r.folder}
                  placeholder="misc"
                  onChange={(e) => setForm({ ...form, folderSystems: form.folderSystems.map((x, j) => (j === i ? { ...x, folder: e.target.value } : x)) })}
                />
                <NativeSelect value={r.slug} onChange={(e) => setForm({ ...form, folderSystems: form.folderSystems.map((x, j) => (j === i ? { ...x, slug: e.target.value } : x)) })}>
                  <option value="" />
                  {systems.data?.map((s) => (
                    <option key={s.slug} value={s.slug}>
                      {s.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            ))}
            <Button size="sm" variant="outline" onClick={() => setForm({ ...form, folderSystems: [...form.folderSystems, { folder: '', slug: '' }] })}>
              +
            </Button>
          </fieldset>
        </div>
        <DialogFooter>
          <Button onClick={() => void submit()} disabled={!form.label || !form.path}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function OrganizeDialog({ path, onClose }: { path: any; onClose(): void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const fws = useQuery({ queryKey: ['firmwares'], queryFn: () => get<any[]>('/devices/firmwares') })
  const [scheme, setScheme] = useState('rename')
  const plan = useQuery({ queryKey: ['organize', path.id, scheme], queryFn: () => get<any[]>(`/admin/paths/${path.id}/organize?scheme=${scheme}`) })
  const apply = async () => {
    try {
      const r = await post(`/admin/paths/${path.id}/organize`, { scheme })
      if (r.errors.length) toast.error(r.errors.slice(0, 3).join('\n'))
      toast.success(`${r.moved}/${r.total}`)
      void qc.invalidateQueries({ queryKey: ['paths'] })
      void plan.refetch()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {t('admin.organize')} · {path.label}
          </DialogTitle>
        </DialogHeader>
        <Field label={t('admin.scheme')}>
          <NativeSelect value={scheme} onChange={(e) => setScheme(e.target.value)}>
            <option value="rename">{t('admin.schemeRename')}</option>
            <option value="system">{t('admin.schemeSystem')}</option>
            {fws.data?.map((f) => (
              <option key={f.slug} value={f.slug}>
                {f.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <p className="text-sm font-medium">
          {t('admin.preview')} ({plan.data?.length ?? 0})
        </p>
        {!plan.data?.length ? (
          <Empty>{t('admin.noChanges')}</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('common.path')}</TableHead>
                <TableHead>→</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plan.data.slice(0, 500).map((p) => (
                <TableRow key={p.from}>
                  <TableCell className="max-w-sm truncate font-mono text-xs">{p.from}</TableCell>
                  <TableCell className="max-w-sm truncate font-mono text-xs">
                    {p.skipped ? <Badge variant="outline">{t('more.organize.skipped')}</Badge> : p.to} {p.conflict && <Badge variant="destructive">{t('admin.conflict')}</Badge>}
                    {p.companions?.length > 0 && <Badge variant="secondary">{t('more.organize.companions', { count: p.companions.length })}</Badge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <p className="text-xs text-muted-foreground">{t('more.organize.help')}</p>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={async () => {
              try {
                const r = await post(`/admin/paths/${path.id}/organize/undo`)
                if (r.errors.length) toast.error(r.errors.slice(0, 3).join('\n'))
                toast.success(t('more.organize.undone', { count: r.restored }))
                void plan.refetch()
              } catch (e) {
                toast.error(errMsg(e))
              }
            }}
          >
            {t('more.organize.undo')}
          </Button>
          <Button onClick={() => void apply()} disabled={!plan.data?.some((p) => !p.skipped)}>
            {t('common.apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
