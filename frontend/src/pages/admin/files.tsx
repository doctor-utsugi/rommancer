import { useState } from 'react'
import { Link } from 'react-router'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { get, post, type Paged } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Empty, Field, NativeSelect, PageHeader, Pagination, errMsg, formatBytes } from '@/components/common'

export function AdminFilesPage() {
  const { t } = useTranslation()
  const paths = useQuery({ queryKey: ['paths'], queryFn: () => get<any[]>('/admin/paths') })
  const [romPathId, setRomPathId] = useState('')
  const [status, setStatus] = useState('UNKNOWN')
  const [q, setQ] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [linking, setLinking] = useState<any | null>(null)
  const params = new URLSearchParams({ page: String(page), pageSize: '100' })
  if (romPathId) params.set('romPathId', romPathId)
  if (status) params.set('status', status)
  if (search) params.set('q', search)
  const { data } = useQuery({ queryKey: ['files', params.toString()], queryFn: () => get<Paged<any>>(`/files?${params}`), placeholderData: keepPreviousData })
  return (
    <div>
      <PageHeader title={t('admin.filesTitle')} />
      <form
        className="mb-4 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          setSearch(q)
          setPage(1)
        }}
      >
        <Input className="w-64" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('common.search')} />
        <NativeSelect value={romPathId} onChange={(e) => setRomPathId(e.target.value)}>
          <option value="">{t('common.all')}</option>
          {paths.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('common.all')}</option>
          {['MATCHED', 'HACK', 'UNKNOWN'].map((s) => (
            <option key={s} value={s}>
              {t(`admin.${s}`)}
            </option>
          ))}
        </NativeSelect>
      </form>
      {!data?.items.length ? (
        <Empty />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('common.path')}</TableHead>
              <TableHead>{t('common.status')}</TableHead>
              <TableHead>{t('common.size')}</TableHead>
              <TableHead>CRC32 / SHA1</TableHead>
              <TableHead>RA</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((f) => (
              <TableRow key={f.id}>
                <TableCell className="max-w-md">
                  <p className="truncate font-mono text-xs" title={f.relativePath}>
                    {f.relativePath}
                    {f.archiveEntry ? ` > ${f.archiveEntry}` : ''}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {f.romPath.label}
                    {f.romPart && (
                      <>
                        {' · '}
                        <Link className="underline" to={`/games/${f.romPart.rom.gameId}`}>
                          {f.romPart.rom.name}
                        </Link>
                      </>
                    )}
                    {f.romHack && (
                      <>
                        {' · '}
                        <Link className="underline" to={`/games/${f.romHack.gameId}`}>
                          {f.romHack.title}
                        </Link>
                      </>
                    )}
                  </p>
                </TableCell>
                <TableCell>
                  <Badge variant={f.status === 'UNKNOWN' ? 'outline' : 'secondary'}>{t(`admin.${f.status}`)}</Badge>
                </TableCell>
                <TableCell>{formatBytes(f.size)}</TableCell>
                <TableCell className="font-mono text-xs">
                  {f.crc32}
                  <br />
                  <span className="text-muted-foreground">{f.sha1?.slice(0, 16)}</span>
                </TableCell>
                <TableCell className="font-mono text-xs">{f.raHash?.slice(0, 8) ?? '-'}</TableCell>
                <TableCell>
                  {f.status === 'UNKNOWN' && f.sha1 && (
                    <Button variant="outline" size="sm" onClick={() => setLinking(f)}>
                      {t('admin.linkHack')}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {data && <Pagination page={page} pageSize={data.pageSize} total={data.total} onChange={setPage} />}
      {linking && <LinkHackDialog file={linking} onClose={() => setLinking(null)} />}
    </div>
  )
}

function LinkHackDialog({ file, onClose }: { file: any; onClose(): void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const name = (file.archiveEntry ?? file.relativePath).split('/').pop().replace(/\.[^.]+$/, '')
  const [q, setQ] = useState(name.replace(/\s*[([].*$/, ''))
  const [gameId, setGameId] = useState('')
  const [form, setForm] = useState({ type: 'HACK', title: name, author: '', version: '', language: '', sourceUrl: '' })
  const games = useQuery({
    queryKey: ['games-search', q, file.systemId],
    queryFn: () => get<Paged<any>>(`/games?q=${encodeURIComponent(q)}&pageSize=20${file.systemId ? `&systemId=${file.systemId}` : ''}`),
    enabled: q.length > 1,
  })
  const submit = async () => {
    try {
      const body = Object.fromEntries(Object.entries({ ...form, gameId: Number(gameId) }).filter(([, v]) => v !== ''))
      await post(`/files/${file.id}/link-hack`, body)
      void qc.invalidateQueries({ queryKey: ['files'] })
      onClose()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('admin.linkHack')}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label={t('common.search')}>
            <Input value={q} onChange={(e) => setQ(e.target.value)} />
          </Field>
          <Field label={t('nav.games')}>
            <NativeSelect value={gameId} onChange={(e) => setGameId(e.target.value)}>
              <option value="">-</option>
              {games.data?.items.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title} ({g.system.slug})
                </option>
              ))}
            </NativeSelect>
          </Field>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={t('common.title')}>
              <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </Field>
            <Field label={t('common.type')}>
              <NativeSelect value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {['HACK', 'TRANSLATION', 'IMPROVEMENT', 'OTHER'].map((x) => (
                  <option key={x} value={x}>
                    {t(`game.hackType.${x}`)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label={t('game.author')}>
              <Input value={form.author} onChange={(e) => setForm({ ...form, author: e.target.value })} />
            </Field>
            <Field label={t('game.version')}>
              <Input value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} />
            </Field>
            <Field label={t('game.language')}>
              <Input value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })} />
            </Field>
            <Field label="URL">
              <Input value={form.sourceUrl} onChange={(e) => setForm({ ...form, sourceUrl: e.target.value })} />
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => void submit()} disabled={!gameId}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
