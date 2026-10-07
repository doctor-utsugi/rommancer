import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Upload } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError, get, post, upload, type Paged } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Field, NativeSelect, PageHeader, SystemSelect, errMsg, formatBytes } from '@/components/common'

const MAX_BROWSER_HASH = 1024 * 1024 * 1024

type State = 'checking' | 'matched' | 'unknown' | 'alreadyOwned' | 'uploading' | 'stored' | 'rejected' | 'tooBig'

interface Row {
  file: File
  state: State
  info?: string
  pct?: number
  noMatch?: boolean
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')

function headerSize(name: string, buf: Uint8Array): number {
  const ext = name.toLowerCase().split('.').pop()
  const str = (o: number, n: number) => String.fromCharCode(...buf.subarray(o, o + n))
  if ((str(0, 4) === 'NES\x1a' || str(0, 4) === 'FDS\x1a') && buf.length > 16) return 16
  if (str(0, 5) === 'LYNX\0' && buf.length > 64) return 64
  if (str(1, 9) === 'ATARI7800' && buf.length > 128) return 128
  if (['sfc', 'smc', 'swc', 'fig'].includes(ext ?? '') && buf.length % 0x2000 === 512) return 512
  return 0
}

export function UploadPage() {
  const { t } = useTranslation()
  const { can } = useAuth()
  const [tab, setTab] = useState(can('roms.upload') ? 'verified' : 'unverified')
  const [pending, setPending] = useState<File | null>(null)
  return (
    <div>
      <PageHeader title={t('upload.title')} />
      <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
        <TabsList>
          {can('roms.upload') && <TabsTrigger value="verified">{t('more.upload.verified')}</TabsTrigger>}
          {can('roms.uploadUnverified') && <TabsTrigger value="unverified">{t('more.upload.unverified')}</TabsTrigger>}
        </TabsList>
        <TabsContent value="verified">
          <VerifiedUpload
            onUnverified={
              can('roms.uploadUnverified')
                ? (f) => {
                    setPending(f)
                    setTab('unverified')
                  }
                : undefined
            }
          />
        </TabsContent>
        <TabsContent value="unverified">
          <UnverifiedUpload key={pending ? `${pending.name}:${pending.size}` : "none"} initial={pending} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/** What an upload resolved to: the rom or romhack it is, whether it was stored now or already owned. */
export type UploadResult = { romId?: number; hackId?: number }

export function VerifiedUpload({
  onUnverified,
  onResolved,
  compact,
  incoming,
}: {
  onUnverified?: (f: File) => void
  onResolved?: (r: UploadResult) => void
  compact?: boolean
  /** Files dropped somewhere else on the page (a new array each time) */
  incoming?: File[]
}) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<Row[]>([])
  const [drag, setDrag] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const update = (file: File, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.file === file ? { ...r, ...patch } : r)))

  const process = async (file: File) => {
    try {
      if (file.size <= MAX_BROWSER_HASH) {
        const buf = new Uint8Array(await file.arrayBuffer())
        const sha1 = hex(await crypto.subtle.digest('SHA-1', buf))
        const h = headerSize(file.name, buf)
        const headerless = h ? { sha1: hex(await crypto.subtle.digest('SHA-1', buf.subarray(h))) } : undefined
        const m = await post('/roms/match', { sha1, size: file.size, headerless })
        if (m.rom?.owned) {
          // Already in the collection: nothing is uploaded
          update(file, { state: 'alreadyOwned', info: m.rom.name })
          onResolved?.({ romId: m.rom.id })
          return
        }
        if (!m.accepted) {
          // Puede coincidir con RetroAchievements (hash md5 calculado en el servidor)
          update(file, { state: 'unknown' })
        } else update(file, { state: 'matched', info: m.rom?.name })
      } else update(file, { state: 'tooBig' })
      update(file, { state: 'uploading', pct: 0 })
      const fd = new FormData()
      fd.append('file', file)
      const r = await upload('/uploads', fd, (pct) => update(file, { pct }))
      update(file, { state: r.status === 'already-owned' ? 'alreadyOwned' : 'stored', info: r.file?.path })
      if (r.romId || r.hackId) onResolved?.({ romId: r.romId ?? undefined, hackId: r.hackId ?? undefined })
    } catch (e) {
      const noMatch = e instanceof ApiError && e.message === 'NO_MATCH'
      update(file, { state: 'rejected', info: noMatch ? t('more.upload.noMatch') : errMsg(e), noMatch })
    }
  }

  const add = (files: FileList | null) => files && addFiles([...files])

  const addFiles = (list: File[]) => {
    setRows((rs) => [...list.map((file) => ({ file, state: 'checking' as State })), ...rs])
    void (async () => {
      for (const f of list) await process(f)
    })()
  }

  useEffect(() => {
    if (incoming?.length) addFiles(incoming)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming])

  const variant = (s: State) => (s === 'stored' || s === 'matched' ? 'default' : s === 'rejected' ? 'destructive' : 'secondary')

  return (
    <div>
      {!compact && <p className="mb-4 max-w-3xl text-sm text-muted-foreground">{t('upload.help')}</p>}
      <div
        className={`mb-6 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed ${compact ? 'p-5' : 'p-10'} text-sm text-muted-foreground transition-colors ${drag ? 'border-primary bg-muted' : ''}`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDrag(true)
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDrag(false)
          add(e.dataTransfer.files)
        }}
      >
        <Upload className="size-8" />
        {t('upload.drop')}
        <input ref={input} type="file" multiple hidden onChange={(e) => add(e.target.files)} />
      </div>
      {rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('common.name')}</TableHead>
              <TableHead>{t('common.size')}</TableHead>
              <TableHead>{t('common.status')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={i}>
                <TableCell className="max-w-md">
                  <p className="truncate">{r.file.name}</p>
                  {r.info && <p className="truncate text-xs text-muted-foreground">{r.info}</p>}
                </TableCell>
                <TableCell>{formatBytes(r.file.size)}</TableCell>
                <TableCell className="w-64">
                  <Badge variant={variant(r.state)}>{t(`upload.${r.state}`)}</Badge>
                  {r.state === 'uploading' && <Progress value={r.pct ?? 0} className="mt-1" />}
                  {r.noMatch && onUnverified && (
                    <Button variant="link" size="sm" onClick={() => onUnverified(r.file)}>
                      {t('more.upload.useUnverified')}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}

function UnverifiedUpload({ initial }: { initial: File | null }) {
  const { t } = useTranslation()
  const [file, setFile] = useState<File | null>(initial)
  const [systemId, setSystemId] = useState('')
  const [mode, setMode] = useState<'existing' | 'new'>('existing')
  const [q, setQ] = useState('')
  const [gameId, setGameId] = useState('')
  const [f, setF] = useState({ newGameTitle: '', kind: 'rom', name: '', regions: '', languages: '', revision: '', hackName: '', hackVersion: '', hackLanguage: '', author: '', baseRomId: '', sourceUrl: '' })
  const [pct, setPct] = useState<number | null>(null)
  const games = useQuery({
    queryKey: ['upload-games', systemId, q],
    queryFn: () => get<Paged<{ id: number; title: string }>>(`/games?systemId=${systemId}&q=${encodeURIComponent(q)}&pageSize=20`),
    enabled: !!systemId && q.length > 1,
  })
  const submit = async () => {
    const fd = new FormData()
    fd.append('file', file!)
    fd.append('systemId', systemId)
    if (mode === 'existing') fd.append('gameId', gameId)
    for (const [k, v] of Object.entries(f)) if (v && (mode === 'new' || k !== 'newGameTitle')) fd.append(k, v)
    try {
      setPct(0)
      const r = await upload('/uploads/unverified', fd, setPct)
      toast.success(`${t('upload.stored')}: ${r.file?.path ?? ''}`)
      setFile(null)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setPct(null)
    }
  }
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const hack = f.kind !== 'rom'
  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm text-muted-foreground">{t('more.upload.unverifiedHelp')}</p>
      <Field label={t('common.upload')}>
        <Input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        {file && <span className="text-xs text-muted-foreground">{file.name} · {formatBytes(file.size)}</span>}
      </Field>
      <Field label={t('common.system')}>
        <SystemSelect value={systemId} onChange={setSystemId} onlyWithData={false} />
      </Field>
      <div className="flex gap-2">
        <Button size="sm" variant={mode === 'existing' ? 'default' : 'outline'} onClick={() => setMode('existing')}>
          {t('more.upload.existingGame')}
        </Button>
        <Button size="sm" variant={mode === 'new' ? 'default' : 'outline'} onClick={() => setMode('new')}>
          {t('more.upload.newGame')}
        </Button>
      </div>
      {mode === 'existing' ? (
        <div className="grid gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('more.upload.searchGame')} disabled={!systemId} />
          <NativeSelect value={gameId} onChange={(e) => setGameId(e.target.value)}>
            <option value="">-</option>
            {games.data?.items.map((g) => (
              <option key={g.id} value={g.id}>
                {g.title}
              </option>
            ))}
          </NativeSelect>
        </div>
      ) : (
        <Field label={t('common.title')}>
          <Input value={f.newGameTitle} onChange={set('newGameTitle')} />
        </Field>
      )}
      <Field label={t('more.upload.kind')}>
        <NativeSelect value={f.kind} onChange={set('kind')}>
          {(['rom', 'hack', 'translation'] as const).map((k) => (
            <option key={k} value={k}>
              {t(`more.upload.kinds.${k}`)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label={t('more.upload.name')}>
        <Input value={f.name} onChange={set('name')} />
      </Field>
      {!hack ? (
        <div className="grid gap-3 md:grid-cols-3">
          <Field label={t('more.upload.regions')}>
            <Input value={f.regions} onChange={set('regions')} placeholder="Europe, USA" />
          </Field>
          <Field label={t('more.upload.languages')}>
            <Input value={f.languages} onChange={set('languages')} placeholder="Es, En" />
          </Field>
          <Field label={t('more.upload.revision')}>
            <Input value={f.revision} onChange={set('revision')} placeholder="Rev 1" />
          </Field>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={t('more.game.hackName')}>
            <Input value={f.hackName} onChange={set('hackName')} />
          </Field>
          <Field label={t('more.upload.hackVersion')}>
            <Input value={f.hackVersion} onChange={set('hackVersion')} />
          </Field>
          <Field label={t('more.upload.hackLanguage')}>
            <Input value={f.hackLanguage} onChange={set('hackLanguage')} />
          </Field>
          <Field label={t('more.upload.author')}>
            <Input value={f.author} onChange={set('author')} />
          </Field>
          <Field label={t('more.upload.baseRomId')}>
            <Input value={f.baseRomId} onChange={set('baseRomId')} inputMode="numeric" />
          </Field>
          <Field label={t('more.game.sourceUrl')}>
            <Input value={f.sourceUrl} onChange={set('sourceUrl')} />
          </Field>
        </div>
      )}
      {pct != null && <Progress value={pct} />}
      <Button onClick={() => void submit()} disabled={!file || !systemId || (mode === 'existing' ? !gameId : !f.newGameTitle) || pct != null}>
        {t('more.upload.submit')}
      </Button>
    </div>
  )
}
