import { useState, type FormEvent, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { api, tokens } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, NativeSelect, errMsg } from '@/components/common'
import i18n, { setLanguage } from '@/i18n'
import { LOCALES } from '@/i18n/locales'

export interface SetupState {
  /** No database configured yet: the server runs only the installer */
  needsDatabase: boolean
  /** The deployment ships its own MySQL, ready to use */
  bundledDatabase: boolean
  /** Database ready, no user yet */
  needsAdmin: boolean
}

export const SYNC_SCHEDULES = [
  { value: '0 4 * * 0', key: 'weekly' },
  { value: '0 4 * * *', key: 'daily' },
  { value: '', key: 'never' },
] as const

function Shell({ step, title, children }: { step: number; title: string; children: ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <div className="mb-2 flex items-center gap-2 text-lg font-semibold">
            <img src="/logo.png" alt="" className="size-7" />
            {t('app.name')}
            <span className="ml-auto text-sm font-normal text-muted-foreground">{t('setup.step', { n: step, total: 2 })}</span>
          </div>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
      <select
        value={i18n.language}
        onChange={(e) => void setLanguage(e.target.value)}
        aria-label={t('profile.language')}
        className="fixed right-4 top-4 h-8 rounded-md border bg-background px-2 text-sm"
      >
        {LOCALES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.name}
          </option>
        ))}
      </select>
    </div>
  )
}

/** First run: where the database is, then the administrator and the server's settings */
export function SetupPage({ state }: { state: SetupState }) {
  return state.needsDatabase ? <DatabaseStep bundled={state.bundledDatabase} /> : <AdminStep />
}

function DatabaseStep({ bundled }: { bundled: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [mode, setMode] = useState<'bundled' | 'external'>(bundled ? 'bundled' : 'external')
  const [db, setDb] = useState({ host: '', port: '3306', database: 'rommancer', user: 'rommancer', password: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api('POST', '/setup/database', mode === 'bundled' ? { mode } : { mode, ...db, port: Number(db.port) })
      await qc.invalidateQueries({ queryKey: ['setup'] })
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }
  const set = (k: keyof typeof db) => (e: React.ChangeEvent<HTMLInputElement>) => setDb({ ...db, [k]: e.target.value })
  return (
    <Shell step={1} title={t('setup.dbTitle')}>
      <form onSubmit={submit} className="grid gap-4">
        <label className={`flex gap-3 rounded-lg border p-3 ${bundled ? 'cursor-pointer' : 'opacity-50'}`}>
          <input type="radio" name="mode" checked={mode === 'bundled'} disabled={!bundled} onChange={() => setMode('bundled')} className="mt-1" />
          <span>
            <span className="font-medium">{t('setup.dbBundled')}</span>
            <span className="block text-sm text-muted-foreground">{bundled ? t('setup.dbBundledHint') : t('setup.dbBundledMissing')}</span>
          </span>
        </label>
        <label className="flex cursor-pointer gap-3 rounded-lg border p-3">
          <input type="radio" name="mode" checked={mode === 'external'} onChange={() => setMode('external')} className="mt-1" />
          <span>
            <span className="font-medium">{t('setup.dbExternal')}</span>
            <span className="block text-sm text-muted-foreground">{t('setup.dbExternalHint')}</span>
          </span>
        </label>
        {mode === 'external' && (
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Field label={t('setup.dbHost')}>
                <Input value={db.host} onChange={set('host')} placeholder="192.168.1.10" required autoFocus />
              </Field>
            </div>
            <Field label={t('setup.dbPort')}>
              <Input value={db.port} onChange={set('port')} inputMode="numeric" required />
            </Field>
            <div className="col-span-3">
              <Field label={t('setup.dbName')}>
                <Input value={db.database} onChange={set('database')} required />
              </Field>
            </div>
            <div className="col-span-3 grid grid-cols-2 gap-3">
              <Field label={t('setup.dbUser')}>
                <Input value={db.user} onChange={set('user')} autoComplete="off" required />
              </Field>
              <Field label={t('common.password')}>
                <Input type="password" value={db.password} onChange={set('password')} autoComplete="new-password" />
              </Field>
            </div>
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy}>
          {busy ? t('setup.dbConnecting') : t('setup.next')}
        </Button>
      </form>
    </Shell>
  )
}

function AdminStep() {
  const { t } = useTranslation()
  const { reload } = useAuth()
  const qc = useQueryClient()
  const [form, setForm] = useState({
    username: 'admin',
    email: '',
    password: '',
    confirm: '',
    publicUrl: window.location.origin,
    seedOnStart: true,
    externalSyncCron: SYNC_SCHEDULES[0].value as string,
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (form.password !== form.confirm) return setError(t('setup.mismatch'))
    setBusy(true)
    setError('')
    try {
      const { confirm: _, ...body } = form
      const r = await api('POST', '/setup/admin', { ...body, locale: i18n.language })
      tokens.set(r.accessToken, r.refreshToken, r.filesToken, true)
      await qc.invalidateQueries({ queryKey: ['setup'] })
      await reload()
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }
  const set = (k: 'username' | 'email' | 'password' | 'confirm' | 'publicUrl') => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value })
  return (
    <Shell step={2} title={t('setup.adminTitle')}>
      <form onSubmit={submit} className="grid gap-4">
        <p className="text-sm text-muted-foreground">{t('setup.adminHint')}</p>
        <div className="grid grid-cols-2 items-start gap-3">
          <Field label={t('setup.username')}>
            <Input value={form.username} onChange={set('username')} autoComplete="username" required autoFocus />
          </Field>
          <Field label={t('common.email')}>
            <Input type="email" value={form.email} onChange={set('email')} autoComplete="email" required />
          </Field>
          <Field label={t('common.password')} hint={t('setup.passwordMin')}>
            <Input type="password" value={form.password} onChange={set('password')} autoComplete="new-password" minLength={10} required />
          </Field>
          <Field label={t('setup.confirm')}>
            <Input type="password" value={form.confirm} onChange={set('confirm')} autoComplete="new-password" required />
          </Field>
        </div>
        <Field label={t('server.publicUrl')} hint={t('server.publicUrlHint')}>
          <Input value={form.publicUrl} onChange={set('publicUrl')} />
        </Field>
        <Field label={t('server.externalSync')} hint={t('server.externalSyncHint')}>
          <NativeSelect value={form.externalSyncCron} onChange={(e) => setForm({ ...form, externalSyncCron: e.target.value })}>
            {SYNC_SCHEDULES.map((s) => (
              <option key={s.key} value={s.value}>
                {t(`server.sync.${s.key}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox checked={form.seedOnStart} onCheckedChange={(v) => setForm({ ...form, seedOnStart: !!v })} className="mt-0.5" />
          <span>
            {t('server.seedOnStart')}
            <span className="block text-muted-foreground">{t('server.seedOnStartHint')}</span>
          </span>
        </label>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy}>
          {t('setup.finish')}
        </Button>
      </form>
    </Shell>
  )
}
