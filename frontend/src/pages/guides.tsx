import { useTranslation } from 'react-i18next'
import { Download } from 'lucide-react'
import { toast } from 'sonner'
import { authUrl } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/common'

interface Guide {
  key: string
  devices: string
  downloads: { label: string; href: string }[]
  command?: string
}

// One card per kind of console: what to download and the few steps to get it syncing
export function GuidesPage() {
  const { t } = useTranslation()
  const origin = window.location.origin
  const guides: Guide[] = [
    { key: 'knulli', devices: 'Anbernic RG40XX, RG35XX, RG406H…', downloads: [{ label: 'Knulli / Batocera (.zip)', href: authUrl('/link/package/knulli') }] },
    { key: 'onion', devices: 'Miyoo Mini, Miyoo Mini Plus', downloads: [{ label: 'Onion (.zip)', href: authUrl('/link/package/onion') }] },
    { key: 'arkos', devices: 'Anbernic RG353, RG503, Powkiddy RGB30…', downloads: [{ label: 'ArkOS / dArkOS (.zip)', href: authUrl('/link/package/arkos') }] },
    { key: 'nextui', devices: 'TrimUI Brick, TrimUI Smart Pro, Anbernic H700', downloads: [{ label: 'NextUI (.zip)', href: authUrl('/link/package/nextui') }] },
    { key: 'android', devices: 'AYN Thor, AYN Odin, Retroid Pocket…', downloads: [{ label: 'Android (.apk)', href: '/api/v1/link/android/rommancer-sync.apk' }] },
    {
      key: 'pc',
      devices: 'Windows, Linux',
      downloads: [
        { label: 'Windows (.exe)', href: '/api/v1/link/desktop/rommancer-desktop-setup.exe' },
        { label: 'Linux (.deb)', href: '/api/v1/link/desktop/rommancer-desktop.deb' },
        { label: 'Linux (AppImage)', href: '/api/v1/link/desktop/rommancer-desktop.AppImage' },
      ],
    },
    { key: 'sd', devices: 'Nintendo DS (TWiLight Menu++), GBA (SuperCard, EZ-Flash…)', downloads: [] },
    {
      key: 'linux',
      devices: 'muOS, ROCKNIX, PC',
      downloads: [],
      command: `wget -O rommancer-sync.sh ${origin}/api/v1/link/client.sh && sh rommancer-sync.sh link ${origin}`,
    },
    { key: 'ssh', devices: t('more.guides.ssh.devices'), downloads: [] },
  ]
  return (
    <div className="space-y-6">
      <PageHeader title={t('more.guides.title')} />
      <p className="max-w-3xl text-sm text-muted-foreground">{t('more.guides.intro')}</p>
      <div className="grid gap-4 lg:grid-cols-2">
        {guides.map((g) => (
          <Card key={g.key}>
            <CardHeader>
              <CardTitle className="text-base">{t(`more.guides.${g.key}.title`)}</CardTitle>
              <p className="text-xs text-muted-foreground">{g.devices}</p>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <ol className="list-decimal space-y-1 pl-5">
                {(t(`more.guides.${g.key}.steps`, { returnObjects: true }) as string[]).map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
              {g.command && (
                <button
                  type="button"
                  className="block w-full rounded-md bg-muted px-3 py-2 text-left font-mono text-xs break-all"
                  title={t('more.guides.copy')}
                  onClick={() => void navigator.clipboard.writeText(g.command!).then(() => toast.success(t('more.guides.copied')))}
                >
                  {g.command}
                </button>
              )}
              {g.downloads.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {g.downloads.map((d) => (
                    <Button key={d.href} size="sm" variant="outline" nativeButton={false} render={<a href={d.href} />}>
                      <Download className="size-4" />
                      {d.label}
                    </Button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
