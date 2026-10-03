import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Upload } from 'lucide-react'
import { post, upload } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader, errMsg, formatBytes } from '@/components/common'

const MAX_BROWSER_HASH = 1024 * 1024 * 1024

type State = 'checking' | 'matched' | 'unknown' | 'alreadyOwned' | 'uploading' | 'stored' | 'rejected' | 'tooBig'

interface Row {
  file: File
  state: State
  info?: string
  pct?: number
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
          update(file, { state: 'alreadyOwned', info: m.rom.name })
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
    } catch (e) {
      update(file, { state: 'rejected', info: errMsg(e) })
    }
  }

  const add = (files: FileList | null) => {
    if (!files) return
    const list = [...files]
    setRows((rs) => [...list.map((file) => ({ file, state: 'checking' as State })), ...rs])
    void (async () => {
      for (const f of list) await process(f)
    })()
  }

  const variant = (s: State) => (s === 'stored' || s === 'matched' ? 'default' : s === 'rejected' ? 'destructive' : 'secondary')

  return (
    <div>
      <PageHeader title={t('upload.title')} />
      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">{t('upload.help')}</p>
      <div
        className={`mb-6 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-10 text-sm text-muted-foreground transition-colors ${drag ? 'border-primary bg-muted' : ''}`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDrag(true)
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault()
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
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
