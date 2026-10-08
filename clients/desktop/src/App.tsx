import { useCallback, useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart'
import { bytes, setLang, t, type Lang } from './i18n'
import { SavePoint } from './SavePoint'

interface Status {
  server: string
  username: string | null
  signed_in: boolean
  auto_sync: boolean
  auto_roms: boolean
  syncing: string[]
}

interface Card {
  root: string
  label: string
  removable: boolean
  guess: string | null
  link: { server: string; user: string; console: boolean; device_id: number | null } | null
  total_bytes: number
  free_bytes: number
}

interface Progress {
  root: string
  phase: string
  done: number
  total: number
  file: string
  file_done: number
  file_total: number
}

interface Finished {
  root: string
  ok: boolean
  message: string
  outcome: { up: number; down: number; errors: number; sent: number; roms: number; roms_failed: number }
}

const api = <T,>(method: string, path: string, body?: unknown) => invoke<T>('api', { method, path, body })

const LANG_KEY = 'rommancer-lang'
const savedLang = (): Lang | '' => {
  try {
    return (localStorage.getItem(LANG_KEY) as Lang | null) ?? ''
  } catch {
    return ''
  }
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null)
  const [ready, setReady] = useState(false)
  const refresh = useCallback(() => void invoke<Status>('status').then(setStatus), [])
  useEffect(refresh, [refresh])
  // The user's choice, otherwise Spanish when any locale variable of the system says so
  useEffect(() => {
    const chosen = savedLang()
    if (chosen) {
      setLang(chosen)
      setReady(true)
    } else
      void invoke<string>('system_lang')
        .then((l) => l === 'es' && setLang('es'))
        .finally(() => setReady(true))
  }, [])
  if (!status || !ready) return null
  return status.signed_in ? <Main status={status} onChange={refresh} /> : <Login server={status.server} onDone={refresh} />
}

function Login({ server: initial, onDone }: { server: string; onDone: () => void }) {
  const [server, setServer] = useState(initial)
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [signup, setSignup] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await invoke('login', { server, username, password, email: signup ? email : null })
      onDone()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="login">
      <SavePoint size={220} />
      <form className="panel" onSubmit={submit}>
        <h1>Rommancer</h1>
        <label>
          {t('server')}
          <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://rommancer.example.com" />
        </label>
        <label>
          {t(signup ? 'username' : 'user')}
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </label>
        {signup && (
          <label>
            {t('email')}
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
        )}
        <label>
          {t('password')}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={signup ? 'new-password' : 'current-password'} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy || !username || !password}>
          {t(signup ? 'signup' : 'login')}
        </button>
        <button type="button" className="link" onClick={() => setSignup(!signup)}>
          {t(signup ? 'haveAccount' : 'noAccount')}
        </button>
      </form>
    </div>
  )
}

function Main({ status, onChange }: { status: Status; onChange: () => void }) {
  const [cards, setCards] = useState<Card[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [progress, setProgress] = useState<Record<string, Progress>>({})
  const [results, setResults] = useState<Record<string, Finished>>({})
  const [optionsOpen, setOptionsOpen] = useState(false)
  const loadCards = useCallback(() => void invoke<Card[]>('cards').then(setCards), [])

  useEffect(() => {
    loadCards()
    const subs = [
      listen('cards-changed', loadCards),
      listen<Progress>('progress', (e) => setProgress((p) => ({ ...p, [e.payload.root]: e.payload }))),
      listen<Finished>('sync-finished', (e) => {
        setProgress((p) => {
          const { [e.payload.root]: _, ...rest } = p
          return rest
        })
        setResults((r) => ({ ...r, [e.payload.root]: e.payload }))
        onChange()
      }),
    ]
    return () => subs.forEach((s) => void s.then((u) => u()))
  }, [loadCards, onChange])

  useEffect(() => {
    if (!selected && cards.length) setSelected(cards[0].root)
    if (selected && !cards.some((c) => c.root === selected)) setSelected(cards[0]?.root ?? null)
  }, [cards, selected])

  const addFolder = async () => {
    const path = await open({ directory: true })
    if (typeof path === 'string') {
      await invoke('add_folder', { path })
      loadCards()
    }
  }
  const card = cards.find((c) => c.root === selected) ?? null
  const syncing = new Set([...status.syncing, ...Object.keys(progress)])
  return (
    <div className="app">
      <aside>
        <header>
          <strong>Rommancer</strong>
          <button className="ghost" onClick={() => setOptionsOpen(!optionsOpen)} title={t('options')}>
            ⚙
          </button>
        </header>
        {optionsOpen && <Options status={status} onChange={onChange} />}
        <p className="muted small">
          {status.username} · {status.server.replace(/^https?:\/\//, '')}
        </p>
        <h2>{t('cards')}</h2>
        {!cards.length && <p className="muted small">{t('noCards')}</p>}
        <ul className="cards">
          {cards.map((c) => (
            <li key={c.root}>
              <button className={c.root === selected ? 'card active' : 'card'} onClick={() => setSelected(c.root)}>
                <span className="icon">{c.removable ? '💾' : '📁'}</span>
                <span className="grow">
                  <span className="title">{c.label}</span>
                  <span className="muted small">{c.link ? (c.link.console ? t('linkedConsole') : t('linked')) : t('notLinked')}</span>
                </span>
                {syncing.has(c.root) && <span className="spinner" />}
              </button>
            </li>
          ))}
        </ul>
        <button className="ghost" onClick={() => void addFolder()}>
          + {t('addFolder')}
        </button>
      </aside>
      <main>
        {card ? (
          <CardView key={card.root} card={card} progress={progress[card.root]} result={results[card.root]} syncing={syncing.has(card.root)} onChange={loadCards} />
        ) : (
          <div className="center">
            <SavePoint size={200} />
            <p className="muted">{t('pick')}</p>
          </div>
        )}
      </main>
    </div>
  )
}

function Options({ status, onChange }: { status: Status; onChange: () => void }) {
  const [auto, setAuto] = useState(false)
  useEffect(() => void isEnabled().then(setAuto).catch(() => {}), [])
  const set = async (opts: Record<string, boolean>) => {
    await invoke('set_options', opts)
    onChange()
  }
  return (
    <div className="options">
      <label className="check">
        <input type="checkbox" checked={status.auto_sync} onChange={(e) => void set({ autoSync: e.target.checked })} />
        {t('autoSync')}
      </label>
      <label className="check">
        <input type="checkbox" checked={status.auto_roms} onChange={(e) => void set({ autoRoms: e.target.checked })} />
        {t('autoRoms')}
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={auto}
          onChange={async (e) => {
            await (e.target.checked ? enable() : disable())
            setAuto(await isEnabled())
          }}
        />
        {t('autostart')}
      </label>
      <label>
        {t('language')}
        <select
          value={savedLang()}
          onChange={(e) => {
            try {
              if (e.target.value) localStorage.setItem(LANG_KEY, e.target.value)
              else localStorage.removeItem(LANG_KEY)
            } catch {
              /* not stored: this session only */
            }
            location.reload()
          }}
        >
          <option value="">{t('langAuto')}</option>
          <option value="es">Español</option>
          <option value="en">English</option>
        </select>
      </label>
      <button
        className="ghost danger"
        onClick={async () => {
          await invoke('logout')
          onChange()
        }}
      >
        {t('logout')}
      </button>
    </div>
  )
}

function CardView({ card, progress, result, syncing, onChange }: { card: Card; progress?: Progress; result?: Finished; syncing: boolean; onChange: () => void }) {
  const [deviceId, setDeviceId] = useState<number | null>(card.link?.device_id ?? null)
  const [tab, setTab] = useState<'summary' | 'lists' | 'add'>('summary')
  const [error, setError] = useState('')
  useEffect(() => {
    if (card.link && !deviceId) invoke<number>('device_id', { root: card.root }).then(setDeviceId, (e) => setError(String(e)))
  }, [card.link, card.root, deviceId])

  const sync = (roms?: boolean) => void invoke('sync_card', { root: card.root, roms: roms ?? null }).catch((e) => setError(String(e)))
  return (
    <div className="cardview">
      <div className="row">
        <div className="grow">
          <h1>{card.label}</h1>
          <p className="muted small">
            {card.root}
            {card.total_bytes > 0 && ` · ${t('free', { free: bytes(card.free_bytes), total: bytes(card.total_bytes) })}`}
          </p>
        </div>
        {card.link &&
          (syncing ? (
            <button onClick={() => void invoke('cancel_sync', { root: card.root })}>{t('cancel')}</button>
          ) : (
            <button className="primary" onClick={() => sync()}>
              {t('syncNow')}
            </button>
          ))}
      </div>
      {error && <p className="error">{error}</p>}
      {syncing && <ProgressBox p={progress} />}
      {!syncing && result && (
        <p className={result.ok ? 'ok' : 'error'}>
          {result.ok
            ? t('done', { up: result.outcome.up, down: result.outcome.down, roms: result.outcome.roms, sent: result.outcome.sent }) +
              (result.outcome.errors + result.outcome.roms_failed ? t('doneErrors', { errors: result.outcome.errors + result.outcome.roms_failed }) : '')
            : t('failed', { msg: result.message })}
        </p>
      )}
      {!card.link ? (
        <LinkForm card={card} onLinked={onChange} />
      ) : (
        deviceId && (
          <>
            <nav className="tabs">
              {(['summary', 'lists', 'add'] as const).map((k) => (
                <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
                  {t(k === 'summary' ? 'tabSummary' : k === 'lists' ? 'tabLists' : 'tabAdd')}
                </button>
              ))}
            </nav>
            {tab === 'summary' && <Summary deviceId={deviceId} onSend={() => sync(false)} refreshKey={result} />}
            {tab === 'lists' && <Lists deviceId={deviceId} name={card.label} onCopy={() => sync(true)} />}
            {tab === 'add' && <AddGames deviceId={deviceId} onAdded={() => sync(true)} />}
            {!card.link.console && (
              <button
                className="ghost danger"
                onClick={async () => {
                  if (confirm(t('unlinkConfirm'))) {
                    await invoke('unlink_card', { root: card.root })
                    onChange()
                  }
                }}
              >
                {t('unlink')}
              </button>
            )}
            {!card.removable && (
              <button
                className="ghost"
                onClick={async () => {
                  await invoke('remove_folder', { path: card.root })
                  onChange()
                }}
              >
                {t('removeFolder')}
              </button>
            )}
          </>
        )
      )}
    </div>
  )
}

function ProgressBox({ p }: { p?: Progress }) {
  const phase = p ? (t(`p_${p.phase}` as never) || p.phase) : t('syncing')
  const share = p && p.total ? ((p.phase === 'roms-download' && p.file_total ? p.done - 1 + p.file_done / p.file_total : p.done) / p.total) * 100 : 0
  return (
    <div className="progress">
      <div className="row small">
        <span>
          {phase}
          {p && p.total > 0 && ` · ${p.done}/${p.total}`}
        </span>
        <span className="muted">{p?.file}</span>
      </div>
      <div className="bar">
        <div style={{ width: `${Math.max(2, Math.min(100, share))}%` }} className={p && p.total ? '' : 'indeterminate'} />
      </div>
      {p?.file_total ? <p className="muted small">{`${bytes(p.file_done)} / ${bytes(p.file_total)}`}</p> : null}
    </div>
  )
}

const CONSOLE_FOR: Record<string, string> = { 'nds-twilight': 'Nintendo DS', onion: 'Miyoo Mini Plus', 'gba-flashcart': 'Game Boy Advance' }
const OTHER = 'other'

function LinkForm({ card, onLinked }: { card: Card; onLinked: () => void }) {
  const [firmwares, setFirmwares] = useState<{ id: number; slug: string; name: string }[]>([])
  const [consoles, setConsoles] = useState<{ id: number; name: string }[]>([])
  const [devices, setDevices] = useState<{ id: number; name: string; console?: { name: string } }[]>([])
  const [owner, setOwner] = useState('')
  const [name, setName] = useState(card.label)
  const [fw, setFw] = useState('')
  const [con, setCon] = useState('')
  const [newCon, setNewCon] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    void api<typeof firmwares>('GET', '/devices/firmwares').then((f) => {
      setFirmwares(f)
      // Unknown layout: the user picks it
      setFw(card.guess ? String(f.find((x) => x.slug === card.guess)?.id ?? '') : '')
    })
    void api<typeof consoles>('GET', '/devices/consoles').then((c) => {
      setConsoles(c)
      const want = CONSOLE_FOR[card.guess ?? ''] ?? ''
      setCon(String(c.find((x) => x.name === want)?.id ?? ''))
    })
    void api<typeof devices>('GET', '/devices').then(setDevices)
  }, [card.guess])
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      onLinked()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  const attach = () => run(() => invoke('attach_card', { root: card.root, deviceId: Number(owner), label: name }))
  const link = () =>
    run(async () => {
      let consoleId = Number(con)
      if (con === OTHER) consoleId = (await api<{ id: number }>('POST', '/devices/consoles', { name: newCon.trim(), manufacturer: newCon.trim().split(' ')[0] })).id
      const f = firmwares.find((x) => String(x.id) === fw)!
      await invoke('link_card', { root: card.root, name, consoleId, firmwareId: Number(fw), firmware: f.slug })
    })
  const existing = owner !== ''
  return (
    <div className="panel">
      <h2>{t('linkTitle')}</h2>
      <p className="muted small">{t('linkHelp')}</p>
      <label>
        {t('belongs')}
        <select value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">{t('belongsNo')}</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
              {d.console?.name ? ` (${d.console.name})` : ''}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t(existing ? 'cardLabel' : 'name')}
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {existing ? (
        <>
          <p className="muted small">{t('attachHelp')}</p>
          {error && <p className="error">{error}</p>}
          <button className="primary" disabled={busy || !name} onClick={() => void attach()}>
            {t('attach')}
          </button>
        </>
      ) : (
        <>
          <div className="row">
            <label className="grow">
              {t('console')}
              <select value={con} onChange={(e) => setCon(e.target.value)}>
                <option value="" disabled>
                  …
                </option>
                {consoles.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                <option value={OTHER}>{t('otherConsole')}</option>
              </select>
            </label>
            {con === OTHER && (
              <label className="grow">
                {t('newConsole')}
                <input autoFocus value={newCon} onChange={(e) => setNewCon(e.target.value)} />
              </label>
            )}
          </div>
          <label>
            {t('firmware')}
            <select value={fw} onChange={(e) => setFw(e.target.value)}>
              <option value="" disabled>
                {t('pickLayout')}
              </option>
              {firmwares.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          {error && <p className="error">{error}</p>}
          <button className="primary" disabled={busy || !name || !fw || !con || (con === OTHER && !newCon.trim())} onClick={() => void link()}>
            {t('link')}
          </button>
        </>
      )}
    </div>
  )
}

interface Inventory {
  summary?: { newGames: number; newFiles: number; newBytes: number; waiting: number; collection: { total: number; before: number; after: number } }
  items: unknown[]
  inventoryAt: string | null
  allowPull: boolean
}

const pct = (n: number, total: number) => (total ? (n / total) * 100 : 0)
const fmtPct = (v: number) => `${v < 1 ? v.toFixed(3) : v < 10 ? v.toFixed(2) : v.toFixed(1)} %`

function Summary({ deviceId, onSend, refreshKey }: { deviceId: number; onSend: () => void; refreshKey: unknown }) {
  const [inv, setInv] = useState<Inventory | null>(null)
  const [error, setError] = useState('')
  useEffect(() => void api<Inventory>('GET', `/devices/${deviceId}/inventory`).then(setInv, (e) => setError(String(e))), [deviceId, refreshKey])
  if (error) return <p className="error">{error}</p>
  if (!inv) return <p className="muted">…</p>
  if (!inv.inventoryAt) return <p className="muted">{t('noInventory')}</p>
  const s = inv.summary
  const send = async () => {
    await api('POST', `/devices/${deviceId}/pull`, { identified: true })
    onSend()
  }
  return (
    <div className="panel">
      <p className="muted small">{t('games', { n: inv.items.length })}</p>
      {s && s.newGames > 0 ? (
        <>
          <h2>{t('newGames', { n: s.newGames })}</h2>
          <p className="small">
            {t('collection')}: <strong>{fmtPct(pct(s.collection.before, s.collection.total))}</strong> → <strong className="accent">{fmtPct(pct(s.collection.after, s.collection.total))}</strong>
            {s.newBytes > 0 && <span className="muted"> · {bytes(s.newBytes)}</span>}
          </p>
          {s.waiting < s.newFiles && (
            <button className="primary" onClick={() => void send()}>
              {t('sendMissing')}
            </button>
          )}
          {s.waiting > 0 && <p className="muted small">{t('sendQueued', { n: s.waiting })}</p>}
        </>
      ) : (
        <p className="muted">{t('nothingNew')}</p>
      )}
    </div>
  )
}

function Lists({ deviceId, name, onCopy }: { deviceId: number; name: string; onCopy: () => void }) {
  const [lists, setLists] = useState<{ id: number; name: string; _count?: { items: number } }[] | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  useEffect(() => {
    void api<typeof lists>('GET', '/lists?scope=all').then(setLists)
    void api<{ id: number }[]>('GET', `/devices/${deviceId}/lists`).then((l) => setPicked(new Set(l.map((x) => x.id))))
  }, [deviceId])
  if (!lists) return <p className="muted">…</p>
  if (!lists.length) return <p className="muted">{t('noLists')}</p>
  // Ticking a list subscribes the card right away; copying happens on the next sync (or now, with the button)
  const toggle = async (id: number, on: boolean) => {
    const n = new Set(picked)
    if (on) n.add(id)
    else n.delete(id)
    setPicked(n)
    await api('PUT', `/devices/${deviceId}/lists`, { listIds: [...n] })
  }
  return (
    <div className="panel">
      <p className="muted small">{t('listsHelp', { name })}</p>
      {lists.map((l) => (
        <label key={l.id} className="check">
          <input type="checkbox" checked={picked.has(l.id)} onChange={(e) => void toggle(l.id, e.target.checked)} />
          {l.name}
          {l._count && <span className="muted small"> · {l._count.items}</span>}
          {picked.has(l.id) && <span className="accent small"> · {t('subscribed')}</span>}
        </label>
      ))}
      <button className="primary" disabled={!picked.size} onClick={onCopy}>
        {t('saveLists')}
      </button>
    </div>
  )
}

function AddGames({ deviceId, onAdded }: { deviceId: number; onAdded: () => void }) {
  const [q, setQ] = useState('')
  const [items, setItems] = useState<{ id: number; title: string; system: { name: string } }[]>([])
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [msg, setMsg] = useState('')
  useEffect(() => {
    const id = setTimeout(() => {
      if (q.trim().length < 2) return setItems([])
      void api<{ items: typeof items }>('GET', `/games?status=owned&pageSize=50&q=${encodeURIComponent(q.trim())}`).then((r) => setItems(r.items))
    }, 300)
    return () => clearTimeout(id)
  }, [q])
  const shown = useMemo(() => items, [items])
  const send = async () => {
    const r = await api<{ added: number }>('POST', `/devices/${deviceId}/send`, { gameIds: [...picked] })
    setMsg(t('added', { n: r.added }))
    setPicked(new Set())
    onAdded()
  }
  return (
    <div className="panel">
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} />
      <div className="results">
        {shown.map((g) => (
          <label key={g.id} className="check">
            <input
              type="checkbox"
              checked={picked.has(g.id)}
              onChange={(e) => {
                const n = new Set(picked)
                if (e.target.checked) n.add(g.id)
                else n.delete(g.id)
                setPicked(n)
              }}
            />
            <span className="grow">{g.title}</span>
            <span className="muted small">{g.system?.name}</span>
          </label>
        ))}
      </div>
      {msg && <p className="ok">{msg}</p>}
      <button className="primary" disabled={!picked.size} onClick={() => void send()}>
        {t('sendToCard', { n: picked.size })}
      </button>
    </div>
  )
}
