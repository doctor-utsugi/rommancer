import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { patch, tokens } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import i18n from '@/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Field, NativeSelect, PageHeader, errMsg } from '@/components/common'

export function ProfilePage() {
  const { t } = useTranslation()
  const { user, reload } = useAuth()
  const [email, setEmail] = useState(user?.email ?? '')
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' })
  const [creds, setCreds] = useState({ ssUser: '', ssPassword: '', raUser: '', raApiKey: '', tgdbApiKey: '' })
  const locked = !!user?.mustChangePassword
  const save = async (body: Record<string, unknown>) => {
    try {
      const r = await patch<{ accessToken?: string; refreshToken?: string; filesToken?: string } | null>('/users/me', body)
      // Al cambiar la contrasena se cierran las otras sesiones y llegan tokens nuevos
      if (r?.accessToken && r.refreshToken) tokens.set(r.accessToken, r.refreshToken, r.filesToken)
      toast.success(t('common.saved'))
      await reload()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  const status = (ok?: boolean) => <Badge variant={ok ? 'default' : 'outline'}>{ok ? t('profile.configured') : t('profile.notConfigured')}</Badge>
  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title={t('profile.title')} />
      {!locked && (
      <Card>
        <CardHeader>
          <CardTitle>{user?.username}</CardTitle>
          <CardDescription>{user?.role}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Field label={t('common.email')}>
            <div className="flex gap-2">
              <Input value={email} onChange={(e) => setEmail(e.target.value)} />
              <Button variant="outline" onClick={() => void save({ email })}>
                {t('common.save')}
              </Button>
            </div>
          </Field>
          <Field label={t('profile.language')}>
            <NativeSelect
              value={i18n.language}
              onChange={async (e) => {
                await i18n.changeLanguage(e.target.value)
                await save({ locale: e.target.value })
              }}
            >
              <option value="es">Español</option>
              <option value="en">English</option>
            </NativeSelect>
          </Field>
        </CardContent>
      </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{t('profile.changePassword')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Field label={t('profile.currentPassword')}>
            <Input type="password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} />
          </Field>
          <Field label={t('profile.newPassword')} hint={t('profile.passwordRule')}>
            <Input type="password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} />
          </Field>
          <div>
            <Button
              disabled={pw.newPassword.length < 10}
              onClick={() =>
                void save(pw).then(() => setPw({ currentPassword: '', newPassword: '' }))
              }
            >
              {t('common.save')}
            </Button>
          </div>
        </CardContent>
      </Card>
      {!locked && (
      <Card>
        <CardHeader>
          <CardTitle>{t('profile.credentials')}</CardTitle>
          <CardDescription>{t('more.profile.credentialsHelp')}</CardDescription>
          {!user?.hasScreenScraper && user?.role !== 'ADMIN' && <p className="text-sm text-amber-600">{t('more.profile.noSs')}</p>}
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex items-center gap-2 text-sm font-medium">ScreenScraper {status(user?.hasScreenScraper)}</div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={t('profile.ssUser')}>
              <Input value={creds.ssUser} onChange={(e) => setCreds({ ...creds, ssUser: e.target.value })} autoComplete="off" />
            </Field>
            <Field label={t('profile.ssPassword')}>
              <Input type="password" value={creds.ssPassword} onChange={(e) => setCreds({ ...creds, ssPassword: e.target.value })} autoComplete="new-password" />
            </Field>
          </div>
          <div className="flex items-center gap-2 text-sm font-medium">RetroAchievements {status(user?.hasRetroAchievements)}</div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={t('profile.raUser')}>
              <Input value={creds.raUser} onChange={(e) => setCreds({ ...creds, raUser: e.target.value })} autoComplete="off" />
            </Field>
            <Field label={t('profile.raApiKey')}>
              <Input type="password" value={creds.raApiKey} onChange={(e) => setCreds({ ...creds, raApiKey: e.target.value })} autoComplete="new-password" />
            </Field>
          </div>
          <div className="flex items-center gap-2 text-sm font-medium">TheGamesDB {status(user?.hasTheGamesDb)}</div>
          <Field label={t('more.profile.tgdbApiKey')}>
            <Input type="password" value={creds.tgdbApiKey} onChange={(e) => setCreds({ ...creds, tgdbApiKey: e.target.value })} autoComplete="new-password" />
          </Field>
          <div className="flex gap-2">
            <Button
              onClick={() =>
                void save(Object.fromEntries(Object.entries(creds).filter(([, v]) => v))).then(() => setCreds({ ssUser: '', ssPassword: '', raUser: '', raApiKey: '', tgdbApiKey: '' }))
              }
            >
              {t('common.save')}
            </Button>
            <Button variant="outline" onClick={() => void save({ ssUser: null, ssPassword: null, raUser: null, raApiKey: null, tgdbApiKey: null })}>
              {t('common.delete')}
            </Button>
          </div>
        </CardContent>
      </Card>
      )}
    </div>
  )
}
