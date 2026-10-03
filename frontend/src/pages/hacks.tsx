import { useState } from 'react'
import { Link } from 'react-router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'
import { get, type Paged } from '@/lib/api'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Empty, PageHeader, Pagination, SystemSelect } from '@/components/common'
import { AddToListButton } from '@/components/add-to-list'

export function HacksPage() {
  const { t } = useTranslation()
  const [systemId, setSystemId] = useState('')
  const [q, setQ] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const params = new URLSearchParams({ page: String(page), pageSize: '100' })
  if (systemId) params.set('systemId', systemId)
  if (search) params.set('q', search)
  const { data } = useQuery({ queryKey: ['hacks', params.toString()], queryFn: () => get<Paged<any>>(`/hacks?${params}`), placeholderData: keepPreviousData })
  return (
    <div>
      <PageHeader title={t('nav.hacks')} />
      <form
        className="mb-4 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          setSearch(q)
          setPage(1)
        }}
      >
        <Input className="w-64" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('common.search')} />
        <SystemSelect
          value={systemId}
          onChange={(v) => {
            setSystemId(v)
            setPage(1)
          }}
        />
      </form>
      {!data?.items.length ? (
        <Empty />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>{t('common.title')}</TableHead>
              <TableHead>{t('common.type')}</TableHead>
              <TableHead>{t('nav.games')}</TableHead>
              <TableHead>{t('game.author')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((h) => (
              <TableRow key={h.id}>
                <TableCell>{h._count.files > 0 && <Check className="size-4 text-green-600" />}</TableCell>
                <TableCell className="max-w-md truncate font-medium">{h.title}</TableCell>
                <TableCell>
                  {t(`game.hackType.${h.type}`)}
                  {h.language ? ` (${h.language})` : ''}
                </TableCell>
                <TableCell>
                  <Link className="hover:underline" to={`/games/${h.game.id}`}>
                    {h.game.title}
                  </Link>
                  <span className="text-xs text-muted-foreground"> · {h.game.system.slug}</span>
                </TableCell>
                <TableCell>{h.author ?? '-'}</TableCell>
                <TableCell>
                  <AddToListButton items={[{ hackId: h.id }]} size="icon-sm" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {data && <Pagination page={page} pageSize={data.pageSize} total={data.total} onChange={setPage} />}
    </div>
  )
}
