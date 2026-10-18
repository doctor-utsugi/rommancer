import { useState } from 'react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Check, Minus } from 'lucide-react'
import { useAuth } from '@/lib/auth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { GuideSteps, consoleGuides } from './guides'

// Consoles that run the app, in the order people most often have them
const APP_GUIDES = ['knulli', 'onion', 'arkos', 'nextui', 'android', 'linux']
// Rows of the comparison; better names the side that wins it
const COMPARE: { key: string; better: 'app' | 'ssh' }[] = [
  { key: 'install', better: 'ssh' },
  { key: 'when', better: 'app' },
  { key: 'what', better: 'app' },
  { key: 'reach', better: 'app' },
  { key: 'consoles', better: 'ssh' },
]

/** Devices with nothing in it yet: the two ways to connect a console, a short guide for each and what sets them apart */
export function DevicesEmpty({ onNew, onSshInstall }: { onNew(connType: 'SSH' | 'LOCAL'): void; onSshInstall(): void }) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const guides = consoleGuides(t).filter((g) => APP_GUIDES.includes(g.key))
  const [pick, setPick] = useState(guides[0].key)
  const guide = guides.find((g) => g.key === pick)!
  const isAdmin = user?.role === 'ADMIN'
  return (
    <div className="max-w-5xl space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t('devices.empty.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('devices.empty.intro')}</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="space-y-1">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              {t('devices.empty.app.title')}
              <Badge>{t('devices.empty.recommended')}</Badge>
            </CardTitle>
            <p className="text-sm text-muted-foreground">{t('devices.empty.app.summary')}</p>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="space-y-2">
              <p className="font-medium">{t('devices.empty.app.pick')}</p>
              <div className="flex flex-wrap gap-1.5" role="radiogroup">
                {guides.map((g) => (
                  <Button key={g.key} size="sm" role="radio" aria-checked={g.key === pick} variant={g.key === pick ? 'default' : 'outline'} onClick={() => setPick(g.key)}>
                    {t(`more.guides.${g.key}.title`)}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">{guide.devices}</p>
            </div>
            <div className="space-y-3 rounded-lg bg-muted/50 p-3">
              <GuideSteps guide={guide} />
            </div>
            <p className="text-muted-foreground">{t('devices.empty.app.code')}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/link" />}>
                {t('more.link.title')}
              </Button>
              <Button size="sm" variant="ghost" nativeButton={false} render={<Link to="/guides" />}>
                {t('devices.empty.app.allGuides')}
              </Button>
            </div>
            {isAdmin && (
              <div className="space-y-2 border-t pt-4">
                <p className="font-medium">{t('devices.empty.app.viaSsh')}</p>
                <p className="text-muted-foreground">{t('devices.empty.app.viaSshHelp')}</p>
                <Button size="sm" variant="outline" onClick={onSshInstall}>
                  {t('more.ssh.add')}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="space-y-1">
            <CardTitle className="text-base">{t('devices.empty.ssh.title')}</CardTitle>
            <p className="text-sm text-muted-foreground">{t('devices.empty.ssh.summary')}</p>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <ol className="list-decimal space-y-1 rounded-lg bg-muted/50 p-3 pl-8">
              {(t('devices.empty.ssh.steps', { returnObjects: true }) as string[]).map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
            <p className="text-muted-foreground">{t('devices.empty.ssh.login')}</p>
            <Button size="sm" onClick={() => onNew('SSH')}>
              {t('devices.empty.ssh.add')}
            </Button>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('devices.empty.compare.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm">
            <div className="hidden border-b pb-2 text-muted-foreground sm:grid sm:grid-cols-[9rem_1fr_1fr] sm:gap-4">
              <span />
              <span className="font-medium">{t('devices.empty.compare.app')}</span>
              <span className="font-medium">{t('devices.empty.compare.ssh')}</span>
            </div>
            {COMPARE.map((row) => (
              <div key={row.key} className="grid gap-2 border-b py-3 last:border-0 sm:grid-cols-[9rem_1fr_1fr] sm:gap-4">
                <span className="font-medium">{t(`devices.empty.compare.${row.key}.label`)}</span>
                {(['app', 'ssh'] as const).map((side) => (
                  <span key={side} className="flex gap-2">
                    {row.better === side ? <Check className="mt-0.5 size-4 shrink-0 text-primary" /> : <Minus className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
                    <span>
                      <span className="text-muted-foreground sm:hidden">{t(`devices.empty.compare.${side}`)}: </span>
                      {t(`devices.empty.compare.${row.key}.${side}`)}
                    </span>
                  </span>
                ))}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>{t('devices.empty.cards')}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/guides" />}>
            {t('more.guides.pc.title')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => onNew('LOCAL')}>
            {t('devices.empty.local')}
          </Button>
        </div>
      </div>
    </div>
  )
}
