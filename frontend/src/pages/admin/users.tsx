import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Copy, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { del, get, patch, post, put } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, NativeSelect, PageHeader, errMsg, formatDate } from '@/components/common'

export const PERMISSIONS = ['collection.view', 'lists', 'saves', 'roms.download', 'roms.upload', 'roms.uploadUnverified', 'scrape.lists', 'scrape.bulk']
export const DEFAULT_PERMISSIONS = ['collection.view', 'lists', 'saves', 'scrape.lists']

function PermsEditor({ value, onChange }: { value: string[]; onChange(v: string[]): void }) {
  const { t } = useTranslation()
  return (
    <div className="grid gap-1 sm:grid-cols-2">
      {PERMISSIONS.map((p) => (
        <label key={p} className="flex items-center gap-2 text-sm">
          <Checkbox checked={value.includes(p)} onCheckedChange={(c) => onChange(c ? [...value, p] : value.filter((x) => x !== p))} />
          {t(`more.perms.${p}`)}
        </label>
      ))}
    </div>
  )
}

export function AdminUsersPage() {
  const { t } = useTranslation()
  const { user: me } = useAuth()
  const qc = useQueryClient()
  const users = useQuery({ queryKey: ['users'], queryFn: () => get<any[]>('/users') })
  const invs = useQuery({ queryKey: ['invitations'], queryFn: () => get<any[]>('/invitations') })
  const signup = useQuery({ queryKey: ['signup-open'], queryFn: () => get<{ open: boolean }>('/admin/settings/signup') })
  const history = useQuery({ queryKey: ['save-history'], queryFn: () => get<{ history: number }>('/admin/settings/saves') })
  const [keep, setKeep] = useState('')
  const session = useQuery({ queryKey: ['session-days'], queryFn: () => get<{ days: number; min: number }>('/admin/settings/session') })
  const [days, setDays] = useState('')
  const [form, setForm] = useState({ username: '', email: '', password: '', role: 'USER', permissions: DEFAULT_PERMISSIONS })
  const [invRole, setInvRole] = useState('USER')
  const [invPerms, setInvPerms] = useState(DEFAULT_PERMISSIONS)
  const [editing, setEditing] = useState<{ id: number; username: string; permissions: string[] } | null>(null)
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      void qc.invalidateQueries({ queryKey: ['users'] })
      void qc.invalidateQueries({ queryKey: ['invitations'] })
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  const link = (token: string) => `${location.origin}/register/${token}`
  return (
    <div className="space-y-6">
      <PageHeader title={t('admin.users')} />
      <Card>
        <CardContent className="flex items-center justify-between gap-4 pt-6">
          <div>
            <p className="font-medium">{t('more.signupOpen')}</p>
            <p className="text-sm text-muted-foreground">{t('more.signupOpenHelp')}</p>
          </div>
          <Switch
            checked={!!signup.data?.open}
            onCheckedChange={(open) => act(async () => {
              await put('/admin/settings/signup', { open })
              void qc.invalidateQueries({ queryKey: ['signup-open'] })
            })}
          />
        </CardContent>
        <CardContent className="flex items-center justify-between gap-4">
          <div>
            <p className="font-medium">{t('more.saveHistory')}</p>
            <p className="text-sm text-muted-foreground">{t('more.saveHistoryHelp')}</p>
          </div>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void act(async () => {
                await put('/admin/settings/saves', { history: Number(keep) })
                void qc.invalidateQueries({ queryKey: ['save-history'] })
                setKeep('')
                toast.success(t('common.saved'))
              })
            }}
          >
            <Input type="number" min={1} max={500} className="w-20" value={keep || String(history.data?.history ?? '')} onChange={(e) => setKeep(e.target.value)} />
            <Button size="sm" type="submit" disabled={!keep || Number(keep) === history.data?.history}>
              {t('common.save')}
            </Button>
          </form>
        </CardContent>
        <CardContent className="flex items-center justify-between gap-4">
          <div>
            <p className="font-medium">{t('more.session.title')}</p>
            <p className="text-sm text-muted-foreground">{t('more.session.help', { min: session.data?.min ?? 30 })}</p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <label className="flex items-center gap-2 text-sm whitespace-nowrap">
              <Switch
                checked={session.data?.days === 0}
                onCheckedChange={(never) => act(async () => {
                  await put('/admin/settings/session', { days: never ? 0 : 90 })
                  void qc.invalidateQueries({ queryKey: ['session-days'] })
                })}
              />
              {t('more.session.never')}
            </label>
            {session.data?.days !== 0 && (
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  void act(async () => {
                    await put('/admin/settings/session', { days: Number(days) })
                    void qc.invalidateQueries({ queryKey: ['session-days'] })
                    setDays('')
                    toast.success(t('common.saved'))
                  })
                }}
              >
                <Input type="number" min={session.data?.min ?? 30} max={3650} className="w-20" aria-label={t('more.session.days')} value={days || String(session.data?.days ?? '')} onChange={(e) => setDays(e.target.value)} />
                <Button size="sm" type="submit" disabled={!days || Number(days) === session.data?.days}>
                  {t('common.save')}
                </Button>
              </form>
            )}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('admin.newUser')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <Field label={t('common.user')}>
            <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          </Field>
          <Field label={t('common.email')}>
            <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <Field label={t('common.password')}>
            <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </Field>
          <Field label={t('common.role')}>
            <NativeSelect value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option>USER</option>
              <option>ADMIN</option>
            </NativeSelect>
          </Field>
          <Button onClick={() => void act(async () => {
            await post('/users', form)
            setForm({ username: '', email: '', password: '', role: 'USER', permissions: DEFAULT_PERMISSIONS })
          })}>
            {t('common.create')}
          </Button>
          {form.role === 'USER' && (
            <div className="w-full">
              <PermsEditor value={form.permissions} onChange={(permissions) => setForm({ ...form, permissions })} />
            </div>
          )}
        </CardContent>
      </Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('common.user')}</TableHead>
            <TableHead>{t('common.email')}</TableHead>
            <TableHead>{t('common.role')}</TableHead>
            <TableHead>{t('more.perms.title')}</TableHead>
            <TableHead>{t('common.date')}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.data?.map((u) => (
            <TableRow key={u.id}>
              <TableCell className="font-medium">{u.username}</TableCell>
              <TableCell>{u.email}</TableCell>
              <TableCell>
                <NativeSelect value={u.role} disabled={u.id === me?.id} onChange={(e) => void act(() => patch(`/users/${u.id}`, { role: e.target.value }))}>
                  <option>USER</option>
                  <option>ADMIN</option>
                </NativeSelect>
              </TableCell>
              <TableCell className="max-w-xs text-xs">
                {u.role === 'ADMIN' ? (
                  t('common.all')
                ) : (
                  <button className="text-left hover:underline" onClick={() => setEditing({ id: u.id, username: u.username, permissions: u.permissions ?? [] })}>
                    {(u.permissions ?? []).map((p: string) => t(`more.perms.${p}`)).join(', ') || '-'}
                  </button>
                )}
                {u.mustChangePassword && <Badge variant="outline">{t('more.perms.mustChange')}</Badge>}
              </TableCell>
              <TableCell className="text-xs">{formatDate(u.createdAt)}</TableCell>
              <TableCell>
                {u.id !== me?.id && (
                  <Button variant="ghost" size="icon-sm" onClick={() => confirm(t('common.confirmDelete')) && void act(() => del(`/users/${u.id}`))}>
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            {t('admin.invitations')}
            <span className="flex gap-2">
              <NativeSelect value={invRole} onChange={(e) => setInvRole(e.target.value)}>
                <option>USER</option>
                <option>ADMIN</option>
              </NativeSelect>
              <Button size="sm" onClick={() => void act(() => post('/invitations', { role: invRole, permissions: invPerms }))}>
                {t('admin.newInvitation')}
              </Button>
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {invRole === 'USER' && (
            <div className="mb-4">
              <PermsEditor value={invPerms} onChange={setInvPerms} />
            </div>
          )}
          <Table>
            <TableBody>
              {invs.data?.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="max-w-md truncate font-mono text-xs">{link(i.token)}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{i.role}</Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {i.usedAt ? `${t('admin.used')} ${formatDate(i.usedAt)}` : `${t('admin.expires')} ${formatDate(i.expiresAt)}`}
                  </TableCell>
                  <TableCell className="space-x-1 text-right">
                    {!i.usedAt && (
                      <Button
                        variant="outline"
                        size="icon-sm"
                        onClick={() => {
                          void navigator.clipboard.writeText(link(i.token))
                          toast.success(t('common.copy'))
                        }}
                      >
                        <Copy className="size-4" />
                      </Button>
                    )}
                    <Button variant="ghost" size="icon-sm" onClick={() => void act(() => del(`/invitations/${i.id}`))}>
                      <Trash2 className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Dialog open={!!editing} onOpenChange={() => setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('more.perms.title')} · {editing?.username}
            </DialogTitle>
          </DialogHeader>
          {editing && <PermsEditor value={editing.permissions} onChange={(permissions) => setEditing({ ...editing, permissions })} />}
          <DialogFooter>
            <Button
              onClick={() =>
                void act(async () => {
                  await patch(`/users/${editing!.id}`, { permissions: editing!.permissions })
                  setEditing(null)
                })
              }
            >
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
