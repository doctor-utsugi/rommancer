import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Check, FileText, ImageOff, Trophy, X } from 'lucide-react'
import { toast } from 'sonner'
import { authUrl, get, post } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, Field, JobProgress, errMsg, formatBytes, useJob } from '@/components/common'
import { AddToListButton } from '@/components/add-to-list'

export function GamePage() {
  const { id } = useParams()
  const { t } = useTranslation()
  const { user } = useAuth()
  const nav = useNavigate()
  const { data: g, refetch } = useQuery({ queryKey: ['game', id], queryFn: () => get(`/games/${id}`) })
  const [jobId, setJobId] = useState<number | null>(null)
  const job = useJob(jobId, [['game', id!]], () => void refetch())
  const [merge, setMerge] = useState(false)
  const [mergeId, setMergeId] = useState('')
  if (!g) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>

  const cover = g.media.find((m: any) => m.type === 'COVER')
  const images = g.media.filter((m: any) => !['MANUAL', 'VIDEO'].includes(m.type))
  const manual = g.media.find((m: any) => m.type === 'MANUAL')

  const scrape = async () => {
    const j = await post('/scrape', { gameIds: [g.id], overwrite: true, ownedOnly: false })
    setJobId(j.id)
  }
  const doMerge = async () => {
    try {
      await post(`/games/${g.id}/merge`, { intoGameId: Number(mergeId) })
      nav(`/games/${mergeId}`)
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-6 md:flex-row">
        <div className="flex aspect-[3/4] w-48 shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-muted">
          {cover ? <img src={authUrl(cover.url)} alt="" className="h-full w-full object-contain" /> : <ImageOff className="size-10 text-muted-foreground" />}
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h1 className="text-2xl font-semibold">{g.title}</h1>
            <p className="text-muted-foreground">{g.system.name}</p>
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
            <Button variant="outline" size="sm" onClick={() => void scrape()}>
              {t('games.scrape')}
            </Button>
            {manual && (
              <Button variant="outline" size="sm" nativeButton={false} render={<a href={authUrl(manual.url)} target="_blank" rel="noreferrer" />}>
                <FileText className="size-4" />
                {t('game.manual')}
              </Button>
            )}
            {user?.role === 'ADMIN' && (
              <Button variant="ghost" size="sm" onClick={() => setMerge(true)}>
                {t('game.merge')}
              </Button>
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
        </TabsList>
        <TabsContent value="roms">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>{t('common.name')}</TableHead>
                <TableHead>{t('common.regions')}</TableHead>
                <TableHead>{t('game.flags')}</TableHead>
                <TableHead>{t('game.ra')}</TableHead>
                <TableHead>{t('game.files')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {g.roms.map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell>{r.owned ? <Check className="size-4 text-green-600" /> : <X className="size-4 text-muted-foreground" />}</TableCell>
                  <TableCell className="max-w-md">
                    <p className="truncate font-medium" title={r.name}>
                      {r.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {r.datSource.type} · {r.parts.map((p: any) => `${p.name} (${formatBytes(p.size)})`).join(', ')}
                    </p>
                  </TableCell>
                  <TableCell>{(r.regions as string[]).join(', ')}</TableCell>
                  <TableCell className="space-x-1">
                    {(r.flags as string[]).map((f) => (
                      <Badge key={f} variant="outline">
                        {f}
                      </Badge>
                    ))}
                  </TableCell>
                  <TableCell>
                    {r.raGame ? (
                      <Badge variant="secondary" title={r.raGame.title}>
                        <Trophy className="size-3" />
                        {t('game.raAchievements', { count: r.raGame.numAchievements })}
                      </Badge>
                    ) : (
                      '-'
                    )}
                  </TableCell>
                  <TableCell className="max-w-xs text-xs text-muted-foreground">
                    {r.parts.flatMap((p: any) => p.files).map((f: any) => (
                      <p key={f.id} className="truncate" title={`${f.romPath.path}/${f.relativePath}`}>
                        {f.romPath.label}: {f.relativePath}
                        {f.archiveEntry ? ` > ${f.archiveEntry}` : ''}
                      </p>
                    ))}
                  </TableCell>
                  <TableCell>
                    <AddToListButton items={[{ romId: r.id }]} size="icon-sm" />
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
                  <TableHead>{t('game.version')}</TableHead>
                  <TableHead>{t('game.files')}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {g.hacks.map((h: any) => (
                  <TableRow key={h.id}>
                    <TableCell>{h.files.length ? <Check className="size-4 text-green-600" /> : <X className="size-4 text-muted-foreground" />}</TableCell>
                    <TableCell className="max-w-md">
                      <p className="truncate font-medium">{h.title}</p>
                      {h.sourceUrl && (
                        <a className="text-xs text-primary underline" href={h.sourceUrl} target="_blank" rel="noreferrer">
                          {h.sourceUrl}
                        </a>
                      )}
                    </TableCell>
                    <TableCell>
                      {t(`game.hackType.${h.type}`)}
                      {h.language ? ` (${h.language})` : ''}
                    </TableCell>
                    <TableCell>{h.author ?? '-'}</TableCell>
                    <TableCell>{h.version ?? '-'}</TableCell>
                    <TableCell className="max-w-xs text-xs text-muted-foreground">
                      {h.files.map((f: any) => (
                        <p key={f.id} className="truncate">
                          {f.romPath.label}: {f.relativePath}
                        </p>
                      ))}
                    </TableCell>
                    <TableCell>
                      <AddToListButton items={[{ hackId: h.id }]} size="icon-sm" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>
        <TabsContent value="media">
          {!images.length ? (
            <Empty />
          ) : (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {images.map((m: any) => (
                <figure key={m.id} className="overflow-hidden rounded-xl border">
                  <img src={authUrl(m.url)} alt="" className="w-full bg-muted object-contain" />
                  <figcaption className="p-2 text-xs text-muted-foreground">
                    {m.type} · {m.source}
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={merge} onOpenChange={setMerge}>
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
    </div>
  )
}
