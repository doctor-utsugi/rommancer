import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { get, post } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Field, JobProgress, PageHeader, SystemSelect, errMsg, useJob } from '@/components/common'

export function AdminIntegrationsPage() {
  const { t } = useTranslation()
  const tools = useQuery({ queryKey: ['tools'], queryFn: () => get<Record<string, boolean>>('/admin/tools') })
  const ra = useQuery({ queryKey: ['ra-status'], queryFn: () => get<any[]>('/ra/status') })
  const [jobId, setJobId] = useState<number | null>(null)
  const job = useJob(jobId, [['ra-status'], ['games'], ['systems']])
  const [raSystem, setRaSystem] = useState('')
  const [scrapeSystem, setScrapeSystem] = useState('')
  const [ownedOnly, setOwnedOnly] = useState(true)
  const [overwrite, setOverwrite] = useState(false)
  const go = async (fn: () => Promise<any>) => {
    try {
      setJobId((await fn()).id)
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  return (
    <div className="space-y-6">
      <PageHeader title={t('admin.integrations')} />
      {jobId && (
        <div className="max-w-xl">
          <JobProgress job={job} />
        </div>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{t('admin.tools')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {Object.entries(tools.data ?? {}).map(([k, v]) => (
            <Badge key={k} variant={v ? 'default' : 'outline'}>
              {k}: {v ? t('admin.available') : t('admin.unavailable')}
            </Badge>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('admin.seed')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">{t('admin.seedHelp')}</p>
          <div className="flex gap-2">
            <Button onClick={() => void go(() => post('/admin/seed/export'))}>{t('admin.seedExport')}</Button>
            <Button variant="outline" onClick={() => void go(() => post('/admin/seed/apply'))}>
              {t('admin.seedApply')}
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('admin.raStatus')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t('common.system')}>
              <SystemSelect value={raSystem} onChange={setRaSystem} onlyWithData={false} />
            </Field>
            <Button onClick={() => void go(() => post('/ra/sync', raSystem ? { systemId: Number(raSystem) } : {}))}>{t('admin.raSync')}</Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('common.system')}</TableHead>
                <TableHead>{t('admin.raGames')}</TableHead>
                <TableHead>{t('admin.raHashes')}</TableHead>
                <TableHead>{t('admin.raRoms')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ra.data?.map((r) => (
                <TableRow key={r.slug}>
                  <TableCell>{r.slug}</TableCell>
                  <TableCell>{r.games}</TableCell>
                  <TableCell>{r.hashes}</TableCell>
                  <TableCell>{r.roms}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('admin.scrapeSystem')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-4">
          <Field label={t('common.system')}>
            <SystemSelect value={scrapeSystem} onChange={setScrapeSystem} allLabel="-" />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={ownedOnly} onCheckedChange={(c) => setOwnedOnly(!!c)} />
            {t('lists.ownedOnly')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={overwrite} onCheckedChange={(c) => setOverwrite(!!c)} />
            {t('lists.overwrite')}
          </label>
          <Button disabled={!scrapeSystem} onClick={() => void go(() => post('/scrape', { systemId: Number(scrapeSystem), ownedOnly, overwrite }))}>
            {t('games.scrape')}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
