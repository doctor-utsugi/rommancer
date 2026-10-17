import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { get, put } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Field, NativeSelect, PageHeader, errMsg } from '@/components/common'

// Ready-made schedules for the external sync (deploy/install.sh does not ask: the installer keeps the default)
export const SYNC_SCHEDULES = [
  { value: '0 4 * * 0', key: 'weekly' },
  { value: '0 4 * * *', key: 'daily' },
  { value: '', key: 'never' },
] as const

export interface ServerSettings {
  publicUrl: string
  corsOrigins: string
  externalSyncCron: string
  forceSyncMinMinutes: number
  seedOnStart: boolean
  seedAutoExport: boolean
  screenscraperDevId: string
  /** Write-only: true when one is stored */
  screenscraperDevPassword: boolean
}

type Form = Omit<ServerSettings, 'screenscraperDevPassword'> & { screenscraperDevPassword: string }

/** The server's own settings; one the deployment fixes by an environment variable shows it and cannot be changed here */
export function AdminServerPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['server-settings'], queryFn: () => get<{ values: ServerSettings; locked: string[] }>('/admin/settings/server') })
  const [form, setForm] = useState<Form | null>(null)
  const [custom, setCustom] = useState(false)
  useEffect(() => {
    if (!q.data) return
    setForm({ ...q.data.values, screenscraperDevPassword: '' })
    setCustom(!SYNC_SCHEDULES.some((s) => s.value === q.data.values.externalSyncCron))
  }, [q.data])
  if (!form || !q.data) return null
  const locked = (k: keyof ServerSettings) => q.data.locked.includes(k)
  const lockHint = (k: keyof ServerSettings) => (locked(k) ? t('server.locked') : undefined)
  const save = async () => {
    try {
      const { screenscraperDevPassword, ...rest } = form
      await put('/admin/settings/server', { ...rest, ...(screenscraperDevPassword ? { screenscraperDevPassword } : {}) })
      toast.success(t('common.saved'))
      void qc.invalidateQueries({ queryKey: ['server-settings'] })
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  const text = (k: 'publicUrl' | 'corsOrigins' | 'screenscraperDevId' | 'screenscraperDevPassword') => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value })
  return (
    <div className="space-y-6">
      <PageHeader title={t('server.title')}>
        <Button onClick={() => void save()}>{t('common.save')}</Button>
      </PageHeader>
      <Card>
        <CardHeader>
          <CardTitle>{t('server.access')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Field label={t('server.publicUrl')} hint={lockHint('publicUrl') ?? t('server.publicUrlHint')}>
            <Input value={form.publicUrl} onChange={text('publicUrl')} disabled={locked('publicUrl')} placeholder={location.origin} />
          </Field>
          <Field label={t('server.corsOrigins')} hint={lockHint('corsOrigins') ?? t('server.corsOriginsHint')}>
            <Input value={form.corsOrigins} onChange={text('corsOrigins')} disabled={locked('corsOrigins')} />
          </Field>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('server.sources')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Field label={t('server.externalSync')} hint={lockHint('externalSyncCron') ?? t('server.externalSyncHint')}>
            <NativeSelect
              value={custom ? 'custom' : form.externalSyncCron}
              disabled={locked('externalSyncCron')}
              onChange={(e) => {
                const custom = e.target.value === 'custom'
                setCustom(custom)
                if (!custom) setForm({ ...form, externalSyncCron: e.target.value })
              }}
            >
              {SYNC_SCHEDULES.map((s) => (
                <option key={s.key} value={s.value}>
                  {t(`server.sync.${s.key}`)}
                </option>
              ))}
              <option value="custom">{t('server.sync.custom')}</option>
            </NativeSelect>
          </Field>
          {custom && (
            <Field label={t('server.cron')} hint={t('server.cronHint')}>
              <Input value={form.externalSyncCron} onChange={(e) => setForm({ ...form, externalSyncCron: e.target.value })} disabled={locked('externalSyncCron')} className="font-mono" />
            </Field>
          )}
          <Field label={t('server.forceSyncMin')} hint={lockHint('forceSyncMinMinutes')}>
            <Input type="number" min={0} value={form.forceSyncMinMinutes} onChange={(e) => setForm({ ...form, forceSyncMinMinutes: Number(e.target.value) })} disabled={locked('forceSyncMinMinutes')} className="w-32" />
          </Field>
          <Toggle label={t('server.seedOnStart')} hint={lockHint('seedOnStart') ?? t('server.seedOnStartHint')} checked={form.seedOnStart} disabled={locked('seedOnStart')} onChange={(v) => setForm({ ...form, seedOnStart: v })} />
          <Toggle label={t('server.seedAutoExport')} hint={lockHint('seedAutoExport') ?? t('server.seedAutoExportHint')} checked={form.seedAutoExport} disabled={locked('seedAutoExport')} onChange={(v) => setForm({ ...form, seedAutoExport: v })} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('server.screenscraper')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-sm text-muted-foreground">{t('server.screenscraperHint')}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('server.devId')} hint={lockHint('screenscraperDevId')}>
              <Input value={form.screenscraperDevId} onChange={text('screenscraperDevId')} disabled={locked('screenscraperDevId')} autoComplete="off" />
            </Field>
            <Field label={t('server.devPassword')} hint={lockHint('screenscraperDevPassword') ?? (q.data.values.screenscraperDevPassword ? t('server.stored') : undefined)}>
              <Input type="password" value={form.screenscraperDevPassword} onChange={text('screenscraperDevPassword')} disabled={locked('screenscraperDevPassword')} autoComplete="new-password" />
            </Field>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function Toggle({ label, hint, checked, disabled, onChange }: { label: string; hint?: string; checked: boolean; disabled?: boolean; onChange(v: boolean): void }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="font-medium">{label}</p>
        {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  )
}
