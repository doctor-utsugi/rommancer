import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Copy, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { del, get, patch, post } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Field, NativeSelect, PageHeader, errMsg, formatDate } from '@/components/common'

export function AdminUsersPage() {
  const { t } = useTranslation()
  const { user: me } = useAuth()
  const qc = useQueryClient()
  const users = useQuery({ queryKey: ['users'], queryFn: () => get<any[]>('/users') })
  const invs = useQuery({ queryKey: ['invitations'], queryFn: () => get<any[]>('/invitations') })
  const [form, setForm] = useState({ username: '', email: '', password: '', role: 'USER' })
  const [invRole, setInvRole] = useState('USER')
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
            setForm({ username: '', email: '', password: '', role: 'USER' })
          })}>
            {t('common.create')}
          </Button>
        </CardContent>
      </Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('common.user')}</TableHead>
            <TableHead>{t('common.email')}</TableHead>
            <TableHead>{t('common.role')}</TableHead>
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
              <Button size="sm" onClick={() => void act(() => post('/invitations', { role: invRole }))}>
                {t('admin.newInvitation')}
              </Button>
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
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
    </div>
  )
}
