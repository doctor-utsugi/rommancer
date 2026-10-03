import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError, get, post } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { JobProgress, JobStatusBadge, NativeSelect, PageHeader, errMsg, formatDate, useJob, useSystems, type Job } from '@/components/common'

interface SyncInfo {
  cron: string
  sources: string[]
  states: { key: string; etag: string | null; version: string | null; checkedAt: string | null; changedAt: string | null }[]
  history: Job[]
}

export function AdminSyncPage() {
  const { t } = useTranslation()
  const { data, refetch } = useQuery({ queryKey: ['admin-sync'], queryFn: () => get<SyncInfo>('/admin/sync') })
  const systems = useSystems()
  const [system, setSystem] = useState('')
  const [jobId, setJobId] = useState<number | null>(null)
  const job = useJob(jobId, [['admin-sync']])
  const [recheck, setRecheck] = useState(false)

  const run = async (sources?: string[]) => {
    try {
      const j = await post<Job>('/admin/sync', { ...(sources ? { sources } : {}), ...(system ? { system } : {}) })
      setJobId(j.id)
      void refetch()
    } catch (e) {
      const code = e instanceof ApiError ? e.message : ''
      toast.error(code === 'SYNC_RUNNING' ? t('more.sync.running') : code === 'SYNC_TOO_SOON' ? t('more.sync.tooSoon') : errMsg(e))
    }
  }
  const identify = async () => {
    const j = await post<Job>('/admin/hacks/identify', { recheck })
    setJobId(j.id)
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('more.sync.title')} />
      <Card>
        <CardHeader>
          <CardDescription>{t('more.sync.help')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm">
            {t('more.sync.cron')}: <code>{data?.cron || t('more.sync.disabled')}</code>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <NativeSelect value={system} onChange={(e) => setSystem(e.target.value)}>
              <option value="">{t('more.sync.allSystems')}</option>
              {systems.data?.map((s) => (
                <option key={s.id} value={s.slug}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
            <Button size="sm" onClick={() => void run()}>
              <RefreshCw className="size-4" />
              {t('more.sync.now')}
            </Button>
            {data?.sources.map((s) => (
              <Button key={s} size="sm" variant="outline" onClick={() => void run([s])}>
                {t(`more.sync.sources.${s}`, { defaultValue: s })}
              </Button>
            ))}
          </div>
          {jobId && (
            <div className="max-w-xl">
              <JobProgress job={job} />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('more.sync.identifyHacks')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={recheck} onCheckedChange={(c) => setRecheck(!!c)} />
            {t('more.sync.recheck')}
          </label>
          <Button size="sm" variant="outline" onClick={() => void identify()}>
            {t('common.apply')}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('more.sync.history')}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('common.date')}</TableHead>
                <TableHead>{t('more.sync.source')}</TableHead>
                <TableHead>{t('common.status')}</TableHead>
                <TableHead>{t('common.description')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.history.map((j: any) => (
                <TableRow key={j.id}>
                  <TableCell className="whitespace-nowrap">{formatDate(j.createdAt)}</TableCell>
                  <TableCell className="text-xs">
                    {(j.params?.sources ?? []).join(', ')}
                    {j.params?.system ? ` · ${j.params.system}` : ''}
                    {j.params?.trigger ? ` · ${j.params.trigger}` : ''}
                  </TableCell>
                  <TableCell>
                    <JobStatusBadge status={j.status} />
                  </TableCell>
                  <TableCell className="max-w-xl">
                    {j.result?.errors && <p className="text-xs text-destructive">{JSON.stringify(j.result.errors)}</p>}
                    {j.result && (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-muted-foreground">{t('admin.log')}</summary>
                        <pre className="max-h-60 overflow-auto rounded bg-muted p-2">{JSON.stringify(j.result, null, 1)}</pre>
                      </details>
                    )}
                    {j.status === 'FAILED' && <p className="text-xs text-destructive">{j.message}</p>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('more.sync.states')}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('more.sync.source')}</TableHead>
                <TableHead>{t('more.sync.checked')}</TableHead>
                <TableHead>{t('more.sync.changed')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.states.map((s) => (
                <TableRow key={s.key}>
                  <TableCell className="max-w-md truncate font-mono text-xs" title={s.key}>
                    {s.key}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{formatDate(s.checkedAt)}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatDate(s.changedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
