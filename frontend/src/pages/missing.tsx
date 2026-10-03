import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Trophy } from 'lucide-react'
import { get, type Paged } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Empty, NativeSelect, PageHeader, Pagination, SystemSelect, useSystems } from '@/components/common'
import { AddToListButton } from '@/components/add-to-list'
import { useRegions } from './games'

const DEFAULT_EXCLUDE = 'proto,beta,demo,sample,pirate,unlicensed,aftermarket'

export function MissingPage() {
  const { t } = useTranslation()
  const systems = useSystems()
  const regions = useRegions()
  const [systemId, setSystemId] = useState('')
  const [region, setRegion] = useState('')
  const [exclude, setExclude] = useState(true)
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  useEffect(() => {
    if (!systemId && systems.data) {
      const first = systems.data.find((s) => s.roms > 0)
      if (first) setSystemId(String(first.id))
    }
  }, [systems.data])
  const q = new URLSearchParams({ systemId, page: String(page), pageSize: '100', excludeFlags: exclude ? DEFAULT_EXCLUDE : '' })
  if (region) q.set('region', region)
  const { data } = useQuery({
    queryKey: ['missing', q.toString()],
    queryFn: () => get<Paged<any>>(`/missing?${q}`),
    enabled: !!systemId,
    placeholderData: keepPreviousData,
  })
  const toggle = (id: number) => {
    const s = new Set(selected)
    if (s.has(id)) s.delete(id)
    else s.add(id)
    setSelected(s)
  }
  return (
    <div>
      <PageHeader title={t('missing.title')}>
        <AddToListButton items={[...selected].map((romId) => ({ romId }))} />
      </PageHeader>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SystemSelect
          value={systemId}
          onChange={(v) => {
            setSystemId(v)
            setPage(1)
          }}
          allLabel="-"
        />
        <NativeSelect
          value={region}
          onChange={(e) => {
            setRegion(e.target.value)
            setPage(1)
          }}
        >
          <option value="">{t('games.anyRegion')}</option>
          {regions.data?.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </NativeSelect>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={exclude} onCheckedChange={(c) => setExclude(!!c)} />
          {t('missing.exclude')}
        </label>
      </div>
      {!data?.items.length ? (
        <Empty />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>{t('common.name')}</TableHead>
              <TableHead>{t('common.regions')}</TableHead>
              <TableHead>RA</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <Checkbox checked={selected.has(r.id)} onCheckedChange={() => toggle(r.id)} />
                </TableCell>
                <TableCell>
                  <Link className="hover:underline" to={`/games/${r.gameId}`}>
                    {r.name}
                  </Link>
                </TableCell>
                <TableCell>{(r.regions as string[]).join(', ')}</TableCell>
                <TableCell>
                  {r.raGameId && (
                    <Badge variant="secondary">
                      <Trophy className="size-3" />
                    </Badge>
                  )}
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
