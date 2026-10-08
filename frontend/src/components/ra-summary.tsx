import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Trophy } from 'lucide-react'
import { toast } from 'sonner'
import { get, post } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { errMsg, formatDate } from '@/components/common'

interface RaSummary {
  configured: boolean
  refreshing: boolean
  at: string | null
  profile: { user: string; pic: string | null; points: number; games: number; achievements: number; mastered: number } | null
}

export function RaSummaryCard() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['ra-me'],
    queryFn: () => get<RaSummary>('/ra/me'),
    refetchInterval: (query) => (query.state.data?.refreshing ? 3000 : false),
  })
  const [busy, setBusy] = useState(false)
  const s = q.data
  const refresh = async () => {
    setBusy(true)
    try {
      qc.setQueryData(['ra-me'], await post<RaSummary>('/ra/me/refresh'))
      void qc.invalidateQueries({ queryKey: ['games'] })
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Trophy className="size-5" /> {t('more.ra.title')}
        </CardTitle>
        <CardDescription>{t('more.ra.help')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!s?.configured ? (
          <p className="text-muted-foreground">{t('more.ra.notSet')}</p>
        ) : !s.profile ? (
          <p className="text-muted-foreground">{t('more.ra.refreshing')}</p>
        ) : (
          <div className="flex items-center gap-3">
            {s.profile.pic && <img src={s.profile.pic} alt="" className="size-12 rounded" />}
            <div>
              <p className="font-medium">
                {s.profile.user} · {t('more.ra.points', { points: s.profile.points })}
              </p>
              <p className="text-muted-foreground">{t('more.ra.summary', { achievements: s.profile.achievements, games: s.profile.games, mastered: s.profile.mastered })}</p>
              {s.at && <p className="text-xs text-muted-foreground">{t('more.ra.readAt', { when: formatDate(s.at) })}</p>}
            </div>
          </div>
        )}
        {s?.configured && (
          <Button size="sm" variant="outline" disabled={busy || s.refreshing} onClick={() => void refresh()}>
            {busy || s.refreshing ? t('more.ra.refreshing') : t('more.ra.refresh')}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
