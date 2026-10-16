import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ChevronRight } from 'lucide-react'
import { get, post, patch, authUrl } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Empty, errMsg, formatBytes, formatDate } from '@/components/common'
import { cn } from '@/lib/utils'

type Entry = { key: string; sha1: string; size: number }
type Command = { id: string; journeyId: string; status: string; error: string | null }
type Binding = { id: string; journeyId: string; generation: number; updatedAt: string; device: { name: string; lastSeenAt: string | null }; commands: Command[] }
type Journey = { id: string; slot: number; name: string; head: number; metadata: number; archived: boolean; updatedAt: string; identityId: string; identity: { title: string; platform: string; digest: string }; entries: Entry[]; devices: Binding[] }
const ACTIVE = ['pending', 'waiting', 'error', 'downloading']
type Revision = { id: string; number: number; base: number; conflict: boolean; createdAt: string; manifest: Entry[]; sourceDevice?: { name: string } | null }

/** A journey's save and savestates, each state's picture beside it rather than a row of its own */
function files(entries: Entry[]) {
  const thumbs = new Map(entries.flatMap((e) => { const m = e.key.match(/(^|\/)thumb\/(\d+)$/); return m ? [[`${e.key.slice(0, -m[0].length)}|${m[2]}`, e] as const] : [] }))
  return entries
    .filter((e) => !/(^|\/)thumb\/\d+$/.test(e.key))
    .map((e) => {
      const m = e.key.match(/(^|\/)(state|save)\/(\d+)$/)
      const label = m ? (m[2] === 'save' ? { key: 'journeys.file.save', vars: {} } : { key: 'journeys.file.state', vars: { n: m[3] } }) : null
      return { e, label, thumb: m?.[2] === 'state' ? thumbs.get(`${e.key.slice(0, -m[0].length)}|${m[3]}`) : undefined, order: m ? (m[2] === 'save' ? -1 : Number(m[3])) : 1e9 }
    })
    .sort((a, b) => a.order - b.order || a.e.key.localeCompare(b.e.key))
}

export function Journeys({ gameId }: { gameId?: number } = {}) {
  const { t } = useTranslation()
  const cache = useQueryClient()
  const { data = [], isPending, error } = useQuery({ queryKey: ['journeys', gameId], queryFn: () => get<Journey[]>(`/journeys${gameId ? `?gameId=${gameId}` : ''}`), refetchInterval: 15000 })
  const [q, setQ] = useState('')
  const [archived, setArchived] = useState(false)
  const [edit, setEdit] = useState<{ source: Journey; action: 'new' | 'duplicate' | 'rename' | 'all'; name: string; consoles?: string[] } | null>(null)
  const [history, setHistory] = useState<Journey | null>(null)
  const [busy, setBusy] = useState(false)
  const [openGames, setOpenGames] = useState<Set<string>>(new Set())
  const [openJourneys, setOpenJourneys] = useState<Set<string>>(new Set())
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
  const toggle = (set: Set<string>, key: string) => { const n = new Set(set); if (n.has(key)) n.delete(key); else n.add(key); return n }
  const latest = (list: Journey[]) => list.reduce((m, j) => (j.updatedAt > m ? j.updatedAt : m), list[0].updatedAt)
  const games = [...groups].sort((a, b) => latest(b[1]).localeCompare(latest(a[1])))
  return <div className="space-y-4">
    <p className="max-w-2xl text-sm text-muted-foreground">{t('journeys.explain')}</p>
    <div className="flex flex-wrap items-center gap-2">
      <Input className="max-w-sm" aria-label={t('common.search')} placeholder={t('journeys.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      <Button size="sm" variant="outline" aria-pressed={archived} onClick={() => setArchived(!archived)}>{t('journeys.showArchived')}</Button>
    </div>
    {isPending && <p>{t('common.loading')}</p>}
    {error && <p role="alert">{errMsg(error)}</p>}
    {!isPending && !error && !filtered.length && <Empty>{t('journeys.empty')}</Empty>}
    <div className="space-y-2">
      {games.map(([identity, journeys]) => {
        const open = !!gameId || openGames.has(identity)
        const using = [...new Set(journeys.flatMap((j) => j.devices.filter((d) => d.journeyId === j.id).map((d) => d.device.name)))]
        return <section key={identity} className={cn('rounded-xl border', open && 'border-primary/40')}>
          <button type="button" aria-expanded={open} className="flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-muted/50" onClick={() => setOpenGames(toggle(openGames, identity))}>
            {!gameId && <ChevronRight className={cn('size-4 shrink-0 transition-transform', open && 'rotate-90')} />}
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{journeys[0].identity.title}</p>
              <p className="truncate text-xs text-muted-foreground">{journeys[0].identity.platform} · {t('journeys.count', { count: journeys.length })} · {formatDate(latest(journeys))}{using.length > 0 && ` · ${t('journeys.inUseOn', { devices: using.join(', ') })}`}</p>
            </div>
          </button>
          {open && <div className="border-t">
            <ul className="divide-y">
              {journeys.map((j) => {
                const here = j.devices.filter((d) => d.journeyId === j.id)
                const filesOpen = openJourneys.has(j.id)
                return <li key={j.id}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
                    <button type="button" aria-expanded={filesOpen} className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpenJourneys(toggle(openJourneys, j.id))}>
                      <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', filesOpen && 'rotate-90')} />
                      {j.slot > 0 && <span className="w-6 shrink-0 tabular-nums text-xs text-muted-foreground">{String(j.slot).padStart(2, '0')}</span>}
                      <span className="truncate font-medium">{j.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{j.entries.length} {t('journeys.files')} · {formatBytes(j.entries.reduce((sum, e) => sum + e.size, 0))} · {formatDate(j.updatedAt)}</span>
                    </button>
                    <div className="flex flex-wrap items-center gap-1">
                      {here.map((d) => <Badge key={d.id} variant="secondary">{d.device.name}</Badge>)}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      <Button size="sm" variant="outline" disabled={j.archived || !j.devices.length} onClick={() => setEdit({ source: j, action: 'all', name: '', consoles: j.devices.filter((d) => d.journeyId !== j.id).map((d) => d.id) })}>{t('journeys.useAll')}</Button>
                      <Button size="sm" variant="ghost" onClick={() => setHistory(j)}>{t('journeys.history')}</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEdit({ source: j, action: 'duplicate', name: `${j.name} — ${t('journeys.copy')}`.slice(0, 80) })}>{t('journeys.duplicate')}</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEdit({ source: j, action: 'rename', name: j.name })}>{t('journeys.rename')}</Button>
                      <Button size="sm" variant="ghost" disabled={busy || (!j.archived && here.length > 0)} onClick={() => perform(() => patch(`/journeys/${j.id}`, { archived: !j.archived, metadata: j.metadata }))}>{t(j.archived ? 'journeys.unarchive' : 'journeys.archive')}</Button>
                    </div>
                  </div>
                  {/* Only requests still under way: a finished one is already told by where the console is */}
                  {j.devices.flatMap((d) => d.commands.filter((c) => c.journeyId === j.id).slice(0, 1).filter((c) => ACTIVE.includes(c.status)).map((c) => <div key={c.id} className="flex flex-wrap items-center gap-2 px-3 pb-2 pl-11 text-sm">
                    <span>{d.device.name}: {t(`journeys.status.${c.status}`)}</span>
                    {c.error && <span role="alert">{c.error}</span>}
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => perform(() => post(`/journeys/commands/${c.id}/cancel`, {}))}>{t('common.cancel')}</Button>
                  </div>))}
                  {filesOpen && <ul className="mx-3 mb-2 ml-11 divide-y rounded-md border bg-muted/30 text-sm">
                    {!j.entries.length && <li className="px-3 py-2 text-muted-foreground">{t('journeys.noFiles')}</li>}
                    {files(j.entries).map(({ e, label, thumb }) => <li key={e.key} className="flex items-center gap-3 px-3 py-1.5">
                      {thumb ? <img src={authUrl(`/journeys/${j.id}/blob/${thumb.sha1}`)} loading="lazy" alt="" className="h-9 w-12 shrink-0 rounded border bg-black object-contain [image-rendering:pixelated]" /> : <span className="h-9 w-12 shrink-0" />}
                      <span className="min-w-0 flex-1 truncate" title={e.key}>{label ? t(label.key, label.vars) : <span className="font-mono text-xs">{e.key}</span>}</span>
                      <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">{formatBytes(e.size)}<a className="text-primary hover:underline" href={authUrl(`/journeys/${j.id}/blob/${e.sha1}`)}>{t('common.download')}</a></span>
                    </li>)}
                  </ul>}
                </li>
              })}
            </ul>
            <div className="border-t p-2"><Button size="sm" variant="ghost" onClick={() => setEdit({ source: journeys[0], action: 'new', name: '' })}>+ {t('journeys.new')}</Button></div>
          </div>}
        </section>
      })}
    </div>
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
