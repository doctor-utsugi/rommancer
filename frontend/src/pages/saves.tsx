import { useState } from 'react'
import { Link } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Ban, Check, ChevronDown, ChevronRight, Clock, Download, History, ImageOff, LayoutList, Play, Rows3, Share2, Trash2, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { authUrl, del, get, patch, post, put, upload } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Checkbox } from '@/components/ui/checkbox'
import { Empty, Field, NativeSelect, PageHeader, errMsg, formatBytes, formatDate } from '@/components/common'

const family = (f: string) => (f.startsWith('ps1') ? 'ps1' : f)

function useEmulators() {
  return useQuery({ queryKey: ['emulators'], queryFn: () => get<any[]>('/devices/emulators'), staleTime: 300_000 })
}

export function SavesPage() {
  const { t } = useTranslation()
  const { data } = useQuery({ queryKey: ['saves'], queryFn: () => get<any[]>('/saves') })
  const [open, setOpen] = useState<number | null>(null)
  const [uploading, setUploading] = useState(false)
  const [view, setView] = useState<'games' | 'list'>(() => {
    try {
      return localStorage.getItem('saves-view') === 'list' ? 'list' : 'games'
    } catch {
      return 'games'
    }
  })
  const pick = (v: 'games' | 'list') => {
    setView(v)
    remember('saves-view', v)
  }
  const [onlyPlayed, setOnlyPlayed] = useState(() => {
    try {
      return localStorage.getItem('saves-only-played') !== '0'
    } catch {
      return true
    }
  })
  // A game only started: its save is the blank file it wrote at its first start (the server tells); savestates and
  // memory card entries are only written when the player saves, so they always show
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const found = needle ? data?.filter((s) => `${s.game?.title ?? ''} ${s.baseName} ${s.label ?? ''} ${s.game?.system.name ?? ''}`.toLowerCase().includes(needle)) : data
  const shown = onlyPlayed ? found?.filter((s) => !s.unplayed) : found
  const hidden = (found?.length ?? 0) - (shown?.length ?? 0)
  return (
    <div>
      <PageHeader title={t('saves.title')}>
        <Button size="sm" onClick={() => setUploading(true)}>
          {t('saves.upload')}
        </Button>
      </PageHeader>
      <Conflicts />
      <Tabs defaultValue="mine">
        <TabsList>
          <TabsTrigger value="mine">{t('more.saves.mine')}</TabsTrigger>
          <TabsTrigger value="shared">{t('more.saves.shared')}</TabsTrigger>
          <TabsTrigger value="cards">{t('more.saves.cards')}</TabsTrigger>
        </TabsList>
        <TabsContent value="mine" className="space-y-3">
          <div className="flex flex-wrap items-center gap-1">
            <Input className="mr-2 w-64" value={q} placeholder={t('more.saves.search')} onChange={(e) => setQ(e.target.value)} />
            <Button size="sm" variant={view === 'games' ? 'default' : 'outline'} onClick={() => pick('games')}>
              <Rows3 className="size-4" />
              {t('more.saves.byGame')}
            </Button>
            <Button size="sm" variant={view === 'list' ? 'default' : 'outline'} onClick={() => pick('list')}>
              <LayoutList className="size-4" />
              {t('more.saves.asList')}
            </Button>
            <label className="ml-3 flex items-center gap-2 text-sm" title={t('more.saves.onlyPlayedHelp')}>
              <Checkbox
                checked={onlyPlayed}
                onCheckedChange={(c) => {
                  setOnlyPlayed(!!c)
                  remember('saves-only-played', c ? '1' : '0')
                }}
              />
              {t('more.saves.onlyPlayed')}
              {onlyPlayed && hidden > 0 && <span className="text-xs text-muted-foreground">({t('more.saves.hiddenUnplayed', { count: hidden })})</span>}
            </label>
          </div>
          {view === 'games' ? <SavesByGame saves={shown} onOpen={setOpen} /> : <MySaves saves={shown} onOpen={setOpen} />}
        </TabsContent>
        <TabsContent value="shared">
          <SharedSaves />
        </TabsContent>
        <TabsContent value="cards">
          <MemoryCards />
        </TabsContent>
      </Tabs>
      {open && <VersionsDialog saveId={open} onClose={() => setOpen(null)} />}
      {uploading && <UploadDialog onClose={() => setUploading(false)} />}
    </div>
  )
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* private mode */
  }
}

const slotLabel = (slot: number) => (slot === -1 ? 'auto' : `#${slot}`)

/** The emulator's screenshot of a savestate, opened full size on click */
function Thumb({ src, className = 'h-14' }: { src: string; className?: string }) {
  return (
    <a href={src} target="_blank" rel="noreferrer" className="shrink-0">
      <img src={src} loading="lazy" alt="" className={`${className} rounded border bg-black object-contain [image-rendering:pixelated]`} />
    </a>
  )
}

/** Consoles of the user with another version of the core a savestate was made with */
function CoreWarning({ warnings, version, short }: { warnings?: { name: string; version: string }[]; version?: string | null; short?: boolean }) {
  const { t } = useTranslation()
  if (!warnings?.length) return null
  const text = t('more.saves.coreWarning', { version, devices: warnings.map((w) => `${w.name} (${w.version})`).join(', ') })
  return (
    <span className="inline-flex items-start gap-1 text-xs text-amber-600 dark:text-amber-400" title={text}>
      <TriangleAlert className="mt-px size-3.5 shrink-0" />
      {!short && text}
    </span>
  )
}

const STATUS = {
  synced: { icon: Check, className: 'border-green-600/40 text-green-700 dark:text-green-400' },
  pending: { icon: Clock, className: 'text-muted-foreground' },
  conflict: { icon: TriangleAlert, className: 'border-amber-500/50 text-amber-600 dark:text-amber-400' },
  incompatible: { icon: Ban, className: 'text-muted-foreground line-through' },
} as const

/** Each of the user's consoles that has (or will get) this save, and how it stands there */
function SaveConsoles({ devices }: { devices?: { deviceId: number; name: string; status: keyof typeof STATUS }[] }) {
  const { t } = useTranslation()
  if (!devices?.length) return <span className="text-xs text-muted-foreground">-</span>
  return (
    <div className="flex flex-wrap gap-1">
      {devices.map((d) => {
        const { icon: Icon, className } = STATUS[d.status]
        return (
          <span key={d.deviceId} title={`${d.name}: ${t(`more.saves.status.${d.status}`)}`} className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs ${className}`}>
            <Icon className="size-3" />
            {d.name}
          </span>
        )
      })}
    </div>
  )
}

const currentOf = (s: any) => s.versions.find((v: any) => v.id === s.currentVersionId)
const dateOf = (s: any) => new Date(currentOf(s)?.fileMtime ?? s.updatedAt).getTime()

/** The user's saves grouped by game, latest played first; each game opens into its saves and states by date */
function SavesByGame({ saves, onOpen }: { saves: any[] | undefined; onOpen(id: number): void }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  if (!saves?.length) return <Empty />
  const groups = new Map<string, any[]>()
  for (const s of saves) {
    const key = s.game ? `g${s.game.id}` : `n${s.baseName}`
    groups.set(key, [...(groups.get(key) ?? []), s])
  }
  const list = [...groups].map(([key, items]) => ({ key, items: items.sort((a, b) => dateOf(b) - dateOf(a)) })).sort((a, b) => dateOf(b.items[0]) - dateOf(a.items[0]))
  const toggle = (key: string) =>
    setExpanded((e) => {
      const n = new Set(e)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  return (
    <div className="space-y-2">
      {list.map(({ key, items }) => {
        const first = items[0]
        const shot = items.find((s) => currentOf(s)?.thumbPath)
        const open = expanded.has(key)
        return (
          <div key={key} className="rounded-xl border">
            <button type="button" className="flex w-full items-center gap-3 p-3 text-left hover:bg-muted/50" onClick={() => toggle(key)}>
              {open ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
              {shot ? (
                <img src={authUrl(`/saves/${shot.id}/versions/${shot.currentVersionId}/thumb`)} loading="lazy" alt="" className="h-12 w-16 shrink-0 rounded border bg-black object-contain [image-rendering:pixelated]" />
              ) : (
                <div className="flex h-12 w-16 shrink-0 items-center justify-center rounded border bg-muted text-muted-foreground">
                  <ImageOff className="size-4" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{first.game?.title ?? first.baseName}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {first.game?.system.name ?? t('saves.unidentified')} · {t('more.saves.saveCount', { count: items.length })} · {t('more.saves.lastPlayed', { date: formatDate(currentOf(first)?.fileMtime) })}
                </p>
              </div>
              {first.game && (
                <Link className="shrink-0 text-xs text-primary hover:underline" to={`/games/${first.game.id}`} onClick={(e) => e.stopPropagation()}>
                  {t('saves.game')}
                </Link>
              )}
            </button>
            {open && (
              <div className="divide-y border-t">
                {items.map((s) => {
                  const cur = currentOf(s)
                  return (
                    <div key={s.id} className="flex flex-wrap items-center gap-3 p-3">
                      {cur?.thumbPath ? (
                        <Thumb src={authUrl(`/saves/${s.id}/versions/${cur.id}/thumb`)} className="h-20 w-28" />
                      ) : (
                        <div className="flex h-20 w-28 shrink-0 items-center justify-center rounded border bg-muted text-xs text-muted-foreground">{t(`saves.kind.${s.kind}`)}</div>
                      )}
                      <div className="min-w-0 flex-1 space-y-1 text-sm">
                        <div className="flex flex-wrap items-center gap-1">
                          <Badge variant={s.kind === 'SAVE' ? 'default' : 'secondary'}>{t(`saves.kind.${s.kind}`)}</Badge>
                          {s.kind === 'STATE' && <span className="text-xs text-muted-foreground">{slotLabel(s.slot)}</span>}
                          {s.kind === 'ENTRY' && <span className="text-xs text-muted-foreground">{s.label ?? s.baseName}</span>}
                          <span className="font-medium">{formatDate(cur?.fileMtime)}</span>
                          <span className="text-xs text-muted-foreground">· {cur?.sourceDevice?.name ?? t('saves.web')}</span>
                          {s.versions.some((v: any) => v.sharedAt) && (
                            <Badge variant="outline">
                              <Share2 className="size-3" />
                              {t('more.saves.sharedBadge')}
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {s.emulator.name}
                          {cur?.coreVersion && ` · ${t('more.saves.core', { version: cur.coreVersion })}`}
                        </p>
                        <SaveConsoles devices={s.devices} />
                        <CoreWarning warnings={s.coreWarnings} version={cur?.coreVersion} />
                      </div>
                      <Button variant="outline" size="sm" onClick={() => onOpen(s.id)}>
                        <History className="size-4" />
                        {t('saves.versions')} ({s.versions.length})
                      </Button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function MySaves({ saves, onOpen }: { saves: any[] | undefined; onOpen(id: number): void }) {
  const { t } = useTranslation()
  if (!saves?.length) return <Empty />
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('saves.game')}</TableHead>
          <TableHead>{t('saves.emulator')}</TableHead>
          <TableHead>{t('common.type')}</TableHead>
          <TableHead>{t('saves.versions')}</TableHead>
          <TableHead>{t('saves.current')}</TableHead>
          <TableHead>{t('more.saves.consoles')}</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {saves.map((s) => {
          const cur = s.versions.find((v: any) => v.id === s.currentVersionId)
          return (
            <TableRow key={s.id}>
              <TableCell className="max-w-md">
                <div className="flex items-center gap-3">
                  {cur?.thumbPath && <Thumb src={authUrl(`/saves/${s.id}/versions/${cur.id}/thumb`)} className="h-14" />}
                  <div className="min-w-0">
                    {s.game ? (
                      <Link className="font-medium hover:underline" to={`/games/${s.game.id}`}>
                        {s.game.title}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">{t('saves.unidentified')}</span>
                    )}
                    <p className="truncate text-xs text-muted-foreground">
                      {s.label && `${s.label} · `}
                      {s.baseName}
                      {s.game && ` · ${s.game.system.name}`}
                    </p>
                  </div>
                </div>
              </TableCell>
              <TableCell>
                {s.emulator.name}
                {cur?.coreVersion && <p className="text-xs text-muted-foreground">{t('more.saves.core', { version: cur.coreVersion })}</p>}
              </TableCell>
              <TableCell>
                <Badge variant={s.kind === 'SAVE' ? 'default' : 'secondary'}>{t(`saves.kind.${s.kind}`)}</Badge>
                {s.kind === 'STATE' && <span className="ml-1 text-xs text-muted-foreground">{slotLabel(s.slot)}</span>}
                {s.versions.some((v: any) => v.sharedAt) && (
                  <Badge variant="outline" className="ml-1">
                    <Share2 className="size-3" />
                    {t('more.saves.sharedBadge')}
                  </Badge>
                )}
                <div>
                  <CoreWarning warnings={s.coreWarnings} version={cur?.coreVersion} short />
                </div>
              </TableCell>
              <TableCell>{s.versions.length}</TableCell>
              <TableCell className="text-xs">
                {formatDate(cur?.fileMtime)}
                <p className="text-muted-foreground">{cur?.sourceDevice?.name ?? t('saves.web')}</p>
              </TableCell>
              <TableCell className="max-w-xs">
                <SaveConsoles devices={s.devices} />
              </TableCell>
              <TableCell>
                <Button variant="outline" size="sm" onClick={() => onOpen(s.id)}>
                  <History className="size-4" />
                  {t('saves.versions')}
                </Button>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

export function VersionsDialog({ saveId, onClose }: { saveId: number; onClose(): void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const emus = useEmulators()
  const { data: s, refetch } = useQuery({ queryKey: ['save', saveId], queryFn: () => get(`/saves/${saveId}`) })
  const [as, setAs] = useState('')
  const [convertTo, setConvertTo] = useState('')
  const [baseName, setBaseName] = useState<string | null>(null)
  const [sharing, setSharing] = useState<any | null>(null)
  if (!s) return null
  const compatible = (emus.data ?? []).filter((e) => family(e.saveFormat) === family(s.emulator.saveFormat))
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      await refetch()
      void qc.invalidateQueries({ queryKey: ['saves'] })
      void qc.invalidateQueries({ queryKey: ['saves-shared'] })
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {s.game?.title ?? s.baseName} · {s.emulator.name}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('saves.downloadAs')}>
            <NativeSelect value={as} onChange={(e) => setAs(e.target.value)}>
              <option value="">{s.emulator.name}</option>
              {s.kind === 'SAVE' &&
                compatible
                  .filter((e) => e.id !== s.emulatorId)
                  .map((e) => (
                    <option key={e.slug} value={e.slug}>
                      {e.name} ({e.saveExt})
                    </option>
                  ))}
            </NativeSelect>
          </Field>
          {s.kind === 'SAVE' && (
            <Field label={t('saves.convert')}>
              <div className="flex gap-2">
                <NativeSelect value={convertTo} onChange={(e) => setConvertTo(e.target.value)}>
                  <option value="">-</option>
                  {compatible
                    .filter((e) => e.id !== s.emulatorId)
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                </NativeSelect>
                <Button variant="outline" size="sm" disabled={!convertTo} onClick={() => void act(() => post(`/saves/${s.id}/convert`, { emulatorId: Number(convertTo) }).then(() => toast.success(t('common.saved'))))}>
                  {t('common.apply')}
                </Button>
              </div>
            </Field>
          )}
          {/* A memory card save is known by its name in the card's directory: it is not renamed */}
          {s.kind !== 'ENTRY' && (
            <Field label={t('saves.baseName')}>
              <div className="flex gap-2">
                <Input className="w-72" value={baseName ?? s.baseName} onChange={(e) => setBaseName(e.target.value)} />
                <Button variant="outline" size="sm" disabled={baseName == null || baseName === s.baseName} onClick={() => void act(() => patch(`/saves/${s.id}`, { baseName }))}>
                  {t('common.save')}
                </Button>
              </div>
            </Field>
          )}
        </div>
        <SaveConsoles devices={s.devices} />
        <CoreWarning warnings={s.coreWarnings} version={s.versions.find((v: any) => v.id === s.currentVersionId)?.coreVersion} />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('common.date')}</TableHead>
              <TableHead>{t('common.size')}</TableHead>
              <TableHead>{t('saves.source')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {s.versions.map((v: any) => (
              <TableRow key={v.id}>
                <TableCell className="text-xs">
                  <div className="flex items-center gap-3">
                    {v.thumbPath && <Thumb src={authUrl(`/saves/${s.id}/versions/${v.id}/thumb`)} />}
                    <div>
                      {formatDate(v.fileMtime)}
                      {v.id === s.currentVersionId && (
                        <Badge className="ml-2" variant="default">
                          {t('saves.current')}
                        </Badge>
                      )}
                      {v.sharedAt && (
                        <Badge className="ml-2" variant="outline">
                          <Share2 className="size-3" />
                          {t('more.saves.sharedBadge')}
                        </Badge>
                      )}
                      {v.note && <p className="text-muted-foreground">{v.note}</p>}
                      {v.coreVersion && <p className="text-muted-foreground">{t('more.saves.core', { version: v.coreVersion })}</p>}
                      {v.shareNote && <p className="italic text-muted-foreground">«{v.shareNote}»</p>}
                    </div>
                  </div>
                </TableCell>
                <TableCell>{formatBytes(v.size)}</TableCell>
                <TableCell>{v.sourceDevice?.name ?? t('saves.web')}</TableCell>
                <TableCell className="space-x-1 text-right">
                  {playable(s) && (
                    <Button variant="outline" size="sm" title={t(s.kind === 'STATE' ? 'more.saves.playStateHelp' : 'more.saves.playHelp')} onClick={() => void play(s.id, v.id, t)}>
                      <Play className="size-4" />
                      {t('more.saves.play')}
                    </Button>
                  )}
                  <Button variant="outline" size="sm" nativeButton={false} render={<a href={authUrl(`/saves/${s.id}/versions/${v.id}/download${as ? `?emulator=${as}` : ''}`)} />}>
                    {t('common.download')}
                  </Button>
                  {v.sharedAt ? (
                    <Button variant="outline" size="sm" onClick={() => void act(() => del(`/saves/${s.id}/versions/${v.id}/share`))}>
                      {t('more.saves.unshare')}
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => setSharing(v)}>
                      <Share2 className="size-4" />
                      {t('more.saves.share')}
                    </Button>
                  )}
                  {v.id !== s.currentVersionId && (
                    <>
                      <Button variant="outline" size="sm" onClick={() => void act(() => post(`/saves/${s.id}/restore`, { versionId: v.id }))}>
                        {t('saves.restore')}
                      </Button>
                      <Button variant="ghost" size="icon-sm" onClick={() => void act(() => del(`/saves/${s.id}/versions/${v.id}`))}>
                        <Trash2 className="size-4" />
                      </Button>
                    </>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <DialogFooter cancel="close">
          <Button
            variant="destructive"
            onClick={() =>
              confirm(t('common.confirmDelete')) &&
              void act(async () => {
                await del(`/saves/${s.id}`)
                onClose()
              })
            }
          >
            {t('common.delete')}
          </Button>
        </DialogFooter>
        {sharing && (
          <ShareDialog
            onClose={() => setSharing(null)}
            onShare={(note) =>
              void act(async () => {
                await put(`/saves/${s.id}/versions/${sharing.id}/share`, { note })
                setSharing(null)
              })
            }
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function ShareDialog({ onClose, onShare }: { onClose(): void; onShare(note: string): void }) {
  const { t } = useTranslation()
  const [note, setNote] = useState('')
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('more.saves.shareTitle')}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t('more.saves.shareHelp')}</p>
        <Field label={t('more.saves.shareNote')}>
          <Input value={note} maxLength={255} placeholder={t('more.saves.shareNotePlaceholder')} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button onClick={() => onShare(note)}>
            <Share2 className="size-4" />
            {t('more.saves.share')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Saves any user made public; GAMEID narrows them to one game (its page), leaving out the user's own */
export function SharedSaves({ gameId }: { gameId?: number }) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const [importing, setImporting] = useState<any | null>(null)
  const params = new URLSearchParams()
  if (gameId) params.set('gameId', String(gameId))
  if (q.trim()) params.set('q', q.trim())
  const { data } = useQuery({ queryKey: ['saves-shared', gameId ?? null, q.trim()], queryFn: () => get<any[]>(`/saves/shared?${params}`) })
  const list = gameId ? data?.filter((v) => !v.mine) : data
  return (
    <div className="space-y-4">
      {!gameId && (
        <div className="flex flex-wrap items-center gap-3">
          <Input className="w-64" value={q} placeholder={t('more.saves.search')} onChange={(e) => setQ(e.target.value)} />
          <p className="text-sm text-muted-foreground">{t('more.saves.sharedHelp')}</p>
        </div>
      )}
      {!list?.length ? (
        <Empty>{t('more.saves.noShared')}</Empty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((v) => (
            <div key={v.id} className="flex gap-3 rounded-xl border p-3">
              {v.hasThumb ? (
                <Thumb src={authUrl(`/saves/shared/${v.id}/thumb`)} className="h-20 w-28" />
              ) : (
                <div className="flex h-20 w-28 shrink-0 items-center justify-center rounded border bg-muted text-muted-foreground">
                  <ImageOff className="size-5" />
                </div>
              )}
              <div className="min-w-0 flex-1 space-y-1 text-sm">
                <p className="truncate font-medium">
                  {v.save.game && !gameId ? (
                    <Link className="hover:underline" to={`/games/${v.save.game.id}`}>
                      {v.save.game.title}
                    </Link>
                  ) : (
                    (v.save.game?.title ?? v.save.baseName)
                  )}
                </p>
                <div className="flex flex-wrap items-center gap-1">
                  <Badge variant={v.save.kind === 'SAVE' ? 'default' : 'secondary'}>{t(`saves.kind.${v.save.kind}`)}</Badge>
                  {v.save.kind === 'STATE' && <span className="text-xs text-muted-foreground">{slotLabel(v.save.slot)}</span>}
                  <span className="text-xs text-muted-foreground">
                    {v.save.emulator.name}
                    {v.coreVersion && ` · ${t('more.saves.core', { version: v.coreVersion })}`}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {v.mine ? t('more.saves.yours') : t('more.saves.by', { user: v.save.user.username })} · {formatDate(v.sharedAt)}
                </p>
                {v.shareNote && <p className="text-xs italic">«{v.shareNote}»</p>}
                <CoreWarning warnings={v.coreWarnings} version={v.coreVersion} />
                <div className="flex flex-wrap gap-1 pt-1">
                  {!v.mine && (
                    <Button size="sm" onClick={() => setImporting(v)}>
                      {t('more.saves.import')}
                    </Button>
                  )}
                  <Button variant="outline" size="sm" nativeButton={false} render={<a href={authUrl(`/saves/shared/${v.id}/download`)} />}>
                    <Download className="size-4" />
                    {t('common.download')}
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {importing && <ImportDialog version={importing} onClose={() => setImporting(null)} />}
    </div>
  )
}

function ImportDialog({ version: v, onClose }: { version: any; onClose(): void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const state = v.save.kind === 'STATE'
  const [slot, setSlot] = useState(String(v.save.slot))
  const submit = async () => {
    try {
      await post(`/saves/shared/${v.id}/import`, state ? { slot: Number(slot) } : {})
      void qc.invalidateQueries({ queryKey: ['saves'] })
      toast.success(t('more.saves.imported'))
      onClose()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('more.saves.import')}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{state ? t('more.saves.importHelpState', { emulator: v.save.emulator.name }) : t('more.saves.importHelpSave')}</p>
        {state && (
          <Field label={t('more.saves.importSlot')}>
            <NativeSelect value={slot} onChange={(e) => setSlot(e.target.value)}>
              {[-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                <option key={n} value={n}>
                  {slotLabel(n)}
                </option>
              ))}
            </NativeSelect>
          </Field>
        )}
        <DialogFooter>
          <Button onClick={() => void submit()}>{t('more.saves.import')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function UploadDialog({ onClose }: { onClose(): void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const emus = useEmulators()
  const [file, setFile] = useState<File | null>(null)
  const [emulatorId, setEmulatorId] = useState('')
  const submit = async () => {
    if (!file) return
    const fd = new FormData()
    fd.append('file', file)
    fd.append('emulatorId', emulatorId)
    fd.append('mtime', String(file.lastModified))
    try {
      await upload('/saves/upload', fd)
      void qc.invalidateQueries({ queryKey: ['saves'] })
      toast.success(t('common.saved'))
      onClose()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('saves.upload')}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label={t('saves.emulator')}>
            <NativeSelect value={emulatorId} onChange={(e) => setEmulatorId(e.target.value)}>
              <option value="">-</option>
              {emus.data?.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} ({e.saveExt}
                  {e.stateExt ? `, ${e.stateExt}` : ''})
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t('saves.baseName')}>
            <Input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
        </div>
        <DialogFooter>
          <Button onClick={() => void submit()} disabled={!file || !emulatorId}>
            {t('common.upload')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Memory card files on the user's consoles: what they hold, why something was not written, and their past images */
function MemoryCards() {
  const { t } = useTranslation()
  const { data } = useQuery({ queryKey: ['memory-cards'], queryFn: () => get<any[]>('/saves/cards') })
  if (!data?.length) return <Empty>{t('more.saves.noCards')}</Empty>
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">{t('more.saves.cardsHelp')}</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('more.saves.consoles')}</TableHead>
            <TableHead>{t('more.saves.cardFile')}</TableHead>
            <TableHead>{t('saves.game')}</TableHead>
            <TableHead>{t('more.saves.cardEntries')}</TableHead>
            <TableHead>{t('more.saves.cardFree')}</TableHead>
            <TableHead>{t('more.saves.cardImages')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((c) => (
            <TableRow key={c.id}>
              <TableCell>{c.device.name}</TableCell>
              <TableCell className="max-w-xs">
                <p className="truncate font-mono text-xs" title={c.path}>
                  {c.path.split('/').pop()}
                </p>
                {c.warning && (
                  <p className="flex items-center gap-1 text-xs text-amber-600">
                    <TriangleAlert className="size-3 shrink-0" />
                    {c.warning}
                  </p>
                )}
                {c.offerSha1 && <p className="text-xs text-muted-foreground">{t('more.saves.cardWaiting')}</p>}
              </TableCell>
              <TableCell>
                {c.shared ? (
                  <Badge variant="outline">{t('more.saves.cardShared')}</Badge>
                ) : c.game ? (
                  <Link className="hover:underline" to={`/games/${c.game.id}`}>
                    {c.game.title}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">{t('saves.unidentified')}</span>
                )}
              </TableCell>
              <TableCell>{c.entries}</TableCell>
              <TableCell>{c.freeBlocks ?? '-'}</TableCell>
              <TableCell>
                <div className="flex flex-col gap-0.5 text-xs">
                  {c.snapshots.slice(0, 3).map((sn: any) => (
                    <a key={sn.id} className="flex items-center gap-1 text-primary hover:underline" href={authUrl(`/saves/cards/${c.id}/snapshots/${sn.id}`)}>
                      <Download className="size-3" />
                      {formatDate(sn.createdAt)} · {t(`more.saves.cardImage.${sn.kind}`)}
                    </a>
                  ))}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/** Systems the browser emulator plays (the server has the same list); a save of an unknown game may be one */
const WEB_SYSTEMS = ['nes', 'fds', 'snes', 'gb', 'gbc', 'gba', 'md', 'sms', 'gg', 'sega32x', 'pcengine', 'ngp', 'ngpc', 'wswan', 'wswanc', 'lynx', 'a7800', 'atari2600', 'virtualboy', 'colecovision']
const playable = (s: any) => s.kind !== 'ENTRY' && (!s.game || WEB_SYSTEMS.includes(s.game.system.slug))

/**
 * Opens a version in the browser emulator, in a new tab: the server says which system, rom and file, and the page gets
 * them with their download links in its address's fragment. Nothing played there is kept. The tab opens at once
 * (a tab opened after waiting for the server would be blocked as a popup)
 */
async function play(saveId: number, versionId: number, t: (k: string) => string) {
  const tab = window.open('about:blank', '_blank')
  try {
    const p = await get<any>(`/saves/${saveId}/versions/${versionId}/play`)
    const cfg = { ...p, romUrl: authUrl(p.romUrl), fileUrl: authUrl(p.fileUrl) }
    const url = `/emulatorjs/play.html#${encodeURIComponent(JSON.stringify(cfg))}`
    if (tab) tab.location.href = url
    else window.open(url, '_blank')
  } catch (e) {
    tab?.close()
    toast.error(`${t('more.saves.playFailed')}: ${errMsg(e)}`)
  }
}

function Conflicts() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data, refetch } = useQuery({ queryKey: ['save-conflicts'], queryFn: () => get<any[]>('/saves/conflicts') })
  if (!data?.length) return null
  const resolve = async (id: number, keep: 'device' | 'server') => {
    try {
      await post(`/saves/conflicts/${id}/resolve`, { keep })
      void refetch()
      void qc.invalidateQueries({ queryKey: ['saves'] })
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  const dl = (saveId: number, versionId: number) => authUrl(`/saves/${saveId}/versions/${versionId}/download`)
  return (
    <div className="mb-6 space-y-2 rounded-xl border border-amber-500/50 p-4">
      <p className="font-medium">{t('more.saves.conflicts')}</p>
      <p className="text-sm text-muted-foreground">{t('more.saves.conflictsAlert', { count: data.length })}</p>
      {data.map((c) => (
        <div key={c.id} className="flex flex-wrap items-center gap-2 border-t pt-2 text-sm">
          <span className="font-medium">{c.save.game?.title ?? c.save.baseName}</span>
          <Badge variant="outline">{t(`saves.kind.${c.save.kind}`)}</Badge>
          <span className="text-muted-foreground">
            {c.device.name} · {formatDate(c.createdAt)}
          </span>
          <a className="text-xs text-primary underline" href={dl(c.save.id, c.deviceVersionId)}>
            {t('more.saves.deviceVersion')}
          </a>
          <a className="text-xs text-primary underline" href={dl(c.save.id, c.serverVersionId)}>
            {t('more.saves.serverVersion')}
          </a>
          <Button size="sm" onClick={() => void resolve(c.id, 'device')}>
            {t('more.saves.keepDevice')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void resolve(c.id, 'server')}>
            {t('more.saves.keepServer')}
          </Button>
        </div>
      ))}
    </div>
  )
}
