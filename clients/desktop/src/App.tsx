import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import { bytes, locale, setLang, t, type Lang } from './i18n'
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
// The guides and console settings pages take the place of a card in the sidebar selection
const GUIDES = '__guides'
const SETTINGS = '__settings'

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
  const [updated, setUpdated] = useState(false)
  useEffect(() => {
    const u = listen('app-updated', () => setUpdated(true))
    return () => void u.then((f) => f())
  }, [])
  const loadCards = useCallback(() => void invoke<Card[]>('cards').then(setCards), [])
  // The listener below lives as long as the window: it reads the cards through a ref
  const cardsRef = useRef<Card[]>([])
  cardsRef.current = cards

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
        void notifyFinished(e.payload, cardsRef.current)
      }),
    ]
    return () => subs.forEach((s) => void s.then((u) => u()))
  }, [loadCards, onChange])

  useEffect(() => {
    if (selected === GUIDES || selected === SETTINGS) return
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
  // Which server device each linked card is, to list cards under their device
  const [devices, setDevices] = useState<Record<number, { name: string; console?: { name: string } }>>({})
  const [ids, setIds] = useState<Record<string, number>>({})
  useEffect(() => {
    void api<{ id: number; name: string; console?: { name: string } }[]>('GET', '/devices').then((ds) => setDevices(Object.fromEntries(ds.map((d) => [d.id, d]))))
    for (const c of cards.filter((x) => x.link)) {
      if (c.link!.device_id) setIds((m) => ({ ...m, [c.root]: c.link!.device_id! }))
      else void invoke<number>('device_id', { root: c.root }).then((id) => setIds((m) => ({ ...m, [c.root]: id })), () => {})
    }
  }, [cards])
  const groups = useMemo(() => {
    const by = new Map<number, Card[]>()
    for (const c of cards) if (c.link && ids[c.root]) by.set(ids[c.root], [...(by.get(ids[c.root]) ?? []), c])
    return [...by.entries()].sort((a, b) => (devices[a[0]]?.name ?? '').localeCompare(devices[b[0]]?.name ?? ''))
  }, [cards, ids, devices])
  const loose = cards.filter((c) => !c.link || !ids[c.root])
  const card = cards.find((c) => c.root === selected) ?? null
  const syncing = new Set([...status.syncing, ...Object.keys(progress)])
  const cardButton = (c: Card) => (
    <li key={c.root}>
      <button className={c.root === selected ? 'card active' : 'card'} onClick={() => setSelected(c.root)}>
        <span className="icon">{c.removable ? '💾' : '📁'}</span>
        <span className="grow">
          <span className="title">{c.label}</span>
          <span className="muted small">
            {t(c.removable ? 'sdCard' : 'folder')}
            {c.link?.console ? ` · ${t('consoleToo')}` : ''}
            {!c.link ? ` · ${t('notLinked')}` : ''}
          </span>
        </span>
        {syncing.has(c.root) && <span className="spinner" />}
      </button>
    </li>
  )
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
        {!cards.length && <p className="muted small">{t('noCards')}</p>}
        {groups.length > 0 && <h2>{t('devicesHeading')}</h2>}
        {groups.map(([id, list]) => (
          <div key={id} className="device">
            <p className="device-name">
              🎮 {devices[id]?.name ?? `#${id}`}
              {devices[id]?.console?.name && <span className="muted small"> · {devices[id].console!.name}</span>}
            </p>
            <ul className="cards nested">{list.map(cardButton)}</ul>
          </div>
        ))}
        {loose.length > 0 && <h2>{t(groups.length ? 'unlinkedHeading' : 'cards')}</h2>}
        <ul className="cards">{loose.map(cardButton)}</ul>
        <button className="ghost" onClick={() => void addFolder()}>
          + {t('addFolder')}
        </button>
        <button className={selected === SETTINGS ? 'card active guides-link' : 'card guides-link'} onClick={() => setSelected(SETTINGS)}>
          <span className="icon">🏆</span>
          <span className="grow title">{t('consoleSettings')}</span>
        </button>
        <button className={selected === GUIDES ? 'card active guides-link' : 'card guides-link'} onClick={() => setSelected(GUIDES)}>
          <span className="icon">📘</span>
          <span className="grow title">{t('guidesNav')}</span>
        </button>
      </aside>
      <main>
        {updated && (
          <div className="banner">
            <span className="grow">{t('updatedBanner')}</span>
            <button className="primary" onClick={() => void invoke('restart_app')}>
              {t('restart')}
            </button>
          </div>
        )}
        {selected === GUIDES ? (
          <Guides server={status.server} />
        ) : selected === SETTINGS ? (
          <ConsoleSettings />
        ) : card ? (
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
  const [tab, setTab] = useState<'summary' | 'games' | 'lists' | 'add'>('summary')
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
              {(['summary', 'games', 'lists', 'add'] as const).map((k) => (
                <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
                  {t(k === 'summary' ? 'tabSummary' : k === 'games' ? 'tabGames' : k === 'lists' ? 'tabLists' : 'tabAdd')}
                </button>
              ))}
            </nav>
            {tab === 'summary' && <Summary deviceId={deviceId} onSend={() => sync(false)} refreshKey={result} />}
            {tab === 'games' && <Games deviceId={deviceId} refreshKey={result} onSend={() => sync(false)} />}
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
const CUSTOM = 'custom'
// Generic entries go last in the console list
const GENERIC = ['Other', 'PC']

function LinkForm({ card, onLinked }: { card: Card; onLinked: () => void }) {
  const [firmwares, setFirmwares] = useState<{ id: number; slug: string; name: string }[]>([])
  const [consoles, setConsoles] = useState<{ id: number; name: string }[]>([])
  const [devices, setDevices] = useState<{ id: number; name: string; console?: { name: string } }[]>([])
  const [systems, setSystems] = useState<{ slug: string; name: string }[]>([])
  const [owner, setOwner] = useState('')
  const [name, setName] = useState(card.label)
  const [fw, setFw] = useState('')
  const [consoleName, setConsoleName] = useState('')
  // "Other (I define it)": one system or a folder per system, where the roms are, where the saves go
  const [oneSystem, setOneSystem] = useState('gba')
  const [multi, setMulti] = useState(false)
  const [romsDir, setRomsDir] = useState('')
  const [savesBeside, setSavesBeside] = useState(true)
  const [savesDir, setSavesDir] = useState('saves')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    void api<typeof firmwares>('GET', '/devices/firmwares').then((f) => {
      setFirmwares(f)
      setFw(card.guess ? String(f.find((x) => x.slug === card.guess)?.id ?? '') : '')
    })
    void api<typeof consoles>('GET', '/devices/consoles').then((c) => {
      const sorted = [...c].sort((a, b) => Number(GENERIC.includes(a.name)) - Number(GENERIC.includes(b.name)) || a.name.localeCompare(b.name))
      setConsoles(sorted)
      setConsoleName(CONSOLE_FOR[card.guess ?? ''] ?? '')
    })
    void api<typeof devices>('GET', '/devices').then(setDevices)
    void api<{ slug: string; name: string }[]>('GET', '/systems').then((x) => setSystems([...x].sort((a, b) => a.name.localeCompare(b.name))))
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
  const clean = (p: string) => p.trim().replace(/^\/+|\/+$/g, '')
  const link = () =>
    run(async () => {
      // The typed console: an existing one, or a new one created now
      const typed = consoleName.trim()
      const found = consoles.find((c) => c.name.toLowerCase() === typed.toLowerCase())
      const consoleId = found ? found.id : (await api<{ id: number }>('POST', '/devices/consoles', { name: typed, manufacturer: typed.split(' ')[0] })).id
      let firmware = firmwares.find((x) => String(x.id) === fw)
      let overrides: string | null = null
      if (fw === CUSTOM) {
        firmware = firmwares.find((x) => x.slug === 'retroarch-desktop')!
        const roms = clean(romsDir)
        overrides = JSON.stringify(
          multi
            ? { romsRoot: roms || 'roms', savesLayout: savesBeside ? 'rom' : 'system', savesRoot: clean(savesDir) || 'saves', statesRoot: clean(savesDir) || 'saves' }
            : { romsRoot: roms, savesRoot: roms, statesRoot: roms, savesLayout: savesBeside ? 'beside' : 'flat', ...(savesBeside ? {} : { savesRoot: clean(savesDir), statesRoot: clean(savesDir) }), systemMap: { [oneSystem]: { folder: '' } }, systemMapOnly: true },
        )
      }
      await invoke('link_card', { root: card.root, name, consoleId, firmwareId: firmware!.id, firmware: firmware!.slug, overrides })
    })
  const existing = owner !== ''
  const ready = !!name && !!fw && !!consoleName.trim() && (fw !== CUSTOM || multi || !!oneSystem)
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
          <label>
            {t('console')}
            <input list="consoles" value={consoleName} onChange={(e) => setConsoleName(e.target.value)} placeholder={t('consoleTypeahead')} />
            <datalist id="consoles">
              {consoles.map((c) => (
                <option key={c.id} value={c.name} />
              ))}
            </datalist>
            {consoleName.trim() && !consoles.some((c) => c.name.toLowerCase() === consoleName.trim().toLowerCase()) && (
              <span className="accent small">{t('newConsoleHint', { name: consoleName.trim() })}</span>
            )}
          </label>
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
              <option value={CUSTOM}>{t('customLayout')}</option>
            </select>
          </label>
          {fw === CUSTOM && (
            <div className="panel inner">
              <label>
                {t('customGames')}
                <select value={multi ? 'multi' : 'one'} onChange={(e) => setMulti(e.target.value === 'multi')}>
                  <option value="one">{t('customOne')}</option>
                  <option value="multi">{t('customMulti')}</option>
                </select>
              </label>
              {!multi && (
                <label>
                  {t('customSystem')}
                  <select value={oneSystem} onChange={(e) => setOneSystem(e.target.value)}>
                    {systems.map((x) => (
                      <option key={x.slug} value={x.slug}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                {t(multi ? 'customRomsMulti' : 'customRoms')}
                <input value={romsDir} onChange={(e) => setRomsDir(e.target.value)} placeholder={multi ? 'roms' : t('customAnywhere')} />
              </label>
              <label>
                {t('customSaves')}
                <select value={savesBeside ? 'beside' : 'folder'} onChange={(e) => setSavesBeside(e.target.value === 'beside')}>
                  <option value="beside">{t('customSavesBeside')}</option>
                  <option value="folder">{t('customSavesFolder')}</option>
                </select>
              </label>
              {!savesBeside && (
                <label>
                  {t('customSavesDir')}
                  <input value={savesDir} onChange={(e) => setSavesDir(e.target.value)} placeholder="saves" />
                </label>
              )}
            </div>
          )}
          {error && <p className="error">{error}</p>}
          <button className="primary" disabled={busy || !ready} onClick={() => void link()}>
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
  const [systems, setSystems] = useState<SystemsInfo | null>(null)
  const [choosing, setChoosing] = useState(false)
  const [plan, setPlan] = useState<PlanInfo | null>(null)
  const [tree, setTree] = useState(false)
  const loadPlan = useCallback(() => void api<PlanInfo>('GET', `/devices/${deviceId}/plan`).then(setPlan, () => {}), [deviceId])
  useEffect(loadPlan, [loadPlan])
  const loadSystems = useCallback(() => void api<SystemsInfo>('GET', `/devices/${deviceId}/list-systems`).then(setSystems), [deviceId])
  useEffect(loadSystems, [loadSystems])
  if (!lists) return <p className="muted">…</p>
  if (!lists.length) return <p className="muted">{t('noLists')}</p>
  // Ticking a list subscribes the card right away; copying happens on the next sync (or now, with the button)
  const toggle = async (id: number, on: boolean) => {
    const n = new Set(picked)
    if (on) n.add(id)
    else n.delete(id)
    setPicked(n)
    await api('PUT', `/devices/${deviceId}/lists`, { listIds: [...n] })
    loadSystems()
    loadPlan()
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
      {systems && systems.systems.length > 0 && (
        <div className="row">
          <button onClick={() => setChoosing(true)}>
            {t('systemsButton', { copied: systems.systems.filter((x) => x.copied).length, total: systems.systems.length })}
          </button>
          {systems.systems.some((x) => x.fresh) && <span className="accent small">{t('freshCount', { n: systems.systems.filter((x) => x.fresh).length })}</span>}
        </div>
      )}
      {choosing && systems && (
        <SystemsDialog
          deviceId={deviceId}
          info={systems}
          onClose={(saved) => {
            setChoosing(false)
            if (saved) {
              loadSystems()
              loadPlan()
            }
          }}
        />
      )}
      {plan && plan.systems.length > 0 && (
        <div className="space">
          <p className="small">
            {plan.total ? t('spaceLine', { free: bytes(plan.free ?? 0), total: bytes(plan.total), need: bytes(plan.missingBytes) }) : t('spaceUnknown')}
          </p>
          {plan.fits === false && <p className="error small">{t('spaceNoFit', { over: bytes(plan.missingBytes - (plan.budget ?? 0)) })}</p>}
          <div className="row">
            <span className="small">{t('spaceReserve')}</span>
            <input
              style={{ width: 70 }}
              defaultValue={plan.reservePercent}
              onBlur={async (e) => {
                await api('PUT', `/devices/${deviceId}/reserve`, { percent: Math.max(0, Math.min(90, Number(e.target.value) || 0)) })
                loadPlan()
              }}
            />
            <span className="small">%</span>
            <button className={plan.fits === false ? 'primary' : ''} onClick={() => setTree(true)}>
              {t('spaceChoose')}
            </button>
          </div>
        </div>
      )}
      {tree && plan && (
        <SpaceTree
          deviceId={deviceId}
          plan={plan}
          onClose={(saved) => {
            setTree(false)
            if (saved) {
              loadPlan()
              loadSystems()
            }
          }}
        />
      )}
      <button className="primary" disabled={!picked.size} onClick={onCopy}>
        {t('saveLists')}
      </button>
    </div>
  )
}

/** Quick guides per kind of console, with the downloads the server offers */
interface ConsoleSettingsData {
  ra: { username: string | null; hasPassword: boolean; hasToken: boolean }
  wifi: { id: number; ssid: string; hasPassword: boolean; band: string; hidden: boolean }[]
}

interface LocalWifi {
  ssid: string
  password: string | null
  band: string
  hidden: boolean
  locked: boolean
}

/** The same settings as the web profile: the RetroAchievements login and WiFi networks pushed to every console */
function ConsoleSettings() {
  const [s, setS] = useState<ConsoleSettingsData | null>(null)
  const [ra, setRa] = useState({ username: '', password: '' })
  const [raForm, setRaForm] = useState(false)
  const [net, setNet] = useState({ ssid: '', password: '', band: 'dual', hidden: false })
  const [adding, setAdding] = useState(false)
  const [local, setLocal] = useState<(LocalWifi & { pick: boolean })[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const load = useCallback(() => void api<ConsoleSettingsData>('GET', '/settings/consoles').then(setS, (e) => setMsg({ ok: false, text: String(e) })), [])
  useEffect(load, [load])
  const run = async (f: () => Promise<unknown>, ok?: string) => {
    setBusy(true)
    setMsg(null)
    try {
      await f()
      if (ok) setMsg({ ok: true, text: ok })
      load()
      return true
    } catch (e) {
      setMsg({ ok: false, text: String(e) })
      return false
    } finally {
      setBusy(false)
    }
  }
  const nets = s?.wifi ?? []
  // Consoles without 5 GHz skip the 5 GHz-only networks, so their first one is the next they can see
  const fallback = nets.find((w) => w.band !== '5')
  const order = (ids: number[]) => void run(() => api('PUT', '/settings/consoles/wifi-order', { ids }))
  const move = (i: number, d: number) => {
    const ids = nets.map((w) => w.id)
    ;[ids[i], ids[i + d]] = [ids[i + d], ids[i]]
    order(ids)
  }
  const connected = !!s?.ra.hasPassword
  const login = (username: string) =>
    run(
      () =>
        api('PUT', '/settings/consoles/ra', { username, password: ra.password }).then(() => {
          setRa({ username: '', password: '' })
          setRaForm(false)
        }),
      t('raConnectedOk', { user: username }),
    )
  const scan = () =>
    void run(async () => {
      const found = await invoke<LocalWifi[]>('local_wifi')
      setLocal(found.map((w) => ({ ...w, pick: !w.locked && !nets.some((n) => n.ssid === w.ssid) })))
    })
  const importPicked = () =>
    void run(async () => {
      const picked = (local ?? []).filter((w) => w.pick)
      for (const w of picked) await api('POST', '/settings/consoles/wifi', { ssid: w.ssid, password: w.password, band: w.band, hidden: w.hidden })
      setLocal(null)
    }, t('wifiImported', { count: (local ?? []).filter((w) => w.pick).length }))
  const bands = (
    <>
      <option value="dual">{t('bandDual')}</option>
      <option value="2.4">2.4 GHz</option>
      <option value="5">{t('band5')}</option>
    </>
  )
  return (
    <div className="cardview">
      <h1>{t('consoleSettings')}</h1>
      <p className="muted small">{t('consoleSettingsHelp')}</p>
      {msg && <p className={msg.ok ? 'ok' : 'error'}>{msg.text}</p>}

      <div className="panel">
        <div className="row">
          <h2 className="grow">🏆 RetroAchievements</h2>
          {connected && !raForm && (
            <button
              className="ghost danger"
              disabled={busy}
              onClick={() => confirm(t('raDisconnectConfirm')) && void run(() => api('DELETE', '/settings/consoles/ra'), t('disconnected'))}
            >
              {t('disconnect')}
            </button>
          )}
        </div>
        {connected && !raForm ? (
          <div className="status-line">
            <span className="ok big">✓</span>
            <span className="grow">
              <strong>{t('raConnectedAs', { user: s!.ra.username ?? '' })}</strong>
              <span className="muted small block">{t('raConnectedHelp')}</span>
            </span>
            <button onClick={() => setRaForm(true)}>{t('changePassword')}</button>
          </div>
        ) : raForm || s ? (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault()
              void login(connected ? s!.ra.username! : ra.username.trim())
            }}
          >
            {!connected && <p className="muted small">{t('raHelp')}</p>}
            <div className="row wrap">
              {!connected && (
                <label className="grow">
                  {t('username')}
                  <input value={ra.username} placeholder={s?.ra.username ?? ''} onChange={(e) => setRa({ ...ra, username: e.target.value })} autoComplete="off" />
                </label>
              )}
              <label className="grow">
                {connected ? t('passwordFor', { user: s!.ra.username ?? '' }) : t('raPassword')}
                <input type="password" value={ra.password} onChange={(e) => setRa({ ...ra, password: e.target.value })} autoComplete="new-password" autoFocus={connected} />
              </label>
            </div>
            <div className="row">
              <button className="primary" type="submit" disabled={busy || !ra.password || (!connected && !ra.username.trim())}>
                {connected ? t('raCheck') : t('connect')}
              </button>
              {raForm && (
                <button type="button" className="ghost" onClick={() => (setRaForm(false), setRa({ username: '', password: '' }))}>
                  {t('cancel')}
                </button>
              )}
            </div>
          </form>
        ) : null}
      </div>

      <div className="panel">
        <h2>{t('wifiTitle')}</h2>
        <p className="muted small">{t('wifiHelp')}</p>
        {s && !nets.length && !adding && !local && <p className="empty">{t('wifiEmpty')}</p>}
        {nets.length > 0 && (
          <ul className="net-list">
            {nets.map((w, i) => (
              <li key={w.id} className="row">
                <span className="grow">
                  <strong>{w.ssid}</strong>
                  {i === 0 && <span className="pill">{t('wifiDefault')}</span>}
                  <span className="muted small block">{[w.hasPassword ? t('wifiSaved') : t('wifiOpen'), w.hidden ? t('wifiHidden') : null].filter(Boolean).join(' · ')}</span>
                  {i === 0 && w.band === '5' && <span className="muted small block">{fallback ? t('wifiDefault24', { ssid: fallback.ssid }) : t('wifiDefaultNo24')}</span>}
                </span>
                <select value={w.band} style={{ width: 'auto' }} onChange={(e) => void run(() => api('PATCH', `/settings/consoles/wifi/${w.id}`, { band: e.target.value }))}>
                  {bands}
                </select>
                <span style={{ width: 150, display: 'flex', justifyContent: 'flex-end' }}>
                  {i > 0 && (
                    <button className="ghost" disabled={busy} onClick={() => order([w.id, ...nets.map((n) => n.id).filter((x) => x !== w.id)])}>
                      {t('wifiMakeDefault')}
                    </button>
                  )}
                </span>
                <button className="small-btn" disabled={busy || i === 0} onClick={() => move(i, -1)} title={t('up')}>
                  ↑
                </button>
                <button className="small-btn" disabled={busy || i === nets.length - 1} onClick={() => move(i, 1)} title={t('down')}>
                  ↓
                </button>
                <button
                  className="small-btn danger"
                  disabled={busy}
                  onClick={() => confirm(t('wifiRemoveConfirm', { ssid: w.ssid })) && void run(() => api('DELETE', `/settings/consoles/wifi/${w.id}`))}
                  title={t('remove')}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        {local && (
          <div className="inline-form">
            <strong>{t('wifiLocalTitle')}</strong>
            <p className="muted small">{t('wifiLocalHelp')}</p>
            {!local.length && <p className="muted small">{t('wifiLocalNone')}</p>}
            {local.map((w, i) => {
              const have = nets.some((n) => n.ssid === w.ssid)
              return (
                <label key={w.ssid} className="check">
                  <input type="checkbox" checked={w.pick} disabled={have || w.locked} onChange={(e) => setLocal(local.map((x, j) => (j === i ? { ...x, pick: e.target.checked } : x)))} />
                  <span className="grow">
                    {w.ssid}
                    <span className="muted small">
                      {' · '}
                      {have ? t('wifiAlready') : w.locked ? t('wifiLocked') : w.password ? t('wifiWithPassword') : t('wifiOpen')}
                    </span>
                  </span>
                  <select value={w.band} style={{ width: 'auto' }} disabled={have || w.locked} onChange={(e) => setLocal(local.map((x, j) => (j === i ? { ...x, band: e.target.value } : x)))}>
                    {bands}
                  </select>
                </label>
              )
            })}
            <div className="row">
              <button className="primary" disabled={busy || !local.some((w) => w.pick)} onClick={importPicked}>
                {t('wifiImport', { count: local.filter((w) => w.pick).length })}
              </button>
              <button className="ghost" onClick={() => setLocal(null)}>
                {t('cancel')}
              </button>
            </div>
          </div>
        )}

        {adding ? (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault()
              void run(() => api('POST', '/settings/consoles/wifi', { ...net, password: net.password || null }), t('wifiAdded', { ssid: net.ssid })).then((ok) => {
                if (ok) setNet({ ssid: '', password: '', band: 'dual', hidden: false })
              })
            }}
          >
            <div className="row wrap">
              <label className="grow">
                {t('ssid')}
                <input value={net.ssid} onChange={(e) => setNet({ ...net, ssid: e.target.value })} autoComplete="off" autoFocus />
              </label>
              <label className="grow">
                {t('wifiPassword')}
                <input type="password" value={net.password} placeholder={t('wifiPasswordHint')} onChange={(e) => setNet({ ...net, password: e.target.value })} autoComplete="new-password" />
              </label>
              <label>
                {t('band')}
                <select value={net.band} onChange={(e) => setNet({ ...net, band: e.target.value })}>
                  {bands}
                </select>
              </label>
            </div>
            <p className="muted small">{t('bandHelp')}</p>
            <div className="row">
              <label className="check grow">
                <input type="checkbox" checked={net.hidden} onChange={(e) => setNet({ ...net, hidden: e.target.checked })} />
                {t('wifiHiddenLong')}
              </label>
              <button className="primary" type="submit" disabled={busy || !net.ssid || (!!net.password && net.password.length < 8)}>
                {t('addWifi')}
              </button>
              <button type="button" className="ghost" onClick={() => setAdding(false)}>
                {t('close')}
              </button>
            </div>
          </form>
        ) : (
          !local && (
            <div className="row wrap">
              <button className="primary" disabled={busy} onClick={scan}>
                {t('wifiFromComputer')}
              </button>
              <button onClick={() => setAdding(true)}>+ {nets.length ? t('addAnother') : t('addWifi')}</button>
            </div>
          )
        )}
      </div>
    </div>
  )
}

function Guides({ server }: { server: string }) {
  const base = server.replace(/\/+$/, '')
  const command = `wget -O rommancer-sync.sh ${base}/api/v1/link/client.sh && sh rommancer-sync.sh link ${base}`
  const cards: { key: string; devices: string; links: { label: string; url: string }[]; command?: string }[] = [
    { key: 'knulli', devices: 'Anbernic RG40XX, RG35XX, RG406H…', links: [{ label: t('fromWeb'), url: `${base}/guides` }] },
    { key: 'onion', devices: 'Miyoo Mini, Miyoo Mini Plus', links: [{ label: t('fromWeb'), url: `${base}/guides` }] },
    { key: 'arkos', devices: 'Anbernic RG353, RG503, Powkiddy RGB30…', links: [{ label: t('fromWeb'), url: `${base}/guides` }] },
    { key: 'android', devices: 'AYN Thor, AYN Odin, Retroid Pocket…', links: [{ label: 'Android (.apk)', url: `${base}/api/v1/link/android/rommancer-sync.apk` }] },
    {
      key: 'pc',
      devices: 'Windows, Linux',
      links: [
        { label: 'Windows (.exe)', url: `${base}/api/v1/link/desktop/rommancer-desktop-setup.exe` },
        { label: 'Linux (.deb)', url: `${base}/api/v1/link/desktop/rommancer-desktop.deb` },
      ],
    },
    { key: 'sd', devices: 'Nintendo DS (TWiLight Menu++), GBA (SuperCard, EZ-Flash…)', links: [] },
    { key: 'linux', devices: 'muOS, ROCKNIX, PC', links: [], command },
  ]
  return (
    <div className="cardview">
      <h1>{t('guidesNav')}</h1>
      <p className="muted small">{t('guidesIntro')}</p>
      {cards.map((c) => (
        <div key={c.key} className="panel">
          <h2>{t(`g_${c.key}_title` as never)}</h2>
          <p className="muted small">{c.devices}</p>
          <ol className="steps">
            {t(`g_${c.key}_steps` as never)
              .split('|')
              .map((step, i) => (
                <li key={i}>{step}</li>
              ))}
          </ol>
          {c.command && (
            <button className="command" title={t('copy')} onClick={() => void navigator.clipboard.writeText(c.command!)}>
              {c.command}
            </button>
          )}
          {c.links.length > 0 && (
            <div className="row wrap">
              {c.links.map((l) => (
                <button key={l.url} onClick={() => void openUrl(l.url)}>
                  ⬇ {l.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

interface Game {
  id: number
  path: string
  name: string
  size: number
  system: string | null
  systemName: string | null
  folder: string | null
  gameId: number | null
  gameTitle: string | null
  onServer: boolean
  pullPending: boolean
}

/** What the card holds (as of its last sync): titles, systems and whether the server has each game */
function Games({ deviceId, refreshKey, onSend }: { deviceId: number; refreshKey: unknown; onSend: () => void }) {
  const [data, setData] = useState<{ inventoryAt: string | null; allowPull: boolean; items: Game[] } | null>(null)
  const [q, setQ] = useState('')
  const [system, setSystem] = useState('')
  const [show, setShow] = useState<'all' | 'new' | 'unidentified' | 'onServer'>('all')
  const [error, setError] = useState('')
  const load = useCallback(() => void api<typeof data>('GET', `/devices/${deviceId}/inventory`).then(setData, (e) => setError(String(e))), [deviceId])
  useEffect(load, [load, refreshKey])
  const items = data?.items ?? []
  const systems = useMemo(() => [...new Map(items.filter((i) => i.system).map((i) => [i.system!, i.systemName ?? i.system!])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [items])
  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">…</p>
  if (!data.inventoryAt) return <p className="muted">{t('noInventory')}</p>
  const needle = q.trim().toLowerCase()
  const shown = items.filter(
    (i) =>
      (!system || i.system === system) &&
      (show === 'all' || (show === 'new' && i.gameId && !i.onServer) || (show === 'unidentified' && !i.gameId && !i.onServer) || (show === 'onServer' && i.onServer)) &&
      (!needle || `${i.name} ${i.gameTitle ?? ''}`.toLowerCase().includes(needle)),
  )
  const send = async (path: string) => {
    await api('POST', `/devices/${deviceId}/pull`, { paths: [path] })
    load()
    onSend()
  }
  return (
    <div className="panel">
      <p className="muted small">{t('gamesAt', { n: items.length, when: new Date(data.inventoryAt).toLocaleString(locale()) })}</p>
      <div className="row">
        <input className="grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('searchCard')} />
        <select style={{ width: 'auto' }} value={system} onChange={(e) => setSystem(e.target.value)}>
          <option value="">{t('allSystems')}</option>
          {systems.map(([slug, name]) => (
            <option key={slug} value={slug}>
              {name}
            </option>
          ))}
        </select>
        <select style={{ width: 'auto' }} value={show} onChange={(e) => setShow(e.target.value as typeof show)}>
          <option value="all">{t('showAll')}</option>
          <option value="new">{t('showNew')}</option>
          <option value="unidentified">{t('showUnidentified')}</option>
          <option value="onServer">{t('showOnServer')}</option>
        </select>
      </div>
      <div className="games">
        {shown.slice(0, 500).map((i) => (
          <div key={i.id} className="game">
            <span className="grow">
              <span className="title" title={i.path}>
                {i.gameTitle ?? i.name}
              </span>
              <span className="muted small">
                {i.systemName ?? i.folder ?? '—'}
                {i.gameTitle && ` · ${i.name}`}
              </span>
            </span>
            {i.onServer ? (
              <span className="ok" title={t('showOnServer')}>
                ✓
              </span>
            ) : i.pullPending ? (
              <span className="muted small">{t('sending')}</span>
            ) : (
              data.allowPull && (
                <button className="small-btn" onClick={() => void send(i.path)}>
                  {t('sendOne')}
                </button>
              )
            )}
          </div>
        ))}
        {shown.length > 500 && <p className="muted small">{t('moreGames', { n: shown.length - 500 })}</p>}
        {!shown.length && <p className="muted small">{t('noMatches')}</p>}
      </div>
    </div>
  )
}

interface PlanInfo {
  reservePercent: number
  free: number | null
  total: number | null
  budget: number | null
  missingBytes: number
  fits: boolean | null
  systems: { slug: string; name: string; excluded: boolean; bytes: number; games: { gameId: number | null; title: string; bytes: number; present: boolean; excluded: boolean }[] }[]
}

/** Systems and games of the card's lists by size: untick what should not be copied to it */
function SpaceTree({ deviceId, plan, onClose }: { deviceId: number; plan: PlanInfo; onClose: (saved: boolean) => void }) {
  const [offSystems, setOffSystems] = useState(new Set(plan.systems.filter((s) => s.excluded).map((s) => s.slug)))
  const [offGames, setOffGames] = useState(new Set(plan.systems.flatMap((s) => s.games.filter((g) => g.excluded && g.gameId && !s.excluded).map((g) => g.gameId!))))
  const [open, setOpen] = useState<string | null>(null)
  const missing = plan.systems.reduce(
    (n, s) => n + (offSystems.has(s.slug) ? 0 : s.games.filter((g) => !g.present && !(g.gameId && offGames.has(g.gameId))).reduce((m, g) => m + g.bytes, 0)),
    0,
  )
  const save = async () => {
    const sys = await api<SystemsInfo>('GET', `/devices/${deviceId}/list-systems`)
    await api('PUT', `/devices/${deviceId}/system-filter`, { newAuto: sys.newAuto, excluded: [...offSystems], known: sys.systems.map((s) => s.slug), excludedGames: [...offGames] })
    onClose(true)
  }
  const fits = plan.budget === null || missing <= plan.budget
  return (
    <div className="overlay" onClick={() => onClose(false)}>
      <div className="panel dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{t('spaceTreeTitle')}</h2>
        <p className={fits ? 'muted small' : 'error small'}>{t('spaceTreeTotal', { need: bytes(missing), budget: plan.budget === null ? '?' : bytes(plan.budget) })}</p>
        <div className="results">
          {plan.systems.map((s) => (
            <div key={s.slug}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={!offSystems.has(s.slug)}
                  onChange={(e) => {
                    const n = new Set(offSystems)
                    if (e.target.checked) n.delete(s.slug)
                    else n.add(s.slug)
                    setOffSystems(n)
                  }}
                />
                <button type="button" className="link grow" style={{ textAlign: 'left' }} onClick={() => setOpen(open === s.slug ? null : s.slug)}>
                  {s.name} · {bytes(s.bytes)} · {t('gamesN', { n: s.games.length })}
                </button>
              </label>
              {open === s.slug && !offSystems.has(s.slug) && (
                <div style={{ paddingLeft: 24 }}>
                  {s.games.map((g, i) => (
                    <label key={g.gameId ?? i} className="check small">
                      <input
                        type="checkbox"
                        disabled={!g.gameId}
                        checked={!(g.gameId && offGames.has(g.gameId))}
                        onChange={(e) => {
                          if (!g.gameId) return
                          const n = new Set(offGames)
                          if (e.target.checked) n.delete(g.gameId)
                          else n.add(g.gameId)
                          setOffGames(n)
                        }}
                      />
                      <span className="grow">{g.title}</span>
                      {g.present && <span className="ok">✓</span>}
                      <span className="muted">{bytes(g.bytes)}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="row end">
          <button onClick={() => onClose(false)}>{t('cancel')}</button>
          <button className="primary" onClick={() => void save()}>
            {t('save')}
          </button>
        </div>
      </div>
    </div>
  )
}

interface SystemsInfo {
  newAuto: boolean
  systems: { slug: string; name: string; games: number; folder: string; copied: boolean; fresh: boolean }[]
}

/** Every system of the card's lists: untick what should not be copied here, and choose what happens to new ones */
function SystemsDialog({ deviceId, info, onClose }: { deviceId: number; info: SystemsInfo; onClose: (saved: boolean) => void }) {
  const [copied, setCopied] = useState(new Set(info.systems.filter((s) => s.copied).map((s) => s.slug)))
  const [newAuto, setNewAuto] = useState(info.newAuto)
  const [error, setError] = useState('')
  const save = async () => {
    try {
      await api('PUT', `/devices/${deviceId}/system-filter`, {
        newAuto,
        excluded: info.systems.filter((s) => !copied.has(s.slug)).map((s) => s.slug),
        known: info.systems.map((s) => s.slug),
      })
      onClose(true)
    } catch (e) {
      setError(String(e))
    }
  }
  return (
    <div className="overlay" onClick={() => onClose(false)}>
      <div className="panel dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{t('systemsTitle')}</h2>
        <p className="muted small">{t('systemsHelp')}</p>
        <div className="results">
          {info.systems.map((s) => (
            <label key={s.slug} className="check">
              <input
                type="checkbox"
                checked={copied.has(s.slug)}
                onChange={(e) => {
                  const n = new Set(copied)
                  if (e.target.checked) n.add(s.slug)
                  else n.delete(s.slug)
                  setCopied(n)
                }}
              />
              <span style={copied.has(s.slug) ? undefined : { textDecoration: 'line-through', opacity: 0.6 }}>{s.name}</span>
              <span className="muted small">
                {' '}
                · {t('gamesN', { n: s.games })} · {t('toFolder', { folder: s.folder || '/' })}
              </span>
              {s.fresh && <span className="accent small"> · {t('fresh')}</span>}
            </label>
          ))}
        </div>
        <label className="check top">
          <input type="checkbox" checked={newAuto} onChange={(e) => setNewAuto(e.target.checked)} />
          <span>
            {t('newAuto')}
            <span className="muted small block">{t('newAutoHelp')}</span>
          </span>
        </label>
        {error && <p className="error">{error}</p>}
        <div className="row end">
          <button onClick={() => onClose(false)}>{t('cancel')}</button>
          <button className="primary" onClick={() => void save()}>
            {t('save')}
          </button>
        </div>
      </div>
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

/** A system notification when a sync brought something (saves, games) while the window is hidden or in the background */
async function notifyFinished(f: Finished, cards: Card[]) {
  if (!f.ok || document.hasFocus()) return
  const o = f.outcome
  const parts = [o.down === 1 ? t('notifySave') : o.down > 1 ? t('notifySaves', { n: o.down }) : '', o.roms > 0 ? t('notifyRoms', { n: o.roms }) : ''].filter(Boolean)
  if (!parts.length) return
  let granted = await isPermissionGranted()
  if (!granted) granted = (await requestPermission()) === 'granted'
  if (!granted) return
  const card = cards.find((c) => c.root === f.root)?.label ?? f.root
  sendNotification({ title: t('notifyTitle', { card }), body: parts.join(' · ') })
}
