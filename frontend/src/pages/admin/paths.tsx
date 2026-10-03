import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Pencil, ScanSearch, Trash2, Wand2 } from 'lucide-react'
import { toast } from 'sonner'
import { del, get, patch, post } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Empty, Field, JobProgress, NativeSelect, PageHeader, SystemSelect, errMsg, formatDate, useJob, useSystems } from '@/components/common'

export function AdminPathsPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['paths'], queryFn: () => get<any[]>('/admin/paths') })
  const [editing, setEditing] = useState<any | null | undefined>(undefined)
  const [organize, setOrganize] = useState<any | null>(null)
  const [jobId, setJobId] = useState<number | null>(null)
  const job = useJob(jobId, [['paths'], ['systems'], ['games']])
  const scan = async (id: number, force = false) => setJobId((await post(`/admin/paths/${id}/scan`, { force })).id)
  const remove = async (id: number) => {
    if (!confirm(t('common.confirmDelete'))) return
    await del(`/admin/paths/${id}`)
    void qc.invalidateQueries({ queryKey: ['paths'] })
  }
  return (
    <div>
      <PageHeader title={t('admin.paths')}>
        <Button size="sm" onClick={() => setEditing(null)}>
          {t('admin.newPath')}
        </Button>
      </PageHeader>
      {jobId && (
        <div className="mb-4 max-w-xl">
          <JobProgress job={job} />
        </div>
      )}
      {!data?.length ? (
        <Empty />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.map((p) => (
            <Card key={p.id}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-2">
                  {p.label}
                  <span className="flex gap-1">
                    {p.isDefaultTarget && <Badge>{t('more.paths.defaultTarget')}</Badge>}
                    {(p.targetSystems ?? []).length > 0 && <Badge variant="secondary">{t('more.paths.targets')}: {(p.targetSystems as string[]).join(', ')}</Badge>}
                    {p.readOnly && <Badge variant="outline">{t('admin.readOnly')}</Badge>}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="font-mono text-xs break-all">{p.path}</p>
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
    readOnly: path?.readOnly ?? false,
  })
  const systems = useSystems()
  const fws = useQuery({ queryKey: ['firmwares'], queryFn: () => get<any[]>('/devices/firmwares') })
  const submit = async () => {
    const body = { ...form, systemId: form.systemId ? Number(form.systemId) : null }
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
            {t('admin.readOnly')}
          </label>
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
                    {p.to} {p.conflict && <Badge variant="destructive">{t('admin.conflict')}</Badge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <DialogFooter>
          <Button onClick={() => void apply()} disabled={!plan.data?.length}>
            {t('common.apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
