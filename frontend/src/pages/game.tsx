import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Check, Download, FilePlus, FileText, ImageOff, Pencil, Play, Star, Trash2, Trophy, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { api, authUrl, del, get, patch, post, upload } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, Field, JobProgress, NativeSelect, errMsg, formatBytes, useJob } from '@/components/common'
import { AddToListButton } from '@/components/add-to-list'
import { WEB_SYSTEMS, openPlayer } from '@/lib/play'
import { MySaves, SharedSaves, VersionsDialog } from './saves'
import { Journeys } from '@/components/journeys'

const ALL_MEDIA = ['COVER', 'BOX_BACK', 'BOX_SIDE', 'BOX_3D', 'SUPPORT', 'SCREENSHOT', 'TITLE', 'FLYER', 'FANART', 'WHEEL', 'MARQUEE', 'MANUAL', 'VIDEO']
const LARGE = ['MANUAL', 'VIDEO']

export function GamePage() {
  const { id } = useParams()
  const { t } = useTranslation()
  const { user, can } = useAuth()
  const admin = user?.role === 'ADMIN'
  const nav = useNavigate()
  const { data: g, refetch } = useQuery({ queryKey: ['game', id], queryFn: () => get(`/games/${id}`) })
  const [jobId, setJobId] = useState<number | null>(null)
  const job = useJob(jobId, [['game', id!]], () => void refetch())
  const [dialog, setDialog] = useState<null | 'merge' | 'split' | 'work' | 'media' | 'manual' | 'patch' | 'hack'>(null)
  const [mergeId, setMergeId] = useState('')
  const [split, setSplit] = useState<Set<number>>(new Set())
  const [qid, setQid] = useState('')
  const [mediaOpts, setMediaOpts] = useState({ large: false, overwrite: false })
  const [manualUrl, setManualUrl] = useState('')
  const [hack, setHack] = useState<any>(null)
  const [patchForm, setPatchForm] = useState<{ file: File | null; baseRomId: string; sourceUrl: string }>({ file: null, baseRomId: '', sourceUrl: '' })
  if (!g) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
  const owned = g.roms.some((r: any) => r.parts.some((p: any) => p.files.length)) || g.hacks.some((h: any) => h.files?.length)
  // Files on the server, list entries and hand-uploaded records go; catalogue entries stay as not owned
  const removeFromCollection = async (romId?: number) => {
    if (!confirm(t(romId ? 'more.game.removeRomConfirm' : 'more.game.removeConfirm'))) return
    try {
      const r = await del<any>(`/games/${g.id}/collection${romId ? `?romId=${romId}` : ''}`)
      toast.success(t('more.game.removed', { count: r.records }))
      if (r.gameDeleted) nav('/games')
      else void refetch()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  const toggleFavorite = async (r: any) => {
    try {
      await (r.favorite ? del(`/roms/${r.id}/favorite`) : api('PUT', `/roms/${r.id}/favorite`))
      void refetch()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  const cover = g.media.find((m: any) => m.type === 'COVER')
  const images = g.media.filter((m: any) => !LARGE.includes(m.type))
  const manuals = g.media.filter((m: any) => m.type === 'MANUAL')
  const videos = g.media.filter((m: any) => m.type === 'VIDEO')
  const close = () => setDialog(null)
  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    try {
      await fn()
      after?.()
      void refetch()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  const scrape = () =>
    run(async () => {
      const types = ALL_MEDIA.filter((x) => mediaOpts.large || !LARGE.includes(x))
      const j = await post(`/scrape/game/${g.id}`, { types, overwrite: mediaOpts.overwrite })
      setJobId(j.id)
      toast.success(t('more.game.queued'))
    }, close)
  const doMerge = () => run(() => post(`/games/${g.id}/merge`, { intoGameId: Number(mergeId) }), () => nav(`/games/${mergeId}`))
  const doSplit = () => run(() => post(`/games/${g.id}/split`, { romIds: [...split] }), close)
  const doWork = () => run(() => post(`/admin/games/${g.id}/work`, { wikidataId: qid.trim() || null }), close)
  const doPatch = () =>
    run(async () => {
      const fd = new FormData()
      fd.append('file', patchForm.file!)
      if (patchForm.baseRomId) fd.append('baseRomId', patchForm.baseRomId)
      if (patchForm.sourceUrl) fd.append('sourceUrl', patchForm.sourceUrl)
      await upload(`/hacks/${hack.id}/patches`, fd)
    }, close)
  const saveHack = () =>
    run(
      () =>
        patch(`/hacks/${hack.id}`, {
          type: hack.type,
          title: hack.title,
          hackName: hack.hackName || null,
          author: hack.author || null,
          version: hack.version || null,
          language: hack.language || null,
          baseRomId: hack.baseRomId ? Number(hack.baseRomId) : null,
          sourceUrl: hack.sourceUrl || null,
        }),
      close,
    )

  const tag = (text: string, variant: 'outline' | 'secondary' | 'destructive' = 'outline') => (
    <Badge key={text} variant={variant}>
      {text}
    </Badge>
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-6 md:flex-row">
        <div className="flex aspect-[3/4] w-48 shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-muted">
          {cover ? <img src={authUrl(cover.url)} alt="" className="h-full w-full object-contain" /> : <ImageOff className="size-10 text-muted-foreground" />}
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              {g.title}
              {g.favorite && <Star className="size-5 fill-amber-400 text-amber-500" aria-label={t('more.fav.favorite')} />}
            </h1>
            <p className="text-muted-foreground">{g.system.name}</p>
            <div className="mt-1 flex flex-wrap gap-2 text-sm">
              {g.groupConfidence === 'low' && tag(t('more.tags.lowConfidence'), 'secondary')}
              {g.work && (
                <Link className="text-primary underline" to={`/works/${g.work.id}`}>
                  {t('more.tags.work')}: {g.work.title}
                </Link>
              )}
              {g.work?.franchise && (
                <Link className="text-primary underline" to={`/franchises/${g.work.franchise.id}`}>
                  {t('more.tags.franchise')}: {g.work.franchise.name}
                </Link>
              )}
            </div>
            {g.work?.games?.length > 0 && (
              <p className="mt-1 text-sm">
                {t('more.tags.otherPlatforms')}:{' '}
                {g.work.games.map((o: any, i: number) => (
                  <span key={o.id}>
                    {i > 0 && ', '}
                    <Link className="text-primary underline" to={`/games/${o.id}`}>
                      {o.system.name}
                    </Link>
                  </span>
                ))}
              </p>
            )}
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-4">
            {(['developer', 'publisher', 'releaseYear', 'genre', 'players'] as const).map((k) =>
              g[k] ? (
                <div key={k}>
                  <dt className="text-muted-foreground">{t(`game.${k === 'releaseYear' ? 'year' : k}`)}</dt>
                  <dd>{g[k]}</dd>
                </div>
              ) : null,
            )}
          </dl>
          {g.description && <p className="max-w-3xl text-sm whitespace-pre-line text-muted-foreground">{g.description}</p>}
          <div className="flex flex-wrap gap-2">
            <AddToListButton items={[{ gameId: g.id }]} />
            {can('scrape.lists') && (
              <Button variant="outline" size="sm" onClick={() => setDialog('media')}>
                {t('more.game.downloadMedia')}
              </Button>
            )}
            {manuals.map((m: any) => (
              <Button
                key={m.id}
                variant="outline"
                size="sm"
                onClick={() => {
                  setManualUrl(authUrl(m.url))
                  setDialog('manual')
                }}
              >
                <FileText className="size-4" />
                {t('more.game.viewManual')}
                {m.region ? ` (${m.region})` : ''}
              </Button>
            ))}
            {admin && (
              <>
                {owned && (
                  <Button variant="outline" size="sm" className="text-destructive" onClick={() => void removeFromCollection()}>
                    <Trash2 className="size-4" />
                    {t('more.game.removeFromCollection')}
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => setDialog('merge')}>
                  {t('game.merge')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setDialog('split')} disabled={g.roms.length < 2}>
                  {t('more.game.split')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setQid(g.wikidataId ?? '')
                    setDialog('work')
                  }}
                >
                  {t('more.game.linkWork')}
                </Button>
              </>
            )}
          </div>
          {jobId && (
            <div className="max-w-md">
              <JobProgress job={job} />
            </div>
          )}
        </div>
      </div>

      <Tabs defaultValue="roms">
        <TabsList>
          <TabsTrigger value="roms">
            {t('game.roms')} ({g.roms.length})
          </TabsTrigger>
          <TabsTrigger value="hacks">
            {t('game.hacks')} ({g.hacks.length})
          </TabsTrigger>
          <TabsTrigger value="media">
            {t('game.media')} ({g.media.length})
          </TabsTrigger>
          {can('saves') && <TabsTrigger value="saves">{t('more.saves.gameTab')}</TabsTrigger>}
        </TabsList>
        <TabsContent value="roms">
          {/* Fixed layout: the name takes the free width and long texts truncate inside their column */}
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>{t('common.name')}</TableHead>
                <TableHead className="w-60">{t('game.flags')}</TableHead>
                <TableHead className="w-40">{t('game.ra')}</TableHead>
                <TableHead className="w-48">{t('game.files')}</TableHead>
                <TableHead className="w-28" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {g.roms.map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell>{r.owned ? <Check className="size-4 text-green-600" /> : r.unverified && r.parts.some((p: any) => p.files.length) ? <Check className="size-4 text-amber-600" /> : <X className="size-4 text-muted-foreground" />}</TableCell>
                  <TableCell>
                    <p className="flex items-center gap-1 truncate font-medium" title={r.name}>
                      <button type="button" onClick={() => void toggleFavorite(r)} aria-label={t(r.favorite ? 'more.fav.remove' : 'more.fav.add')} title={t(r.favorite ? 'more.fav.remove' : 'more.fav.add')}>
                        <Star className={`size-4 shrink-0 ${r.favorite ? 'fill-amber-400 text-amber-500' : 'text-muted-foreground hover:text-amber-500'}`} />
                      </button>
                      <span className="truncate">{r.name}</span>
                    </p>
                    <p className="truncate text-xs text-muted-foreground" title={r.parts.map((p: any) => p.name).join(', ')}>
                      {r.datSource.type} · {r.parts.map((p: any) => `${p.name} (${formatBytes(Number(p.size))})`).join(', ')}
                      {r.localTitle ? ` · ${t('more.tags.localTitle')}: ${r.localTitle}` : ''}
                    </p>
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <div className="flex flex-wrap gap-1">
                      {(r.regions as string[]).map((x) => tag(x, 'secondary'))}
                      {/* One badge for all languages: a dozen separate ones squeeze the table */}
                      {(r.languages as string[]).length > 0 && tag((r.languages as string[]).join(' · '))}
                      {g.showRevision && r.revision && tag(r.revision)}
                      {(r.flags as string[]).filter((f) => f !== 'unverified').map((f) => tag(f))}
                      {r.unverified && tag(`${t('more.tags.unverified')}${r.uploadedBy ? ` · ${t('more.tags.uploadedBy', { user: r.uploadedBy })}` : ''}`, 'destructive')}
                      {r.removedFromSource && tag(t('more.tags.removed'))}
                      {r.serial && tag(`${t('more.tags.serial')} ${r.serial}`)}
                    </div>
                  </TableCell>
                  <TableCell>
                    {r.raGame ? (
                      <a href={`https://retroachievements.org/game/${r.raGame.id}`} target="_blank" rel="noreferrer" title={t('more.ra.open', { title: r.raGame.title })}>
                        <Badge variant={r.raProgress?.awarded ? 'default' : 'secondary'}>
                          <Trophy className="size-3" />
                          {r.raProgress ? t('more.ra.progress', { awarded: r.raProgress.awarded, total: r.raProgress.total || r.raGame.numAchievements }) : t('game.raAchievements', { count: r.raGame.numAchievements })}
                        </Badge>
                      </a>
                    ) : (
                      '-'
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.parts.flatMap((p: any) => p.files).map((f: any) => (
                      <p key={f.id} className="truncate" title={`${f.romPath.path}/${f.relativePath}`}>
                        {f.romPath.label}: {f.relativePath}
                        {f.archiveEntry ? ` > ${f.archiveEntry}` : ''}
                      </p>
                    ))}
                  </TableCell>
                  <TableCell className="space-x-1 whitespace-nowrap">
                    {can('roms.download') && r.parts.length === 1 && r.parts[0].files.length > 0 && WEB_SYSTEMS.includes(g.system.slug) && (
                      <Button variant="outline" size="icon-sm" title={t('more.game.tryHelp')} onClick={() => void openPlayer(`/roms/${r.id}/play`, t)}>
                        <Play className="size-4" />
                      </Button>
                    )}
                    {can('roms.download') && r.parts.length === 1 && r.parts[0].files.length > 0 && (
                      <Button variant="outline" size="icon-sm" title={t('more.game.downloadRom')} nativeButton={false} render={<a href={authUrl(`/roms/${r.id}/download`)} />}>
                        <Download className="size-4" />
                      </Button>
                    )}
                    <AddToListButton items={[{ romId: r.id }]} size="icon-sm" />
                    {admin && r.parts.some((p: any) => p.files.length) && (
                      <Button variant="ghost" size="icon-sm" title={t('more.game.removeRom')} onClick={() => void removeFromCollection(r.id)}>
                        <Trash2 className="size-4 text-destructive" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TabsContent>
        <TabsContent value="hacks">
          {!g.hacks.length ? (
            <Empty>{t('game.noHacks')}</Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>{t('common.title')}</TableHead>
                  <TableHead>{t('common.type')}</TableHead>
                  <TableHead>{t('game.author')}</TableHead>
                  <TableHead>{t('game.files')}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {g.hacks.map((h: any) => (
                  <TableRow key={h.id}>
                    <TableCell>{h.files.length ? <Check className="size-4 text-green-600" /> : h.canGenerate ? <Check className="size-4 text-amber-600" /> : <X className="size-4 text-muted-foreground" />}</TableCell>
                    <TableCell className="max-w-md">
                      <p className="truncate font-medium" title={h.title}>
                        {h.label}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">{h.title}</p>
                      {h.sourceUrl && (
                        <a className="text-xs text-primary underline" href={h.sourceUrl} target="_blank" rel="noreferrer">
                          {h.sourceUrl}
                        </a>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {tag(t(`game.hackType.${h.type}`), 'secondary')}
                        {h.language && tag(h.language)}
                        {h.baseEvidence && tag(`${t('more.tags.base')}: ${t(`more.tags.baseEvidence.${h.baseEvidence}`, { defaultValue: h.baseEvidence })}`)}
                        {h.removedFromSource && tag(t('more.tags.removed'))}
                      </div>
                    </TableCell>
                    <TableCell>{h.author ?? '-'}</TableCell>
                    <TableCell className="max-w-xs text-xs text-muted-foreground">
                      {h.files.map((f: any) => (
                        <p key={f.id} className="truncate">
                          {f.romPath.label}: {f.relativePath}
                        </p>
                      ))}
                      {h.patches.map((p: any) => (
                        <p key={p.id} className="flex items-center gap-1">
                          {t('more.game.patches')}: {p.format.toUpperCase()}
                          {admin && (
                            <button className="text-destructive" title={t('common.delete')} onClick={() => void run(() => del(`/patches/${p.id}`))}>
                              <Trash2 className="size-3" />
                            </button>
                          )}
                        </p>
                      ))}
                    </TableCell>
                    <TableCell className="space-x-1 whitespace-nowrap">
                      {can('roms.download') && h.files.length > 0 && WEB_SYSTEMS.includes(g.system.slug) && (
                        <Button variant="outline" size="icon-sm" title={t('more.game.tryHelp')} onClick={() => void openPlayer(`/hacks/${h.id}/play`, t)}>
                          <Play className="size-4" />
                        </Button>
                      )}
                      {can('roms.download') && (h.files.length > 0 || h.canGenerate) && (
                        <Button
                          variant="outline"
                          size="icon-sm"
                          title={h.files.length ? t('more.game.downloadHack') : t('more.game.generate')}
                          nativeButton={false}
                          render={<a href={authUrl(`/hacks/${h.id}/download`)} />}
                        >
                          <Download className="size-4" />
                        </Button>
                      )}
                      {admin && (
                        <>
                          {h.canMakePatch && (
                            <Button variant="ghost" size="icon-sm" title={t('more.game.makePatch')} onClick={() => void run(() => post(`/hacks/${h.id}/make-patch`))}>
                              <FilePlus className="size-4" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title={t('more.game.uploadPatch')}
                            onClick={() => {
                              setHack(h)
                              setPatchForm({ file: null, baseRomId: h.baseRomId ? String(h.baseRomId) : '', sourceUrl: '' })
                              setDialog('patch')
                            }}
                          >
                            <Upload className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title={t('more.game.editHack')}
                            onClick={() => {
                              setHack({ ...h, baseRomId: h.baseRomId ?? '' })
                              setDialog('hack')
                            }}
                          >
                            <Pencil className="size-4" />
                          </Button>
                        </>
                      )}
                      <AddToListButton items={[{ hackId: h.id }]} size="icon-sm" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>
        <TabsContent value="media" className="space-y-6">
          {!g.media.length && <Empty />}
          {images.length > 0 && (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {images.map((m: any) => (
                <figure key={m.id} className="overflow-hidden rounded-xl border">
                  <a href={authUrl(m.url)} target="_blank" rel="noreferrer">
                    <img src={authUrl(m.url)} alt="" className="w-full bg-muted object-contain" loading="lazy" />
                  </a>
                  <figcaption className="p-2 text-xs text-muted-foreground">
                    {m.type} · {m.source}
                    {m.region ? ` · ${m.region}` : ''}
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
          {videos.map((m: any) => (
            <figure key={m.id} className="max-w-2xl">
              <video controls preload="none" src={authUrl(m.url)} className="w-full rounded-xl border" />
              <figcaption className="p-1 text-xs text-muted-foreground">
                {t('more.game.video')} · {m.source}
              </figcaption>
            </figure>
          ))}
        </TabsContent>
        {can('saves') && (
          <TabsContent value="saves">
            <GameSaves gameId={g.id} />
            <section className="mt-6 space-y-3"><h3 className="font-medium">{t('journeys.title')}</h3><Journeys gameId={g.id} /></section>
          </TabsContent>
        )}
      </Tabs>

      <Dialog open={dialog === 'merge'} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('game.merge')}</DialogTitle>
          </DialogHeader>
          <Field label={t('game.mergeInto')}>
            <Input value={mergeId} onChange={(e) => setMergeId(e.target.value)} inputMode="numeric" />
          </Field>
          <DialogFooter>
            <Button onClick={() => void doMerge()} disabled={!mergeId}>
              {t('common.apply')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'split'} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('more.game.split')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{t('more.game.splitHelp')}</p>
          <div className="max-h-80 space-y-1 overflow-auto">
            {g.roms.map((r: any) => (
              <label key={r.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={split.has(r.id)}
                  onCheckedChange={(c) => {
                    const s = new Set(split)
                    if (c) s.add(r.id)
                    else s.delete(r.id)
                    setSplit(s)
                  }}
                />
                {r.name}
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button onClick={() => void doSplit()} disabled={!split.size || split.size === g.roms.length}>
              {t('common.apply')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'work'} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('more.game.linkWork')}</DialogTitle>
          </DialogHeader>
          <Field label="Wikidata" hint={t('more.game.workHelp')}>
            <Input value={qid} onChange={(e) => setQid(e.target.value)} placeholder="Q123" />
          </Field>
          <DialogFooter>
            <Button onClick={() => void doWork()} disabled={!!qid && !/^Q\d+$/.test(qid.trim())}>
              {t('common.apply')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'media'} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('more.game.downloadMedia')}</DialogTitle>
          </DialogHeader>
          {!user?.hasScreenScraper && user?.role !== 'ADMIN' && <p className="text-sm text-muted-foreground">{t('more.profile.noSs')}</p>}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={mediaOpts.large} onCheckedChange={(c) => setMediaOpts({ ...mediaOpts, large: !!c })} />
            {t('more.game.includeLarge')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={mediaOpts.overwrite} onCheckedChange={(c) => setMediaOpts({ ...mediaOpts, overwrite: !!c })} />
            {t('more.game.overwrite')}
          </label>
          <DialogFooter>
            <Button onClick={() => void scrape()}>{t('common.apply')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'manual'} onOpenChange={close}>
        <DialogContent className="h-[90vh] max-w-5xl sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>{t('game.manual')}</DialogTitle>
          </DialogHeader>
          {manualUrl && <iframe title="manual" src={manualUrl} className="h-full w-full rounded border" />}
          <DialogFooter cancel="close" />
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'patch'} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('more.game.uploadPatch')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{hack?.label}</p>
          <Field label="IPS / BPS / UPS">
            <Input type="file" accept=".ips,.bps,.ups" onChange={(e) => setPatchForm({ ...patchForm, file: e.target.files?.[0] ?? null })} />
          </Field>
          <Field label={t('more.game.baseRomId')}>
            <NativeSelect value={patchForm.baseRomId} onChange={(e) => setPatchForm({ ...patchForm, baseRomId: e.target.value })}>
              <option value="">-</option>
              {g.roms.map((r: any) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t('more.game.sourceUrl')}>
            <Input value={patchForm.sourceUrl} onChange={(e) => setPatchForm({ ...patchForm, sourceUrl: e.target.value })} />
          </Field>
          <DialogFooter>
            <Button onClick={() => void doPatch()} disabled={!patchForm.file}>
              {t('common.upload')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'hack'} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('more.game.editHack')}</DialogTitle>
          </DialogHeader>
          {hack && (
            <div className="grid gap-3">
              <Field label={t('common.type')}>
                <NativeSelect value={hack.type} onChange={(e) => setHack({ ...hack, type: e.target.value })}>
                  {['HACK', 'TRANSLATION', 'IMPROVEMENT', 'OTHER'].map((x) => (
                    <option key={x} value={x}>
                      {t(`game.hackType.${x}`)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label={t('common.title')}>
                <Input value={hack.title} onChange={(e) => setHack({ ...hack, title: e.target.value })} />
              </Field>
              <Field label={t('more.game.hackName')}>
                <Input value={hack.hackName ?? ''} onChange={(e) => setHack({ ...hack, hackName: e.target.value })} />
              </Field>
              <div className="grid grid-cols-3 gap-2">
                <Field label={t('game.version')}>
                  <Input value={hack.version ?? ''} onChange={(e) => setHack({ ...hack, version: e.target.value })} />
                </Field>
                <Field label={t('game.language')}>
                  <Input value={hack.language ?? ''} onChange={(e) => setHack({ ...hack, language: e.target.value })} />
                </Field>
                <Field label={t('game.author')}>
                  <Input value={hack.author ?? ''} onChange={(e) => setHack({ ...hack, author: e.target.value })} />
                </Field>
              </div>
              <Field label={t('more.tags.base')}>
                <NativeSelect value={hack.baseRomId} onChange={(e) => setHack({ ...hack, baseRomId: e.target.value })}>
                  <option value="">-</option>
                  {g.roms.map((r: any) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label={t('more.game.sourceUrl')}>
                <Input value={hack.sourceUrl ?? ''} onChange={(e) => setHack({ ...hack, sourceUrl: e.target.value })} />
              </Field>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => void saveHack()}>{t('common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** The user's own saves of a game and those other users shared */
function GameSaves({ gameId }: { gameId: number }) {
  const { t } = useTranslation()
  const { data } = useQuery({ queryKey: ['saves', { gameId }], queryFn: () => get<any[]>(`/saves?gameId=${gameId}`) })
  const [open, setOpen] = useState<number | null>(null)
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h3 className="font-medium">{t('more.saves.gameMine')}</h3>
        <MySaves saves={data} onOpen={setOpen} />
      </section>
      <section className="space-y-2">
        <h3 className="font-medium">{t('more.saves.gameShared')}</h3>
        <SharedSaves gameId={gameId} />
      </section>
      {open && <VersionsDialog saveId={open} onClose={() => setOpen(null)} />}
    </div>
  )
}
