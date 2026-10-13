import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Gamepad2, Star } from 'lucide-react'
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
  const { data: all } = useQuery({ queryKey: ['lists', scope], queryFn: () => get<any[]>(`/lists?scope=${scope}`) })
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const data = needle ? all?.filter((l) => `${l.kind === 'favorites' ? t('more.fav.listName') : l.name} ${l.description ?? ''}`.toLowerCase().includes(needle)) : all

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
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Tabs value={scope} onValueChange={(v) => setScope(String(v))}>
          <TabsList>
            <TabsTrigger value="mine">{t('lists.mine')}</TabsTrigger>
            <TabsTrigger value="shared">{t('lists.shared')}</TabsTrigger>
            <TabsTrigger value="public">{t('lists.public')}</TabsTrigger>
          </TabsList>
        </Tabs>
        <Input className="w-64" value={q} placeholder={t('common.search')} onChange={(e) => setQ(e.target.value)} />
      </div>
      {!data?.length ? (
        <Empty />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.map((l) => (
            <Link key={l.id} to={`/lists/${l.id}`}>
              <Card className="h-full transition-colors hover:bg-muted/50">
                <CardHeader>
                  <CardTitle className="flex items-start justify-between gap-2">
                    <span className="flex items-center gap-2">
                      {l.kind === 'favorites' && <Star className="size-4 fill-amber-400 text-amber-500" />}
                      {l.kind === 'favorites' ? t('more.fav.listName') : l.name}
                    </span>
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
                  {l.devices?.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {l.devices.map(({ device }: any) => (
                        <Badge key={device.id} variant="secondary">
                          <Gamepad2 className="size-3" />
                          {device.name}
                        </Badge>
                      ))}
                    </div>
                  )}
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

export interface ListForm {
  name: string
  description: string
  visibility: string
  isCollaborative: boolean
}

/**
 * A list's name, description and sharing: editing LIST, or a new one (from INITIAL values, saved by SAVE when given,
 * with TITLE, CHILDREN shown above the fields and SAVELABEL on the button)
 */
export function ListFormDialog({
  list,
  initial,
  title,
  children,
  save,
  saveLabel,
  onClose,
  onSaved,
}: {
  list?: any
  initial?: Partial<ListForm>
  title?: string
  children?: React.ReactNode
  save?(form: ListForm): Promise<any>
  saveLabel?: string
  onClose(): void
  onSaved(l: any): void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<ListForm>({
    name: list?.name ?? initial?.name ?? '',
    description: list?.description ?? initial?.description ?? '',
    visibility: list?.visibility ?? initial?.visibility ?? 'PRIVATE',
    isCollaborative: list?.isCollaborative ?? initial?.isCollaborative ?? false,
  })
  const submit = async () => {
    setBusy(true)
    try {
      const l = list ? await patch(`/lists/${list.id}`, form) : save ? await save(form) : await post('/lists', form)
      void qc.invalidateQueries({ queryKey: ['lists'] })
      void qc.invalidateQueries({ queryKey: ['list'] })
      onSaved(l)
      onClose()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{list ? t('common.edit') : (title ?? t('lists.new'))}</DialogTitle>
        </DialogHeader>
        {children}
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
        <DialogFooter cancel={false}>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={!form.name || busy}>
            {saveLabel ?? t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
