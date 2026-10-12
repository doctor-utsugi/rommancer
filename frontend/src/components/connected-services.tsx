import { useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, CircleDashed, ExternalLink, Gamepad2, Image, Trophy } from 'lucide-react'
import { toast } from 'sonner'
import { del, get, patch, post, put } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Field, errMsg, formatDate } from '@/components/common'

interface RaSummary {
  configured: boolean
  refreshing: boolean
  at: string | null
  profile: { user: string; pic: string | null; points: number; games: number; achievements: number; mastered: number } | null
}

/** One status line: done (green check) or missing (dashed circle), with its actions on the right */
function Status({ ok, title, detail, children }: { ok: boolean; title: ReactNode; detail?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {ok ? <CheckCircle2 className="size-5 shrink-0 text-emerald-600" /> : <CircleDashed className="size-5 shrink-0 text-muted-foreground" />}
      <div className="min-w-0 grow text-sm">
        <p className={ok ? 'font-medium' : 'font-medium text-muted-foreground'}>{title}</p>
        {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
      </div>
      <div className="flex gap-2">{children}</div>
    </div>
  )
}

/** A small form under a status line, with its own save and cancel */
function InlineForm({ children, onSave, onCancel, canSave, busy, saveLabel }: { children: ReactNode; onSave: () => void; onCancel: () => void; canSave: boolean; busy: boolean; saveLabel: string }) {
  const { t } = useTranslation()
  return (
    <form
      className="ml-8 grid gap-3 rounded-md border bg-muted/30 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (canSave && !busy) onSave()
      }}
    >
      {children}
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={!canSave || busy}>
          {saveLabel}
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  )
}

function useRun() {
  const [busy, setBusy] = useState(false)
  const run = async (f: () => Promise<unknown>, ok?: string) => {
    setBusy(true)
    try {
      await f()
      if (ok) toast.success(ok)
      return true
    } catch (e) {
      toast.error(errMsg(e))
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, run }
}

/**
 * RetroAchievements in one place: the account, the password the consoles log in with, and the Web API key that
 * reads the catalogue and the user's progress. Each part says whether it is set.
 */
function RetroAchievementsBlock() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { user, reload } = useAuth()
  const { busy, run } = useRun()
  const summary = useQuery({ queryKey: ['ra-me'], queryFn: () => get<RaSummary>('/ra/me'), refetchInterval: (q) => (q.state.data?.refreshing ? 3000 : false) })
  const [form, setForm] = useState<null | 'connect' | 'password' | 'key'>(null)
  const [f, setF] = useState({ username: '', password: '', key: '' })
  const [help, setHelp] = useState(false)
  const done = async () => {
    setForm(null)
    setF({ username: '', password: '', key: '' })
    await reload()
    void qc.invalidateQueries({ queryKey: ['console-settings'] })
    void qc.invalidateQueries({ queryKey: ['ra-me'] })
  }
  const raUser = user?.raUser
  const login = (username: string) => run(() => put('/settings/consoles/ra', { username, password: f.password }).then(done), t('more.services.raConnectedOk', { user: username }))
  const saveKey = () => run(() => patch('/users/me', { raApiKey: f.key.trim() }).then(done), t('more.services.raKeyOk'))
  const disconnect = () =>
    confirm(t('more.services.raDisconnectConfirm')) &&
    void run(async () => {
      await del('/settings/consoles/ra')
      await patch('/users/me', { raUser: null, raApiKey: null })
      await done()
    }, t('more.services.disconnected'))
  const s = summary.data
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Trophy className="size-5 text-amber-500" />
        <div className="grow">
          <p className="font-medium">RetroAchievements</p>
          <p className="text-xs text-muted-foreground">{raUser ? t('more.services.connectedAs', { user: raUser }) : t('more.services.notConnected')}</p>
        </div>
        {raUser ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={disconnect}>
            {t('more.services.disconnect')}
          </Button>
        ) : (
          form !== 'connect' && (
            <Button size="sm" onClick={() => setForm('connect')}>
              {t('more.services.connect')}
            </Button>
          )
        )}
      </div>

      {!raUser && form === 'connect' && (
        <InlineForm busy={busy} canSave={!!f.username.trim() && !!f.password} saveLabel={t('more.services.connect')} onCancel={() => setForm(null)} onSave={() => void login(f.username.trim())}>
          <p className="text-xs text-muted-foreground">{t('more.services.raConnectHelp')}</p>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label={t('profile.raUser')}>
              <Input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoComplete="off" autoFocus />
            </Field>
            <Field label={t('more.config.raPassword')}>
              <Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
            </Field>
          </div>
        </InlineForm>
      )}

      {raUser && (
        <div className="grid gap-3 border-l-2 pl-4">
          <Status
            ok={!!user?.raConsoles}
            title={t('more.services.raConsoles')}
            detail={user?.raConsoles ? t('more.services.raConsolesOk') : t('more.services.raConsolesMissing')}
          >
            {form !== 'password' && (
              <Button size="sm" variant={user?.raConsoles ? 'outline' : 'default'} onClick={() => setForm('password')}>
                {user?.raConsoles ? t('more.services.changePassword') : t('more.services.addPassword')}
              </Button>
            )}
          </Status>
          {form === 'password' && (
            <InlineForm busy={busy} canSave={!!f.password} saveLabel={t('more.config.raCheck')} onCancel={() => setForm(null)} onSave={() => void login(raUser)}>
              <Field label={t('more.services.passwordFor', { user: raUser })}>
                <Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" autoFocus />
              </Field>
            </InlineForm>
          )}

          <Status
            ok={!!user?.hasRetroAchievements}
            title={t('more.services.raKey')}
            detail={
              user?.hasRetroAchievements ? (
                s?.profile ? (
                  <>
                    {t('more.ra.points', { points: s.profile.points })} · {t('more.ra.summary', { achievements: s.profile.achievements, games: s.profile.games, mastered: s.profile.mastered })}
                    {s.at && <> · {t('more.ra.readAt', { when: formatDate(s.at) })}</>}
                  </>
                ) : (
                  t('more.ra.refreshing')
                )
              ) : (
                t('more.services.raKeyMissing')
              )
            }
          >
            {user?.hasRetroAchievements && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || s?.refreshing}
                onClick={() => void run(async () => qc.setQueryData(['ra-me'], await post<RaSummary>('/ra/me/refresh')))}
              >
                {s?.refreshing ? t('more.ra.refreshing') : t('more.ra.refresh')}
              </Button>
            )}
            {form !== 'key' && (
              <Button size="sm" variant={user?.hasRetroAchievements ? 'ghost' : 'default'} onClick={() => setForm('key')}>
                {user?.hasRetroAchievements ? t('more.services.change') : t('more.services.addKey')}
              </Button>
            )}
          </Status>
          {form === 'key' && (
            <InlineForm busy={busy} canSave={f.key.trim().length > 10} saveLabel={t('more.services.checkSave')} onCancel={() => setForm(null)} onSave={() => void saveKey()}>
              <Field label={t('profile.raApiKey')}>
                <Input type="password" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} autoComplete="new-password" autoFocus />
              </Field>
              <button type="button" className="justify-self-start text-xs text-primary underline underline-offset-2" onClick={() => setHelp(true)}>
                {t('more.profile.raKeyWhere')}
              </button>
            </InlineForm>
          )}
        </div>
      )}

      <Dialog open={help} onOpenChange={setHelp}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('more.profile.raKeyTitle')}</DialogTitle>
            <DialogDescription>{t('more.profile.raKeyIntro')}</DialogDescription>
          </DialogHeader>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            {(t('more.profile.raKeySteps', { returnObjects: true }) as string[]).map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
          <DialogFooter cancel={false}>
            <Button variant="outline" nativeButton={false} render={<a href="https://retroachievements.org/controlpanel.php" target="_blank" rel="noreferrer" />}>
              <ExternalLink className="size-4" />
              {t('more.profile.raKeyOpen')}
            </Button>
            <Button onClick={() => setHelp(false)}>{t('more.profile.raKeyDone')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** A service that only needs one or two credentials kept: connected (and as whom) or not, change, disconnect */
function SimpleService({
  icon,
  name,
  help,
  connected,
  connectedLabel,
  fields,
  clear,
  steps,
  check,
}: {
  icon: ReactNode
  name: string
  help: string
  connected: boolean
  connectedLabel: string
  fields: { key: string; label: string; secret?: boolean }[]
  clear: Record<string, null>
  /** How to get the account or key, with links */
  steps: { text: string; href?: string }[]
  /** Whether the saved credentials work, tried live by the server (undefined while it tries) */
  check: { ok: boolean; error: string | null } | null | undefined
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { reload } = useAuth()
  const { busy, run } = useRun()
  const [open, setOpen] = useState(false)
  const [v, setV] = useState<Record<string, string>>({})
  const save = () =>
    run(async () => {
      await patch('/users/me', Object.fromEntries(Object.entries(v).filter(([, x]) => x.trim())))
      setOpen(false)
      setV({})
      await reload()
      void qc.invalidateQueries({ queryKey: ['services-check'] })
    }, t('common.saved'))
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        {icon}
        <div className="grow">
          <p className="font-medium">{name}</p>
          <p className="text-xs text-muted-foreground">
            {connected ? connectedLabel : t('more.services.notConnected')}
            {connected && check === undefined && ` · ${t('more.services.checking')}`}
          </p>
          {connected && check && (
            <p className={`text-xs ${check.ok ? 'text-emerald-600' : 'text-destructive'}`}>{check.ok ? t('more.services.works') : t('more.services.fails', { error: check.error })}</p>
          )}
        </div>
        {!open && (
          <Button size="sm" variant={connected ? 'outline' : 'default'} onClick={() => setOpen(true)}>
            {connected ? t('more.services.change') : t('more.services.connect')}
          </Button>
        )}
        {connected && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => confirm(t('more.services.disconnectConfirm', { name })) && void run(() => patch('/users/me', clear).then(reload), t('more.services.disconnected'))}
          >
            {t('more.services.disconnect')}
          </Button>
        )}
      </div>
      {open && (
        <InlineForm busy={busy} canSave={fields.every((x) => (v[x.key] ?? '').trim())} saveLabel={t('common.save')} onCancel={() => (setOpen(false), setV({}))} onSave={() => void save()}>
          <p className="text-xs text-muted-foreground">{help}</p>
          <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
            {steps.map((s) => (
              <li key={s.text}>
                {s.href ? (
                  <a className="inline-flex items-center gap-1 text-primary underline" href={s.href} target="_blank" rel="noreferrer">
                    {s.text}
                    <ExternalLink className="size-3" />
                  </a>
                ) : (
                  s.text
                )}
              </li>
            ))}
          </ol>
          <div className="grid gap-3 md:grid-cols-2">
            {fields.map((x, i) => (
              <Field key={x.key} label={x.label}>
                <Input type={x.secret ? 'password' : 'text'} value={v[x.key] ?? ''} onChange={(e) => setV({ ...v, [x.key]: e.target.value })} autoComplete={x.secret ? 'new-password' : 'off'} autoFocus={i === 0} />
              </Field>
            ))}
          </div>
        </InlineForm>
      )}
    </div>
  )
}

export function ConnectedServicesCard() {
  const { t } = useTranslation()
  const { user } = useAuth()
  const any = !!user?.hasScreenScraper || !!user?.hasTheGamesDb
  const { data: check } = useQuery({ queryKey: ['services-check'], queryFn: () => get<any>('/users/me/services'), enabled: any, staleTime: 5 * 60_000 })
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('more.services.title')}</CardTitle>
        <CardDescription>{t('more.services.help')}</CardDescription>
      </CardHeader>
      <CardContent className="grid divide-y [&>*]:py-5 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
        <RetroAchievementsBlock />
        <SimpleService
          icon={<Image className="size-5 text-sky-600" />}
          name="ScreenScraper"
          help={t('more.services.ssHelp')}
          connected={!!user?.hasScreenScraper}
          connectedLabel={t('more.services.connectedAs', { user: user?.ssUser ?? '' })}
          fields={[
            { key: 'ssUser', label: t('profile.ssUser') },
            { key: 'ssPassword', label: t('profile.ssPassword'), secret: true },
          ]}
          clear={{ ssUser: null, ssPassword: null }}
          steps={[
            { text: t('more.services.ssStep1'), href: 'https://www.screenscraper.fr/membreinscription.php' },
            { text: t('more.services.ssStep2') },
            { text: t('more.services.ssStep3') },
          ]}
          check={check ? check.screenscraper : undefined}
        />
        <SimpleService
          icon={<Gamepad2 className="size-5 text-violet-600" />}
          name="TheGamesDB"
          help={t('more.services.tgdbHelp')}
          connected={!!user?.hasTheGamesDb}
          connectedLabel={t('more.services.keySaved')}
          fields={[{ key: 'tgdbApiKey', label: t('more.profile.tgdbApiKey'), secret: true }]}
          clear={{ tgdbApiKey: null }}
          steps={[
            { text: t('more.services.tgdbStep1'), href: 'https://forums.thegamesdb.net/ucp.php?mode=register' },
            { text: t('more.services.tgdbStep2'), href: 'https://api.thegamesdb.net/key.php' },
            { text: t('more.services.tgdbStep3') },
          ]}
          check={check ? check.thegamesdb : undefined}
        />
      </CardContent>
    </Card>
  )
}
