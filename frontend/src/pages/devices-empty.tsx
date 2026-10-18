import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Check, ChevronRight, Download, HardDrive, Minus, Terminal, Wifi } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { consoleGuides, type Guide } from './guides'

type Way = 'app' | 'pc' | 'ssh'

const WAYS: { key: Way; icon: typeof Wifi }[] = [
  { key: 'app', icon: Wifi },
  { key: 'pc', icon: HardDrive },
  { key: 'ssh', icon: Terminal },
]
// Consoles that run the app, in the order people most often have them
const APP_GUIDES = ['knulli', 'onion', 'arkos', 'nextui', 'android', 'linux']
// Rows of the comparison and which ways win each
const COMPARE: { key: string; better: Way[] }[] = [
  { key: 'install', better: ['pc', 'ssh'] },
  { key: 'when', better: ['app'] },
  { key: 'what', better: ['app', 'pc'] },
  { key: 'needs', better: ['pc'] },
]

function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="space-y-3">
      {items.map((s, i) => (
        <li key={i} className="flex gap-3 text-sm">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">{i + 1}</span>
          <div className="min-w-0 flex-1 space-y-2 pt-0.5">{s}</div>
        </li>
      ))}
    </ol>
  )
}

/**
 * Devices with nothing in it yet: first how the console will connect (its own app, through the computer's app, or
 * SSH), then only that way's few steps. The comparison stays folded until asked for.
 */
export function DevicesEmpty({ onNew, onSshInstall }: { onNew(connType: 'SSH' | 'LOCAL'): void; onSshInstall(): void }) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const isAdmin = user?.role === 'ADMIN'
  const [way, setWay] = useState<Way | null>(null)
  const all = consoleGuides(t)
  const appGuides = all.filter((g) => APP_GUIDES.includes(g.key))
  const pcGuide = all.find((g) => g.key === 'pc')!
  const [firmware, setFirmware] = useState<string | null>(null)
  const guide = appGuides.find((g) => g.key === firmware)
  const k = (key: string) => t(`devices.empty.${key}`)
  // The firmware's guide as steps of their own: its download under the first, its command under the second
  const guideSteps = (g: Guide): ReactNode[] => [
    ...(t(`more.guides.${g.key}.steps`, { returnObjects: true }) as string[]).map((text, i) => (
      <>
        <p>{text}</p>
        {i === 0 && g.downloads.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {g.downloads.map((d) => (
              <Button key={d.href} size="sm" variant="outline" nativeButton={false} render={<a href={d.href} />}>
                <Download className="size-4" />
                {d.label}
              </Button>
            ))}
          </div>
        )}
        {i === 1 && g.command && (
          <button
            type="button"
            className="block w-full rounded-md bg-muted px-3 py-2 text-left font-mono text-xs break-all"
            title={t('more.guides.copy')}
            onClick={() => void navigator.clipboard.writeText(g.command!).then(() => toast.success(t('more.guides.copied')))}
          >
            {g.command}
          </button>
        )}
        {i === 2 && g.key === 'linux' && (
          <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/link" />}>
            {t('more.link.title')}
          </Button>
        )}
      </>
    )),
    <p className="text-muted-foreground">{k('app.appears')}</p>,
  ]

  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{k('title')}</h2>
        <p className="text-sm text-muted-foreground">{way ? k(`${way}.summary`) : k('intro')}</p>
      </div>

      {!way ? (
        <>
          <div className="grid gap-3" role="list">
            {WAYS.map(({ key, icon: Icon }) => (
              <button
                key={key}
                type="button"
                role="listitem"
                onClick={() => setWay(key)}
                className="group flex items-center gap-4 rounded-xl border p-4 text-left transition-colors hover:border-foreground/30 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <Icon className="size-5" />
                </span>
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="flex flex-wrap items-center gap-2 font-medium">
                    {k(`${key}.title`)}
                    {key === 'app' && <Badge>{k('recommended')}</Badge>}
                  </span>
                  <span className="block text-sm text-muted-foreground">{k(`${key}.pitch`)}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </button>
            ))}
          </div>
          <details className="group rounded-xl border text-sm">
            <summary className="cursor-pointer px-4 py-3 font-medium">{k('compare.title')}</summary>
            <div className="border-t px-4 pb-2">
              <div className="hidden gap-4 py-2 text-muted-foreground sm:grid sm:grid-cols-[8rem_1fr_1fr_1fr]">
                <span />
                {WAYS.map((w) => (
                  <span key={w.key} className="font-medium">
                    {k(`${w.key}.short`)}
                  </span>
                ))}
              </div>
              {COMPARE.map((row) => (
                <div key={row.key} className="grid gap-2 border-t py-3 sm:grid-cols-[8rem_1fr_1fr_1fr] sm:gap-4">
                  <span className="font-medium">{k(`compare.${row.key}.label`)}</span>
                  {WAYS.map((w) => (
                    <span key={w.key} className="flex gap-2">
                      {row.better.includes(w.key) ? <Check className="mt-0.5 size-4 shrink-0 text-primary" /> : <Minus className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
                      <span>
                        <span className="text-muted-foreground sm:hidden">{k(`${w.key}.short`)}: </span>
                        {k(`compare.${row.key}.${w.key}`)}
                      </span>
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </details>
        </>
      ) : (
        <div className="space-y-5 rounded-xl border p-5">
          <button
            type="button"
            onClick={() => {
              setWay(null)
              setFirmware(null)
            }}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            {k('back')}
          </button>
          <h3 className="font-semibold">{k(`${way}.title`)}</h3>

          {way === 'app' && (
            <Steps
              items={[
                <>
                  <p>{k('app.pick')}</p>
                  <div className="flex flex-wrap gap-1.5" role="radiogroup">
                    {appGuides.map((g) => (
                      <Button key={g.key} size="sm" role="radio" aria-checked={g.key === firmware} variant={g.key === firmware ? 'default' : 'outline'} onClick={() => setFirmware(g.key)}>
                        {t(`more.guides.${g.key}.title`)}
                      </Button>
                    ))}
                  </div>
                  {guide && <p className="text-xs text-muted-foreground">{guide.devices}</p>}
                </>,
                ...(guide ? guideSteps(guide) : []),
              ]}
            />
          )}
          {way === 'app' && isAdmin && (
            <p className="border-t pt-4 text-sm text-muted-foreground">
              {k('app.viaSsh')}{' '}
              <button type="button" className="font-medium text-foreground underline underline-offset-4" onClick={onSshInstall}>
                {t('more.ssh.add')}
              </button>
            </p>
          )}

          {way === 'pc' && (
            <>
              <Steps
                items={[
                  <>
                    <p>{k('pc.install')}</p>
                    <div className="flex flex-wrap gap-2">
                      {pcGuide.downloads.map((d) => (
                        <Button key={d.href} size="sm" variant="outline" nativeButton={false} render={<a href={d.href} />}>
                          <Download className="size-4" />
                          {d.label}
                        </Button>
                      ))}
                    </div>
                  </>,
                  <>
                    <p>{k('pc.signIn')}</p>
                    <button
                      type="button"
                      className="rounded-md bg-muted px-3 py-1.5 font-mono text-xs"
                      title={t('more.guides.copy')}
                      onClick={() => void navigator.clipboard.writeText(location.origin).then(() => toast.success(t('more.guides.copied')))}
                    >
                      {location.origin}
                    </button>
                  </>,
                  <p>{k('pc.insert')}</p>,
                  <p>{k('pc.link')}</p>,
                ]}
              />
              <p className="border-t pt-4 text-sm text-muted-foreground">{k('pc.allConsoles')}</p>
              <p className="text-sm text-muted-foreground">
                {k('pc.local')}{' '}
                <button type="button" className="font-medium text-foreground underline underline-offset-4" onClick={() => onNew('LOCAL')}>
                  {k('pc.localAdd')}
                </button>
              </p>
            </>
          )}

          {way === 'ssh' && (
            <>
              <Steps items={[<p>{k('ssh.on')}</p>, <p>{k('ssh.add')}</p>, <p>{k('ssh.test')}</p>, <p>{k('ssh.sync')}</p>]} />
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">{k('ssh.loginsTitle')}</summary>
                <p className="mt-2 text-muted-foreground">{k('ssh.logins')}</p>
              </details>
              <Button onClick={() => onNew('SSH')}>{k('ssh.button')}</Button>
            </>
          )}
        </div>
      )}
      <p className={cn('text-sm text-muted-foreground', way && 'hidden')}>
        <Link to="/guides" className="underline underline-offset-4">
          {t('more.guides.title')}
        </Link>
      </p>
    </div>
  )
}
