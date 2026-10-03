import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Empty, PageHeader, useSystems } from '@/components/common'

export function DashboardPage() {
  const { t } = useTranslation()
  const { data, isLoading } = useSystems()
  const systems = (data ?? []).filter((s) => s.roms > 0 || s.files.unknown > 0)
  const totals = systems.reduce(
    (a, s) => ({ games: a.games + s.games, roms: a.roms + s.roms, owned: a.owned + s.owned, hacks: a.hacks + s.hacks }),
    { games: 0, roms: 0, owned: 0, hacks: 0 },
  )
  return (
    <div>
      <PageHeader title={t('dashboard.title')} />
      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : !systems.length ? (
        <Empty>{t('dashboard.noData')}</Empty>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
            {(
              [
                ['games', totals.games],
                ['roms', totals.roms],
                ['owned', totals.owned],
                ['hacks', totals.hacks],
              ] as const
            ).map(([k, v]) => (
              <Card key={k}>
                <CardHeader className="pb-1">
                  <CardTitle className="text-sm font-medium text-muted-foreground">{t(`dashboard.${k}`)}</CardTitle>
                </CardHeader>
                <CardContent className="text-2xl font-semibold">{v.toLocaleString()}</CardContent>
              </Card>
            ))}
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {systems.map((s) => {
              const pct = s.roms ? (s.owned / s.roms) * 100 : 0
              return (
                <Link key={s.id} to={`/games?systemId=${s.id}&status=owned`}>
                  <Card className="transition-colors hover:bg-muted/50">
                    <CardHeader>
                      <CardTitle className="flex items-center justify-between">
                        <span>{s.name}</span>
                        <span className="text-sm font-normal text-muted-foreground">{s.manufacturer}</span>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span>
                          {t('dashboard.owned')}: {s.owned.toLocaleString()} / {s.roms.toLocaleString()}
                        </span>
                        <span className="text-muted-foreground">{pct.toFixed(1)}%</span>
                      </div>
                      <Progress value={pct} />
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>
                          {t('dashboard.hacks')}: {s.files.hack} / {s.hacks}
                        </span>
                        {s.files.unverified > 0 && <span>{t('more.tags.unverifiedCount', { count: s.files.unverified })}</span>}
                        <span>
                          {t('dashboard.unknown')}: {s.files.unknown}
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
