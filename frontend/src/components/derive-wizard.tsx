import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Check, Trophy } from 'lucide-react'
import { toast } from 'sonner'
import { post } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Field, errMsg } from '@/components/common'
import { useRegions } from '@/pages/games'

interface Version {
  id: number
  name: string
  regions: string[]
  languages: string[]
  flags: string[]
  ra: boolean
  owned: boolean
  verified: boolean
}

interface Preview {
  matched: { gameId: number; title: string; rom: Version }[]
  missing: { gameId: number; title: string; system: string; versions: Version[] }[]
  hacks: number
}

/** Quick picks: each sets regions and/or languages the version must have */
const PRESETS: { key: string; regions?: string[]; languages?: string[] }[] = [
  { key: 'ntsc', regions: ['USA', 'Canada', 'Japan', 'Korea', 'Brazil'] },
  { key: 'ntscu', regions: ['USA', 'Canada', 'Brazil'] },
  { key: 'ntscj', regions: ['Japan', 'Korea'] },
  { key: 'pal', regions: ['Europe', 'UK', 'Spain', 'France', 'Germany', 'Italy', 'Netherlands', 'Sweden', 'Scandinavia', 'Australia'] },
  { key: 'spanish', languages: ['Es'] },
]
const LANGS = ['Es', 'En', 'Fr', 'De', 'It', 'Ja', 'Pt']
const DEFAULT_EXCLUDE = ['proto', 'beta', 'demo', 'sample', 'pirate']

function VersionTags({ v }: { v: Version }) {
  const { t } = useTranslation()
  return (
    <span className="flex flex-wrap items-center gap-1">
      {v.regions.map((r) => (
        <Badge key={r} variant="outline">
          {r}
        </Badge>
      ))}
      {v.languages.length > 0 && <Badge variant="outline">{v.languages.join(' · ')}</Badge>}
      {v.ra && (
        <Badge variant="secondary">
          <Trophy className="size-3" />
        </Badge>
      )}
      {v.owned && (
        <Badge variant="secondary">
          <Check className="size-3" /> {t('more.derive.owned')}
        </Badge>
      )}
      {!v.verified && <Badge variant="destructive">{t('more.tags.unverified')}</Badge>}
      {v.flags.map((f) => (
        <Badge key={f} variant="outline">
          {f}
        </Badge>
      ))}
    </span>
  )
}

/** New sublist: filters with a live count, then the games without that version one by one. */
export function DeriveWizard({ list, onClose }: { list: { id: number; name: string }; onClose(): void }) {
  const { t } = useTranslation()
  const nav = useNavigate()
  const allRegions = useRegions()
  const [step, setStep] = useState<'filters' | 'resolve' | 'review'>('filters')
  const [name, setName] = useState(`${list.name} · ${t('more.derive.defaultName')}`)
  const [regions, setRegions] = useState<string[]>([])
  const [languages, setLanguages] = useState<string[]>([])
  const [raOnly, setRaOnly] = useState(false)
  const [ownedOnly, setOwnedOnly] = useState(false)
  const [verifiedOnly, setVerifiedOnly] = useState(false)
  const [extras, setExtras] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loading, setLoading] = useState(false)
  const [showMissing, setShowMissing] = useState(false)
  // Resolving: where we are, the choice per game (rom id, or null to leave it out), and the rule for the rest
  const [idx, setIdx] = useState(0)
  const [choice, setChoice] = useState<Record<number, number | null>>({})
  const [applyRest, setApplyRest] = useState(false)
  const [restFrom, setRestFrom] = useState<number | null>(null)

  const filters = useMemo(
    () => ({
      ...(regions.length ? { regions, strictRegions: true } : {}),
      ...(languages.length ? { languages, strictLanguages: true } : {}),
      raOnly,
      ownedOnly,
      verifiedOnly,
      excludeFlags: extras ? [] : DEFAULT_EXCLUDE,
    }),
    [regions, languages, raOnly, ownedOnly, verifiedOnly, extras],
  )

  useEffect(() => {
    setLoading(true)
    const timer = setTimeout(() => {
      post<Preview>(`/lists/${list.id}/derive/preview`, filters)
        .then((p) => {
          setPreview(p)
          setChoice({})
          setRestFrom(null)
          setIdx(0)
        })
        .catch((e) => toast.error(errMsg(e)))
        .finally(() => setLoading(false))
    }, 350)
    return () => clearTimeout(timer)
  }, [filters, list.id])

  const missing = preview?.missing ?? []
  const current = missing[idx]
  const presetOn = (p: (typeof PRESETS)[number]) => (p.regions ?? []).every((r) => regions.includes(r)) && (p.languages ?? []).every((l) => languages.includes(l))
  const togglePreset = (p: (typeof PRESETS)[number]) => {
    if (presetOn(p)) {
      setRegions(regions.filter((r) => !p.regions?.includes(r)))
      setLanguages(languages.filter((l) => !p.languages?.includes(l)))
    } else {
      setRegions([...new Set([...regions, ...(p.regions ?? [])])])
      setLanguages([...new Set([...languages, ...(p.languages ?? [])])])
    }
  }
  const pick = current ? (current.gameId in choice ? choice[current.gameId] : (current.versions[0]?.id ?? null)) : null

  const nextGame = () => {
    if (!current) return
    const next = { ...choice, [current.gameId]: pick }
    setChoice(next)
    if (applyRest) {
      setRestFrom(idx)
      setStep('review')
    } else if (idx + 1 < missing.length) setIdx(idx + 1)
    else setStep('review')
  }

  // What the rest rule does to a game: the version most like the one chosen, or leaving it out
  const restRule = restFrom !== null ? missing[restFrom] : null
  const restChoice = restRule ? choice[restRule.gameId] : undefined
  const decided = missing.filter((_, i) => restFrom === null || i <= restFrom)
  const perGame = Object.fromEntries(decided.map((m) => [String(m.gameId), choice[m.gameId] ?? null]))
  const left = decided.filter((m) => choice[m.gameId] == null).length + (restFrom !== null && restChoice == null ? missing.length - restFrom - 1 : 0)
  const other = decided.filter((m) => choice[m.gameId] != null).length + (restFrom !== null && restChoice != null ? missing.length - restFrom - 1 : 0)

  const create = async () => {
    try {
      const rest = restFrom !== null && restChoice != null ? { mode: 'like', romId: restChoice } : { mode: 'skip' }
      const r = await post(`/lists/${list.id}/derive`, { name, ...filters, perGame, rest })
      toast.success(`${t('lists.added', { count: r.added })} · ${t('lists.skipped', { count: r.skipped.length })}`)
      nav(`/lists/${r.id}`)
      onClose()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('lists.derive')}</DialogTitle>
          <DialogDescription>{t(`more.derive.help_${step}`)}</DialogDescription>
        </DialogHeader>

        {step === 'filters' && (
          <div className="grid gap-4">
            <Field label={t('common.name')}>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label={t('more.derive.quick')}>
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((p) => (
                  <Button key={p.key} size="sm" variant={presetOn(p) ? 'default' : 'outline'} onClick={() => togglePreset(p)}>
                    {t(`more.derive.preset_${p.key}`)}
                  </Button>
                ))}
              </div>
            </Field>
            <Field label={t('more.derive.regions')} hint={t('more.derive.regionsHint')}>
              <div className="flex max-h-28 flex-wrap gap-1 overflow-auto">
                {(allRegions.data ?? []).map((r) => (
                  <Badge key={r} variant={regions.includes(r) ? 'default' : 'outline'} className="cursor-pointer" onClick={() => setRegions(regions.includes(r) ? regions.filter((x) => x !== r) : [...regions, r])}>
                    {r}
                  </Badge>
                ))}
              </div>
            </Field>
            <Field label={t('more.derive.languages')}>
              <div className="flex flex-wrap gap-1">
                {LANGS.map((l) => (
                  <Badge key={l} variant={languages.includes(l) ? 'default' : 'outline'} className="cursor-pointer" onClick={() => setLanguages(languages.includes(l) ? languages.filter((x) => x !== l) : [...languages, l])}>
                    {l}
                  </Badge>
                ))}
              </div>
            </Field>
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              {(
                [
                  ['raOnly', raOnly, setRaOnly],
                  ['ownedOnly', ownedOnly, setOwnedOnly],
                  ['verifiedOnly', verifiedOnly, setVerifiedOnly],
                  ['extras', extras, setExtras],
                ] as const
              ).map(([key, value, set]) => (
                <label key={key} className="flex items-center gap-2">
                  <Checkbox checked={value} onCheckedChange={(c) => set(!!c)} />
                  {t(`more.derive.${key}`)}
                </label>
              ))}
            </div>
            <div className="rounded-lg border p-3 text-sm">
              {!preview || loading ? (
                <p className="text-muted-foreground">{t('more.derive.counting')}</p>
              ) : (
                <>
                  <p>
                    <span className="font-medium text-green-700 dark:text-green-400">{t('more.derive.matched', { count: preview.matched.length })}</span>
                    {missing.length > 0 && (
                      <>
                        {' · '}
                        <button type="button" className="font-medium text-amber-600 underline" onClick={() => setShowMissing(!showMissing)}>
                          {t('more.derive.missing', { count: missing.length })}
                        </button>
                      </>
                    )}
                    {preview.hacks > 0 && ` · ${t('more.derive.hacks', { count: preview.hacks })}`}
                  </p>
                  {showMissing && <p className="mt-1 text-xs text-muted-foreground">{missing.map((m) => m.title).join(' · ')}</p>}
                </>
              )}
            </div>
          </div>
        )}

        {step === 'resolve' && current && (
          <div className="grid gap-3">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t('more.derive.progress', { n: idx + 1, total: missing.length })}</p>
              <Progress value={((idx + 1) / missing.length) * 100} />
            </div>
            <div>
              <p className="font-medium">{current.title}</p>
              <p className="text-xs text-muted-foreground">{current.system}</p>
            </div>
            <div className="max-h-72 space-y-1 overflow-auto">
              <label className={`flex cursor-pointer items-center gap-3 rounded-md border p-2 text-sm ${pick === null ? 'border-primary bg-muted' : ''}`}>
                <input type="radio" checked={pick === null} onChange={() => setChoice({ ...choice, [current.gameId]: null })} />
                {t('more.derive.skip')}
              </label>
              {current.versions.map((v) => (
                <label key={v.id} className={`flex cursor-pointer items-start gap-3 rounded-md border p-2 text-sm ${pick === v.id ? 'border-primary bg-muted' : ''}`}>
                  <input type="radio" className="mt-1" checked={pick === v.id} onChange={() => setChoice({ ...choice, [current.gameId]: v.id })} />
                  <span className="min-w-0 space-y-1">
                    <span className="block truncate" title={v.name}>
                      {v.name}
                    </span>
                    <VersionTags v={v} />
                  </span>
                </label>
              ))}
            </div>
            {idx + 1 < missing.length && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={applyRest} onCheckedChange={(c) => setApplyRest(!!c)} />
                {pick === null ? t('more.derive.restSkip', { count: missing.length - idx - 1 }) : t('more.derive.restLike', { count: missing.length - idx - 1 })}
              </label>
            )}
          </div>
        )}

        {step === 'review' && preview && (
          <div className="grid gap-2 text-sm">
            <p>{t('more.derive.reviewMatched', { count: preview.matched.length })}</p>
            {other > 0 && <p>{t('more.derive.reviewOther', { count: other })}</p>}
            {left > 0 && <p className="text-amber-600">{t('more.derive.reviewLeft', { count: left })}</p>}
            {restFrom !== null && <p className="text-xs text-muted-foreground">{t(restChoice != null ? 'more.derive.reviewRuleLike' : 'more.derive.reviewRuleSkip')}</p>}
            <Field label={t('common.name')}>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
        )}

        <DialogFooter className="gap-2">
          {step !== 'filters' && (
            <Button
              variant="outline"
              onClick={() => {
                setRestFrom(null)
                setApplyRest(false)
                if (step === 'resolve' && idx > 0) setIdx(idx - 1)
                else setStep(step === 'review' && missing.length ? 'resolve' : 'filters')
              }}
            >
              {t('more.derive.back')}
            </Button>
          )}
          {step === 'filters' && (
            <Button disabled={!preview || loading || !name} onClick={() => (missing.length ? setStep('resolve') : setStep('review'))}>
              {missing.length ? t('more.derive.resolve', { count: missing.length }) : t('more.derive.next')}
            </Button>
          )}
          {step === 'resolve' && <Button onClick={nextGame}>{applyRest || idx + 1 >= missing.length ? t('more.derive.finish') : t('more.derive.next')}</Button>}
          {step === 'review' && (
            <Button disabled={!name} onClick={() => void create()}>
              {t('more.derive.create')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
