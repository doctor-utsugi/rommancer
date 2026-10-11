import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface ComboOption {
  value: string
  label: string
}

/** Accents and case do not matter when typing to filter */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/**
 * A select whose list filters as you type: arrows move, Enter picks, Escape closes. MULTIPLE keeps it open and
 * toggles each option (the value is then a list).
 */
function useCombo(options: ComboOption[], onPick: (o: ComboOption) => void, keepOpen: boolean) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const shown = useMemo(() => {
    const q = fold(query.trim())
    return q ? options.filter((o) => fold(o.label).includes(q)) : options
  }, [options, query])
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => root.current && !root.current.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])
  useEffect(() => setActive(0), [query, open])
  useEffect(() => {
    list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])
  const pick = (o: ComboOption) => {
    onPick(o)
    if (!keepOpen) {
      setOpen(false)
      setQuery('')
    }
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) setOpen(true)
      else setActive((a) => Math.min(a + 1, shown.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (open && shown[active]) pick(shown[active])
      else setOpen(true)
    } else if (e.key === 'Escape') {
      setOpen(false)
      setQuery('')
    }
  }
  return { open, setOpen, query, setQuery, active, setActive, root, list, shown, pick, onKeyDown }
}

const box = 'h-8 rounded-lg border border-input bg-transparent text-sm outline-none focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30'

function Menu({ c, isOn }: { c: ReturnType<typeof useCombo>; isOn: (v: string) => boolean }) {
  if (!c.open) return null
  return (
    <ul ref={c.list} role="listbox" className="absolute top-full left-0 z-50 mt-1 max-h-72 min-w-full overflow-y-auto rounded-lg border bg-popover p-1 text-sm text-popover-foreground shadow-md">
      {c.shown.length === 0 && <li className="px-2 py-1.5 text-muted-foreground">—</li>}
      {c.shown.map((o, i) => (
        <li
          key={o.value}
          data-i={i}
          role="option"
          aria-selected={isOn(o.value)}
          onMouseEnter={() => c.setActive(i)}
          onMouseDown={(e) => {
            e.preventDefault()
            c.pick(o)
          }}
          className={cn('flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 whitespace-nowrap', i === c.active && 'bg-accent text-accent-foreground')}
        >
          <Check className={cn('size-3.5 shrink-0', isOn(o.value) ? 'opacity-100' : 'opacity-0')} />
          {o.label}
        </li>
      ))}
    </ul>
  )
}

export function Combobox({ value, onChange, options, placeholder, className }: { value: string; onChange(v: string): void; options: ComboOption[]; placeholder?: string; className?: string }) {
  const c = useCombo(options, (o) => onChange(o.value), false)
  const current = options.find((o) => o.value === value)
  return (
    <div ref={c.root} className={cn('relative', className)}>
      <div className={cn(box, 'flex items-center gap-1 px-2')} onClick={() => c.setOpen(true)}>
        <input
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-foreground"
          value={c.open ? c.query : ''}
          placeholder={c.open ? current?.label ?? placeholder : current?.label ?? placeholder ?? ''}
          onChange={(e) => {
            c.setQuery(e.target.value)
            c.setOpen(true)
          }}
          onFocus={() => c.setOpen(true)}
          onKeyDown={c.onKeyDown}
          size={Math.max(8, (current?.label ?? placeholder ?? '').length)}
        />
        <ChevronDown className="size-4 shrink-0 opacity-60" />
      </div>
      <Menu c={c} isOn={(v) => v === value} />
    </div>
  )
}

/** Several picks: chosen ones as removable chips, the list stays open while ticking */
export function MultiCombobox({ value, onChange, options, placeholder, className }: { value: string[]; onChange(v: string[]): void; options: ComboOption[]; placeholder?: string; className?: string }) {
  const c = useCombo(options, (o) => onChange(value.includes(o.value) ? value.filter((v) => v !== o.value) : [...value, o.value]), true)
  const label = new Map(options.map((o) => [o.value, o.label]))
  return (
    <div ref={c.root} className={cn('relative', className)}>
      <div className={cn(box, 'flex h-auto min-h-8 flex-wrap items-center gap-1 px-1.5 py-1')} onClick={() => c.setOpen(true)}>
        {value.map((v) => (
          <span key={v} className="flex items-center gap-1 rounded-md bg-secondary px-1.5 py-0.5 text-xs">
            {label.get(v) ?? v}
            <X
              className="size-3 cursor-pointer opacity-60 hover:opacity-100"
              onMouseDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onChange(value.filter((x) => x !== v))
              }}
            />
          </span>
        ))}
        <input
          className="min-w-24 flex-1 bg-transparent px-1 outline-none"
          value={c.query}
          placeholder={value.length ? '' : placeholder}
          onChange={(e) => {
            c.setQuery(e.target.value)
            c.setOpen(true)
          }}
          onFocus={() => c.setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !c.query && value.length) onChange(value.slice(0, -1))
            c.onKeyDown(e)
          }}
        />
      </div>
      <Menu c={c} isOn={(v) => value.includes(v)} />
    </div>
  )
}
