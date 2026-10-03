import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { get, patch, post } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Empty, Field, NativeSelect, PageHeader, errMsg } from '@/components/common'

export function ListsPage() {
  const { t } = useTranslation()
  const { user } = useAuth()
  const nav = useNavigate()
  const qc = useQueryClient()
  const [scope, setScope] = useState('mine')
  const [creating, setCreating] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const { data } = useQuery({ queryKey: ['lists', scope], queryFn: () => get<any[]>(`/lists?scope=${scope}`) })

  const importFile = async (f: File) => {
    try {
      const json = JSON.parse(await f.text())
      const r = await post('/lists/import', json)
      toast.success(`${t('lists.added', { count: r.added })} · ${t('lists.unresolved', { count: r.unresolved.length })}`)
      void qc.invalidateQueries({ queryKey: ['lists'] })
      nav(`/lists/${r.list.id}`)
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  return (
    <div>
      <PageHeader title={t('lists.title')}>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])} />
        <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
          {t('lists.import')}
        </Button>
        <Button size="sm" onClick={() => setCreating(true)}>
          {t('lists.new')}
        </Button>
      </PageHeader>
      <Tabs value={scope} onValueChange={(v) => setScope(String(v))} className="mb-4">
        <TabsList>
          <TabsTrigger value="mine">{t('lists.mine')}</TabsTrigger>
          <TabsTrigger value="shared">{t('lists.shared')}</TabsTrigger>
          <TabsTrigger value="public">{t('lists.public')}</TabsTrigger>
        </TabsList>
      </Tabs>
      {!data?.length ? (
        <Empty />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.map((l) => (
            <Link key={l.id} to={`/lists/${l.id}`}>
              <Card className="h-full transition-colors hover:bg-muted/50">
                <CardHeader>
                  <CardTitle className="flex items-start justify-between gap-2">
                    <span>{l.name}</span>
                    <Badge variant="outline">{t(`lists.${l.visibility}`)}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-1 text-sm text-muted-foreground">
                  {l.description && <p className="line-clamp-2">{l.description}</p>}
                  <p>
                    {t('lists.items', { count: l._count.items })}
                    {l.owner.id !== user?.id && ` · ${l.owner.username}`}
                    {l.isCollaborative && ` · ${t('lists.collaborative').split(' (')[0]}`}
                    {l.parentListId && ` · ${t('lists.derive')}`}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
      {creating && <ListFormDialog onClose={() => setCreating(false)} onSaved={(l) => nav(`/lists/${l.id}`)} />}
    </div>
  )
}

export function ListFormDialog({ list, onClose, onSaved }: { list?: any; onClose(): void; onSaved(l: any): void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [form, setForm] = useState({
    name: list?.name ?? '',
    description: list?.description ?? '',
    visibility: list?.visibility ?? 'PRIVATE',
    isCollaborative: list?.isCollaborative ?? false,
  })
  const submit = async () => {
    try {
      const l = list ? await patch(`/lists/${list.id}`, form) : await post('/lists', form)
      void qc.invalidateQueries({ queryKey: ['lists'] })
      void qc.invalidateQueries({ queryKey: ['list'] })
      onSaved(l)
      onClose()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{list ? t('common.edit') : t('lists.new')}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label={t('common.name')}>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
          </Field>
          <Field label={t('common.description')}>
            <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <Field label={t('lists.visibility')}>
            <NativeSelect value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })}>
              {['PRIVATE', 'SHARED', 'PUBLIC'].map((v) => (
                <option key={v} value={v}>
                  {t(`lists.${v}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={form.isCollaborative} onCheckedChange={(c) => setForm({ ...form, isCollaborative: !!c })} />
            {t('lists.collaborative')}
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={!form.name}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
