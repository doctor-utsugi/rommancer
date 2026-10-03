import { useState } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { get, post } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Empty, NativeSelect, PageHeader, errMsg } from '@/components/common'

interface Item {
  id: number
  kind: 'conflict' | 'wikidata' | 'hack'
  payload: any
  game: { id: number; title: string; system: { slug: string } } | null
  roms: { id: number; name: string; gameId: number }[]
}

export function AdminReviewPage() {
  const { t } = useTranslation()
  const [kind, setKind] = useState('')
  const { data, refetch } = useQuery({ queryKey: ['review', kind], queryFn: () => get<{ lowConfidence: number; items: Item[] }>(`/admin/review${kind ? `?kind=${kind}` : ''}`) })
  const act = async (id: number, body: Record<string, unknown>) => {
    try {
      await post(`/admin/review/${id}`, body)
      void refetch()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  return (
    <div>
      <PageHeader title={t('more.review.title')}>
        <NativeSelect value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">{t('common.all')}</option>
          <option value="conflict">{t('more.review.conflict')}</option>
          <option value="wikidata">{t('more.review.wikidata')}</option>
          <option value="hack">{t('more.review.hack')}</option>
        </NativeSelect>
      </PageHeader>
      {!!data?.lowConfidence && (
        <p className="mb-4 text-sm">
          {t('more.review.lowConfidence', { count: data.lowConfidence })}{' '}
          <Link className="text-primary underline" to="/games?lowConfidence=1">
            {t('more.review.seeLow')}
          </Link>
        </p>
      )}
      {!data?.items.length ? (
        <Empty>{t('more.review.empty')}</Empty>
      ) : (
        <div className="space-y-3">
          {data.items.map((i) => (
            <div key={i.id} className="space-y-2 rounded-lg border p-3 text-sm">
              <Badge variant="secondary">{t(`more.review.${i.kind}`)}</Badge>
              {i.kind === 'conflict' && <ConflictItem item={i} act={act} />}
              {i.kind === 'wikidata' && <WikidataItem item={i} act={act} />}
              {i.kind === 'hack' && <HackItem item={i} act={act} />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

type Act = (id: number, body: Record<string, unknown>) => Promise<void>

function ConflictItem({ item, act }: { item: Item; act: Act }) {
  const { t } = useTranslation()
  return (
    <>
      <ul className="list-disc pl-5">
        {item.roms.map((r) => (
          <li key={r.id}>
            <Link className="hover:underline" to={`/games/${r.gameId}`}>
              {r.name}
            </Link>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        {item.payload.source}: {item.payload.evidenceKey}
      </p>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void act(item.id, { action: 'same' })}>
          {t('more.review.same')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => void act(item.id, { action: 'different' })}>
          {t('more.review.different')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void act(item.id, { action: 'dismiss' })}>
          {t('more.review.dismiss')}
        </Button>
      </div>
    </>
  )
}

function WikidataItem({ item, act }: { item: Item; act: Act }) {
  const { t } = useTranslation()
  return (
    <>
      {item.game && (
        <Link className="font-medium hover:underline" to={`/games/${item.game.id}`}>
          {item.game.title} ({item.game.system.slug})
        </Link>
      )}
      <p className="text-xs text-muted-foreground">{t('more.review.candidates')}</p>
      <div className="flex flex-wrap gap-2">
        {(item.payload.candidates ?? []).map((c: any) => (
          <div key={c.qid} className="flex items-center gap-1 rounded border px-2 py-1">
            <a className="text-primary underline" href={`https://www.wikidata.org/wiki/${c.qid}`} target="_blank" rel="noreferrer">
              {c.label} {c.year ? `(${c.year})` : ''} · {c.qid}
            </a>
            <Button size="sm" variant="outline" onClick={() => void act(item.id, { action: 'link', wikidataId: c.qid })}>
              {t('more.review.link')}
            </Button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => void act(item.id, { action: 'none' })}>
          {t('more.review.none')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void act(item.id, { action: 'dismiss' })}>
          {t('more.review.dismiss')}
        </Button>
      </div>
    </>
  )
}

function HackItem({ item, act }: { item: Item; act: Act }) {
  const { t } = useTranslation()
  const [gameId, setGameId] = useState('')
  const p = item.payload
  return (
    <>
      <p className="font-medium">{p.name}</p>
      {p.candidates?.length > 0 && (
        <>
          <p className="text-xs text-muted-foreground">{t('more.review.pickBase')}</p>
          <div className="flex flex-wrap gap-2">
            {p.candidates.map((c: any) => (
              <Button key={c.romId} size="sm" variant="outline" onClick={() => void act(item.id, { action: 'link', romId: c.romId })}>
                {c.name} · {t('more.review.score', { pct: Math.round(c.score * 100) })}
              </Button>
            ))}
          </div>
        </>
      )}
      {p.codeRoms?.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {p.codeRoms.map((c: any) => (
            <Button key={c.romId} size="sm" variant="outline" onClick={() => void act(item.id, { action: 'link', romId: c.romId })}>
              {c.name}
            </Button>
          ))}
        </div>
      )}
      {p.titleSuggestions?.length > 0 && (
        <>
          <p className="text-xs text-muted-foreground">{t('more.review.titleSuggestions')}</p>
          <div className="flex flex-wrap gap-2">
            {p.titleSuggestions.map((g: any) => (
              <span key={g.id} className="flex items-center gap-1">
                <Link className="text-primary underline" to={`/games/${g.id}`}>
                  {g.title}
                </Link>
                <Button size="sm" variant="outline" onClick={() => void act(item.id, { action: 'link', gameId: g.id })}>
                  {t('more.review.link')}
                </Button>
              </span>
            ))}
          </div>
        </>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Input className="w-40" value={gameId} onChange={(e) => setGameId(e.target.value)} placeholder={t('more.review.otherGame')} inputMode="numeric" />
        <Button size="sm" variant="outline" disabled={!gameId} onClick={() => void act(item.id, { action: 'link', gameId: Number(gameId) })}>
          {t('more.review.link')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => void act(item.id, { action: 'none' })}>
          {t('more.review.none')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void act(item.id, { action: 'dismiss' })}>
          {t('more.review.dismiss')}
        </Button>
      </div>
    </>
  )
}
