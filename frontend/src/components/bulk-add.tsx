import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { post } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, errMsg, useSystems } from '@/components/common'
import { MultiCombobox } from '@/components/combobox'
import { useRegions } from '@/pages/games'

interface Preview {
  games: number
  roms: number
  perSystem: { systemId: number; games: number; roms: number }[]
}

/** Quick picks for regions, as in the sublist wizard */
const PRESETS: { key: string; regions: string[] }[] = [
  { key: 'pal', regions: ['Europe', 'UK', 'Spain', 'France', 'Germany', 'Italy', 'Netherlands', 'Sweden', 'Scandinavia', 'Australia'] },
  { key: 'ntscu', regions: ['USA', 'Canada', 'Brazil'] },
  { key: 'ntscj', regions: ['Japan', 'Korea'] },
]
const EXTRAS = ['proto', 'beta', 'demo', 'sample', 'pirate']

/** Whole systems into the list at once: chosen systems and regions, with a live count before adding */
export function BulkAddDialog({ listId, onClose }: { listId: number; onClose(): void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const systems = useSystems()
  const allRegions = useRegions()
  const [systemIds, setSystemIds] = useState<string[]>([])
  const [regions, setRegions] = useState<string[]>([])
  const [mode, setMode] = useState<'best' | 'all'>('best')
  // Always on: lists only take roms the server has (the box stays hidden in case it comes back)
  const [ownedOnly, setOwnedOnly] = useState(true)
  const [verifiedOnly, setVerifiedOnly] = useState(false)
  const [extras, setExtras] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const systemOptions = useMemo(() => (systems.data ?? []).filter((s) => s.owned > 0).map((s) => ({ value: String(s.id), label: s.name })), [systems.data])
  const regionOptions = useMemo(() => (allRegions.data ?? []).map((r) => ({ value: r, label: r })), [allRegions.data])
  const nameOf = new Map(systemOptions.map((o) => [Number(o.value), o.label]))
  const body = useMemo(
    () => ({ systemIds: systemIds.map(Number), ...(regions.length ? { regions } : {}), mode, ownedOnly, verifiedOnly, excludeFlags: extras ? [] : EXTRAS }),
    [systemIds, regions, mode, ownedOnly, verifiedOnly, extras],
  )
  useEffect(() => {
    if (!systemIds.length) {
      setPreview(null)
      return
    }
    const timer = setTimeout(() => {
      post<Preview>(`/lists/${listId}/items/bulk/preview`, body)
        .then(setPreview)
        .catch((e) => toast.error(errMsg(e)))
    }, 300)
    return () => clearTimeout(timer)
  }, [body, listId, systemIds.length])
  const presetOn = (p: (typeof PRESETS)[number]) => p.regions.every((r) => regions.includes(r))
  const togglePreset = (p: (typeof PRESETS)[number]) => setRegions(presetOn(p) ? regions.filter((r) => !p.regions.includes(r)) : [...new Set([...regions, ...p.regions])])
  const add = async () => {
    setBusy(true)
    try {
      const r = await post<{ added: number }>(`/lists/${listId}/items/bulk`, body)
      toast.success(t('more.bulk.added', { count: r.added }))
      void qc.invalidateQueries({ queryKey: ['list', String(listId)] })
      void qc.invalidateQueries({ queryKey: ['list'] })
      onClose()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('more.bulk.title')}</DialogTitle>
          <DialogDescription>{t('more.bulk.help')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label={t('more.bulk.systems')}>
            <MultiCombobox value={systemIds} onChange={setSystemIds} options={systemOptions} placeholder={t('more.bulk.systemsHint')} />
          </Field>
          <Field label={t('more.bulk.regions')}>
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((p) => (
                  <Badge key={p.key} variant={presetOn(p) ? 'default' : 'outline'} className="cursor-pointer" onClick={() => togglePreset(p)}>
                    {t(`more.derive.preset_${p.key}`)}
                  </Badge>
                ))}
              </div>
              <MultiCombobox value={regions} onChange={setRegions} options={regionOptions} placeholder={t('more.bulk.anyRegion')} />
            </div>
          </Field>
          <div className="space-y-1.5 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" checked={mode === 'best'} onChange={() => setMode('best')} />
              {t('more.bulk.best')}
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={mode === 'all'} onChange={() => setMode('all')} />
              {t('more.bulk.all')}
            </label>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
            <label className="hidden items-center gap-2">
              <Checkbox checked={ownedOnly} onCheckedChange={(c) => setOwnedOnly(!!c)} />
              {t('more.derive.ownedOnly')}
            </label>
            <label className="flex items-center gap-2">
              <Checkbox checked={verifiedOnly} onCheckedChange={(c) => setVerifiedOnly(!!c)} />
              {t('more.derive.verifiedOnly')}
            </label>
            <label className="flex items-center gap-2">
              <Checkbox checked={extras} onCheckedChange={(c) => setExtras(!!c)} />
              {t('more.bulk.extras')}
            </label>
          </div>
          {preview && (
            <div className="rounded-md border p-3 text-sm">
              <p className="font-medium">{t('more.bulk.total', { games: preview.games, roms: preview.roms })}</p>
              <ul className="mt-1 text-xs text-muted-foreground">
                {preview.perSystem.map((p) => (
                  <li key={p.systemId}>
                    {nameOf.get(p.systemId) ?? p.systemId}: {t('more.bulk.line', { games: p.games, roms: p.roms })}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <DialogFooter cancel={false}>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void add()} disabled={busy || !preview?.roms}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {busy ? t('more.bulk.adding', { count: preview?.roms ?? 0 }) : t('more.bulk.go', { count: preview?.roms ?? 0 })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
