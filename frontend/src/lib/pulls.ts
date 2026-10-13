import type { TFunction } from 'i18next'
import { toast } from 'sonner'

export interface Pulls {
  asked: number
  notAllowed: number
  nowhere: number
  denied: boolean
}

/** What became of the unidentified files a new list holds and the server lacks: asked from the consoles, or why not */
export function toastPulls(t: TFunction, p: Pulls | undefined) {
  if (!p) return
  if (p.asked) toast.info(t('more.pulls.asked', { count: p.asked }))
  if (p.denied) toast.warning(t('more.pulls.denied', { count: p.notAllowed }), { duration: 15000 })
  else if (p.notAllowed) toast.warning(t('more.pulls.off', { count: p.notAllowed }), { duration: 15000 })
  if (p.nowhere) toast.warning(t('more.pulls.nowhere', { count: p.nowhere }), { duration: 15000 })
}
