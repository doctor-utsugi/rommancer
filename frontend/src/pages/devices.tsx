import { useState } from 'react'
import { Link } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Pencil, Plug, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { authUrl, del, get, patch, post, tokens } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Empty, Field, JobProgress, NativeSelect, PageHeader, errMsg, formatDate, useJob, useSystems } from '@/components/common'

export function DevicesPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['devices'], queryFn: () => get<any[]>('/devices') })
  const [editing, setEditing] = useState<any | null | undefined>(undefined)
  const [jobId, setJobId] = useState<number | null>(null)
  const job = useJob(jobId, [['devices'], ['saves']])
  const { can, user } = useAuth()
  const [sshAdd, setSshAdd] = useState(false)
  const [scripts, setScripts] = useState<any | null>(null)
  const revoke = async (id: number) => {
    await del(`/devices/${id}/token`)
    toast.success(t('common.saved'))
  }

  const test = async (id: number) => {
    const r = await post(`/devices/${id}/test`)
    if (r.ok) toast.success(`${t('devices.testOk')}${r.romsFolders.length ? `: ${r.romsFolders.slice(0, 8).join(', ')}` : ''}`)
    else toast.error(`${t('devices.testFail')}: ${r.error}`)
  }
  const sync = async (id: number, direction: string) => {
    try {
      setJobId((await post(`/saves/sync/${id}`, { direction })).id)
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  const remove = async (id: number) => {
    if (!confirm(t('common.confirmDelete'))) return
    await del(`/devices/${id}`)
    void qc.invalidateQueries({ queryKey: ['devices'] })
  }

  return (
    <div>
      <PageHeader title={t('devices.title')}>
        <Button size="sm" variant="outline" nativeButton={false} render={<a href={authUrl('/link/package/onion')} />} title={t('more.link.installerHelp')}>
          {t('more.link.installer', { os: 'Onion' })}
        </Button>
        <Button size="sm" variant="outline" nativeButton={false} render={<a href={authUrl('/link/package/knulli')} />} title={t('more.link.installerHelp')}>
          {t('more.link.installer', { os: 'Knulli / Batocera' })}
        </Button>
        <Button size="sm" variant="outline" nativeButton={false} render={<a href="/api/v1/link/desktop/rommancer-desktop-setup.exe" />} title={t('more.desktop.help')}>
          {t('more.desktop.app', { os: 'Windows' })}
        </Button>
        <Button size="sm" variant="outline" nativeButton={false} render={<a href="/api/v1/link/desktop/rommancer-desktop.deb" />} title={t('more.desktop.help')}>
          {t('more.desktop.app', { os: 'Linux' })}
        </Button>
        <Button size="sm" variant="outline" render={<Link to="/link" />} nativeButton={false}>
          {t('more.link.title')}
        </Button>
        {user?.role === 'ADMIN' && (
          <Button size="sm" variant="outline" onClick={() => setSshAdd(true)} title={t('more.ssh.help')}>
            {t('more.ssh.add')}
          </Button>
        )}
        <Button size="sm" onClick={() => setEditing(null)}>
          {t('devices.new')}
        </Button>
      </PageHeader>
      {sshAdd && <SshInstallDialog onClose={() => setSshAdd(false)} />}
      {jobId && (
        <div className="mb-4 max-w-md">
          <JobProgress job={job} />
        </div>
      )}
      {!data?.length ? (
        <Empty />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.map((d) => (
            <Card key={d.id}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-2">
                  {d.name}
                  <Badge variant="outline">{d.connType}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="text-muted-foreground">
                  {d.console.name} · {d.firmware.name}
                </p>
                <p className="truncate font-mono text-xs" title={d.rootPath}>
                  {d.connType === 'SSH' ? `${d.sshUser}@${d.sshHost}:${d.sshPort ?? 22}` : ''}
                  {d.rootPath}
                </p>
                {d.connType === 'AGENT' && (
                  <p className="text-xs text-muted-foreground">
                    {t('more.device.games', { count: d._count?.inventory ?? 0 })}
                    {d.clientVersion && ` · ${t('more.device.client')} ${d.clientVersion}`}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  {t('devices.lastSync')}: {formatDate(d.lastSyncAt)}
                  {d.connType === 'AGENT' && ` · ${t('more.devices.lastSeen')}: ${formatDate(d.lastSeenAt)}`}
                  {d.syncSaves && ` · ${t('devices.syncSaves')}`}
                </p>
                <div className="flex flex-wrap gap-1">
                  {d.connType === 'AGENT' ? (
                    can('saves') && (
                      <>
                        <Button size="sm" nativeButton={false} render={<Link to={`/devices/${d.id}`} />}>
                          {t('more.device.open')}
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setScripts(d)}>
                          {t('more.devices.scripts')}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => void revoke(d.id)}>
                          {t('more.devices.revoke')}
                        </Button>
                      </>
                    )
                  ) : (
                    <>
                      <Button variant="outline" size="sm" onClick={() => void test(d.id)}>
                        <Plug className="size-4" />
                        {t('common.test')}
                      </Button>
                      {can('saves') && (
                        <>
                          <Button variant="outline" size="sm" onClick={() => void sync(d.id, 'both')}>
                            <RefreshCw className="size-4" />
                            {t('devices.syncNow')}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => void sync(d.id, 'pull')}>
                            {t('devices.pull')}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => void sync(d.id, 'push')}>
                            {t('devices.push')}
                          </Button>
                        </>
                      )}
                    </>
                  )}
                  <Button variant="ghost" size="icon-sm" onClick={() => setEditing(d)}>
                    <Pencil className="size-4" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => void remove(d.id)}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {editing !== undefined && <DeviceDialog device={editing} onClose={() => setEditing(undefined)} />}
      {scripts && <ScriptsDialog device={scripts} onClose={() => setScripts(null)} />}
    </div>
  )
}

function ScriptsDialog({ device, onClose }: { device: any; onClose(): void }) {
  const { t } = useTranslation()
  const [flavor, setFlavor] = useState(device.firmware.slug.includes('esde') || device.firmware.slug.includes('android') ? 'esde' : 'batocera')
  const [server, setServer] = useState(location.origin)
  const download = async () => {
    try {
      // Descarga con fetch para enviar el token de acceso en la cabecera
      const r = await fetch(`/api/v1/devices/${device.id}/agent-script`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ flavor, server }),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText)
      const url = URL.createObjectURL(await r.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = `rommancer-${flavor}.zip`
      a.click()
      URL.revokeObjectURL(url)
      onClose()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('more.devices.scripts')}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t('more.devices.scriptsHelp')}</p>
        <Field label={t('more.devices.flavor')}>
          <NativeSelect value={flavor} onChange={(e) => setFlavor(e.target.value)}>
            <option value="esde">{t('more.devices.esde')}</option>
            <option value="batocera">{t('more.devices.batocera')}</option>
          </NativeSelect>
        </Field>
        <Field label={t('more.devices.server')}>
          <Input value={server} onChange={(e) => setServer(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button onClick={() => void download()}>{t('common.download')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeviceDialog({ device, onClose }: { device: any | null; onClose(): void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const consoles = useQuery({ queryKey: ['consoles'], queryFn: () => get<any[]>('/devices/consoles') })
  const firmwares = useQuery({ queryKey: ['firmwares'], queryFn: () => get<any[]>('/devices/firmwares') })
  const emulators = useQuery({ queryKey: ['emulators'], queryFn: () => get<any[]>('/devices/emulators') })
  const systems = useSystems()
  const o = device?.overrides ?? {}
  const [form, setForm] = useState({
    name: device?.name ?? '',
    consoleId: String(device?.consoleId ?? ''),
    firmwareId: String(device?.firmwareId ?? ''),
    connType: device?.connType ?? 'LOCAL',
    rootPath: device?.rootPath ?? '',
    sshHost: device?.sshHost ?? '',
    sshPort: String(device?.sshPort ?? 22),
    sshUser: device?.sshUser ?? '',
    sshPassword: '',
    sshKey: '',
    syncSaves: device?.syncSaves ?? false,
    romsRoot: o.romsRoot ?? '',
    savesRoot: o.savesRoot ?? '',
    statesRoot: o.statesRoot ?? '',
    savesLayout: o.savesLayout ?? '',
  })
  const [systemMap, setSystemMap] = useState<Record<string, { folder: string; emulator: string }>>(o.systemMap ?? {})
  const [newConsole, setNewConsole] = useState('')
  const fw = firmwares.data?.find((f) => String(f.id) === form.firmwareId)
  const set = (k: keyof typeof form, v: unknown) => setForm({ ...form, [k]: v })

  const submit = async () => {
    try {
      let consoleId = Number(form.consoleId)
      if (newConsole) consoleId = (await post('/devices/consoles', { name: newConsole, manufacturer: newConsole.split(' ')[0] })).id
      const overrides: Record<string, unknown> = {}
      for (const k of ['romsRoot', 'savesRoot', 'statesRoot', 'savesLayout'] as const) if (form[k]) overrides[k] = form[k]
      if (Object.keys(systemMap).length) overrides.systemMap = systemMap
      const body: Record<string, unknown> = {
        name: form.name,
        consoleId,
        firmwareId: Number(form.firmwareId),
        connType: form.connType,
        rootPath: form.rootPath,
        syncSaves: form.syncSaves,
        overrides: Object.keys(overrides).length ? overrides : null,
      }
      if (form.connType === 'SSH') {
        Object.assign(body, { sshHost: form.sshHost, sshPort: Number(form.sshPort), sshUser: form.sshUser })
        if (form.sshPassword) body.sshPassword = form.sshPassword
        if (form.sshKey) body.sshKey = form.sshKey
      }
      if (device) await patch(`/devices/${device.id}`, body)
      else await post('/devices', body)
      void qc.invalidateQueries({ queryKey: ['devices'] })
      void qc.invalidateQueries({ queryKey: ['consoles'] })
      onClose()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  const activeSystems = (systems.data ?? []).filter((s) => s.roms > 0)
  return (
    <Dialog open onOpenChange={(op) => !op && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{device ? device.name : t('devices.new')}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t('common.name')}>
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label={t('devices.console')}>
            <NativeSelect value={form.consoleId} onChange={(e) => set('consoleId', e.target.value)}>
              <option value="">{newConsole ? `+ ${newConsole}` : '-'}</option>
              {consoles.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </NativeSelect>
            {!form.consoleId && <Input placeholder={t('devices.newConsole')} value={newConsole} onChange={(e) => setNewConsole(e.target.value)} />}
          </Field>
          <Field label={t('devices.firmware')}>
            <NativeSelect value={form.firmwareId} onChange={(e) => set('firmwareId', e.target.value)}>
              <option value="">-</option>
              {firmwares.data?.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t('devices.conn')}>
            <NativeSelect value={form.connType} onChange={(e) => set('connType', e.target.value)}>
              <option value="LOCAL">{t('devices.LOCAL')}</option>
              <option value="SSH">{t('devices.SSH')}</option>
              <option value="AGENT">{t('more.devices.AGENT')}</option>
            </NativeSelect>
            <span className="text-xs text-muted-foreground">{form.connType === 'AGENT' ? t('more.devices.agentHelp') : form.connType === 'LOCAL' ? t('more.devices.mountedHelp') : ''}</span>
          </Field>
          <Field label={t('devices.root')}>
            <Input value={form.rootPath} onChange={(e) => set('rootPath', e.target.value)} placeholder={form.connType === 'SSH' ? '/storage' : '/Volumes/SD'} />
          </Field>
          {form.connType === 'SSH' && (
            <>
              <Field label={t('devices.host')}>
                <Input value={form.sshHost} onChange={(e) => set('sshHost', e.target.value)} />
              </Field>
              <Field label={t('devices.port')}>
                <Input value={form.sshPort} onChange={(e) => set('sshPort', e.target.value)} inputMode="numeric" />
              </Field>
              <Field label={t('common.user')}>
                <Input value={form.sshUser} onChange={(e) => set('sshUser', e.target.value)} />
              </Field>
              <Field label={t('common.password')} hint={device ? t('devices.keepSecret') : undefined}>
                <Input type="password" value={form.sshPassword} onChange={(e) => set('sshPassword', e.target.value)} />
              </Field>
              <div className="md:col-span-2">
                <Field label={t('devices.sshKey')} hint={device ? t('devices.keepSecret') : undefined}>
                  <Textarea value={form.sshKey} onChange={(e) => set('sshKey', e.target.value)} className="font-mono text-xs" rows={3} />
                </Field>
              </div>
            </>
          )}
          <label className="flex items-center gap-2 text-sm md:col-span-2">
            <Checkbox checked={form.syncSaves} onCheckedChange={(c) => set('syncSaves', !!c)} />
            {t('devices.syncSaves')}
          </label>
        </div>
        {fw && (
          <details className="rounded-lg border p-3 text-sm">
            <summary className="cursor-pointer font-medium">{t('devices.layout')}</summary>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <Field label={t('devices.romsRoot')}>
                <Input value={form.romsRoot} placeholder={fw.romsRoot} onChange={(e) => set('romsRoot', e.target.value)} />
              </Field>
              <Field label={t('devices.savesRoot')}>
                <Input value={form.savesRoot} placeholder={fw.savesRoot} onChange={(e) => set('savesRoot', e.target.value)} />
              </Field>
              <Field label={t('devices.statesRoot')}>
                <Input value={form.statesRoot} placeholder={fw.statesRoot} onChange={(e) => set('statesRoot', e.target.value)} />
              </Field>
              <Field label={t('devices.savesLayout')}>
                <NativeSelect value={form.savesLayout} onChange={(e) => set('savesLayout', e.target.value)}>
                  <option value="">{t(`devices.layouts.${fw.savesLayout}`)} (firmware)</option>
                  {['flat', 'system', 'core', 'rom', 'rom-core', 'rom-saves'].map((l) => (
                    <option key={l} value={l}>
                      {t(`devices.layouts.${l}`)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>
            <p className="mt-4 mb-2 font-medium">{t('devices.folders')}</p>
            <div className="grid gap-2">
              {activeSystems.map((s) => {
                const base = fw.systemMap[s.slug] ?? { folder: s.slug, emulator: '' }
                const cur = systemMap[s.slug] ?? base
                return (
                  <div key={s.slug} className="grid grid-cols-3 items-center gap-2">
                    <span>{s.name}</span>
                    <Input value={cur.folder} onChange={(e) => setSystemMap({ ...systemMap, [s.slug]: { ...cur, folder: e.target.value } })} />
                    <NativeSelect value={cur.emulator} onChange={(e) => setSystemMap({ ...systemMap, [s.slug]: { ...cur, emulator: e.target.value } })}>
                      {emulators.data?.map((em) => (
                        <option key={em.slug} value={em.slug}>
                          {em.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                )
              })}
            </div>
          </details>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={!form.name || !form.firmwareId || (!form.consoleId && !newConsole) || !form.rootPath}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// A console that only offers SSH: the server installs the client on it and keeps it in sync from then on
function SshInstallDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const consoles = useQuery({ queryKey: ['consoles'], queryFn: () => get<any[]>('/devices/consoles') })
  const firmwares = useQuery({ queryKey: ['firmwares'], queryFn: () => get<any[]>('/devices/firmwares') })
  const key = useQuery({ queryKey: ['ssh-key'], queryFn: () => get<{ publicKey: string }>('/devices/ssh-key') })
  const [form, setForm] = useState({ name: '', consoleId: '', firmwareId: '', host: '', port: '22', user: 'root', password: '', rootPath: '', server: '' })
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }))
  const install = async () => {
    setBusy(true)
    try {
      await post('/devices/ssh-install', {
        name: form.name,
        consoleId: Number(form.consoleId),
        firmwareId: Number(form.firmwareId),
        host: form.host,
        port: Number(form.port) || 22,
        user: form.user || 'root',
        password: form.password || undefined,
        rootPath: form.rootPath || undefined,
        server: form.server || undefined,
      })
      toast.success(t('more.ssh.installed'))
      void qc.invalidateQueries({ queryKey: ['devices'] })
      onClose()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('more.ssh.add')}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t('more.ssh.intro')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('common.name')}>
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label={t('devices.console')}>
            <NativeSelect value={form.consoleId} onChange={(e) => set('consoleId', e.target.value)}>
              <option value="" />
              {consoles.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t('devices.firmware')}>
            <NativeSelect value={form.firmwareId} onChange={(e) => set('firmwareId', e.target.value)}>
              <option value="" />
              {firmwares.data?.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t('more.ssh.root')}>
            <Input value={form.rootPath} placeholder={t('more.ssh.rootAuto')} onChange={(e) => set('rootPath', e.target.value)} />
          </Field>
          <Field label={t('more.ssh.host')}>
            <Input value={form.host} placeholder="192.0.2.50" onChange={(e) => set('host', e.target.value)} />
          </Field>
          <Field label={t('more.ssh.port')}>
            <Input value={form.port} inputMode="numeric" onChange={(e) => set('port', e.target.value)} />
          </Field>
          <Field label={t('more.ssh.user')}>
            <Input value={form.user} onChange={(e) => set('user', e.target.value)} />
          </Field>
          <Field label={t('more.ssh.password')}>
            <Input type="password" autoComplete="new-password" value={form.password} onChange={(e) => set('password', e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Field label={t('more.ssh.server')}>
              <Input value={form.server} placeholder={window.location.origin} onChange={(e) => set('server', e.target.value)} />
            </Field>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t('more.ssh.keyHelp')}</p>
        <Textarea readOnly rows={3} className="font-mono text-xs break-all" value={key.data?.publicKey ?? ''} onFocus={(e) => e.currentTarget.select()} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void install()} disabled={busy || !form.name || !form.consoleId || !form.firmwareId || !form.host}>
            {busy ? t('more.ssh.installing') : t('more.ssh.install')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
