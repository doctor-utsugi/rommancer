import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { get, post, upload } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Empty, Field, JobProgress, NativeSelect, PageHeader, SystemSelect, errMsg, formatDate, useJob } from '@/components/common'

const TYPES = ['NOINTRO', 'REDUMP', 'FBNEO', 'MAME', 'HACKS', 'OTHER']

export function AdminDatsPage() {
  const { t } = useTranslation()
  const { data } = useQuery({ queryKey: ['dats'], queryFn: () => get<any[]>('/admin/dats') })
  const local = useQuery({ queryKey: ['dat-files'], queryFn: () => get<string[]>('/admin/dats/files') })
  const presets = useQuery({ queryKey: ['dat-presets'], queryFn: () => get<any[]>('/admin/dats/presets') })
  const [batch, setBatch] = useState<number[]>([])
  const batchJob = useJob(batch.length ? batch[batch.length - 1] : null, [['dats'], ['dat-presets'], ['systems'], ['games']])
  const importAll = async (onlyMissing: boolean) => {
    try {
      const ids = onlyMissing ? presets.data?.filter((p) => !p.imported).map((p) => p.id) : undefined
      if (ids && !ids.length) return
      const jobs = await post<any[]>('/admin/dats/fetch-presets', ids ? { ids } : {})
      setBatch(jobs.map((j) => j.id))
      toast.success(`${jobs.length} DATs`)
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  const [systemId, setSystemId] = useState('')
  const [type, setType] = useState('')
  const [preset, setPreset] = useState('')
  const [localFile, setLocalFile] = useState('')
  const [url, setUrl] = useState('')
  const [jobId, setJobId] = useState<number | null>(null)
  const job = useJob(jobId, [['dats'], ['dat-files'], ['systems'], ['games']])
  const fileRef = useRef<HTMLInputElement>(null)
  const opts = () => ({ ...(systemId ? { systemId: Number(systemId) } : {}), ...(type ? { type } : {}) })

  const go = async (fn: () => Promise<any>) => {
    try {
      setJobId((await fn()).id)
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  const uploadFile = (f: File) =>
    go(() => {
      const fd = new FormData()
      fd.append('file', f)
      for (const [k, v] of Object.entries(opts())) fd.append(k, String(v))
      return upload('/admin/dats/upload', fd)
    })

  return (
    <div className="space-y-6">
      <PageHeader title={t('admin.dats')}>
        <Button size="sm" onClick={() => void importAll(true)}>
          {t('admin.importMissing')}
        </Button>
        <Button variant="outline" size="sm" onClick={() => void importAll(false)}>
          {t('admin.importAll')}
        </Button>
        <Button variant="outline" size="sm" onClick={() => void go(() => post('/admin/rematch'))}>
          {t('admin.rematch')}
        </Button>
      </PageHeader>
      {jobId && (
        <div className="max-w-xl">
          <JobProgress job={job} />
        </div>
      )}
      {batch.length > 0 && (
        <div className="max-w-xl space-y-1">
          <p className="text-sm text-muted-foreground">{t('admin.batch', { count: batch.length })}</p>
          <JobProgress job={batchJob} />
        </div>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{t('admin.importFile')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex flex-wrap gap-3">
            <Field label={t('common.system')}>
              <SystemSelect value={systemId} onChange={setSystemId} allLabel={t('admin.detect')} onlyWithData={false} />
            </Field>
            <Field label={t('admin.datType')}>
              <NativeSelect value={type} onChange={(e) => setType(e.target.value)}>
                <option value="">{t('admin.detect')}</option>
                {TYPES.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <input ref={fileRef} type="file" accept=".dat,.xml" hidden onChange={(e) => e.target.files?.[0] && void uploadFile(e.target.files[0])} />
            <Button onClick={() => fileRef.current?.click()}>{t('common.upload')} .dat / .xml</Button>
            <Field label={t('admin.localDats')}>
              <div className="flex gap-2">
                <NativeSelect value={localFile} onChange={(e) => setLocalFile(e.target.value)}>
                  <option value="">-</option>
                  {local.data?.map((f) => (
                    <option key={f}>{f}</option>
                  ))}
                </NativeSelect>
                <Button variant="outline" disabled={!localFile} onClick={() => void go(() => post('/admin/dats/import-file', { file: localFile, ...opts() }))}>
                  {t('common.apply')}
                </Button>
              </div>
            </Field>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('admin.presets')}>
              <div className="flex gap-2">
                <NativeSelect value={preset} onChange={(e) => setPreset(e.target.value)} className="max-w-md">
                  <option value="">-</option>
                  {presets.data?.map((p) => (
                    <option key={p.id} value={p.url}>
                      {p.imported ? '(OK) ' : ''}
                      {p.label}
                    </option>
                  ))}
                </NativeSelect>
                <Button variant="outline" disabled={!preset} onClick={() => void go(() => post('/admin/dats/fetch', { url: preset, ...opts() }))}>
                  {t('common.download')}
                </Button>
              </div>
            </Field>
            <Field label={t('admin.fetchUrl')}>
              <div className="flex gap-2">
                <Input className="w-96" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://raw.githubusercontent.com/..." />
                <Button variant="outline" disabled={!url} onClick={() => void go(() => post('/admin/dats/fetch', { url, ...opts() }))}>
                  {t('common.download')}
                </Button>
              </div>
            </Field>
          </div>
        </CardContent>
      </Card>
      {!data?.length ? (
        <Empty />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('common.name')}</TableHead>
              <TableHead>{t('common.system')}</TableHead>
              <TableHead>{t('admin.datType')}</TableHead>
              <TableHead>{t('admin.version')}</TableHead>
              <TableHead>{t('admin.roms')}</TableHead>
              <TableHead>{t('admin.imported')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((d) => (
              <TableRow key={d.id}>
                <TableCell>{d.name}</TableCell>
                <TableCell>{d.system.name}</TableCell>
                <TableCell>{d.type}</TableCell>
                <TableCell>{d.version ?? '-'}</TableCell>
                <TableCell>{d.romCount}</TableCell>
                <TableCell className="text-xs">{formatDate(d.importedAt)}</TableCell>
                <TableCell />
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
