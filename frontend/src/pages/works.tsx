import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Check, ImageOff, X } from 'lucide-react'
import { authUrl, get } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Empty, PageHeader } from '@/components/common'
import { AddToListButton } from '@/components/add-to-list'

export function WorkPage() {
  const { id } = useParams()
  const { t } = useTranslation()
  const { data: w } = useQuery({ queryKey: ['work', id], queryFn: () => get(`/works/${id}`) })
  if (!w) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
  return (
    <div>
      <PageHeader title={w.title}>
        <AddToListButton items={[{ workId: w.id }]} />
      </PageHeader>
      <div className="mb-6 flex flex-wrap gap-3 text-sm text-muted-foreground">
        {w.releaseYear && <span>{w.releaseYear}</span>}
        {w.franchise && (
          <Link className="text-primary underline" to={`/franchises/${w.franchise.id}`}>
            {t('more.tags.franchise')}: {w.franchise.name}
          </Link>
        )}
        {w.wikidataId && (
          <a className="text-primary underline" href={`https://www.wikidata.org/wiki/${w.wikidataId}`} target="_blank" rel="noreferrer">
            {w.wikidataId}
          </a>
        )}
      </div>
      <h2 className="mb-3 font-medium">{t('more.works.platforms')}</h2>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-5">
        {w.games.map((g: any) => (
          <Link key={g.id} to={`/games/${g.id}`} className="overflow-hidden rounded-xl border bg-card">
            <div className="flex aspect-[3/4] items-center justify-center bg-muted">
              {g.cover ? <img src={authUrl(g.cover)} alt="" className="h-full w-full object-contain" loading="lazy" /> : <ImageOff className="size-8 text-muted-foreground" />}
            </div>
            <div className="space-y-1 p-3 text-sm">
              <p className="font-medium">{g.title}</p>
              <p className="text-xs text-muted-foreground">{g.system.name}</p>
              <Badge variant={g.owned ? 'default' : 'outline'}>{g.owned ? t('common.owned') : t('common.missing')}</Badge>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}

export function FranchisesPage() {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const { data } = useQuery({ queryKey: ['franchises', q], queryFn: () => get<any[]>(`/franchises?q=${encodeURIComponent(q)}`) })
  return (
    <div>
      <PageHeader title={t('more.works.franchises')}>
        <Input className="w-64" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('common.search')} />
      </PageHeader>
      {!data?.length ? (
        <Empty>{t('more.works.none')}</Empty>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((f) => (
            <Link key={f.id} to={`/franchises/${f.id}`} className="rounded-lg border p-3 text-sm hover:bg-muted">
              <p className="font-medium">{f.name}</p>
              <p className="text-xs text-muted-foreground">{t('more.works.worksCount', { count: f._count.works })}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

export function FranchisePage() {
  const { id } = useParams()
  const { t } = useTranslation()
  const { data: f } = useQuery({ queryKey: ['franchise', id], queryFn: () => get(`/franchises/${id}`) })
  if (!f) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
  return (
    <div>
      <PageHeader title={f.name} />
      <div className="space-y-3">
        {f.works.map((w: any) => (
          <div key={w.id} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Link to={`/works/${w.id}`} className="font-medium hover:underline">
                {w.title} {w.releaseYear && <span className="text-sm text-muted-foreground">({w.releaseYear})</span>}
              </Link>
              <AddToListButton items={[{ workId: w.id }]} size="icon-sm" />
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {w.games.map((g: any) => (
                <Link key={g.id} to={`/games/${g.id}`}>
                  <Badge variant={g.owned ? 'default' : 'outline'}>
                    {g.owned ? <Check className="size-3" /> : <X className="size-3" />}
                    {g.system.slug}
                  </Badge>
                </Link>
              ))}
            </div>
            {w.missingPlatforms.length > 0 && w.missingPlatforms.length < w.games.length && (
              <p className="mt-1 text-xs text-muted-foreground">{t('more.works.missingPlatforms', { list: w.missingPlatforms.join(', ') })}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
