import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'

// The update's steps in order, with the share of the bar each one takes and how long it usually lasts (building the
// images is most of it)
const STEPS = [
  { key: 'queued', share: 3, seconds: 10 },
  { key: 'download', share: 10, seconds: 20 },
  { key: 'build', share: 60, seconds: 240 },
  { key: 'backup', share: 7, seconds: 15 },
  { key: 'start', share: 20, seconds: 45 },
]

/**
 * How far the update has gone: each step fills its part of the bar, quickly at first and then slower, so the bar
 * keeps moving without reaching the next step's part before the updater does. Going back fills a bar of its own.
 */
export function UpdateProgress({ step, at }: { step: string; at: string | null }) {
  const { t } = useTranslation()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  // When the step began: the updater's own time, or when this page first saw it
  const [since, setSince] = useState(() => ({ step, time: at ? Date.parse(at) : now }))
  if (since.step !== step) setSince({ step, time: at ? Date.parse(at) : now })
  const rollback = step === 'rollback'
  const index = Math.max(
    STEPS.findIndex((s) => s.key === step),
    0,
  )
  const elapsed = Math.max(0, (now - since.time) / 1000)
  // Within the step: 63% of its part after its usual time, never all of it
  const within = 1 - Math.exp(-elapsed / (rollback ? 60 : STEPS[index].seconds))
  const done = rollback ? 0 : STEPS.slice(0, index).reduce((n, s) => n + s.share, 0)
  const value = Math.min(99, Math.round(done + (rollback ? 100 : STEPS[index].share) * within * 0.95))
  return (
    <div className="space-y-1.5">
      <Progress
        value={value}
        aria-label={t('update.title')}
        className={cn('[&_[data-slot=progress-track]]:h-2', rollback && '[&_[data-slot=progress-indicator]]:bg-destructive')}
      />
      <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
        <span>{rollback ? t('update.progress.rollback') : t('update.progress.step', { n: index + 1, total: STEPS.length })}</span>
        <span>{value}%</span>
      </div>
    </div>
  )
}
