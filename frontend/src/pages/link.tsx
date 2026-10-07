import { useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { CheckCircle2 } from 'lucide-react'
import { get, post } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Field, NativeSelect, PageHeader, errMsg } from '@/components/common'

// Approves a pairing code shown by a sync client (handheld or PC)
export function LinkPage() {
  const { t } = useTranslation()
  const [params] = useSearchParams()
  const [code, setCode] = useState(params.get('code') ?? '')
  const [lookup, setLookup] = useState(params.get('code') ?? '')
  const link = useQuery({ queryKey: ['link', lookup], queryFn: () => get<any>(`/link/${encodeURIComponent(lookup)}`), enabled: !!lookup, retry: false })
  return (
    <div className="mx-auto max-w-lg space-y-6">
      <PageHeader title={t('more.link.title')} />
      <Card>
        <CardContent className="pt-6">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              setLookup(code.trim())
            }}
          >
            <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABCD-2345" className="font-mono tracking-widest" autoFocus />
            <Button type="submit">{t('more.link.find')}</Button>
          </form>
          <p className="mt-2 text-sm text-muted-foreground">{t('more.link.help')}</p>
          {link.isError && <p className="mt-2 text-sm text-destructive">{t('more.link.invalid')}</p>}
        </CardContent>
      </Card>
      {link.data && <Approve key={link.data.code} link={link.data} />}
    </div>
  )
}

function Approve({ link }: { link: any }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const consoles = useQuery({ queryKey: ['consoles'], queryFn: () => get<any[]>('/devices/consoles') })
  const firmwares = useQuery({ queryKey: ['firmwares'], queryFn: () => get<any[]>('/devices/firmwares') })
  const [form, setForm] = useState({ name: link.deviceName, consoleId: String(link.suggestedConsoleId ?? ''), firmwareId: String(link.suggestedFirmwareId ?? '') })
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      await post(`/link/${encodeURIComponent(link.code)}/approve`, { name: form.name, consoleId: Number(form.consoleId), firmwareId: Number(form.firmwareId) })
      setDone(true)
      void qc.invalidateQueries({ queryKey: ['devices'] })
    } catch (err) {
      setError(errMsg(err))
    }
  }
  if (done)
    return (
      <Card>
        <CardContent className="flex items-center gap-3 pt-6">
          <CheckCircle2 className="size-6 text-green-600" />
          <p>{t('more.link.done', { name: form.name })}</p>
        </CardContent>
      </Card>
    )
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('more.link.device', { code: link.code })}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4">
          <p className="text-sm text-muted-foreground">
            {[link.model, link.rootHint].filter(Boolean).join(' · ')}
          </p>
          <Field label={t('common.name')}>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </Field>
          <Field label={t('devices.console')}>
            <NativeSelect value={form.consoleId} onChange={(e) => setForm({ ...form, consoleId: e.target.value })} required>
              <option value="" />
              {consoles.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t('devices.firmware')}>
            <NativeSelect value={form.firmwareId} onChange={(e) => setForm({ ...form, firmwareId: e.target.value })} required>
              <option value="" />
              {firmwares.data?.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit">{t('more.link.approve')}</Button>
        </form>
      </CardContent>
    </Card>
  )
}
