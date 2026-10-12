import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getVersion } from '@tauri-apps/api/app'
import { open } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import { bytes, locale, setLang, t, tn, type Key, type Lang } from './i18n'
import { SavePoint } from './SavePoint'

interface PcInfo {
  name: string
  device_id: number
  root: string
  saves_dir: string
  states_dir: string
  roms_dir: string
  saves_layout: string
  states_layout: string
  cfg: string | null
}

interface Status {
  server: string
  username: string | null
  signed_in: boolean
  auto_sync: boolean
  auto_roms: boolean
  allow_pull: boolean
  syncing: string[]
  pc: PcInfo | null
  pc_conflicts: number
  pc_offline_since: number | null
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
  step: number
  steps: number
  step_name: string
  done: number
  total: number
  file: string
  file_done: number
  file_total: number
}

interface Outcome {
  saves_up: number
  saves_down: number
  states_up: number
  states_down: number
  games_down: number
  games_failed: number
  games_sent: number
  errors: number
  config: number
  conflicts: number
}

interface Finished {
  root: string
  ok: boolean
  cancelled: boolean
  message: string
  outcome: Outcome
  at: number
  ok_at: number
  mode: string
}

interface Conflict {
  id: number
  game: string
  kind: string
  device_date: string
  server_date: string
  server_device: string
}

const api = <T,>(method: string, path: string, body?: unknown) => invoke<T>('api', { method, path, body })
// Pages that take the place of a device in the sidebar selection
const PC = 'pc'
const GUIDES = '__guides'
const CONSOLE_SETTINGS = '__consoles'
const APP_SETTINGS = '__settings'

const LANG_KEY = 'rommancer-lang'
const savedLang = (): Lang | '' => {
  try {
    return (localStorage.getItem(LANG_KEY) as Lang | null) ?? ''
  } catch {
    return ''
  }
}

const time = (ms: number) => new Date(ms).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })

/** "today, 18:52", "yesterday, 18:52" or the date */
function when(ms: number) {
  const d = new Date(ms)
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(new Date()) - day(d)) / 86_400_000)
  if (diff === 0) return t('today', { time: time(ms) })
  if (diff === 1) return t('yesterday', { time: time(ms) })
  return d.toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' })
}

/** The state line of a device, most urgent first */
function stateLines(conflicts: number, offlineSince: number | null, result: Finished | undefined) {
  const lines: { text: string; warn?: boolean }[] = []
  if (conflicts > 0) lines.push({ text: tn('stateConflicts', conflicts), warn: true })
  if (offlineSince) lines.push({ text: t('stateOffline', { time: time(offlineSince) }) })
  lines.push({ text: result?.ok_at ? t('stateSynced', { when: when(result.ok_at) }) : t('stateNever') })
  return lines
}

/** What a sync did, one fact per line, only the facts that are not zero */
function summaryLines(o: Outcome) {
  const facts: [Key, number][] = [
    ['sum_saves_up', o.saves_up],
    ['sum_saves_down', o.saves_down],
    ['sum_states_up', o.states_up],
    ['sum_states_down', o.states_down],
    ['sum_games_down', o.games_down],
    ['sum_games_sent', o.games_sent],
    ['sum_conflicts', o.conflicts],
  ]
  return facts.filter(([, n]) => n > 0).map(([k, n]) => tn(k, n))
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
  const [selected, setSelected] = useState<string>(PC)
  const [progress, setProgress] = useState<Record<string, Progress>>({})
  const [results, setResults] = useState<Record<string, Finished>>({})
  const [updated, setUpdated] = useState(false)
  const [version, setVersion] = useState('')
  useEffect(() => {
    void getVersion().then(setVersion)
    void invoke<Record<string, Finished>>('results').then((r) => setResults((now) => ({ ...r, ...now })))
    const u = listen('app-updated', () => setUpdated(true))
    return () => void u.then((f) => f())
  }, [])
  const loadCards = useCallback(() => void invoke<Card[]>('cards').then(setCards), [])
  // The listener below lives as long as the window: it reads the cards and this PC's name through refs
  const cardsRef = useRef<Card[]>([])
  cardsRef.current = cards
  const pcName = useRef('')
  pcName.current = status.pc?.name ?? t('thisPc')

  useEffect(() => {
    loadCards()
    const subs = [
      listen('cards-changed', loadCards),
      listen('pc-state', onChange),
      listen('sync-started', onChange),
      listen<Progress>('progress', (e) => setProgress((p) => ({ ...p, [e.payload.root]: e.payload }))),
      listen<Finished>('sync-finished', (e) => {
        setProgress((p) => {
          const { [e.payload.root]: _, ...rest } = p
          return rest
        })
        setResults((r) => ({ ...r, [e.payload.root]: e.payload }))
        onChange()
        void notifyFinished(e.payload, e.payload.root === PC ? pcName.current : (cardsRef.current.find((c) => c.root === e.payload.root)?.label ?? e.payload.root))
      }),
    ]
    return () => subs.forEach((s) => void s.then((u) => u()))
  }, [loadCards, onChange])

  useEffect(() => {
    if ([PC, GUIDES, CONSOLE_SETTINGS, APP_SETTINGS].includes(selected)) return
    if (!cards.some((c) => c.root === selected)) setSelected(PC)
  }, [cards, selected])

  const addFolder = async () => {
    const path = await open({ directory: true })
    if (typeof path === 'string') {
      await invoke('add_folder', { path })
      loadCards()
    }
  }
  // Which server device each linked card is, to list cards under their device; asked again only when the set of
  // linked cards changes (every insertion or removal emits cards-changed)
  const [devices, setDevices] = useState<Record<number, { name: string; console?: { name: string } }>>({})
  const [ids, setIds] = useState<Record<string, number>>({})
  const linkedKey = cards
    .filter((c) => c.link)
    .map((c) => c.root)
    .sort()
    .join('\n')
  useEffect(() => {
    if (!linkedKey) return
    void api<{ id: number; name: string; console?: { name: string } }[]>('GET', '/devices').then((ds) => setDevices(Object.fromEntries(ds.map((d) => [d.id, d]))))
    for (const c of cardsRef.current.filter((x) => x.link)) {
      if (c.link!.device_id) setIds((m) => ({ ...m, [c.root]: c.link!.device_id! }))
      else void invoke<number>('device_id', { root: c.root }).then((id) => setIds((m) => ({ ...m, [c.root]: id })), () => {})
    }
  }, [linkedKey])
  const groups = useMemo(() => {
    const by = new Map<number, Card[]>()
    for (const c of cards) if (c.link && ids[c.root]) by.set(ids[c.root], [...(by.get(ids[c.root]) ?? []), c])
    return [...by.entries()].sort((a, b) => (devices[a[0]]?.name ?? '').localeCompare(devices[b[0]]?.name ?? ''))
  }, [cards, ids, devices])
  const loose = cards.filter((c) => !c.link || !ids[c.root])
  const card = cards.find((c) => c.root === selected) ?? null
  const syncing = new Set([...status.syncing, ...Object.keys(progress)])

  // The tray speaks the interface language and shows this PC's state line
  const pcLine = status.pc
    ? syncing.has(PC)
      ? t('syncing')
      : stateLines(status.pc_conflicts, status.pc_offline_since, results[PC])
          .map((l) => l.text)
          .join(' · ')
    : t('notSetUp')
  useEffect(() => {
    void invoke('set_tray', { tooltip: `Rommancer · ${pcLine}`, open: t('trayOpen'), sync: t('syncNow'), quit: t('trayQuit') }).catch(() => {})
  }, [pcLine])

  const nav = (key: string, icon: string, label: string) => (
    <button className={selected === key ? 'card active guides-link' : 'card guides-link'} onClick={() => setSelected(key)}>
      <span className="icon">{icon}</span>
      <span className="grow title">{label}</span>
    </button>
  )
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
          <strong>Rommancer Sync</strong>
          <span className="muted small">{version}</span>
        </header>
        <ul className="cards top-device">
          <li>
            <button className={selected === PC ? 'card active' : 'card'} onClick={() => setSelected(PC)}>
              <span className="icon">🖥</span>
              <span className="grow">
                <span className="title">{t('thisPc')}</span>
                <span className={status.pc_conflicts > 0 ? 'warn small' : 'muted small'}>{status.pc ? pcLine : t('notSetUp')}</span>
              </span>
              {syncing.has(PC) && <span className="spinner" />}
            </button>
          </li>
        </ul>
        <h2>{t('consoleCards')}</h2>
        {!cards.length && <p className="muted small">{t('noCards')}</p>}
        {groups.map(([id, list]) => (
          <div key={id} className="device">
            <p className="device-name">
              🎮 {devices[id]?.name ?? `#${id}`}
              {devices[id]?.console?.name && <span className="muted small"> · {devices[id].console!.name}</span>}
            </p>
            <ul className="cards nested">{list.map(cardButton)}</ul>
          </div>
        ))}
        {loose.length > 0 && groups.length > 0 && <p className="device-name muted">{t('unlinkedHeading')}</p>}
        <ul className="cards">{loose.map(cardButton)}</ul>
        <button className="ghost" onClick={() => void addFolder()}>
          + {t('addFolder')}
        </button>
        <div className="side-nav">
          {nav(APP_SETTINGS, '⚙', t('settingsNav'))}
          {nav(CONSOLE_SETTINGS, '🏆', t('consoleSettings'))}
          {nav(GUIDES, '📘', t('guidesNav'))}
        </div>
        <p className="muted small">{t('accountLine', { user: status.username ?? '', server: status.server.replace(/^https?:\/\//, '') })}</p>
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
        ) : selected === CONSOLE_SETTINGS ? (
          <ConsoleSettings />
        ) : selected === APP_SETTINGS ? (
          <AppSettings status={status} onChange={onChange} />
        ) : selected === PC ? (
          status.pc ? (
            <DeviceHome
              key={`pc-${status.pc.device_id}`}
              syncKey={PC}
              title={status.pc.name}
              subtitle={t('thisPcSub', { version })}
              deviceId={status.pc.device_id}
              conflicts={status.pc_conflicts}
              offlineSince={status.pc_offline_since}
              progress={progress[PC]}
              result={results[PC]}
              syncing={syncing.has(PC)}
              pc={status.pc}
              version={version}
              status={status}
            />
          ) : (
            <PcSetup onDone={onChange} />
          )
        ) : card ? (
          <CardView key={card.root} card={card} progress={progress[card.root]} result={results[card.root]} syncing={syncing.has(card.root)} onChange={loadCards} version={version} status={status} />
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

/** Settings of this app: when to sync, what the server may ask, language and account */
function AppSettings({ status, onChange }: { status: Status; onChange: () => void }) {
  const [auto, setAuto] = useState(false)
  useEffect(() => void isEnabled().then(setAuto).catch(() => {}), [])
  const set = async (opts: Record<string, boolean>) => {
    await invoke('set_options', opts)
    onChange()
  }
  const toggle = (checked: boolean, onToggle: (v: boolean) => void, label: Key, help: Key) => (
    <label className="check top">
      <input type="checkbox" checked={checked} onChange={(e) => onToggle(e.target.checked)} />
      <span>
        {t(label)}
        <span className="muted small block">{t(help)}</span>
      </span>
    </label>
  )
  return (
    <div className="cardview">
      <h1>{t('settingsNav')}</h1>
      <div className="panel">
        {toggle(status.auto_sync, (v) => void set({ autoSync: v }), 'autoSync', 'autoSyncHelp')}
        {toggle(status.auto_roms, (v) => void set({ autoRoms: v }), 'autoRoms', 'autoRomsHelp')}
        {toggle(status.allow_pull, (v) => void set({ allowPull: v }), 'allowPull', 'allowPullHelp')}
        {toggle(
          auto,
          async (v) => {
            await (v ? enable() : disable())
            setAuto(await isEnabled())
          },
          'autostart',
          'autostartHelp',
        )}
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
      </div>
      <div className="panel">
        <h2>{t('account')}</h2>
        <p>{t('accountLine', { user: status.username ?? '', server: status.server.replace(/^https?:\/\//, '') })}</p>
        <div className="row wrap">
          {status.pc && (
            <button
              className="ghost danger"
              onClick={async () => {
                if (!confirm(t('pcForgetConfirm'))) return
                await invoke('pc_forget')
                onChange()
              }}
            >
              {t('pcForget')}
            </button>
          )}
          <button
            className="ghost danger"
            onClick={async () => {
              if (!confirm(t('logoutConfirm'))) return
              await invoke('logout')
              onChange()
            }}
          >
            {t('logout')}
          </button>
        </div>
      </div>
    </div>
  )
}

interface RetroArch {
  cfg: string
  kind: string
  saves_dir: string | null
  states_dir: string | null
  saves_layout: string
  states_layout: string
}

const layoutText = (l: string) => t(`layout_${l}` as Key)

/** Making this PC a device: the RetroArch it found and the folder for list games */
function PcSetup({ onDone }: { onDone: () => void }) {
  const [found, setFound] = useState<RetroArch[] | null>(null)
  const [pick, setPick] = useState(0)
  const [name, setName] = useState('')
  const [roms, setRoms] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    void invoke<{ found: RetroArch[]; roms_default: string; hostname: string }>('retroarch_detect').then((d) => {
      setFound(d.found)
      setName(d.hostname)
      setRoms(d.roms_default)
    })
  }, [])
  const chooseCfg = async () => {
    const path = await open({ filters: [{ name: 'retroarch.cfg', extensions: ['cfg'] }] })
    if (typeof path !== 'string') return
    try {
      const ra = await invoke<RetroArch>('retroarch_read', { cfg: path })
      const list = [...(found ?? []).filter((f) => f.cfg !== ra.cfg), ra]
      setFound(list)
      setPick(list.length - 1)
    } catch (e) {
      setError(String(e))
    }
  }
  const chooseRoms = async () => {
    const path = await open({ directory: true, defaultPath: roms || undefined })
    if (typeof path === 'string') setRoms(path)
  }
  const ra = found?.[pick]
  const setup = async () => {
    if (!ra) return
    setBusy(true)
    setError('')
    try {
      await invoke('pc_setup', {
        name: name.trim(),
        savesDir: ra.saves_dir,
        statesDir: ra.states_dir,
        savesLayout: ra.saves_layout,
        statesLayout: ra.states_layout,
        romsDir: roms,
        cfg: ra.cfg,
      })
      onDone()
    } catch (e) {
      setError(String(e) === 'different drives' ? t('pcDrives') : String(e))
    } finally {
      setBusy(false)
    }
  }
  if (!found) return <p className="muted">…</p>
  const where = (dir: string | null, layout: string) => (dir ? `${dir} · ${layoutText(layout)}` : layoutText('rom'))
  return (
    <div className="cardview">
      <h1>{t('thisPc')}</h1>
      <p className="muted small">{t('pcSetupHelp')}</p>
      <div className="panel">
        <h2>{t('pcFound')}</h2>
        {!found.length && <p className="muted small">{t('pcNotFound')}</p>}
        {found.map((f, i) => (
          <label key={f.cfg} className="check top">
            <input type="radio" name="ra" checked={i === pick} onChange={() => setPick(i)} />
            <span>
              <span className="mono">{f.cfg}</span>
              {f.kind && <span className="muted small"> · {t(`pcKind_${f.kind}` as Key) || f.kind}</span>}
              <span className="muted small block">
                {t('pcSaves')}: {where(f.saves_dir, f.saves_layout)}
              </span>
              <span className="muted small block">
                {t('pcStates')}: {where(f.states_dir, f.states_layout)}
              </span>
            </span>
          </label>
        ))}
        <button className="ghost" onClick={() => void chooseCfg()}>
          {t('pcPickCfg')}
        </button>
      </div>
      <div className="panel">
        <label>
          {t('pcName')}
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          {t('pcRoms')}
          <div className="row">
            <input className="grow" value={roms} onChange={(e) => setRoms(e.target.value)} />
            <button onClick={() => void chooseRoms()}>{t('choose')}</button>
          </div>
          <span className="muted small">{t('pcRomsHelp')}</span>
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy || !ra || !name.trim() || !roms.trim()} onClick={() => void setup()}>
          {t('pcSetupButton')}
        </button>
      </div>
    </div>
  )
}

type View = 'home' | 'conflicts' | 'lists' | 'games' | 'add' | 'status'

/**
 * The home screen of a device, the same for this PC and for a card: header, state line, live work, then
 * Sync now, Conflicts (only when there are), Lists, Games, Add games and Status
 */
function DeviceHome({
  syncKey,
  title,
  subtitle,
  deviceId,
  conflicts,
  offlineSince,
  progress,
  result,
  syncing,
  pc,
  card,
  version,
  status,
  children,
}: {
  syncKey: string
  title: string
  subtitle: string
  deviceId: number | null
  conflicts: number
  offlineSince: number | null
  progress?: Progress
  result?: Finished
  syncing: boolean
  pc?: PcInfo
  card?: Card
  version: string
  status: Status
  children?: React.ReactNode
}) {
  const [view, setView] = useState<View>('home')
  const [error, setError] = useState('')
  const sync = (mode = 'full', roms?: boolean) => void invoke('sync_device', { key: syncKey, mode, roms: roms ?? null }).catch((e) => setError(String(e)))
  useEffect(() => {
    if (view === 'conflicts' && conflicts === 0) setView('home')
  }, [view, conflicts])
  const live =
    progress?.phase === 'roms-download' ? t('liveGames', { done: progress.done, total: progress.total }) : progress?.phase === 'pulls' ? t('liveSending', { done: progress.done, total: progress.total }) : ''
  const tabs: [View, string][] = [
    ['home', t('tabHome')],
    ...(conflicts > 0 ? [['conflicts', t('conflictsBtn', { n: conflicts })] as [View, string]] : []),
    ['lists', t('tabLists')],
    ['games', t('tabGames')],
    ['add', t('tabAdd')],
    ['status', t('tabStatus')],
  ]
  return (
    <div className="cardview">
      <div className="row">
        <div className="grow">
          <h1>{title}</h1>
          <p className="muted small">{subtitle}</p>
          {stateLines(conflicts, offlineSince, result).map((l) => (
            <p key={l.text} className={l.warn ? 'warn state' : 'state'}>
              {l.text}
            </p>
          ))}
          {live && <p className="accent small">{live}</p>}
        </div>
        {syncing ? (
          <button onClick={() => void invoke('cancel_sync', { root: syncKey })}>{t('cancel')}</button>
        ) : (
          <button className="primary" onClick={() => sync()}>
            {t('syncNow')}
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {deviceId && (
        <nav className="tabs">
          {tabs.map(([k, label]) => (
            <button key={k} className={(view === k ? 'active ' : '') + (k === 'conflicts' ? 'warn' : '')} onClick={() => setView(k)}>
              {label}
            </button>
          ))}
        </nav>
      )}
      {view === 'home' && (
        <>
          {syncing && <ProgressBox p={progress} />}
          {result && <LastSync result={result} onDetails={() => setView('status')} />}
          {deviceId && <Summary deviceId={deviceId} onSend={() => sync('pulls')} refreshKey={result} />}
          {children}
        </>
      )}
      {view === 'conflicts' && <Conflicts syncKey={syncKey} isPc={!!pc} />}
      {view === 'lists' && deviceId && <Lists deviceId={deviceId} name={title} onCopy={() => sync('full', true)} />}
      {view === 'games' && deviceId && <Games deviceId={deviceId} refreshKey={result} onSend={() => sync('pulls')} />}
      {view === 'add' && deviceId && <AddGames deviceId={deviceId} onAdded={() => sync('full', true)} />}
      {view === 'status' && <StatusView syncKey={syncKey} deviceId={deviceId} name={title} result={result} pc={pc} card={card} version={version} status={status} />}
    </div>
  )
}

/** The result of the last sync: one fact per line, or "All up to date" */
function LastSync({ result, onDetails }: { result: Finished; onDetails: () => void }) {
  const lines = summaryLines(result.outcome)
  const errors = result.outcome.errors + result.outcome.games_failed
  return (
    <div className="panel">
      <div className="row">
        <h2 className="grow">{t('lastSync')}</h2>
        {result.at > 0 && <span className="muted small">{when(result.at)}</span>}
      </div>
      {result.cancelled ? (
        <p className="muted">{t('syncCancelled')}</p>
      ) : (
        !result.ok && (
          <p className="error">
            {t('syncFailed', { msg: result.message })}{' '}
            <button className="link" onClick={onDetails}>
              {t('seeDetails')}
            </button>
          </p>
        )
      )}
      {lines.map((l) => (
        <p key={l} className={l.startsWith('⚠') ? 'warn fact' : 'fact'}>
          {l}
        </p>
      ))}
      {errors > 0 && (
        <p className="warn fact">
          {tn('sum_errors', errors)}{' '}
          <button className="link" onClick={onDetails}>
            {t('seeDetails')}
          </button>
        </p>
      )}
      {result.ok && !lines.length && !errors && <p className="ok fact">{t('allUpToDate')}</p>}
    </div>
  )
}

/** Saves that changed here and on the server: keep one version or the other */
function Conflicts({ syncKey, isPc }: { syncKey: string; isPc: boolean }) {
  const [rows, setRows] = useState<Conflict[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = useCallback(() => void invoke<Conflict[]>('conflicts', { key: syncKey }).then(setRows, (e) => setError(String(e))), [syncKey])
  useEffect(load, [load])
  const date = (iso: string) => (iso && iso !== '-' ? when(new Date(iso).getTime()) : '—')
  const keep = async (id: number, which: 'device' | 'server') => {
    setBusy(true)
    setError('')
    try {
      await invoke('resolve_conflict', { key: syncKey, id, keep: which })
      load()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  if (!rows) return error ? <p className="error">{error}</p> : <p className="muted">…</p>
  return (
    <div className="panel">
      <h2>{t('conflictsTitle')}</h2>
      <p className="muted small">{t('conflictsHelp')}</p>
      {error && <p className="error">{error}</p>}
      {!rows.length && <p className="muted">{t('conflictNone')}</p>}
      {rows.map((c) => (
        <div key={c.id} className="conflict">
          <strong>{c.game}</strong> <span className="muted small">· {t(c.kind === 'STATE' ? 'kindState' : 'kindSave')}</span>
          <p className="muted small">
            {t('conflictHere', { date: date(c.device_date) })}
            <br />
            {t('conflictServer', { date: date(c.server_date), device: c.server_device === '-' ? '—' : c.server_device })}
          </p>
          <div className="row wrap">
            <button disabled={busy} onClick={() => void keep(c.id, 'device')}>
              {t(isPc ? 'keepPc' : 'keepCard')}
            </button>
            <button disabled={busy} onClick={() => void keep(c.id, 'server')}>
              {t('keepServer')}
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

/** Version, account, server, the device's folders, the last result and the last log lines */
function StatusView({
  syncKey,
  deviceId,
  name,
  result,
  pc,
  card,
  version,
  status,
}: {
  syncKey: string
  deviceId: number | null
  name: string
  result?: Finished
  pc?: PcInfo
  card?: Card
  version: string
  status: Status
}) {
  const [log, setLog] = useState<[number, string][]>([])
  useEffect(() => void invoke<[number, string][]>('log_lines', { key: syncKey }).then(setLog), [syncKey, result])
  const row = (label: string, value: string) => (
    <p className="small">
      <span className="muted">{label}: </span>
      <span className="mono">{value}</span>
    </p>
  )
  return (
    <>
      <div className="panel">
        {row(t('statusVersion'), version)}
        {row(t('account'), t('accountLine', { user: status.username ?? '', server: status.server.replace(/^https?:\/\//, '') }))}
        {row(t('statusDevice'), deviceId ? `${name} (#${deviceId})` : name)}
        {pc && (
          <>
            {row(t('pcSaves'), `${pc.saves_dir} · ${layoutText(pc.saves_layout)}`)}
            {row(t('pcStates'), `${pc.states_dir} · ${layoutText(pc.states_layout)}`)}
            {row(t('pcGames'), pc.roms_dir)}
            {pc.cfg && row(t('pcConfig'), pc.cfg)}
          </>
        )}
        {card && row(t(card.removable ? 'sdCard' : 'folder'), card.root)}
      </div>
      {result && <LastSync result={result} onDetails={() => {}} />}
      <div className="panel">
        <h2>{t('statusLog')}</h2>
        {!log.length ? (
          <p className="muted small">{t('statusLogEmpty')}</p>
        ) : (
          <pre className="log">{log.map(([at, line]) => `${new Date(at).toLocaleTimeString(locale())}  ${line}`).join('\n')}</pre>
        )}
      </div>
    </>
  )
}

function CardView({
  card,
  progress,
  result,
  syncing,
  onChange,
  version,
  status,
}: {
  card: Card
  progress?: Progress
  result?: Finished
  syncing: boolean
  onChange: () => void
  version: string
  status: Status
}) {
  const [deviceId, setDeviceId] = useState<number | null>(card.link?.device_id ?? null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (card.link && !deviceId) invoke<number>('device_id', { root: card.root }).then(setDeviceId, (e) => setError(String(e)))
  }, [card.link, card.root, deviceId])
  const subtitle = [t(card.removable ? 'sdCard' : 'folder'), card.root, card.total_bytes > 0 ? t('free', { free: bytes(card.free_bytes), total: bytes(card.total_bytes) }) : ''].filter(Boolean).join(' · ')
  const removeFolder = !card.removable && (
    <button
      className="ghost"
      onClick={async () => {
        await invoke('remove_folder', { path: card.root })
        onChange()
      }}
    >
      {t('removeFolder')}
    </button>
  )
  if (!card.link)
    return (
      <div className="cardview">
        <h1>{card.label}</h1>
        <p className="muted small">{subtitle}</p>
        <LinkForm card={card} onLinked={onChange} />
        {removeFolder}
      </div>
    )
  return (
    <>
      {error && <p className="error">{error}</p>}
      <DeviceHome
        syncKey={card.root}
        title={card.label}
        subtitle={subtitle}
        deviceId={deviceId}
        conflicts={result?.outcome.conflicts ?? 0}
        offlineSince={null}
        progress={progress}
        result={result}
        syncing={syncing}
        card={card}
        version={version}
        status={status}
      >
        <div className="row wrap">
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
          {removeFolder}
        </div>
      </DeviceHome>
    </>
  )
}

/** Numbered steps (so the bar never seems to go back), what happens now, the bar, and the current file */
function ProgressBox({ p }: { p?: Progress }) {
  const doing = p ? t(`p_${p.phase}` as Key) || p.phase : t('syncing')
  const share = p && p.total ? ((p.phase === 'roms-download' && p.file_total ? p.done - 1 + p.file_done / p.file_total : p.done) / p.total) * 100 : 0
  const fileShare = p?.file_total ? Math.min(100, Math.round((p.file_done / p.file_total) * 100)) : null
  return (
    <div className="progress panel">
      {p && p.steps > 0 && (
        <p className="step">
          {t('stepOf', { n: p.step, m: p.steps })} · {t(`step_${p.step_name}` as Key)}
        </p>
      )}
      <div className="row small">
        <span>
          {doing}
          {p && p.total > 0 && ` ${p.done}/${p.total}`}
        </span>
        {p && p.total > 0 && <span className="muted">{Math.round(Math.min(100, share))} %</span>}
      </div>
      <div className="bar">
        <div style={{ width: `${Math.max(2, Math.min(100, share))}%` }} className={p && p.total ? '' : 'indeterminate'} />
      </div>
      {p?.file && (
        <p className="muted small file">
          {p.file}
          {p.file_total > 0 && ` · ${p.file_done ? `${bytes(p.file_done)} / ` : ''}${bytes(p.file_total)}${p.file_done && fileShare !== null ? ` (${fileShare} %)` : ''}`}
        </p>
      )}
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
async function notifyFinished(f: Finished, name: string) {
  if (!f.ok || document.hasFocus()) return
  const o = f.outcome
  const saves = o.saves_down + o.states_down
  const parts = [saves === 1 ? t('notifySave') : saves > 1 ? t('notifySaves', { n: saves }) : '', o.games_down > 0 ? t('notifyRoms', { n: o.games_down }) : ''].filter(Boolean)
  if (!parts.length) return
  let granted = await isPermissionGranted()
  if (!granted) granted = (await requestPermission()) === 'granted'
  if (!granted) return
  sendNotification({ title: t('notifyTitle', { card: name }), body: parts.join(' · ') })
}
