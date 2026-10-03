import { useState } from 'react'
import { Link } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { History, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { authUrl, del, get, patch, post, upload } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Empty, Field, NativeSelect, PageHeader, errMsg, formatBytes, formatDate } from '@/components/common'

const family = (f: string) => (f.startsWith('ps1') ? 'ps1' : f)

function useEmulators() {
  return useQuery({ queryKey: ['emulators'], queryFn: () => get<any[]>('/devices/emulators'), staleTime: 300_000 })
}

export function SavesPage() {
  const { t } = useTranslation()
  const { data } = useQuery({ queryKey: ['saves'], queryFn: () => get<any[]>('/saves') })
  const [open, setOpen] = useState<number | null>(null)
  const [uploading, setUploading] = useState(false)
  return (
    <div>
      <PageHeader title={t('saves.title')}>
        <Button size="sm" onClick={() => setUploading(true)}>
          {t('saves.upload')}
        </Button>
      </PageHeader>
      {!data?.length ? (
        <Empty />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('saves.game')}</TableHead>
              <TableHead>{t('saves.emulator')}</TableHead>
              <TableHead>{t('common.type')}</TableHead>
              <TableHead>{t('saves.versions')}</TableHead>
              <TableHead>{t('saves.current')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((s) => {
              const cur = s.versions.find((v: any) => v.id === s.currentVersionId)
              return (
                <TableRow key={s.id}>
                  <TableCell className="max-w-md">
                    {s.game ? (
                      <Link className="font-medium hover:underline" to={`/games/${s.game.id}`}>
                        {s.game.title}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">{t('saves.unidentified')}</span>
                    )}
                    <p className="truncate text-xs text-muted-foreground">
                      {s.baseName}
                      {s.game && ` · ${s.game.system.name}`}
                    </p>
                  </TableCell>
                  <TableCell>{s.emulator.name}</TableCell>
                  <TableCell>
                    <Badge variant={s.kind === 'SAVE' ? 'default' : 'secondary'}>{t(`saves.kind.${s.kind}`)}</Badge>
                    {s.kind === 'STATE' && <span className="ml-1 text-xs text-muted-foreground">{s.slot === -1 ? 'auto' : `#${s.slot}`}</span>}
                  </TableCell>
                  <TableCell>{s.versions.length}</TableCell>
                  <TableCell className="text-xs">
                    {formatDate(cur?.fileMtime)}
                    <p className="text-muted-foreground">{cur?.sourceDevice?.name ?? t('saves.web')}</p>
                  </TableCell>
                  <TableCell>
                    <Button variant="outline" size="sm" onClick={() => setOpen(s.id)}>
                      <History className="size-4" />
                      {t('saves.versions')}
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
      {open && <VersionsDialog saveId={open} onClose={() => setOpen(null)} />}
      {uploading && <UploadDialog onClose={() => setUploading(false)} />}
    </div>
  )
}

function VersionsDialog({ saveId, onClose }: { saveId: number; onClose(): void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const emus = useEmulators()
  const { data: s, refetch } = useQuery({ queryKey: ['save', saveId], queryFn: () => get(`/saves/${saveId}`) })
  const [as, setAs] = useState('')
  const [convertTo, setConvertTo] = useState('')
  const [baseName, setBaseName] = useState<string | null>(null)
  if (!s) return null
  const compatible = (emus.data ?? []).filter((e) => family(e.saveFormat) === family(s.emulator.saveFormat))
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      await refetch()
      void qc.invalidateQueries({ queryKey: ['saves'] })
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {s.game?.title ?? s.baseName} · {s.emulator.name}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('saves.downloadAs')}>
            <NativeSelect value={as} onChange={(e) => setAs(e.target.value)}>
              <option value="">{s.emulator.name}</option>
              {s.kind === 'SAVE' &&
                compatible
                  .filter((e) => e.id !== s.emulatorId)
                  .map((e) => (
                    <option key={e.slug} value={e.slug}>
                      {e.name} ({e.saveExt})
                    </option>
                  ))}
            </NativeSelect>
          </Field>
          {s.kind === 'SAVE' && (
            <Field label={t('saves.convert')}>
              <div className="flex gap-2">
                <NativeSelect value={convertTo} onChange={(e) => setConvertTo(e.target.value)}>
                  <option value="">-</option>
                  {compatible
                    .filter((e) => e.id !== s.emulatorId)
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                </NativeSelect>
                <Button variant="outline" size="sm" disabled={!convertTo} onClick={() => void act(() => post(`/saves/${s.id}/convert`, { emulatorId: Number(convertTo) }).then(() => toast.success(t('common.saved'))))}>
                  {t('common.apply')}
                </Button>
              </div>
            </Field>
          )}
          <Field label={t('saves.baseName')}>
            <div className="flex gap-2">
              <Input className="w-72" value={baseName ?? s.baseName} onChange={(e) => setBaseName(e.target.value)} />
              <Button variant="outline" size="sm" disabled={baseName == null || baseName === s.baseName} onClick={() => void act(() => patch(`/saves/${s.id}`, { baseName }))}>
                {t('common.save')}
              </Button>
            </div>
          </Field>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('common.date')}</TableHead>
              <TableHead>{t('common.size')}</TableHead>
              <TableHead>{t('saves.source')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {s.versions.map((v: any) => (
              <TableRow key={v.id}>
                <TableCell className="text-xs">
                  {formatDate(v.fileMtime)}
                  {v.id === s.currentVersionId && (
                    <Badge className="ml-2" variant="default">
                      {t('saves.current')}
                    </Badge>
                  )}
                  {v.note && <p className="text-muted-foreground">{v.note}</p>}
                </TableCell>
                <TableCell>{formatBytes(v.size)}</TableCell>
                <TableCell>{v.sourceDevice?.name ?? t('saves.web')}</TableCell>
                <TableCell className="space-x-1 text-right">
                  <Button variant="outline" size="sm" nativeButton={false} render={<a href={authUrl(`/saves/${s.id}/versions/${v.id}/download${as ? `?emulator=${as}` : ''}`)} />}>
                    {t('common.download')}
                  </Button>
                  {v.id !== s.currentVersionId && (
                    <>
                      <Button variant="outline" size="sm" onClick={() => void act(() => post(`/saves/${s.id}/restore`, { versionId: v.id }))}>
                        {t('saves.restore')}
                      </Button>
                      <Button variant="ghost" size="icon-sm" onClick={() => void act(() => del(`/saves/${s.id}/versions/${v.id}`))}>
                        <Trash2 className="size-4" />
                      </Button>
                    </>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <DialogFooter>
          <Button
            variant="destructive"
            onClick={() =>
              confirm(t('common.confirmDelete')) &&
              void act(async () => {
                await del(`/saves/${s.id}`)
                onClose()
              })
            }
          >
            {t('common.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function UploadDialog({ onClose }: { onClose(): void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const emus = useEmulators()
  const [file, setFile] = useState<File | null>(null)
  const [emulatorId, setEmulatorId] = useState('')
  const submit = async () => {
    if (!file) return
    const fd = new FormData()
    fd.append('file', file)
    fd.append('emulatorId', emulatorId)
    fd.append('mtime', String(file.lastModified))
    try {
      await upload('/saves/upload', fd)
      void qc.invalidateQueries({ queryKey: ['saves'] })
      toast.success(t('common.saved'))
      onClose()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('saves.upload')}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label={t('saves.emulator')}>
            <NativeSelect value={emulatorId} onChange={(e) => setEmulatorId(e.target.value)}>
              <option value="">-</option>
              {emus.data?.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} ({e.saveExt}
                  {e.stateExt ? `, ${e.stateExt}` : ''})
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t('saves.baseName')}>
            <Input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
        </div>
        <DialogFooter>
          <Button onClick={() => void submit()} disabled={!file || !emulatorId}>
            {t('common.upload')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
