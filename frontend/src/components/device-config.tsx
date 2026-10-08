import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Download, Pencil, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { authUrl, del, get, patch, post, put } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Field, NativeSelect, errMsg, formatBytes, formatDate } from '@/components/common'

/** Server notes come as "code" or "code:detail" lines; unknown ones are shown as they are */
function useNotes() {
  const { t, i18n } = useTranslation()
  return (msg: string | null) =>
    (msg ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [code, ...rest] = line.split(':')
        const key = `more.config.note_${code}`
        return i18n.exists(key) ? t(key, { detail: rest.join(':') }) : line
      })
      .join(' · ')
}

interface Wifi {
  id: number
  ssid: string
  hasPassword: boolean
  band: '2.4' | '5' | 'dual'
  hidden: boolean
  priority: number
}

interface ConsoleSettings {
  ra: { username: string | null; hasPassword: boolean; hasToken: boolean }
  wifi: Wifi[]
}

/** The user's RetroAchievements login and WiFi networks, kept applied on their consoles */
export function ConsoleSettingsCard() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['console-settings'], queryFn: () => get<ConsoleSettings>('/settings/consoles') })
  const [ra, setRa] = useState({ username: '', password: '' })
  const [net, setNet] = useState({ ssid: '', password: '', band: 'dual', hidden: false })
  const [busy, setBusy] = useState(false)
  const reload = () => void qc.invalidateQueries({ queryKey: ['console-settings'] })
  const run = async (f: () => Promise<unknown>, ok?: string) => {
    setBusy(true)
    try {
      await f()
      if (ok) toast.success(ok)
      reload()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(false)
    }
  }
  const s = q.data
  const move = (i: number, d: number) => {
    const ids = s!.wifi.map((w) => w.id)
    ;[ids[i], ids[i + d]] = [ids[i + d], ids[i]]
    void run(() => put('/settings/consoles/wifi-order', { ids }))
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('more.config.settingsTitle')}</CardTitle>
        <CardDescription>{t('more.config.settingsHelp')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <div className="grid gap-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            RetroAchievements
            <Badge variant={s?.ra.hasPassword ? 'default' : 'outline'}>{s?.ra.hasPassword ? s.ra.username : t('profile.notConfigured')}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">{t('more.config.raHelp')}</p>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label={t('profile.raUser')}>
              <Input value={ra.username} placeholder={s?.ra.username ?? ''} onChange={(e) => setRa({ ...ra, username: e.target.value })} autoComplete="off" />
            </Field>
            <Field label={t('more.config.raPassword')}>
              <Input type="password" value={ra.password} onChange={(e) => setRa({ ...ra, password: e.target.value })} autoComplete="new-password" />
            </Field>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || !(ra.username || s?.ra.username) || !ra.password}
              onClick={() => void run(() => put('/settings/consoles/ra', { username: ra.username || s?.ra.username, password: ra.password }).then(() => setRa({ username: '', password: '' })), t('more.config.raOk'))}
            >
              {t('more.config.raCheck')}
            </Button>
            {s?.ra.hasPassword && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => del('/settings/consoles/ra'))}>
                {t('common.delete')}
              </Button>
            )}
          </div>
        </div>

        <div className="grid gap-3">
          <div className="text-sm font-medium">{t('more.config.wifiTitle')}</div>
          <p className="text-xs text-muted-foreground">{t('more.config.wifiHelp')}</p>
          {!!s?.wifi.length && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('more.config.ssid')}</TableHead>
                  <TableHead className="w-40">{t('more.config.band')}</TableHead>
                  <TableHead className="w-24">{t('more.config.hidden')}</TableHead>
                  <TableHead className="w-32" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.wifi.map((w, i) => (
                  <TableRow key={w.id}>
                    <TableCell>
                      {w.ssid}
                      {!w.hasPassword && <span className="ml-2 text-xs text-muted-foreground">{t('more.config.open')}</span>}
                    </TableCell>
                    <TableCell>
                      <NativeSelect value={w.band} onChange={(e) => void run(() => patch(`/settings/consoles/wifi/${w.id}`, { band: e.target.value }))}>
                        <option value="dual">{t('more.config.bandDual')}</option>
                        <option value="2.4">2.4 GHz</option>
                        <option value="5">{t('more.config.band5')}</option>
                      </NativeSelect>
                    </TableCell>
                    <TableCell>
                      <Checkbox checked={w.hidden} onCheckedChange={(v) => void run(() => patch(`/settings/consoles/wifi/${w.id}`, { hidden: !!v }))} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="icon" variant="ghost" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label={t('more.config.up')}>
                        <ArrowUp className="size-4" />
                      </Button>
                      <Button size="icon" variant="ghost" disabled={busy || i === s.wifi.length - 1} onClick={() => move(i, 1)} aria-label={t('more.config.down')}>
                        <ArrowDown className="size-4" />
                      </Button>
                      <Button size="icon" variant="ghost" disabled={busy} onClick={() => void run(() => del(`/settings/consoles/wifi/${w.id}`))} aria-label={t('common.delete')}>
                        <Trash2 className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <div className="grid gap-3 md:grid-cols-[1fr_1fr_10rem]">
            <Field label={t('more.config.ssid')}>
              <Input value={net.ssid} onChange={(e) => setNet({ ...net, ssid: e.target.value })} autoComplete="off" />
            </Field>
            <Field label={t('more.config.wifiPassword')} hint={t('more.config.wifiPasswordHint')}>
              <Input type="password" value={net.password} onChange={(e) => setNet({ ...net, password: e.target.value })} autoComplete="new-password" />
            </Field>
            <Field label={t('more.config.band')}>
              <NativeSelect value={net.band} onChange={(e) => setNet({ ...net, band: e.target.value })}>
                <option value="dual">{t('more.config.bandDual')}</option>
                <option value="2.4">2.4 GHz</option>
                <option value="5">{t('more.config.band5')}</option>
              </NativeSelect>
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">{t('more.config.bandHelp')}</p>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={net.hidden} onCheckedChange={(v) => setNet({ ...net, hidden: !!v })} />
              {t('more.config.hiddenLong')}
            </label>
            <Button
              size="sm"
              disabled={busy || !net.ssid || (!!net.password && net.password.length < 8)}
              onClick={() => void run(() => post('/settings/consoles/wifi', { ...net, password: net.password || null }).then(() => setNet({ ssid: '', password: '', band: 'dual', hidden: false })))}
            >
              {t('more.config.addWifi')}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

interface ConfigVersion {
  id: number
  source: 'backup' | 'before' | 'edit'
  note: string | null
  bytes: number
  files: number
  createdAt: string
}

interface ConfigOp {
  id: number
  kind: 'backup' | 'settings' | 'restore'
  status: 'pending' | 'collecting' | 'applying' | 'done' | 'failed'
  channel: string | null
  error: string | null
  createdAt: string
  doneAt: string | null
}

interface DeviceConfig {
  supported: boolean
  firmware: string
  keepSettings: boolean
  wifiBands: 'none' | '2.4' | 'dual' | null
  wifiBandsSource: 'manual' | 'device' | 'model' | null
  wifiLeftOut: string[]
  settingsPending: boolean
  settingsAt: string | null
  settingsError: string | null
  ops: ConfigOp[]
  versions: ConfigVersion[]
}

/** A device's configuration: settings kept applied, copies of its files, restores and edits */
export function DeviceConfigTab({ deviceId, canEdit }: { deviceId: number; canEdit: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['device-config', deviceId],
    queryFn: () => get<DeviceConfig>(`/devices/${deviceId}/config`),
    refetchInterval: (query) => (query.state.data?.ops.some((o) => ['pending', 'collecting', 'applying'].includes(o.status)) ? 5000 : false),
  })
  const [open, setOpen] = useState<number | null>(null)
  const notes = useNotes()
  const reload = () => void qc.invalidateQueries({ queryKey: ['device-config', deviceId] })
  const run = async (f: () => Promise<unknown>, ok?: string) => {
    try {
      await f()
      if (ok) toast.success(ok)
      reload()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  const c = q.data
  if (!c) return null
  if (!c.supported) return <p className="text-sm text-muted-foreground">{t(c.firmware.startsWith('android') ? 'more.config.android' : 'more.config.unsupported')}</p>
  const source = (v: ConfigVersion) => (v.source === 'backup' ? t('more.config.srcBackup') : v.source === 'edit' ? t('more.config.srcEdit') : t('more.config.srcBefore'))
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('more.config.yourSettings')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <label className="flex items-center gap-2">
            <Checkbox checked={c.keepSettings} disabled={!canEdit} onCheckedChange={(v) => void run(() => patch(`/devices/${deviceId}/config`, { keepSettings: !!v }))} />
            {t('more.config.keep')}
          </label>
          <p className={c.settingsError ? 'text-amber-600' : 'text-muted-foreground'}>
            {c.settingsPending
              ? t('more.config.pending')
              : c.settingsAt
                ? t('more.config.appliedAt', { when: formatDate(c.settingsAt) })
                : t('more.config.never')}
            {c.settingsError && ` · ${notes(c.settingsError)}`}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <span>{t('more.config.bands')}</span>
            <NativeSelect
              value={c.wifiBandsSource === 'manual' ? (c.wifiBands ?? '') : ''}
              disabled={!canEdit}
              onChange={(e) => void run(() => patch(`/devices/${deviceId}/config`, { wifiBands: e.target.value || null }))}
            >
              <option value="">{t('more.config.bandsAuto', { value: c.wifiBandsSource && c.wifiBandsSource !== 'manual' ? t(`more.config.bands_${c.wifiBands}`) : t('more.config.bandsUnknown') })}</option>
              <option value="dual">{t('more.config.bands_dual')}</option>
              <option value="2.4">{t('more.config.bands_2.4')}</option>
              <option value="none">{t('more.config.bands_none')}</option>
            </NativeSelect>
          </div>
          {!!c.wifiLeftOut.length && <p className="text-amber-600">{t('more.config.leftOut', { list: c.wifiLeftOut.join(', ') })}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={!canEdit} onClick={() => void run(() => post(`/devices/${deviceId}/config/apply`), t('more.config.queued'))}>
              {t('more.config.applyNow')}
            </Button>
            <Button size="sm" variant="outline" disabled={!canEdit} onClick={() => void run(() => post(`/devices/${deviceId}/config/backup`), t('more.config.queued'))}>
              {t('more.config.backupNow')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('more.config.channels')}</p>
        </CardContent>
      </Card>

      {!!c.ops.length && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('more.config.activity')}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableBody>
                {c.ops.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="w-40">{formatDate(o.doneAt ?? o.createdAt)}</TableCell>
                    <TableCell>{t(`more.config.op_${o.kind}`)}</TableCell>
                    <TableCell>
                      <Badge variant={o.status === 'failed' ? 'destructive' : o.status === 'done' ? 'default' : 'outline'}>{t(`more.config.st_${o.status}`)}</Badge>
                      {o.channel && <span className="ml-2 text-xs text-muted-foreground">{t(`more.config.ch_${o.channel}`)}</span>}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{notes(o.error)}</TableCell>
                    <TableCell className="w-10">
                      {o.status === 'pending' && canEdit && (
                        <Button size="icon" variant="ghost" onClick={() => void run(() => del(`/devices/${deviceId}/config/ops/${o.id}`))} aria-label={t('common.cancel')}>
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('more.config.copies')}</CardTitle>
          <CardDescription>{t('more.config.copiesHelp')}</CardDescription>
        </CardHeader>
        <CardContent>
          {!c.versions.length ? (
            <p className="text-sm text-muted-foreground">{t('more.config.noCopies')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-40">{t('more.config.when')}</TableHead>
                  <TableHead>{t('more.config.what')}</TableHead>
                  <TableHead className="w-28">{t('more.config.size')}</TableHead>
                  <TableHead className="w-28" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {c.versions.map((v) => (
                  <TableRow key={v.id}>
                    <TableCell>{formatDate(v.createdAt)}</TableCell>
                    <TableCell>
                      {source(v)}
                      {v.note && <span className="ml-2 text-xs text-muted-foreground">{v.source === 'before' ? t(`more.config.before_${v.note}`) : v.note}</span>}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {t('more.config.filesCount', { count: v.files })} · {formatBytes(v.bytes)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="icon" variant="ghost" onClick={() => setOpen(v.id)} aria-label={t('more.config.open_copy')}>
                        <Pencil className="size-4" />
                      </Button>
                      <Button size="icon" variant="ghost" asChild aria-label={t('more.config.download')}>
                        <a href={authUrl(`/devices/${deviceId}/config/versions/${v.id}/zip`)}>
                          <Download className="size-4" />
                        </a>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {open !== null && <VersionDialog deviceId={deviceId} versionId={open} canEdit={canEdit} onClose={() => setOpen(null)} onQueued={reload} />}
    </div>
  )
}

interface VersionDetail {
  id: number
  createdAt: string
  files: { path: string; size: number }[]
}

/** The files of a copy: read one, change it and send it to the device, or put the copy back */
function VersionDialog({ deviceId, versionId, canEdit, onClose, onQueued }: { deviceId: number; versionId: number; canEdit: boolean; onClose(): void; onQueued(): void }) {
  const { t } = useTranslation()
  const v = useQuery({ queryKey: ['device-config-version', deviceId, versionId], queryFn: () => get<VersionDetail>(`/devices/${deviceId}/config/versions/${versionId}`) })
  const [file, setFile] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [original, setOriginal] = useState('')
  const openFile = async (p: string) => {
    setFile(p)
    setText(null)
    const r = await fetch(authUrl(`/devices/${deviceId}/config/versions/${versionId}/file?path=${encodeURIComponent(p)}`))
    const body = await r.text()
    setOriginal(body)
    setText(body)
  }
  const act = async (f: () => Promise<unknown>) => {
    try {
      await f()
      toast.success(t('more.config.queued'))
      onQueued()
      onClose()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t('more.config.copyOf', { when: v.data ? formatDate(v.data.createdAt) : '' })}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 md:grid-cols-[16rem_1fr]">
          <div className="max-h-[60vh] space-y-1 overflow-auto text-sm">
            {v.data?.files.map((f) => (
              <button key={f.path} className={`block w-full truncate rounded px-2 py-1 text-left hover:bg-muted ${file === f.path ? 'bg-muted font-medium' : ''}`} title={f.path} onClick={() => void openFile(f.path)}>
                {f.path}
              </button>
            ))}
          </div>
          <div>
            {file === null ? (
              <p className="text-sm text-muted-foreground">{t('more.config.pickFile')}</p>
            ) : text === null ? (
              <p className="text-sm text-muted-foreground">…</p>
            ) : (
              <textarea
                className="h-[60vh] w-full rounded-md border bg-background p-2 font-mono text-xs"
                value={text}
                spellCheck={false}
                readOnly={!canEdit}
                onChange={(e) => setText(e.target.value)}
              />
            )}
          </div>
        </div>
        <DialogFooter className="gap-2">
          {canEdit && file && text !== null && text !== original && (
            <Button onClick={() => void act(() => put(`/devices/${deviceId}/config/versions/${versionId}/file`, { path: file, content: text }))}>{t('more.config.saveSend')}</Button>
          )}
          {canEdit && file && text === original && (
            <Button variant="outline" onClick={() => void act(() => post(`/devices/${deviceId}/config/versions/${versionId}/restore`, { paths: [file] }))}>
              <RotateCcw className="size-4" /> {t('more.config.restoreFile')}
            </Button>
          )}
          {canEdit && (
            <Button variant="outline" onClick={() => void act(() => post(`/devices/${deviceId}/config/versions/${versionId}/restore`, {}))}>
              <RotateCcw className="size-4" /> {t('more.config.restoreAll')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
