import { useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { get } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Field, errMsg } from '@/components/common'

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-2 flex items-center gap-2 text-lg font-semibold">
            <img src="/logo.png" alt="" className="size-7" />
            {t('app.name')}
          </div>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  )
}

export function LoginPage() {
  const config = useQuery({ queryKey: ['auth-config'], queryFn: () => get<{ signupOpen: boolean }>('/auth/config') })
  const [signingUp, setSigningUp] = useState(false)
  if (signingUp) return <SignupPage onBack={() => setSigningUp(false)} />
  return <LoginForm onSignup={config.data?.signupOpen ? () => setSigningUp(true) : undefined} />
}

function LoginForm({ onSignup }: { onSignup?: () => void }) {
  const { t } = useTranslation()
  const { login } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await login(username, password)
    } catch {
      setError(t('auth.invalid'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Shell title={t('auth.login')}>
      <form onSubmit={submit} className="grid gap-4">
        <Field label={t('auth.username')}>
          <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />
        </Field>
        <Field label={t('common.password')}>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </Field>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy}>
          {t('auth.login')}
        </Button>
        {onSignup && (
          <Button type="button" variant="link" onClick={onSignup}>
            {t('more.link.noAccount')}
          </Button>
        )}
      </form>
    </Shell>
  )
}

// Self-service sign-up, shown only when the admin opened it
function SignupPage({ onBack }: { onBack(): void }) {
  const { t } = useTranslation()
  const { signup } = useAuth()
  const [form, setForm] = useState({ username: '', email: '', password: '' })
  const [error, setError] = useState('')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await signup(form)
    } catch (err) {
      setError(errMsg(err))
    }
  }
  return (
    <Shell title={t('more.link.signup')}>
      <form onSubmit={submit} className="grid gap-4">
        <Field label={t('common.user')}>
          <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required minLength={3} autoFocus />
        </Field>
        <Field label={t('common.email')}>
          <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
        </Field>
        <Field label={t('common.password')} hint={t('more.link.passwordMin')}>
          <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={10} autoComplete="new-password" />
        </Field>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit">{t('more.link.signup')}</Button>
        <Button type="button" variant="link" onClick={onBack}>
          {t('more.link.haveAccount')}
        </Button>
      </form>
    </Shell>
  )
}

export function RegisterPage() {
  const { t } = useTranslation()
  const { token = '' } = useParams()
  const { register } = useAuth()
  const nav = useNavigate()
  const inv = useQuery({ queryKey: ['invitation', token], queryFn: () => get(`/auth/invitations/${token}`), retry: false })
  const [form, setForm] = useState({ username: '', email: '', password: '' })
  const [error, setError] = useState('')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await register({ token, ...form })
      nav('/')
    } catch (err) {
      setError(errMsg(err))
    }
  }
  if (inv.isError) return <Shell title={t('auth.register')}><p className="text-sm text-destructive">{t('auth.invitationInvalid')}</p></Shell>
  return (
    <Shell title={t('auth.register')}>
      <form onSubmit={submit} className="grid gap-4">
        <Field label={t('common.user')}>
          <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required minLength={3} />
        </Field>
        <Field label={t('common.email')}>
          <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
        </Field>
        <Field label={t('common.password')} hint={t('auth.passwordMin')}>
          <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={8} />
        </Field>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit">{t('auth.register')}</Button>
      </form>
    </Shell>
  )
}
