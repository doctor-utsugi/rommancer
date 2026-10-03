import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ImageOff, Trophy } from 'lucide-react'
import { authUrl, get, post, type Paged } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Empty, JobProgress, NativeSelect, PageHeader, Pagination, SystemSelect, useJob } from '@/components/common'
import { AddToListButton } from '@/components/add-to-list'

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
}

export function useRegions() {
  return useQuery({ queryKey: ['regions'], queryFn: () => get<string[]>('/regions'), staleTime: 300_000 })
}

export function GamesPage() {
  const { t } = useTranslation()
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
        <AddToListButton items={[...selected].map((gameId) => ({ gameId }))} />
        <Button variant="outline" size="sm" onClick={() => void scrape()} disabled={!data?.items.length}>
          {t('games.scrape')}
        </Button>
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
