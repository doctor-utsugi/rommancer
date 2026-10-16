import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as KeyEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { bytes, t, tn } from './i18n'

/** A system the server can send: here = games on the device or queued, new_bytes = the size of the rest */
interface BSystem {
  slug: string
  name: string
  games: number
  bytes: number
  here: number
  new_bytes: number
}

interface BGame {
  id: string
  bytes: number
  state: 'new' | 'here' | 'queued'
  system: string
  title: string
}

interface BCheck {
  need_bytes: number
  need_games: number
  have: number
  pending: number
  /** null: the space could not be measured */
  usable: number | null
  free: number
  kept: number
  fits: boolean
  nospace: boolean
  added: number | null
  /** The name a new list of the pick gets; null: no list actions (older server, account without lists) */
  listname: string | null
  saved: BSaved | null
  /** Why a save did not happen: nolist, nolists, empty */
  refused: string | null
}

/** The list a pick was saved to: added = new in it, games = the pick's, ondevice = the device has it */
interface BSaved {
  id: string
  added: number
  games: number
  ondevice: boolean
  name: string
}

interface BList {
  id: string
  items: number
  name: string
}

/** The games ticked one by one, and whole systems with the games unticked inside them */
interface Pick {
  games: Record<string, BGame>
  systems: Record<string, string[]>
}

const EMPTY: Pick = { games: {}, systems: {} }
const PAGE = 100
/** The search goes out this long after the last edit (Enter searches at once) */
const DEBOUNCE = 2000

const fresh = (s: BSystem) => Math.max(0, s.games - s.here)
const ticked = (p: Pick, g: BGame) => g.state === 'new' && (g.id in p.games || (p.systems[g.system] !== undefined && !p.systems[g.system].includes(g.id)))
/** 2 all ticked, 1 some, 0 none */
const systemState = (p: Pick, slug: string) => (p.systems[slug]?.length === 0 ? 2 : slug in p.systems || Object.values(p.games).some((g) => g.system === slug) ? 1 : 0)

function toggleGame(p: Pick, g: BGame): Pick {
  if (g.state !== 'new') return p
  const skip = p.systems[g.system]
  if (skip) return { ...p, systems: { ...p.systems, [g.system]: skip.includes(g.id) ? skip.filter((x) => x !== g.id) : [...skip, g.id] } }
  const games = { ...p.games }
  if (g.id in games) delete games[g.id]
  else games[g.id] = g
  return { ...p, games }
}

/** Ticking a system clears its single game ticks; an all-ticked one is unticked */
function toggleSystem(p: Pick, slug: string): Pick {
  if (systemState(p, slug) === 2) {
    const { [slug]: _, ...systems } = p.systems
    return { ...p, systems }
  }
  return { games: Object.fromEntries(Object.entries(p.games).filter(([, g]) => g.system !== slug)), systems: { ...p.systems, [slug]: [] } }
}

/** Games and bytes, roughly: a whole system counts its share of new games (the review shows the server's check) */
function countOf(p: Pick, known: BSystem[]): [number, number] {
  let n = Object.keys(p.games).length
  let size = Object.values(p.games).reduce((a, g) => a + g.bytes, 0)
  for (const [slug, skip] of Object.entries(p.systems)) {
    const s = known.find((x) => x.slug === slug)
    if (!s) continue
    const take = Math.max(0, fresh(s) - skip.length)
    n += take
    if (fresh(s) > 0) size += Math.round((s.new_bytes * take) / fresh(s))
  }
  return [n, size]
}

const Icon = ({ d, size = 16 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
)
const ICON = {
  back: 'M15 18l-6-6 6-6',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.35-4.35',
  close: 'M18 6L6 18M6 6l12 12',
  check: 'M20 6L9 17l-5-5',
  eyeOff: 'M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A9.8 9.8 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6C3.9 8.4 2 12 2 12s4 7 10 7a9.7 9.7 0 0 0 5.4-1.6',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
}

/** A checkbox the keyboard never stops on (the list's cursor ticks); MIXED shows the "some games" state */
function Tick({ on, mixed, disabled, onToggle }: { on: boolean; mixed?: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <input
      type="checkbox"
      tabIndex={-1}
      checked={on}
      disabled={disabled}
      ref={(el) => {
        if (el) el.indeterminate = !!mixed
      }}
      onClick={(e) => e.stopPropagation()}
      onChange={onToggle}
    />
  )
}

/**
 * The server's games for one device (docs/browse.md): its systems, a system's games or a search, ticked one by one or a
 * whole system at a time, then the server's space check and the download. ONDONE: the download started
 */
export function Browse({ syncKey, refreshKey, onDone, onExit }: { syncKey: string; refreshKey: unknown; onDone: () => void; onExit: () => void }) {
  const [systems, setSystems] = useState<BSystem[] | null>(null)
  const [error, setError] = useState('')
  const [denied, setDenied] = useState(false)
  const [all, setAll] = useState(false)
  const [system, setSystem] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState<{ games: BGame[]; total: number }>({ games: [], total: 0 })
  const [loading, setLoading] = useState(false)
  const [pick, setPick] = useState<Pick>(EMPTY)
  const [cursor, setCursor] = useState(0)
  const [review, setReview] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Only the answer to the latest request is shown
  const gen = useRef(0)
  // The cursor follows the keyboard into view, not the mouse
  const byKeys = useRef(false)

  const fail = useCallback((e: unknown) => {
    if (String(e) === 'denied') setDenied(true)
    else setError(String(e))
  }, [])

  useEffect(() => {
    void invoke<BSystem[]>('browse_systems', { key: syncKey }).then((s) => {
      setSystems(s)
      setError('')
    }, fail)
  }, [syncKey, refreshKey, fail])

  const inGames = system !== null || query !== ''
  useEffect(() => {
    if (!inGames) {
      gen.current++
      return setPage({ games: [], total: 0 })
    }
    const g = ++gen.current
    setPage({ games: [], total: 0 })
    setLoading(true)
    setCursor(0)
    void invoke<{ games: BGame[]; total: number }>('browse_games', { key: syncKey, system, q: query, offset: 0, limit: PAGE, all })
      .then((p) => g === gen.current && (setPage(p), setError('')), (e) => g === gen.current && fail(e))
      .finally(() => g === gen.current && setLoading(false))
  }, [syncKey, system, query, all, inGames, refreshKey, fail])

  const more = useCallback(() => {
    if (!inGames || loading || page.games.length >= page.total) return
    const g = gen.current
    setLoading(true)
    void invoke<{ games: BGame[]; total: number }>('browse_games', { key: syncKey, system, q: query, offset: page.games.length, limit: PAGE, all })
      .then((p) => g === gen.current && setPage((now) => ({ games: [...now.games, ...p.games], total: p.total })), (e) => g === gen.current && fail(e))
      .finally(() => g === gen.current && setLoading(false))
  }, [inGames, loading, page, syncKey, system, query, all, fail])

  // The next page loads as the end of the list comes into view
  const sentinel = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = sentinel.current
    if (!el) return
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && more(), { root: list.current, rootMargin: '300px' })
    io.observe(el)
    return () => io.disconnect()
  }, [more, inGames])

  const known = systems ?? []
  const names = useMemo(() => Object.fromEntries(known.map((s) => [s.slug, s.name])), [known])
  const shownSystems = known.filter((s) => all || fresh(s) > 0)
  const rows = inGames ? page.games.length : shownSystems.length
  const [count, size] = countOf(pick, known)

  useEffect(() => setCursor((c) => Math.min(c, Math.max(0, rows - 1))), [rows])
  useEffect(() => {
    if (!byKeys.current) return
    byKeys.current = false
    document.querySelector(`.browse [data-row="${cursor}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const openSearch = () => {
    setSearchOpen(true)
    setTimeout(() => field.current?.focus(), 0)
  }
  const closeSearch = () => {
    clearTimeout(timer.current)
    setSearchOpen(false)
    setText('')
    setQuery('')
  }
  const edit = (v: string) => {
    setText(v)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setQuery(v.trim()), DEBOUNCE)
  }
  const searchNow = () => {
    clearTimeout(timer.current)
    setQuery(text.trim())
  }
  useEffect(() => () => clearTimeout(timer.current), [])

  const openSystem = (slug: string) => {
    setSystem(slug)
    setCursor(0)
  }
  const back = () => {
    if (searchOpen || query) return closeSearch()
    if (system !== null) {
      setSystem(null)
      return setCursor(Math.max(0, shownSystems.findIndex((s) => s.slug === system)))
    }
    if (count > 0 && !confirm(tn('browseDiscard', count))) return
    onExit()
  }
  // Ticks the row (Space) or opens it (Enter: a system; a game is ticked)
  const act = (i: number, open: boolean) => {
    if (inGames) {
      const g = page.games[i]
      if (g) setPick((p) => toggleGame(p, g))
    } else {
      const s = shownSystems[i]
      if (!s) return
      if (open) openSystem(s.slug)
      else if (fresh(s) > 0) setPick((p) => toggleSystem(p, s.slug))
    }
  }

  // Keys on the whole window while this screen is up; a text field or a focused button keeps its own
  const keys = useRef<(e: KeyboardEvent) => void>(() => {})
  keys.current = (e: KeyboardEvent) => {
    if (review) return
    const el = document.activeElement as HTMLElement | null
    const typing = el?.tagName === 'INPUT' && (el as HTMLInputElement).type === 'text'
    if (typing) {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeSearch()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        searchNow()
      } else if (e.key === 'ArrowDown' && rows > 0) {
        e.preventDefault()
        field.current?.blur()
        byKeys.current = true
        setCursor(0)
      }
      return
    }
    if (el && ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) return
    if (e.key === '/' || (e.key.toLowerCase() === 'f' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault()
      return openSearch()
    }
    if (el?.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return
    const move = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 }[e.key]
    if (move !== undefined || e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      byKeys.current = true
      setCursor((c) => (e.key === 'Home' ? 0 : e.key === 'End' ? rows - 1 : Math.max(0, Math.min(rows - 1, c + move!))))
      if (e.key === 'End' || (move && move > 0 && cursor + move >= rows - 1)) more()
    } else if (e.key === ' ') {
      e.preventDefault()
      act(cursor, false)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      act(cursor, true)
    } else if (e.key === 'Escape' || e.key === 'Backspace') {
      if (system !== null || query) {
        e.preventDefault()
        back()
      }
    }
  }
  useEffect(() => {
    ;(document.activeElement as HTMLElement | null)?.blur()
    const on = (e: KeyboardEvent) => keys.current(e)
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

  // The screen fills what is left of the window under the device's header, so the footer stays at the bottom and only
  // the list scrolls
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = box.current
    const main = el?.closest('main')
    if (!el || !main) return
    const fit = () => {
      const pad = parseFloat(getComputedStyle(main).paddingBottom) || 0
      const top = el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop
      el.style.height = `${Math.max(280, main.clientHeight - top - pad)}px`
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(main)
    if (main.firstElementChild) ro.observe(main.firstElementChild)
    return () => ro.disconnect()
  }, [])

  const pending = searchOpen && text.trim() !== query
  const searching = pending || (loading && query !== '' && !page.games.length)
  const atRoot = system === null && !searchOpen && !query
  const row = (i: number) => ({
    'data-row': i,
    className: 'brow' + (i === cursor ? ' cursor' : ''),
    onMouseMove: () => i !== cursor && setCursor(i),
  })

  let head = ''
  if (inGames) head = `${(query ? t('browseResults') : (names[system!] ?? system ?? '')).toUpperCase()} · ${tn('browseGamesN', page.total)}`
  else if (systems) head = `${t('browseSystemsHead').toUpperCase()} · ${all ? tn('browseSystemsAll', shownSystems.length) : t('browseSystemsNew', { n: shownSystems.length })}`

  let empty = ''
  if (denied) empty = t('browseDenied')
  else if (inGames) {
    if (loading && !page.games.length) empty = query ? '' : t('browseLoading')
    else if (!page.games.length) empty = query ? t('browseNoMatch', { q: query }) : t('browseAllOwned')
  } else if (!systems) empty = error ? '' : t('browseLoading')
  else if (!known.length) empty = t('browseNone')
  else if (!shownSystems.length) empty = t('browseAllOwned')

  return (
    <div className="browse" ref={box}>
      <div className="btop">
        <div className="bbar">
          <button className="ghost icon-btn" title={t('browseBack')} aria-label={t('browseBack')} onMouseDown={(e) => e.preventDefault()} onClick={back}>
            <Icon d={ICON.back} />
          </button>
          <nav className="crumbs">
            <button className="link" disabled={atRoot} onMouseDown={(e) => e.preventDefault()} onClick={() => (closeSearch(), setSystem(null))}>
              {t('browseRoot')}
            </button>
            {system !== null && (
              <>
                <span className="muted">›</span>
                <span className="crumb">{names[system] ?? system}</span>
              </>
            )}
          </nav>
          {searchOpen ? (
            <div className="bsearch">
              <Icon d={ICON.search} size={14} />
              <input ref={field} type="text" value={text} placeholder={t('browseSearchHint')} onChange={(e) => edit(e.target.value)} />
              {searching && (
                <span className="bwait">
                  <span className="spinner" />
                  {t('browseSearching')}
                </span>
              )}
              <button className="ghost icon-btn" title={t('browseSearchClose')} aria-label={t('browseSearchClose')} onMouseDown={(e) => e.preventDefault()} onClick={closeSearch}>
                <Icon d={ICON.close} size={14} />
              </button>
            </div>
          ) : (
            <>
              <button className="ghost icon-btn" title={t('browseSearch')} aria-label={t('browseSearch')} onMouseDown={(e) => e.preventDefault()} onClick={openSearch}>
                <Icon d={ICON.search} />
              </button>
              <button className={'chip' + (all ? '' : ' on')} title={t('browseOwnedHelp')} aria-pressed={!all} onMouseDown={(e) => e.preventDefault()} onClick={() => setAll(!all)}>
                <Icon d={all ? ICON.eye : ICON.eyeOff} size={13} />
                {t('browseHideOwned')}
              </button>
            </>
          )}
        </div>
        {head && !denied && <p className="bhead">{head}</p>}
      </div>
      {error && !denied && (
        <p className="error small">
          {t('browseFail')}: {error}
        </p>
      )}
      {empty && <p className="muted bempty">{empty}</p>}
      <div className="blist" ref={list}>
        {!denied &&
          !inGames &&
          shownSystems.map((s, i) => {
            const st = systemState(pick, s.slug)
            const n = fresh(s)
            return (
              <div key={s.slug} {...row(i)} onClick={() => openSystem(s.slug)}>
                <Tick on={st === 2} mixed={st === 1} disabled={n === 0} onToggle={() => setPick((p) => toggleSystem(p, s.slug))} />
                <span className="grow btitle">{s.name}</span>
                <span className="bside">
                  {n > 0 ? t('browseToDownload', { n, size: bytes(s.new_bytes) }) : t('browseAllHere')}
                  {n > 0 && s.here > 0 && <span className="bdim"> {t('browseOnConsoleN', { n: s.here })}</span>}
                </span>
              </div>
            )
          })}
        {!denied &&
          inGames &&
          page.games.map((g, i) => (
            <div key={g.id} {...row(i)} onClick={() => setPick((p) => toggleGame(p, g))}>
              {g.state === 'new' ? (
                <Tick on={ticked(pick, g)} onToggle={() => setPick((p) => toggleGame(p, g))} />
              ) : (
                <span className={'bstate ' + g.state}>
                  <Icon d={g.state === 'here' ? ICON.check : ICON.clock} size={14} />
                </span>
              )}
              <span className={'grow btitle' + (g.state === 'new' ? '' : ' bdim')}>{g.title}</span>
              {g.state !== 'new' && <span className={'badge ' + g.state}>{t(g.state === 'here' ? 'browseHere' : 'browseQueued')}</span>}
              {system === null && <span className="badge">{names[g.system] ?? g.system}</span>}
              <span className="bside">{bytes(g.bytes)}</span>
            </div>
          ))}
        {inGames && loading && page.games.length > 0 && <p className="muted small bempty">{t('browseLoadingMore')}</p>}
        <div ref={sentinel} />
      </div>
      {!denied && (
        <div className="bfoot">
          <span className="grow">
            {count > 0 ? tn('browseSelected', count, { size: bytes(size) }) : <span className="muted">{t('browseNoneSelected')}</span>}
            <span className="muted small bkeys">{t('browseKeys')}</span>
          </span>
          {count > 0 && (
            <button className="ghost" onMouseDown={(e) => e.preventDefault()} onClick={() => setPick(EMPTY)}>
              {t('browseClearSel')}
            </button>
          )}
          <button className="primary" disabled={!count} onMouseDown={(e) => e.preventDefault()} onClick={() => setReview(true)}>
            {t('browseReview')}
          </button>
        </div>
      )}
      {review && (
        <Review
          syncKey={syncKey}
          pick={pick}
          known={known}
          onClose={() => setReview(false)}
          onSaved={() => setPick(EMPTY)}
          onAdded={() => {
            setReview(false)
            setPick(EMPTY)
            onDone()
          }}
        />
      )}
    </div>
  )
}

/** Arrows move the focus through the dialog (a gamepad's D-pad arrives as arrows); left and right stay in a text field */
function arrows(e: KeyEvent<HTMLElement>) {
  const dir = ({ ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 } as Record<string, number>)[e.key]
  const el = document.activeElement as HTMLElement | null
  if (!dir || (el?.tagName === 'INPUT' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'))) return
  const all = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input')]
  const next = all[el && all.includes(el) ? Math.max(0, Math.min(all.length - 1, all.indexOf(el) + dir)) : 0]
  if (!next) return
  e.preventDefault()
  next.focus()
  next.scrollIntoView({ block: 'nearest' })
}

type Step = 'review' | 'name' | 'lists' | 'saved'

/** The server's check of the pick, then Download, Save as a new list or Add to a list… (docs/browse.md).
 * ONSAVED: a list got the pick (the dialog stays for the result); ONADDED: a download started */
function Review({ syncKey, pick, known, onClose, onSaved, onAdded }: { syncKey: string; pick: Pick; known: BSystem[]; onClose: () => void; onSaved: () => void; onAdded: () => void }) {
  const [check, setCheck] = useState<BCheck | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState<Step>('review')
  const [name, setName] = useState('')
  const [lists, setLists] = useState<BList[] | null>(null)
  const [saved, setSaved] = useState<BCheck | null>(null)
  // Kept from when the dialog opened: a save clears the selection, and Download them to this console resends it
  const [body] = useState(() => ({ games: Object.keys(pick.games), systems: pick.systems }))
  const [whole] = useState(() =>
    Object.entries(pick.systems)
      .map(([slug, skip]) => {
        const s = known.find((x) => x.slug === slug)
        return s ? t('browseWhole', { name: s.name, n: Math.max(0, fresh(s) - skip.length) }) : ''
      })
      .filter(Boolean),
  )
  const failed = (e: unknown) => setError(String(e) === 'denied' ? t('browseDenied') : `${t('browseFail')}: ${e}`)
  useEffect(() => {
    void invoke<BCheck>('browse_check', { key: syncKey, pick: body }).then(setCheck, failed)
  }, [syncKey, body])

  const fetching = !!saved && saved.saved?.ondevice && saved.need_games > 0 && !saved.nospace
  const leave = () => (fetching ? onAdded() : onClose())
  const toReview = () => {
    setError('')
    setStep('review')
  }
  const escape = useRef(leave)
  escape.current = step === 'name' || step === 'lists' ? toReview : leave
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      escape.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const download = async () => {
    setBusy(true)
    setError('')
    try {
      const c = await invoke<BCheck>('browse_add', { key: syncKey, pick: body })
      if (c.nospace || c.added === null) setCheck(c)
      else onAdded()
    } catch (e) {
      failed(e)
    } finally {
      setBusy(false)
    }
  }

  /** ASSIGN also gives the list to this device */
  const save = async (to: { name: string } | { id: string }, assign: boolean) => {
    setBusy(true)
    setError('')
    try {
      const c = await invoke<BCheck>('browse_list', { key: syncKey, pick: body, to, assign })
      if (c.saved) {
        if (assign) return c.need_games > 0 ? onAdded() : onClose()
        onSaved()
        setSaved(c)
        setStep('saved')
      } else if (c.nospace && assign) {
        setSaved({ ...saved!, nospace: true })
        setError(c.usable === null ? t('browseNoMeasure') : t('browseNoSpace', { need: bytes(c.need_bytes), usable: bytes(c.usable) }))
      } else if (c.nospace) {
        // The device has the list, so the add had to fit: nothing was saved
        setCheck({ ...c, listname: check?.listname ?? null })
        setStep('review')
        setError(t('browseListNoSpace'))
      } else {
        if (c.refused === 'nolist') setLists(null)
        setError(t(c.refused === 'nolists' ? 'browseListsDenied' : c.refused === 'empty' ? 'browseListEmpty' : 'browseNoList'))
      }
    } catch (e) {
      failed(e)
    } finally {
      setBusy(false)
    }
  }

  const openName = () => {
    setError('')
    setName(check?.listname ?? '')
    setStep('name')
  }
  const openLists = () => {
    setError('')
    setStep('lists')
    setLists(null)
    void invoke<BList[]>('browse_lists', { key: syncKey }).then(setLists, (e) => (String(e) === 'nolists' ? setError(t('browseListsDenied')) : failed(e)))
  }

  const ok = !!check && check.fits && !check.nospace && check.need_games > 0
  const actions = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (step === 'name') {
      const el = field.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    } else actions.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
  }, [step, check, lists, saved])

  const savedLine = (c: BCheck) => {
    const s = c.saved!
    return s.added < s.games ? t('browseSavedNew', { name: s.name, n: s.added }) : tn('browseSaved', s.games, { name: s.name })
  }

  return (
    <div className="overlay" onClick={leave}>
      <div className="panel dialog breview" role="dialog" onClick={(e) => e.stopPropagation()} onKeyDown={arrows}>
        {step === 'review' && (
          <>
            <h2>{t('browseReview')}</h2>
            {!check && !error && (
              <p className="muted row">
                <span className="spinner" />
                {t('browseChecking')}
              </p>
            )}
            {check && check.need_games > 0 && <p>{tn('browseAsk', check.need_games, { size: bytes(check.need_bytes) })}</p>}
            {check && check.need_games === 0 && <p>{t('browseNothingNew')}</p>}
            {check && check.need_games > 0 && check.usable !== null && <p className="small">{t('browseUsable', { usable: bytes(check.usable), free: bytes(check.free), kept: bytes(check.kept) })}</p>}
            {check && check.pending > 0 && <p className="small">{t('browsePending', { size: bytes(check.pending) })}</p>}
            {check && check.have > 0 && check.need_games > 0 && <p className="muted small">{tn('browseHave', check.have)}</p>}
            {check && check.need_games > 0 && whole.map((w) => <p key={w} className="muted small">{w}</p>)}
            {check && check.need_games > 0 && (check.need_games > 50 || check.need_bytes > 2 * 1024 ** 3) && <p className="muted small">{t('browseLong')}</p>}
            {check && check.need_games > 0 && !check.fits && (
              <p className="error">{check.usable === null ? t('browseNoMeasure') : t('browseNoSpace', { need: bytes(check.need_bytes), usable: bytes(check.usable) })}</p>
            )}
            {error && <p className="error">{error}</p>}
            <div className="bactions" ref={actions}>
              {ok && (
                <button className="primary" disabled={busy} onClick={() => void download()}>
                  {t('browseDownload')}
                </button>
              )}
              {check?.listname && (
                <>
                  <button disabled={busy} onClick={openName}>
                    {t('browseSaveNew')}
                  </button>
                  <button disabled={busy} onClick={openLists}>
                    {t('browseAddTo')}
                  </button>
                </>
              )}
              <button onClick={onClose}>{t('cancel')}</button>
            </div>
          </>
        )}
        {step === 'name' && (
          <>
            <h2>{t('browseSaveNew')}</h2>
            <label className="block">
              <span className="small muted">{t('browseListName')}</span>
              <input
                ref={field}
                type="text"
                value={name}
                maxLength={191}
                placeholder={check?.listname ?? ''}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || busy) return
                  e.preventDefault()
                  void save({ name: name.trim() || (check?.listname ?? '') }, false)
                }}
              />
            </label>
            <p className="muted small">{t('browseListNameHelp')}</p>
            {error && <p className="error">{error}</p>}
            <div className="bactions" ref={actions}>
              <button className="primary" disabled={busy} onClick={() => void save({ name: name.trim() || (check?.listname ?? '') }, false)}>
                {busy ? t('browseSaving') : t('browseSave')}
              </button>
              <button disabled={busy} onClick={toReview}>
                {t('back')}
              </button>
            </div>
          </>
        )}
        {step === 'lists' && (
          <>
            <h2>{t('browseAddTo')}</h2>
            {!lists && !error && (
              <p className="muted row">
                <span className="spinner" />
                {t('browseListsLoading')}
              </p>
            )}
            {lists && !lists.length && <p className="muted">{t('browseNoLists')}</p>}
            {error && <p className="error">{error}</p>}
            <div className="bactions" ref={actions}>
              {lists && lists.length > 0 && (
                <div className="blist bpick">
                  {lists.map((l) => (
                    <button key={l.id} className="brow" disabled={busy} onMouseMove={(e) => e.currentTarget.focus()} onClick={() => void save({ id: l.id }, false)}>
                      <span className="grow btitle">{l.name}</span>
                      <span className="bside">{tn('browseGamesN', l.items)}</span>
                    </button>
                  ))}
                </div>
              )}
              <button disabled={busy} onClick={toReview}>
                {t('back')}
              </button>
            </div>
          </>
        )}
        {step === 'saved' && saved?.saved && (
          <>
            <h2>{savedLine(saved)}</h2>
            {fetching && <p>{tn('browseSavedGet', saved.need_games, { size: bytes(saved.need_bytes) })}</p>}
            {!fetching && saved.need_games > 0 && <p>{tn('browseSavedNotHere', saved.need_games, { size: bytes(saved.need_bytes) })}</p>}
            {error && <p className="error">{error}</p>}
            <div className="bactions" ref={actions}>
              {!fetching && saved.need_games > 0 && !saved.nospace && (
                <button className="primary" disabled={busy} onClick={() => void save({ id: saved.saved!.id }, true)}>
                  {t('browseGetThem')}
                </button>
              )}
              <button disabled={busy} onClick={leave}>
                {t('browseDone')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
