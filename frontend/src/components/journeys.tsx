import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { get, post, patch, authUrl } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Empty, errMsg, formatBytes, formatDate } from '@/components/common'

type Entry = { key: string; sha1: string; size: number }
type Command = { id: string; journeyId: string; status: string; error: string | null }
type Binding = { id: string; journeyId: string; generation: number; updatedAt: string; device: { name: string; lastSeenAt: string | null }; commands: Command[] }
type Journey = { id: string; slot: number; name: string; head: number; metadata: number; archived: boolean; updatedAt: string; identityId: string; identity: { title: string; platform: string; digest: string }; entries: Entry[]; devices: Binding[] }
const ACTIVE = ['pending', 'waiting', 'error', 'downloading']
type Revision = { id: string; number: number; base: number; conflict: boolean; createdAt: string; manifest: Entry[]; sourceDevice?: { name: string } | null }

export function Journeys({ gameId }: { gameId?: number } = {}) {
  const { t } = useTranslation()
  const cache = useQueryClient()
  const { data = [], isPending, error } = useQuery({ queryKey: ['journeys', gameId], queryFn: () => get<Journey[]>(`/journeys${gameId ? `?gameId=${gameId}` : ''}`), refetchInterval: 15000 })
  const [q, setQ] = useState('')
  const [archived, setArchived] = useState(false)
  const [edit, setEdit] = useState<{ source: Journey; action: 'new' | 'duplicate' | 'rename' | 'all'; name: string; consoles?: string[] } | null>(null)
  const [history, setHistory] = useState<Journey | null>(null)
  const [busy, setBusy] = useState(false)
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true)
    try { await action(); await cache.invalidateQueries({ queryKey: ['journeys'] }); setEdit(null) }
    catch (e) { toast.error(errMsg(e)) }
    finally { setBusy(false) }
  }
  const submit = () => {
    if (!edit) return
    const { source, action, name } = edit
    return perform(() => action === 'all'
      ? post(`/journeys/${source.id}/switch-requests`, { bindings: source.devices.filter((d) => edit.consoles?.includes(d.id)).map((d) => ({ id: d.id, generation: d.generation })) })
      : action === 'rename'
        ? patch(`/journeys/${source.id}`, { name, metadata: source.metadata })
        : post('/journeys', { id: crypto.randomUUID(), identityId: source.identityId, name, ...(action === 'duplicate' ? { sourceId: source.id, sourceRevision: source.head } : {}) }))
  }
  const filtered = data.filter((j) => j.archived === archived && `${j.name} ${j.identity.title} ${j.identity.platform}`.toLowerCase().includes(q.toLowerCase()))
  const groups = new Map<string, Journey[]>()
  for (const journey of filtered) groups.set(journey.identityId, [...(groups.get(journey.identityId) ?? []), journey])
  // Slot order, as the consoles list them
  for (const [id, list] of groups) groups.set(id, [...list].sort((a, b) => a.slot - b.slot))
  return <div className="space-y-5">
    <p className="max-w-2xl text-sm text-muted-foreground">{t('journeys.explain')}</p>
    <Input className="max-w-sm" aria-label={t('common.search')} placeholder={t('journeys.search')} value={q} onChange={(e) => setQ(e.target.value)} />
    <Button size="sm" variant="outline" aria-pressed={archived} onClick={() => setArchived(!archived)}>{t('journeys.showArchived')}</Button>
    {isPending && <p>{t('common.loading')}</p>}
    {error && <p role="alert">{errMsg(error)}</p>}
    {!isPending && !error && !filtered.length && <Empty>{t('journeys.empty')}</Empty>}
    {[...groups].map(([identity, journeys]) => <section key={identity} className="space-y-3">
      <div><h2 className="text-lg font-semibold break-words">{journeys[0].identity.title}</h2><p className="text-xs text-muted-foreground">{journeys[0].identity.platform} · {t('journeys.exactRom')} · {journeys[0].identity.digest.slice(0, 12)}</p></div>
      <div className="divide-y rounded-lg border">
        {journeys.map((j) => <div key={j.id} className="space-y-3 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h3 className="font-medium">{j.slot > 0 && <span className="mr-2 tabular-nums text-muted-foreground">{String(j.slot).padStart(2, '0')}</span>}{j.name}</h3><p className="text-sm text-muted-foreground">{j.entries.length} {t('journeys.files')} · {formatBytes(j.entries.reduce((sum, e) => sum + e.size, 0))} · {formatDate(j.updatedAt)}</p></div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setHistory(j)}>{t('journeys.content')}</Button>
              <Button size="sm" variant="outline" onClick={() => setEdit({ source: j, action: 'duplicate', name: `${j.name} — ${t('journeys.copy')}`.slice(0, 80) })}>{t('journeys.duplicate')}</Button>
              <Button size="sm" variant="ghost" onClick={() => setEdit({ source: j, action: 'rename', name: j.name })}>{t('journeys.rename')}</Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">{t('journeys.selectedOn')}</span>
            {j.devices.filter((d) => d.journeyId === j.id).map((d) => <Badge key={d.id} variant="secondary">{d.device.name}</Badge>)}
            {!j.devices.some((d) => d.journeyId === j.id) && <span>{t('journeys.noConsole')}</span>}
          </div>
          {/* Only requests still under way: a finished one is already told by where the console is */}
          {j.devices.flatMap((d) => d.commands.filter((c) => c.journeyId === j.id).slice(0, 1).filter((c) => ACTIVE.includes(c.status)).map((c) => <div key={c.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span>{d.device.name}: {t(`journeys.status.${c.status}`)}</span>
            {c.error && <span role="alert">{c.error}</span>}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => perform(() => post(`/journeys/commands/${c.id}/cancel`, {}))}>{t('common.cancel')}</Button>
          </div>))}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={j.archived || !j.devices.length} onClick={() => setEdit({ source: j, action: 'all', name: '', consoles: j.devices.filter((d) => d.journeyId !== j.id).map((d) => d.id) })}>{t('journeys.useAll')}</Button>
            <Button size="sm" variant="ghost" disabled={busy || (!j.archived && j.devices.some((d) => d.journeyId === j.id))} onClick={() => perform(() => patch(`/journeys/${j.id}`, { archived: !j.archived, metadata: j.metadata }))}>{t(j.archived ? 'journeys.unarchive' : 'journeys.archive')}</Button>
          </div>
        </div>)}
      </div>
      <Button variant="outline" onClick={() => setEdit({ source: journeys[0], action: 'new', name: '' })}>{t('journeys.new')}</Button>
    </section>)}
    {edit && <Dialog open onOpenChange={(open) => { if (!open && !busy) setEdit(null) }}><DialogContent>
      <DialogHeader><DialogTitle>{t(`journeys.action.${edit.action}`)}</DialogTitle></DialogHeader>
      {edit.action === 'all' ? <div className="space-y-3"><p className="text-sm">{t('journeys.allExplain', { name: edit.source.name })}</p><ul className="space-y-2 text-sm">{edit.source.devices.map((d) => <li key={d.id}><label className="flex items-center gap-2"><Checkbox checked={!!edit.consoles?.includes(d.id)} onCheckedChange={(c) => setEdit({ ...edit, consoles: c ? [...(edit.consoles ?? []), d.id] : (edit.consoles ?? []).filter((x) => x !== d.id) })} /><span>{d.device.name} · {d.journeyId === edit.source.id ? t('journeys.alreadyHere') : `${t('journeys.lastSeen')} ${d.device.lastSeenAt ? formatDate(d.device.lastSeenAt) : t('journeys.never')}`}</span></label></li>)}</ul></div>
        : <><Input maxLength={80} aria-label={t('common.name')} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />{edit.action === 'duplicate' && <p className="text-sm text-muted-foreground">{t('journeys.duplicateExplain')}</p>}</>}
      <DialogFooter cancel={false}><Button variant="outline" disabled={busy} onClick={() => setEdit(null)}>{t('common.cancel')}</Button><Button disabled={busy || (edit.action === 'all' ? !edit.consoles?.length : !edit.name.trim())} onClick={submit}>{busy ? t('common.loading') : t(`journeys.action.${edit.action}`)}</Button></DialogFooter>
    </DialogContent></Dialog>}
    {history && <JourneyHistory journey={history} onClose={() => setHistory(null)} />}
  </div>
}

function JourneyHistory({ journey, onClose }: { journey: Journey; onClose: () => void }) {
  const { t } = useTranslation()
  const cache = useQueryClient()
  const { data = [], isPending, error } = useQuery({ queryKey: ['journey-history', journey.id], queryFn: () => get<Revision[]>(`/journeys/${journey.id}/revisions`) })
  const [busy, setBusy] = useState(false)
  const [restore, setRestore] = useState<Revision | null>(null)
  const apply = async () => {
    if (!restore) return
    setBusy(true)
    try {
      const result = await post<{ conflict: boolean }>(`/journeys/${journey.id}/restore`, { checkpoint: restore.id, base: journey.head, operation: crypto.randomUUID() })
      if (result.conflict) toast.error(t('journeys.restoreConflict'))
      else { await cache.invalidateQueries({ queryKey: ['journeys'] }); await cache.invalidateQueries({ queryKey: ['journey-history', journey.id] }); onClose() }
    } catch (e) { toast.error(errMsg(e)) }
    finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
    <DialogHeader><DialogTitle>{journey.name} · {t('journeys.content')}</DialogTitle></DialogHeader>
    {isPending && <p>{t('common.loading')}</p>}{error && <p role="alert">{errMsg(error)}</p>}
    {!data.length && !isPending && <p>{t('journeys.noFiles')}</p>}
    {data.map((r) => <section key={r.id} className="space-y-2 border-t pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">{formatDate(r.createdAt)} · {r.sourceDevice?.name ?? 'Web'} · {r.conflict ? t('journeys.conflict') : `#${r.number}`}</h3><Button size="sm" variant="outline" disabled={busy} onClick={() => setRestore(r)}>{t('journeys.restore')}</Button></div>
      <ul className="space-y-1 text-sm">{r.manifest.map((e) => <li key={e.key} className="flex flex-wrap justify-between gap-2"><span className="break-all">{e.key} · {formatBytes(e.size)}</span><a className="underline underline-offset-4" href={authUrl(`/journeys/${journey.id}/blob/${e.sha1}`)}>{t('common.download')}</a></li>)}</ul>
    </section>)}
    {restore && <div className="space-y-2 rounded border p-3"><p className="text-sm">{t('journeys.restoreExplain')}</p><div className="flex gap-2"><Button disabled={busy} onClick={apply}>{t('journeys.restore')}</Button><Button variant="outline" disabled={busy} onClick={() => setRestore(null)}>{t('common.cancel')}</Button></div></div>}
  </DialogContent></Dialog>
}
