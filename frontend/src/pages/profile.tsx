import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { patch, put, tokens } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import i18n, { setLanguage } from '@/i18n'
import { LOCALES } from '@/i18n/locales'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Field, NativeSelect, PageHeader, errMsg } from '@/components/common'
import { ConnectedServicesCard } from '@/components/connected-services'
import { WifiNetworksCard } from '@/components/device-config'

export function ProfilePage() {
  const { t } = useTranslation()
  const { user, reload } = useAuth()
  const [email, setEmail] = useState(user?.email ?? '')
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' })
  const locked = !!user?.mustChangePassword
  const [pwOpen, setPwOpen] = useState(locked)
  const save = async (body: Record<string, unknown>) => {
    try {
      const r = await patch<{ accessToken?: string; refreshToken?: string; filesToken?: string } | null>('/users/me', body)
      // Changing the password closes other sessions and issues new tokens
      if (r?.accessToken && r.refreshToken) tokens.set(r.accessToken, r.refreshToken, r.filesToken)
      toast.success(t('common.saved'))
      await reload()
      return true
    } catch (e) {
      toast.error(errMsg(e))
      return false
    }
  }
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title={t('profile.title')} />
      {!locked && (
        <Card>
          <CardHeader>
            <CardTitle>{t('more.services.account')}</CardTitle>
            <CardDescription>
              {user?.username} · {user?.role}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-4 md:grid-cols-[1fr_12rem]">
              <Field label={t('common.email')}>
                <div className="flex gap-2">
                  <Input value={email} onChange={(e) => setEmail(e.target.value)} />
                  <Button variant="outline" disabled={email === user?.email} onClick={() => void save({ email })}>
                    {t('common.save')}
                  </Button>
                </div>
              </Field>
              <Field label={t('profile.language')}>
                <NativeSelect
                  value={i18n.language}
                  onChange={async (e) => {
                    await setLanguage(e.target.value)
                    await save({ locale: e.target.value })
                    if (locked && user?.role === 'ADMIN') await put('/admin/settings/locale', { locale: e.target.value }).catch(() => {})
                  }}
                >
                  {LOCALES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>
            {!pwOpen && (
              <div>
                <Button variant="outline" size="sm" onClick={() => setPwOpen(true)}>
                  {t('profile.changePassword')}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
      {pwOpen && (
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
            <div className="flex gap-2">
              <Button
                disabled={!pw.newPassword}
                onClick={() =>
                  void save(pw).then((ok) => {
                    if (!ok) return
                    setPw({ currentPassword: '', newPassword: '' })
                    setPwOpen(false)
                  })
                }
              >
                {t('common.save')}
              </Button>
              {!locked && (
                <Button variant="ghost" onClick={() => (setPwOpen(false), setPw({ currentPassword: '', newPassword: '' }))}>
                  {t('common.cancel')}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}
      {!locked && <ConnectedServicesCard />}
      {!locked && <WifiNetworksCard />}
    </div>
  )
}
