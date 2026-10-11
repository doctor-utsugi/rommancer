import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ListPlus } from 'lucide-react'
import { toast } from 'sonner'
import { get, post } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Field, NativeSelect, errMsg } from '@/components/common'

export interface ListItemRef {
  gameId?: number
  romId?: number
  hackId?: number
  workId?: number
}

export function AddToListButton({ items, size = 'sm', label }: { items: ListItemRef[]; size?: 'sm' | 'icon-sm'; label?: boolean }) {
  const { t } = useTranslation()
  const { can } = useAuth()
  const [open, setOpen] = useState(false)
  if (!can('lists')) return null
  return (
    <>
      <Button variant="outline" size={size} onClick={() => setOpen(true)} title={t('games.addToList')} disabled={!items.length}>
        <ListPlus className="size-4" />
        {label !== false && size !== 'icon-sm' && t('games.addToList')}
      </Button>
      {open && <AddToListDialog items={items} onClose={() => setOpen(false)} />}
    </>
  )
}

function AddToListDialog({ items, onClose }: { items: ListItemRef[]; onClose(): void }) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const qc = useQueryClient()
  const lists = useQuery({ queryKey: ['lists', 'all'], queryFn: () => get<any[]>('/lists?scope=all') })
  const editable = (lists.data ?? []).filter(
    (l) => l.ownerId === user?.id || l.shares.some((s: any) => s.userId === user?.id && s.canEdit) || l.isCollaborative,
  )
  const [listId, setListId] = useState<string>('')
  const [newName, setNewName] = useState('')
  const submit = async () => {
    try {
      let id = Number(listId)
      if (!id) {
        const l = await post('/lists', { name: newName || t('lists.new') })
        id = l.id
      }
      const r = await post(`/lists/${id}/items`, { items })
      toast.success(`${t('lists.addedTo')} (${r.added})`)
      void qc.invalidateQueries({ queryKey: ['lists'] })
      void qc.invalidateQueries({ queryKey: ['list', String(id)] })
      onClose()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('games.addToList')}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label={t('lists.pickList')}>
            <NativeSelect value={listId} onChange={(e) => setListId(e.target.value)}>
              <option value="">+ {t('lists.new')}</option>
              {editable.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.owner.username})
                </option>
              ))}
            </NativeSelect>
          </Field>
          {!listId && (
            <Field label={t('common.name')}>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('lists.new')} />
            </Field>
          )}
        </div>
        <DialogFooter cancel={false}>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void submit()}>{t('common.add')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
