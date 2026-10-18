import { useState, type FormEvent, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Folder, FolderUp, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { ApiError, api, get, tokens } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Field, errMsg } from '@/components/common'
import i18n, { setLanguage } from '@/i18n'
import { LOCALES } from '@/i18n/locales'

export interface SetupState {
  /** No database configured yet: the server runs only the installer */
  needsDatabase: boolean
  /** The deployment ships its own MySQL, ready to use */
  bundledDatabase: boolean
  /** Database ready, no user yet */
  needsAdmin: boolean
  /** Installed from the browser: the administrator still picks the roms folder (older servers leave it out) */
  needsRoms?: boolean
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// The console installer (deploy/install.sh) checks the same, in the same order
const USERNAME = /^[a-zA-Z0-9_.-]{3,64}$/
const PUBLIC_URL = /^(https?:\/\/\S+)?$/

/** What went wrong, kept as a translation key so it follows a change of language */
interface Problem {
  key?: string
  params?: Record<string, string>
  text?: string
  detail?: string
}

const ADMIN_FIELD_ERRORS: Record<string, string> = { username: 'setup.invalidUsername', publicUrl: 'setup.badUrl' }

/** A refusal from the setup API as a problem to show: database codes and validated fields are translated */
function problemOf(err: unknown): Problem {
  if (!(err instanceof ApiError)) return { text: errMsg(err) }
  const data = err.data as { code?: string; detail?: string; issues?: { path?: (string | number)[] }[] } | undefined
  if (data?.code) return { key: `setup.errors.${data.code}`, detail: data.detail }
  const field = data?.issues?.[0]?.path?.[0]
  if (typeof field === 'string' && ADMIN_FIELD_ERRORS[field]) return { key: ADMIN_FIELD_ERRORS[field] }
  return { text: err.message }
}

function ProblemNote({ problem }: { problem: Problem | null }) {
  const { t } = useTranslation()
  return (
    <div role="alert" className="text-sm text-destructive empty:hidden">
      {problem && (problem.key ? t(problem.key, problem.params) : problem.text)}
      {problem?.detail && (
        <details className="mt-1 text-xs text-muted-foreground">
          <summary className="cursor-pointer">{t('setup.details')}</summary>
          <p className="mt-1 break-words">{problem.detail}</p>
        </details>
      )}
    </div>
  )
}

function Shell({ step, total, title, children }: { step: number; total: number; title: string; children: ReactNode }) {
  const { t } = useTranslation()
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-muted/40 p-4">
      <div className="flex w-full max-w-lg justify-end">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          {t('profile.language')}
          <select value={i18n.language} onChange={(e) => void setLanguage(e.target.value)} className="h-8 rounded-md border bg-background px-2 text-sm text-foreground">
            {LOCALES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Card className="w-full max-w-lg">
        <CardHeader>
          <div className="mb-2 flex items-center gap-2 text-lg font-semibold">
            <img src="/logo.png" alt="" className="size-7" />
            {t('app.name')}
            <span className="ml-auto text-sm font-normal text-muted-foreground">{t('setup.step', { n: step, total })}</span>
          </div>
          <CardTitle>
            <h1>{title}</h1>
          </CardTitle>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </main>
  )
}

/**
 * First run: where the database is, then the administrator (the server's settings keep their defaults), and when
 * Rommancer was installed from the browser, the folder with the roms
 */
export function SetupPage({ state }: { state: SetupState }) {
  const total = state.needsRoms ? 3 : 2
  if (state.needsDatabase) return <DatabaseStep bundled={state.bundledDatabase} total={total} />
  return state.needsAdmin ? <AdminStep total={total} /> : <RomsStep />
}

function DatabaseOption({ checked, disabled, onChange, title, hint }: { checked: boolean; disabled?: boolean; onChange: () => void; title: string; hint: string }) {
  return (
    <label
      className={`flex gap-3 rounded-lg border p-3 has-[:checked]:border-primary has-[:checked]:bg-muted/60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${disabled ? '' : 'cursor-pointer'}`}
    >
      <input type="radio" name="mode" checked={checked} disabled={disabled} onChange={onChange} className="mt-1 self-start" />
      <span>
        <span className={`font-medium ${disabled ? 'text-muted-foreground' : ''}`}>{title}</span>
        <span className="block text-sm text-muted-foreground">{hint}</span>
      </span>
    </label>
  )
}

function DatabaseStep({ bundled, total }: { bundled: boolean; total: number }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [mode, setMode] = useState<'bundled' | 'external'>(bundled ? 'bundled' : 'external')
  const [db, setDb] = useState({ host: '', port: '3306', database: 'rommancer', user: 'rommancer', password: '' })
  const [problem, setProblem] = useState<Problem | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (mode === 'external') {
      const labels = { host: 'setup.dbHost', database: 'setup.dbName', user: 'setup.dbUser' } as const
      const missing = (['host', 'database', 'user'] as const).find((k) => !db[k].trim())
      if (missing) return setProblem({ key: 'setup.required', params: { field: t(labels[missing]) } })
      const port = Number(db.port)
      if (!/^\d+$/.test(db.port) || port < 1 || port > 65535) return setProblem({ key: 'setup.badPort' })
    }
    setBusy(true)
    setProblem(null)
    try {
      await api('POST', '/setup/database', mode === 'bundled' ? { mode } : { mode, ...db, port: Number(db.port) })
      // The installer steps aside for the real server, which answers once it has started with that database
      let state: SetupState | null = null
      for (let i = 0; i < 90 && (!state || state.needsDatabase); i++) {
        await sleep(2000)
        state = await get<SetupState>('/setup').catch(() => null)
      }
      if (!state || state.needsDatabase) return setProblem({ key: 'setup.errors.db_failed' })
      qc.setQueryData(['setup'], state)
    } catch (err) {
      setProblem(problemOf(err))
    } finally {
      setBusy(false)
    }
  }
  const set = (k: keyof typeof db) => (e: React.ChangeEvent<HTMLInputElement>) => setDb({ ...db, [k]: e.target.value })
  return (
    <Shell step={1} total={total} title={t('setup.dbTitle')}>
      <form onSubmit={submit} noValidate className="grid gap-4">
        <fieldset className="grid gap-3" disabled={busy}>
          <legend className="sr-only">{t('setup.dbTitle')}</legend>
          <DatabaseOption
            checked={mode === 'bundled'}
            disabled={!bundled}
            onChange={() => setMode('bundled')}
            title={t('setup.dbBundled')}
            hint={bundled ? t('setup.dbBundledHint') : t('setup.dbBundledMissing')}
          />
          <DatabaseOption checked={mode === 'external'} onChange={() => setMode('external')} title={t('setup.dbExternal')} hint={t('setup.dbExternalHint')} />
        </fieldset>
        {mode === 'external' && (
          <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-3" disabled={busy}>
            <div className="sm:col-span-2">
              <Field label={t('setup.dbHost')}>
                <Input value={db.host} onChange={set('host')} placeholder="192.168.1.10" autoComplete="off" required autoFocus />
              </Field>
            </div>
            <Field label={t('setup.dbPort')}>
              <Input value={db.port} onChange={set('port')} inputMode="numeric" pattern="[0-9]*" required />
            </Field>
            <div className="sm:col-span-3">
              <Field label={t('setup.dbName')}>
                <Input value={db.database} onChange={set('database')} required />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:col-span-3 sm:grid-cols-2">
              <Field label={t('setup.dbUser')}>
                <Input value={db.user} onChange={set('user')} autoComplete="off" required />
              </Field>
              <Field label={t('common.password')}>
                <Input type="password" value={db.password} onChange={set('password')} autoComplete="new-password" />
              </Field>
            </div>
          </fieldset>
        )}
        <ProblemNote problem={problem} />
        <Button type="submit" disabled={busy} className="h-auto min-h-9 whitespace-normal py-2">
          {busy ? t('setup.dbConnecting') : t('setup.next')}
        </Button>
      </form>
    </Shell>
  )
}

function AdminStep({ total }: { total: number }) {
  const { t } = useTranslation()
  const { reload } = useAuth()
  const qc = useQueryClient()
  const [form, setForm] = useState({ username: 'admin', password: '', confirm: '', publicUrl: '' })
  const [problem, setProblem] = useState<Problem | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const labels = { username: 'setup.username', password: 'common.password' } as const
    const missing = (['username', 'password'] as const).find((k) => !form[k].trim())
    if (missing) return setProblem({ key: 'setup.required', params: { field: t(labels[missing]) } })
    if (!USERNAME.test(form.username)) return setProblem({ key: 'setup.invalidUsername' })
    if (form.password !== form.confirm) return setProblem({ key: 'setup.mismatch' })
    if (!PUBLIC_URL.test(form.publicUrl.trim())) return setProblem({ key: 'setup.badUrl' })
    setBusy(true)
    setProblem(null)
    try {
      const { confirm: _, ...body } = form
      const r = await api('POST', '/setup/admin', { ...body, locale: i18n.language })
      tokens.set(r.accessToken, r.refreshToken, r.filesToken, true)
      await qc.invalidateQueries({ queryKey: ['setup'] })
      await reload()
    } catch (err) {
      setProblem(problemOf(err))
    } finally {
      setBusy(false)
    }
  }
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value })
  return (
    <Shell step={2} total={total} title={t('setup.adminTitle')}>
      <form onSubmit={submit} noValidate className="grid gap-4">
        <p className="text-sm text-muted-foreground">{t('setup.adminHint')}</p>
        <fieldset className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2" disabled={busy}>
          <div className="sm:col-span-2">
            <Field label={t('setup.username')} hint={t('setup.usernameHint')}>
              <Input value={form.username} onChange={set('username')} autoComplete="username" required autoFocus />
            </Field>
          </div>
          <Field label={t('common.password')}>
            <Input type="password" value={form.password} onChange={set('password')} autoComplete="new-password" required />
          </Field>
          <Field label={t('setup.confirm')}>
            <Input type="password" value={form.confirm} onChange={set('confirm')} autoComplete="new-password" required />
          </Field>
          <div className="sm:col-span-2">
            <Field label={t('setup.publicUrl')} hint={t('setup.publicUrlHint')}>
              <Input type="url" value={form.publicUrl} onChange={set('publicUrl')} placeholder="https://roms.example.com" autoComplete="url" inputMode="url" />
            </Field>
          </div>
        </fieldset>
        <ProblemNote problem={problem} />
        <Button type="submit" disabled={busy} className="h-auto min-h-9 whitespace-normal py-2">
          {busy ? t('setup.creating') : t('setup.finish')}
        </Button>
      </form>
    </Shell>
  )
}

interface RomsState {
  pending: boolean
  /** The roms folder as the computer names it */
  current: string | null
  /** Whether the computer can mount another one (its service and watcher are installed) */
  canChange: boolean
  /** The computer's folders that can be browsed */
  roots: string[]
}


/** The installer's last step from the browser: pick the computer's folder with the roms */
function RomsStep() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const state = useQuery({ queryKey: ['setup-roms'], queryFn: () => get<RomsState>('/setup/roms') })
  const [at, setAt] = useState<string | null>(null)
  const browsing = at ?? state.data?.roots[0] ?? null
  const folders = useQuery({
    queryKey: ['setup-roms-folders', browsing],
    queryFn: () => get<{ path: string; folders: { name: string; path: string }[] }>(`/setup/roms/folders?path=${encodeURIComponent(browsing!)}`),
    enabled: !!browsing && !!state.data?.canChange,
  })
  const [problem, setProblem] = useState<Problem | null>(null)
  const [busy, setBusy] = useState<'saving' | 'restarting' | null>(null)
  const d = state.data
  const root = d?.roots.find((r) => browsing === r || browsing?.startsWith(r + '/'))
  const parent = browsing && root && browsing !== root ? browsing.slice(0, browsing.lastIndexOf('/')) || '/' : null

  const choose = async (path: string) => {
    setBusy('saving')
    setProblem(null)
    try {
      const r = await api<{ restarting: boolean; path: string }>('POST', '/setup/roms', { path })
      if (r.restarting) {
        // The computer starts Rommancer again with that folder: done once it answers with it
        setBusy('restarting')
        let now: RomsState | null = null
        for (let i = 0; i < 90 && now?.current !== r.path; i++) {
          await sleep(2000)
          now = await get<RomsState>('/setup/roms').catch(() => null)
        }
        if (now?.current !== r.path) {
          setBusy(null)
          return setProblem({ key: 'setup.romsFailed' })
        }
      }
      await qc.invalidateQueries({ queryKey: ['setup'] })
    } catch (err) {
      setBusy(null)
      setProblem(problemOf(err))
    }
  }

  if (!d) return null
  return (
    <Shell step={3} total={3} title={t('setup.romsTitle')}>
      <div className="grid gap-4">
        <p className="text-sm text-muted-foreground">{t('setup.romsHint')}</p>
        {busy === 'restarting' ? (
          <p className="flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" />
            {t('setup.romsRestarting')}
          </p>
        ) : d.canChange ? (
          <>
            <div className="flex flex-wrap gap-1.5">
              {d.roots.map((r) => (
                <Button key={r} type="button" size="sm" variant={r === root ? 'default' : 'outline'} onClick={() => setAt(r)}>
                  {r}
                </Button>
              ))}
            </div>
            <div className="rounded-lg border">
              <div className="flex items-center gap-2 border-b px-3 py-2 font-mono text-xs break-all">
                {parent && (
                  <button type="button" className="shrink-0 rounded p-1 hover:bg-muted" title={t('setup.romsUp')} aria-label={t('setup.romsUp')} onClick={() => setAt(parent)}>
                    <FolderUp className="size-4" />
                  </button>
                )}
                {browsing}
              </div>
              <ul className="max-h-64 overflow-y-auto py-1 text-sm">
                {folders.data?.folders.map((f) => (
                  <li key={f.path}>
                    <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted" onClick={() => setAt(f.path)}>
                      <Folder className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{f.name}</span>
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                    </button>
                  </li>
                ))}
                {folders.data && folders.data.folders.length === 0 && <li className="px-3 py-1.5 text-muted-foreground">{t('setup.romsEmpty')}</li>}
              </ul>
            </div>
            <ProblemNote problem={problem} />
            <Button type="button" disabled={!!busy || !browsing} onClick={() => void choose(browsing!)} className="h-auto min-h-9 whitespace-normal py-2">
              {t('setup.romsUse', { path: browsing })}
            </Button>
            {d.current && (
              <Button type="button" variant="ghost" disabled={!!busy} onClick={() => void choose(d.current!)} className="h-auto min-h-9 whitespace-normal py-2">
                {t('setup.romsKeep', { path: d.current })}
              </Button>
            )}
          </>
        ) : (
          <>
            <p className="text-sm">{t('setup.romsFixed', { path: d.current ?? '/roms' })}</p>
            <ProblemNote problem={problem} />
            <Button type="button" disabled={!!busy} onClick={() => void choose(d.current ?? '/roms')}>
              {t('setup.next')}
            </Button>
          </>
        )}
      </div>
    </Shell>
  )
}
