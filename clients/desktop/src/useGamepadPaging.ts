import { useEffect } from 'react'

export function useGamepadPaging() {
  useEffect(() => {
    const fallback = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !['PageUp', 'PageDown'].includes(event.key)) return
      const active = document.activeElement as HTMLElement | null
      const host = document.querySelector<HTMLElement>('[role="dialog"]') ?? document.querySelector<HTMLElement>('main')
      if (!host) return
      const candidates = [host, ...host.querySelectorAll<HTMLElement>('*')].filter((element) => {
        const box = element.getBoundingClientRect()
        return box.width > 0 && box.height > 0 && element.scrollHeight > element.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(element).overflowY)
      })
      const scroll = candidates.find((el) => active && el.contains(active)) ?? candidates[0]
      if (!scroll) return
      event.preventDefault()
      const direction = event.key === 'PageDown' ? 1 : -1
      const bounds = scroll.getBoundingClientRect()
      const y = (active && scroll.contains(active) ? active.getBoundingClientRect().top : bounds.top) + direction * scroll.clientHeight * .85
      const focusable = [...scroll.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]')]
        .filter((el) => el.getBoundingClientRect().height > 0)
      const target = focusable.filter((el) => direction > 0 ? el.getBoundingClientRect().top >= y : el.getBoundingClientRect().top <= y)
        .sort((a, b) => Math.abs(a.getBoundingClientRect().top - y) - Math.abs(b.getBoundingClientRect().top - y))[0]
      if (target) { target.focus(); target.scrollIntoView({ block: 'nearest' }) }
      else scroll.scrollBy({ top: direction * scroll.clientHeight * .85 })
    }
    // Let list-specific keyboard handlers consume the event before the generic scroll fallback.
    const keyboard = (event: KeyboardEvent) => queueMicrotask(() => fallback(event))
    window.addEventListener('keydown', keyboard)
    const held = new Map<string, number>()
    let frame = 0
    const poll = (now: number) => {
      for (const pad of navigator.getGamepads?.() ?? []) {
        if (!pad || pad.mapping !== 'standard') continue
        for (const [button, key] of [[4, 'PageUp'], [5, 'PageDown']] as const) {
          const id = `${pad.index}/${button}`
          if (!pad.buttons[button]?.pressed) { held.delete(id); continue }
          const next = held.get(id)
          if (next === undefined || now >= next) {
            window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
            held.set(id, now + (next === undefined ? 400 : 160))
          }
        }
      }
      frame = requestAnimationFrame(poll)
    }
    frame = requestAnimationFrame(poll)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('keydown', keyboard) }
  }, [])
}
