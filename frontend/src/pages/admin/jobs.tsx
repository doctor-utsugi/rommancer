import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { get } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { JobStatusBadge, PageHeader, formatDate, type Job } from '@/components/common'

export function AdminJobsPage() {
  const { t } = useTranslation()
  const { data } = useQuery({ queryKey: ['jobs'], queryFn: () => get<Job[]>('/jobs?limit=100'), refetchInterval: 2000 })
  const [open, setOpen] = useState<number | null>(null)
  const detail = useQuery({ queryKey: ['job-detail', open], queryFn: () => get<Job>(`/jobs/${open}`), enabled: !!open, refetchInterval: 2000 })
  return (
    <div>
      <PageHeader title={t('admin.jobs')} />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>#</TableHead>
            <TableHead>{t('common.type')}</TableHead>
            <TableHead>{t('common.status')}</TableHead>
            <TableHead className="w-64" />
            <TableHead>{t('common.date')}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {data?.map((j) => (
            <TableRow key={j.id}>
              <TableCell>{j.id}</TableCell>
              <TableCell>{t(`jobs.types.${j.type}`, { defaultValue: j.type })}</TableCell>
              <TableCell>
                <JobStatusBadge status={j.status} />
              </TableCell>
              <TableCell>
                {j.status === 'RUNNING' && j.total > 0 && <Progress value={(j.processed / j.total) * 100} />}
                <p className="max-w-64 truncate text-xs text-muted-foreground">{j.message}</p>
              </TableCell>
              <TableCell className="text-xs">{formatDate(j.createdAt)}</TableCell>
              <TableCell>
                <Button variant="outline" size="sm" onClick={() => setOpen(j.id)}>
                  {t('admin.log')}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>#{open}</DialogTitle>
          </DialogHeader>
          {detail.data?.result && <pre className="max-h-48 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(detail.data.result, null, 1)}</pre>}
          <pre className="max-h-[50vh] overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">{detail.data?.log ?? ''}</pre>
          <DialogFooter cancel="close" />
        </DialogContent>
      </Dialog>
    </div>
  )
}
