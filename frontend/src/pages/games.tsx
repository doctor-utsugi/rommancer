import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ImageOff, LayoutGrid, List, Trophy } from 'lucide-react'
import { authUrl, get, post, type Paged } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Empty, JobProgress, NativeSelect, PageHeader, Pagination, SystemSelect, useJob } from '@/components/common'
import { AddToListButton } from '@/components/add-to-list'
import { useAuth } from '@/lib/auth'

interface GameRow {
  id: number
  title: string
  system: { slug: string; name: string }
  cover: string | null
  romCount: number
  ownedCount: number
  regions: string[]
  ra: boolean
  hackCount: number
  releaseYear: number | null
  unverifiedCount: number
  groupConfidence: 'high' | 'low'
}

export function useRegions() {
  return useQuery({ queryKey: ['regions'], queryFn: () => get<string[]>('/regions'), staleTime: 300_000 })
}

const VIEW_KEY = 'rommancer-games-view'
const storedView = (): 'grid' | 'list' => {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid'
  }
}

export function GamesPage() {
  // Grid of covers or a compact list, remembered in this browser
  const [view, setView] = useState<'grid' | 'list'>(storedView)
  const setViewMode = (v: 'grid' | 'list') => {
    setView(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      /* not remembered: this visit only */
    }
  }
  const { t } = useTranslation()
  const { can } = useAuth()
  const [params, setParams] = useSearchParams()
  const systemId = params.get('systemId') ?? ''
  const status = params.get('status') ?? 'all'
  const region = params.get('region') ?? ''
  const ra = params.get('ra') === '1'
  const page = Number(params.get('page') ?? 1)
  const [q, setQ] = useState(params.get('q') ?? '')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [jobId, setJobId] = useState<number | null>(null)
  const job = useJob(jobId, [['games']])
  const regions = useRegions()

  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params)
    if (v) next.set(k, v)
    else next.delete(k)
    if (k !== 'page') next.delete('page')
    setParams(next)
  }

  const query = new URLSearchParams({ page: String(page), pageSize: '60', status })
  if (systemId) query.set('systemId', systemId)
  if (params.get('q')) query.set('q', params.get('q')!)
  if (region) query.set('region', region)
  if (ra) query.set('ra', '1')
  for (const k of ['lowConfidence', 'workId', 'franchiseId']) if (params.get(k)) query.set(k, params.get(k)!)
  const { data, isFetching } = useQuery({
    queryKey: ['games', query.toString()],
    queryFn: () => get<Paged<GameRow>>(`/games?${query}`),
    placeholderData: keepPreviousData,
  })

  const toggle = (id: number) => {
    const s = new Set(selected)
    if (s.has(id)) s.delete(id)
    else s.add(id)
    setSelected(s)
  }

  const scrape = async () => {
    const ids = selected.size ? [...selected] : (data?.items.map((g) => g.id) ?? [])
    const j = await post('/scrape', { gameIds: ids })
    setJobId(j.id)
  }

  return (
    <div>
      <PageHeader title={t('games.title')}>
        <div className="flex rounded-md border">
          <Button size="icon-sm" variant={view === 'grid' ? 'secondary' : 'ghost'} onClick={() => setViewMode('grid')} aria-label={t('more.gamesList.grid')} title={t('more.gamesList.grid')}>
            <LayoutGrid className="size-4" />
          </Button>
          <Button size="icon-sm" variant={view === 'list' ? 'secondary' : 'ghost'} onClick={() => setViewMode('list')} aria-label={t('more.gamesList.list')} title={t('more.gamesList.list')}>
            <List className="size-4" />
          </Button>
        </div>
        <AddToListButton items={[...selected].map((gameId) => ({ gameId }))} />
        {can('scrape.bulk') && (
          <Button variant="outline" size="sm" onClick={() => void scrape()} disabled={!data?.items.length}>
            {t('games.scrape')}
          </Button>
        )}
      </PageHeader>
      <form
        className="mb-4 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          set('q', q)
        }}
      >
        <Input className="w-64" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('common.search')} />
        <SystemSelect value={systemId} onChange={(v) => set('systemId', v)} />
        <NativeSelect value={status} onChange={(e) => set('status', e.target.value)}>
          <option value="all">{t('games.filterAll')}</option>
          <option value="owned">{t('games.filterOwned')}</option>
          <option value="missing">{t('games.filterMissing')}</option>
          <option value="hacks">{t('games.filterHacks')}</option>
        </NativeSelect>
        <NativeSelect value={region} onChange={(e) => set('region', e.target.value)}>
          <option value="">{t('games.anyRegion')}</option>
          {regions.data?.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </NativeSelect>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={ra} onCheckedChange={(c) => set('ra', c ? '1' : '')} />
          {t('games.raOnly')}
        </label>
      </form>
      {jobId && (
        <div className="mb-4 max-w-md">
          <JobProgress job={job} />
        </div>
      )}
      {!data?.items.length && !isFetching ? (
        <Empty />
      ) : view === 'list' ? (
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-10" />
              <TableHead>{t('common.title')}</TableHead>
              <TableHead className="w-44">{t('common.system')}</TableHead>
              <TableHead className="w-20">{t('more.gamesList.year')}</TableHead>
              <TableHead className="w-32">{t('more.gamesList.regions')}</TableHead>
              <TableHead className="w-28">ROMs</TableHead>
              <TableHead className="w-40" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.items.map((g) => (
              <TableRow key={g.id}>
                <TableCell>
                  <Checkbox checked={selected.has(g.id)} onCheckedChange={() => toggle(g.id)} />
                </TableCell>
                <TableCell className="truncate font-medium" title={g.title}>
                  <Link className="hover:underline" to={`/games/${g.id}`}>
                    {g.title}
                  </Link>
                </TableCell>
                <TableCell className="truncate">{g.system.name}</TableCell>
                <TableCell>{g.releaseYear ?? ''}</TableCell>
                <TableCell className="truncate text-xs">{g.regions.join(', ')}</TableCell>
                <TableCell>
                  <Badge variant={g.ownedCount ? 'default' : 'outline'}>
                    {g.ownedCount}/{g.romCount}
                  </Badge>
                </TableCell>
                <TableCell className="space-x-1 truncate">
                  {g.ra && (
                    <Badge variant="secondary">
                      <Trophy className="size-3" />
                      RA
                    </Badge>
                  )}
                  {g.hackCount > 0 && <Badge variant="secondary">{g.hackCount} hacks</Badge>}
                  {g.unverifiedCount > 0 && <Badge variant="destructive">{g.unverifiedCount}</Badge>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {data?.items.map((g) => (
            <div key={g.id} className="group relative overflow-hidden rounded-xl border bg-card">
              <div className="absolute top-2 left-2 z-10">
                <Checkbox checked={selected.has(g.id)} onCheckedChange={() => toggle(g.id)} className="bg-background" />
              </div>
              <Link to={`/games/${g.id}`}>
                <div className="flex aspect-[3/4] items-center justify-center bg-muted">
                  {g.cover ? (
                    <img src={authUrl(g.cover)} alt="" className="h-full w-full object-contain" loading="lazy" />
                  ) : (
                    <ImageOff className="size-8 text-muted-foreground" />
                  )}
                </div>
                <div className="space-y-1 p-3">
                  <p className="line-clamp-2 text-sm font-medium" title={g.title}>
                    {g.title}
                  </p>
                  <p className="text-xs text-muted-foreground">{g.system.name}</p>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant={g.ownedCount ? 'default' : 'outline'}>{t('games.roms', { owned: g.ownedCount, count: g.romCount })}</Badge>
                    {g.ra && (
                      <Badge variant="secondary">
                        <Trophy className="size-3" />
                        RA
                      </Badge>
                    )}
                    {g.hackCount > 0 && <Badge variant="secondary">{g.hackCount} hacks</Badge>}
                    {g.unverifiedCount > 0 && <Badge variant="destructive">{t('more.tags.unverifiedCount', { count: g.unverifiedCount })}</Badge>}
                    {g.groupConfidence === 'low' && <Badge variant="outline">{t('more.tags.lowConfidence')}</Badge>}
                  </div>
                </div>
              </Link>
            </div>
          ))}
        </div>
      )}
      {data && <Pagination page={page} pageSize={data.pageSize} total={data.total} onChange={(p) => set('page', String(p))} />}
    </div>
  )
}
