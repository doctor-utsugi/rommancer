import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Folder, FolderPlus, HardDrive, X } from 'lucide-react'
import { toast } from 'sonner'
import { get, post } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Field, NativeSelect, PageHeader, errMsg, formatBytes, useSystems } from '@/components/common'

interface Survey {
  path: string
  files: number
  truncated: boolean
  systems: { slug: string; name: string; files: number; bytes: number; folders: string[] }[]
  unknown: { folder: string; files: number; bytes: number; exts: string[] }[]
}

const GENERAL = '__general'

/**
 * Storage setup: where the roms already are (sources, only read), what each folder holds, and where new
 * roms go (destinations, with a free-space reserve). Runs on a new server and any time later.
 */
export function StorageSetupPage() {
  const { t } = useTranslation()
  const nav = useNavigate()
  const qc = useQueryClient()
  const env = useQuery({ queryKey: ['storage-env'], queryFn: () => get<any>('/admin/storage/env') })
  const systems = useSystems()
  const [step, setStep] = useState(1)
  const [browse, setBrowse] = useState('/')
  const dir = useQuery({ queryKey: ['storage-browse', browse], queryFn: () => get<any>(`/admin/storage/browse?path=${encodeURIComponent(browse)}`) })
  const [folders, setFolders] = useState<string[]>([])
  const [overrides, setOverrides] = useState<Record<string, Record<string, string>>>({})
  const [surveys, setSurveys] = useState<Record<string, Survey>>({})
  const [surveying, setSurveying] = useState(false)
  // Destination per system: one of the folders, or the general destination
  const [route, setRoute] = useState<Record<string, string>>({})
  const [generalPath, setGeneralPath] = useState('')
  const [reserve, setReserve] = useState('5')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (env.data?.mounts?.length && browse === '/') setBrowse(env.data.mounts[0].mountPoint)
  }, [env.data])

  const survey = async () => {
    setSurveying(true)
    try {
      const out: Record<string, Survey> = {}
      for (const f of folders) out[f] = await get<Survey>(`/admin/storage/survey?path=${encodeURIComponent(f)}&overrides=${encodeURIComponent(JSON.stringify(overrides[f] ?? {}))}`)
      setSurveys(out)
      setStep(2)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setSurveying(false)
    }
  }

  // Every system found, with the folders holding it and their total size
  const found = useMemo(() => {
    const m = new Map<string, { slug: string; name: string; bytes: number; where: string[] }>()
    for (const [f, s] of Object.entries(surveys))
      for (const x of s.systems) {
        const e = m.get(x.slug) ?? { slug: x.slug, name: x.name, bytes: 0, where: [] }
        e.bytes += x.bytes
        e.where.push(f)
        m.set(x.slug, e)
      }
    return [...m.values()].sort((a, b) => b.bytes - a.bytes)
  }, [surveys])

  const finish = async () => {
    setBusy(true)
    try {
      const created: number[] = []
      // A retry after a failure halfway: folders created by the first attempt are reused, not refused as overlaps
      const create = async (body: Record<string, unknown>) => {
        try {
          return (await post<any>('/admin/paths', body)).id as number
        } catch (e) {
          const [code, id, ...rest] = errMsg(e).split(':')
          if (code === 'OVERLAP' && rest.join(':') === body.path) return Number(id)
          throw e
        }
      }
      const toFolder = (f: string) => Object.entries(route).filter(([, v]) => v === f).map(([k]) => k)
      for (const f of folders) {
        const targets = toFolder(f)
        const general = generalPath.trim() === f
        const id = await create({
          label: f.split('/').filter(Boolean).pop() ?? f,
          path: f,
          readOnly: !targets.length && !general,
          targetSystems: targets,
          isDefaultTarget: general,
          reservePercent: Number(reserve) || 5,
          folderSystems: overrides[f] && Object.keys(overrides[f]).length ? overrides[f] : null,
        })
        created.push(id)
      }
      if (generalPath.trim() && !folders.includes(generalPath.trim())) {
        created.push(await create({ label: 'Rommancer', path: generalPath.trim(), readOnly: false, isDefaultTarget: true, reservePercent: Number(reserve) || 5, create: true }))
      }
      for (const id of created) await post(`/admin/paths/${id}/scan`, {})
      toast.success(t('more.setup.done', { count: created.length }))
      void qc.invalidateQueries({ queryKey: ['paths'] })
      nav('/admin/paths')
    } catch (e) {
      const m = errMsg(e)
      toast.error(m.startsWith('OVERLAP') ? t('more.setup.overlap', { path: m.split(':').slice(2).join(':') }) : m.startsWith('SAME_FOLDER') ? t('more.setup.same', { path: m.split(':').slice(2).join(':') }) : m)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('more.setup.title')} />
      <p className="max-w-3xl text-sm text-muted-foreground">{t('more.setup.intro')}</p>
      <div className="flex gap-2 text-sm">
        {[1, 2, 3].map((n) => (
          <Badge key={n} variant={step === n ? 'default' : 'outline'}>
            {n}. {t(`more.setup.step${n}`)}
          </Badge>
        ))}
      </div>

      {step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('more.setup.step1')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <p className="text-muted-foreground">{t('more.setup.sourcesHelp')}</p>
            {env.data?.inContainer && (
              <div className="rounded-md border border-dashed p-3 text-xs">
                <p>{t('more.setup.container')}</p>
                <pre className="mt-2 overflow-x-auto rounded bg-muted p-2">{`volumes:\n  - /path/to/your/disk:/roms-disco2`}</pre>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {env.data?.mounts?.map((m: any) => (
                <Button key={m.mountPoint} size="sm" variant="outline" onClick={() => setBrowse(m.mountPoint)} title={`${m.source} ${m.root}`}>
                  <HardDrive className="size-4" />
                  {m.mountPoint} · {formatBytes(m.free)} {t('more.setup.free')}
                </Button>
              ))}
            </div>
            <div className="rounded-md border">
              <div className="flex items-center gap-2 border-b px-3 py-2">
                <span className="grow truncate font-mono text-xs">{dir.data?.path ?? browse}</span>
                <Button size="sm" onClick={() => dir.data && !folders.includes(dir.data.path) && setFolders([...folders, dir.data.path])}>
                  <FolderPlus className="size-4" />
                  {t('more.setup.addThis')}
                </Button>
              </div>
              <div className="max-h-72 overflow-y-auto">
                {dir.data?.parent && (
                  <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted" onClick={() => setBrowse(dir.data.parent)}>
                    <Folder className="size-4" /> ..
                  </button>
                )}
                {dir.data?.dirs?.map((d: string) => (
                  <button
                    key={d}
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted"
                    onClick={() => setBrowse(`${dir.data.path.replace(/\/$/, '')}/${d}`)}
                  >
                    <Folder className="size-4" /> <span className="grow">{d}</span> <ChevronRight className="size-4 text-muted-foreground" />
                  </button>
                ))}
              </div>
            </div>
            {folders.length > 0 && (
              <div className="space-y-1">
                <p className="font-medium">{t('more.setup.chosen')}</p>
                {folders.map((f) => (
                  <div key={f} className="flex items-center gap-2">
                    <span className="grow truncate font-mono text-xs">{f}</span>
                    <Button size="icon-sm" variant="ghost" onClick={() => setFolders(folders.filter((x) => x !== f))}>
                      <X className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-end">
              <Button disabled={!folders.length || surveying} onClick={() => void survey()}>
                {surveying ? t('more.setup.surveying') : t('more.setup.next')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 2 &&
        folders.map((f) => {
          const s = surveys[f]
          return (
            <Card key={f}>
              <CardHeader>
                <CardTitle className="truncate font-mono text-sm">{f}</CardTitle>
                <p className="text-xs text-muted-foreground">
                  {t('more.setup.filesFound', { count: s?.files ?? 0 })}
                  {s?.truncated && ` · ${t('more.setup.truncated')}`}
                </p>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {s?.systems.length ? (
                  <Table className="table-fixed">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-48">{t('common.system')}</TableHead>
                        <TableHead className="w-24">{t('more.setup.files')}</TableHead>
                        <TableHead className="w-24">{t('more.setup.size')}</TableHead>
                        <TableHead>{t('more.setup.folders')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {s.systems.map((x) => (
                        <TableRow key={x.slug}>
                          <TableCell className="truncate">{x.name}</TableCell>
                          <TableCell>{x.files}</TableCell>
                          <TableCell>{formatBytes(x.bytes)}</TableCell>
                          <TableCell className="truncate font-mono text-xs" title={x.folders.join('\n')}>
                            {x.folders.join(' · ')}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <p className="text-muted-foreground">{t('more.setup.nothing')}</p>
                )}
                {s?.unknown.length > 0 && (
                  <div className="space-y-2">
                    <p className="font-medium">{t('more.setup.unknown')}</p>
                    {s.unknown.map((u) => (
                      <div key={u.folder} className="flex flex-wrap items-center gap-2">
                        <span className="w-56 truncate font-mono text-xs">{u.folder}</span>
                        <span className="text-xs text-muted-foreground">
                          {u.files} · {u.exts.join(' ')}
                        </span>
                        <NativeSelect
                          value={overrides[f]?.[u.folder.toLowerCase()] ?? ''}
                          onChange={(e) => setOverrides({ ...overrides, [f]: { ...(overrides[f] ?? {}), [u.folder.toLowerCase()]: e.target.value } })}
                        >
                          <option value="">{t('more.setup.ignore')}</option>
                          {systems.data?.map((x) => (
                            <option key={x.slug} value={x.slug}>
                              {x.name}
                            </option>
                          ))}
                        </NativeSelect>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )
        })}
      {step === 2 && (
        <div className="flex justify-between">
          <Button variant="outline" onClick={() => setStep(1)}>
            {t('more.setup.back')}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" disabled={surveying} onClick={() => void survey()}>
              {t('more.setup.resurvey')}
            </Button>
            <Button onClick={() => setStep(3)}>{t('more.setup.next')}</Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('more.setup.step3')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <p className="text-muted-foreground">{t('more.setup.destHelp')}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('more.setup.general')}>
                <Input value={generalPath} onChange={(e) => setGeneralPath(e.target.value)} placeholder={`${(env.data?.mounts?.[0]?.mountPoint ?? '/roms').replace(/\/+$/, '')}/rommancer`} className="font-mono" />
              </Field>
              <Field label={t('more.setup.reserve')}>
                <Input value={reserve} onChange={(e) => setReserve(e.target.value)} inputMode="numeric" />
              </Field>
            </div>
            {found.length > 0 && (
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-48">{t('common.system')}</TableHead>
                    <TableHead className="w-24">{t('more.setup.size')}</TableHead>
                    <TableHead>{t('more.setup.newGoTo')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {found.map((x) => (
                    <TableRow key={x.slug}>
                      <TableCell className="truncate">
                        {x.name}
                        {x.where.length > 1 && <span className="block text-xs text-muted-foreground">{t('more.setup.scattered', { count: x.where.length })}</span>}
                      </TableCell>
                      <TableCell>{formatBytes(x.bytes)}</TableCell>
                      <TableCell>
                        <NativeSelect value={route[x.slug] ?? GENERAL} onChange={(e) => setRoute({ ...route, [x.slug]: e.target.value })}>
                          <option value={GENERAL}>{t('more.setup.toGeneral')}</option>
                          {x.where.map((w) => (
                            <option key={w} value={w}>
                              {w}
                            </option>
                          ))}
                        </NativeSelect>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <p className="text-xs text-muted-foreground">{t('more.setup.readOnlyNote')}</p>
            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep(2)}>
                {t('more.setup.back')}
              </Button>
              <Button disabled={busy || (!generalPath.trim() && !Object.values(route).some((v) => v !== GENERAL))} onClick={() => void finish()}>
                {busy ? t('more.setup.creating') : t('more.setup.finish')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
