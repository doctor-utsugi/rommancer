//! Rommancer companion: this PC as a device of its own (its RetroArch saves and states, synced in the
//! background like a console), plus the SD cards and folders of other consoles, synced when they appear.

mod api;
mod card;
mod folder;
mod game;
mod hook;
mod launchbox;
mod pc;
mod prune;
mod sync;
mod wifi;

use api::{DeviceApi, RootHeader, UserApi};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
struct Settings {
    server: String,
    username: Option<String>,
    refresh_token: Option<String>,
    /// Sync linked cards as soon as they are inserted
    auto_sync: bool,
    /// Copy the games of a device's lists on every full sync
    auto_roms: bool,
    /// The server may ask this PC and the cards synced here for games it lacks
    allow_pull: bool,
    folders: Vec<String>,
    /// This PC as a device, once set up
    pc: Option<pc::PcLink>,
    /// Before a LaunchBox game starts: its saves synced, and its conflicts asked about
    game_sync: bool,
    game_ask: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self { server: "https://".into(), username: None, refresh_token: None, auto_sync: true, auto_roms: true, allow_pull: true, folders: vec![], pc: None, game_sync: true, game_ask: true }
    }
}

const LOG_LINES: usize = 300;

struct AppState {
    settings: Mutex<Settings>,
    user: Mutex<Option<Arc<UserApi>>>,
    /// Devices being synced (a card's root, or "pc"), with their cancel flag
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Roots present at the last look, to notice insertions
    present: Mutex<HashSet<String>>,
    /// Recent log lines per device, with their time (ms)
    logs: Mutex<HashMap<String, VecDeque<(u64, String)>>>,
    /// The last sync of each device, kept across restarts
    last: Mutex<HashMap<String, Finished>>,
    pc_conflicts: Mutex<u32>,
    pc_offline: Mutex<Option<u64>>,
    launchbox: Mutex<launchbox::Cache>,
    /// The LaunchBox game being played since then: no sync writes its saves meanwhile
    playing: Mutex<Option<(String, Instant)>>,
    /// Where the conflict screen before a game sends its answers
    answer: Mutex<Option<std::sync::mpsc::Sender<Vec<(u64, String)>>>>,
}

/// A game stays "playing" this long at most when LaunchBox never says it ended
const PLAYING_MAX: Duration = Duration::from_secs(6 * 3600);

fn playing(state: &AppState) -> bool {
    let mut p = state.playing.lock().unwrap();
    if p.as_ref().is_some_and(|(_, at)| at.elapsed() >= PLAYING_MAX) {
        *p = None;
    }
    p.is_some()
}

/// What LaunchBox's plugin tells: a game about to start (answered once its saves are ready) or one that ended
fn game_hook(app: &AppHandle, req: hook::Request) -> String {
    let state = app.state::<AppState>();
    let rom = pc::wire(Path::new(req.body.trim()));
    let log = |line: String| push_log(app, pc::KEY, line);
    match req.path.as_str() {
        "/game-start" => {
            log(format!("game-start: {rom}"));
            *state.playing.lock().unwrap() = Some((rom.clone(), Instant::now()));
            let (link, on, ask_on) = {
                let s = state.settings.lock().unwrap();
                (s.pc.clone(), s.game_sync, s.game_ask)
            };
            let Some(link) = link.filter(|_| on && state.user.lock().unwrap().is_some()) else { return "ok".into() };
            if state.pc_offline.lock().unwrap().is_some() {
                log("game-start: offline, playing the local save".into());
                return "ok".into();
            }
            // A sync under way ends first; none starts while this one works
            let since = Instant::now();
            loop {
                {
                    let mut running = state.running.lock().unwrap();
                    if !running.contains_key(pc::KEY) || since.elapsed() >= Duration::from_secs(60) {
                        running.insert(pc::KEY.into(), Arc::new(AtomicBool::new(false)));
                        break;
                    }
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            let game = Path::new(&rom).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let ask = |c: &[sync::Conflict]| -> Vec<(u64, String)> {
                if !ask_on {
                    return vec![];
                }
                let (tx, rx) = std::sync::mpsc::channel();
                *state.answer.lock().unwrap() = Some(tx);
                let _ = app.emit("game-conflicts", serde_json::json!({ "game": game, "conflicts": c }));
                show(app);
                let got = rx.recv_timeout(Duration::from_secs(180)).unwrap_or_default();
                *state.answer.lock().unwrap() = None;
                let _ = app.emit("game-conflicts-done", ());
                got
            };
            if let Err(e) = game::start(&Target::Pc(link).api(), &rom, &ask, &log) {
                log(format!("game-start: {e:#}"));
            }
            state.running.lock().unwrap().remove(pc::KEY);
            "ok".into()
        }
        "/game-end" => {
            log(format!("game-end: {rom}"));
            *state.playing.lock().unwrap() = None;
            if state.settings.lock().unwrap().pc.is_some() {
                let _ = start_sync(app, &state, pc::KEY.into(), Mode::Saves, None);
            }
            "ok".into()
        }
        _ => "unknown".into(),
    }
}

/// The answers of the conflict screen shown before a game: the kept side of each conflict answered
#[tauri::command]
fn game_answer(state: State<AppState>, answers: Vec<(u64, String)>) {
    let answers = answers.into_iter().filter(|(_, k)| k == "device" || k == "server").collect();
    if let Some(tx) = state.answer.lock().unwrap().take() {
        let _ = tx.send(answers);
    }
}

/// LaunchBox's library on this PC (the folder the user picked, else the one found)
fn library(state: &AppState) -> Option<Arc<launchbox::Library>> {
    let chosen = state.settings.lock().unwrap().pc.as_ref().and_then(|p| p.launchbox.clone());
    state.launchbox.lock().unwrap().get(chosen.as_deref())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn push_log(app: &AppHandle, key: &str, line: String) {
    let state = app.state::<AppState>();
    let mut logs = state.logs.lock().unwrap();
    let q = logs.entry(key.to_string()).or_default();
    q.push_back((now_ms(), line));
    while q.len() > LOG_LINES {
        q.pop_front();
    }
}

fn last_path(app: &AppHandle) -> PathBuf {
    data_dir(app).join("last-syncs.json")
}

fn settings_path(app: &AppHandle) -> PathBuf {
    app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from(".")).join("settings.json")
}

fn data_dir(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn save_settings(app: &AppHandle, s: &Settings) {
    let p = settings_path(app);
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let _ = std::fs::write(p, serde_json::to_string_pretty(s).unwrap_or_default());
}

/// The refresh token rotates on every renewal: keep the newest one on disk
fn persist_session(app: &AppHandle, state: &AppState) {
    let refresh = state.user.lock().unwrap().as_ref().and_then(|u| u.refresh.lock().unwrap().clone());
    let mut s = state.settings.lock().unwrap();
    if s.refresh_token != refresh {
        s.refresh_token = refresh;
        save_settings(app, &s);
    }
}

fn user(state: &AppState) -> Result<Arc<UserApi>, String> {
    state.user.lock().unwrap().clone().ok_or_else(|| "not signed in".to_string())
}

#[derive(Serialize)]
struct PcInfo {
    name: String,
    device_id: u64,
    root: String,
    saves_dir: String,
    states_dir: String,
    roms_dir: String,
    saves_layout: String,
    states_layout: String,
    cfg: Option<String>,
}

#[derive(Serialize)]
struct Status {
    server: String,
    username: Option<String>,
    signed_in: bool,
    auto_sync: bool,
    auto_roms: bool,
    allow_pull: bool,
    syncing: Vec<String>,
    pc: Option<PcInfo>,
    pc_conflicts: u32,
    /// Milliseconds since the epoch of the first failed contact in a row; none while the server answers
    pc_offline_since: Option<u64>,
    launchbox: Option<launchbox::Summary>,
    game_sync: bool,
    game_ask: bool,
}

#[tauri::command]
fn status(state: State<AppState>) -> Status {
    let launchbox = if state.settings.lock().unwrap().pc.is_some() {
        library(&state).map(|l| launchbox::Summary { restart: state.launchbox.lock().unwrap().needs_restart(&l.dir), ..l.summary() })
    } else {
        None
    };
    let s = state.settings.lock().unwrap();
    Status {
        server: s.server.clone(),
        username: s.username.clone(),
        signed_in: state.user.lock().unwrap().is_some(),
        auto_sync: s.auto_sync,
        auto_roms: s.auto_roms,
        allow_pull: s.allow_pull,
        syncing: state.running.lock().unwrap().keys().cloned().collect(),
        pc: s.pc.as_ref().map(|p| PcInfo {
            name: p.name.clone(),
            device_id: p.device_id,
            root: p.root.clone(),
            saves_dir: p.saves_dir.clone(),
            states_dir: p.states_dir.clone(),
            roms_dir: p.roms_dir.clone(),
            saves_layout: p.saves_layout.clone(),
            states_layout: p.states_layout.clone(),
            cfg: p.cfg.clone(),
        }),
        pc_conflicts: *state.pc_conflicts.lock().unwrap(),
        pc_offline_since: *state.pc_offline.lock().unwrap(),
        launchbox,
        game_sync: s.game_sync,
        game_ask: s.game_ask,
    }
}

/// LaunchBox's folder, picked by the user (none: found by itself again)
#[tauri::command]
fn launchbox_set(app: AppHandle, state: State<AppState>, dir: Option<String>) -> Result<(), String> {
    if let Some(d) = &dir {
        if !launchbox::is_launchbox(Path::new(d)) {
            return Err("no LaunchBox there (Data\\Emulators.xml is missing)".into());
        }
    }
    {
        let mut s = state.settings.lock().unwrap();
        let Some(pc) = s.pc.as_mut() else { return Err("this PC is not set up".into()) };
        pc.launchbox = dir;
        save_settings(&app, &s);
    }
    let _ = app.emit("pc-state", ());
    let _ = start_sync(&app, &state, pc::KEY.into(), Mode::Full, None);
    Ok(())
}

#[tauri::command]
async fn login(app: AppHandle, state: State<'_, AppState>, server: String, username: String, password: String, email: Option<String>) -> Result<Value, String> {
    let server = server.trim().trim_end_matches('/').to_string();
    let api = Arc::new(UserApi::new(&server, None));
    let a = api.clone();
    let who = tauri::async_runtime::spawn_blocking(move || match email.filter(|e| !e.is_empty()) {
        Some(e) => a.signup(&username, &e, &password),
        None => a.login(&username, &password),
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    {
        let mut s = state.settings.lock().unwrap();
        s.server = server;
        s.username = who.get("username").and_then(|v| v.as_str()).map(str::to_string);
    }
    *state.user.lock().unwrap() = Some(api);
    persist_session(&app, &state);
    Ok(who)
}

#[tauri::command]
async fn logout(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(u) = state.user.lock().unwrap().take() {
        tauri::async_runtime::spawn_blocking(move || u.logout());
    }
    let mut s = state.settings.lock().unwrap();
    s.refresh_token = None;
    save_settings(&app, &s);
    Ok(())
}

/// Any call of the web API as the signed-in user (lists, collection, a card's inventory...)
#[tauri::command]
async fn api(app: AppHandle, state: State<'_, AppState>, method: String, path: String, body: Option<Value>) -> Result<Value, String> {
    let u = user(&state)?;
    let r = tauri::async_runtime::spawn_blocking(move || u.call(&method, &path, body.as_ref())).await.map_err(|e| e.to_string())?;
    persist_session(&app, &state);
    r.map_err(|e| e.to_string())
}

#[tauri::command]
fn cards(state: State<AppState>) -> Vec<card::Card> {
    let folders = state.settings.lock().unwrap().folders.clone();
    card::list(&folders)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn set_options(app: AppHandle, state: State<AppState>, auto_sync: Option<bool>, auto_roms: Option<bool>, allow_pull: Option<bool>, game_sync: Option<bool>, game_ask: Option<bool>) {
    let mut s = state.settings.lock().unwrap();
    if let Some(v) = game_sync {
        s.game_sync = v;
    }
    if let Some(v) = game_ask {
        s.game_ask = v;
    }
    if let Some(v) = auto_sync {
        s.auto_sync = v;
    }
    if let Some(v) = auto_roms {
        s.auto_roms = v;
    }
    if let Some(v) = allow_pull {
        s.allow_pull = v;
    }
    save_settings(&app, &s);
}

#[tauri::command]
fn add_folder(app: AppHandle, state: State<AppState>, path: String) {
    let mut s = state.settings.lock().unwrap();
    if !s.folders.contains(&path) {
        s.folders.push(path);
        save_settings(&app, &s);
    }
}

#[tauri::command]
fn remove_folder(app: AppHandle, state: State<AppState>, path: String) {
    let mut s = state.settings.lock().unwrap();
    s.folders.retain(|f| card::server_root(Path::new(f)) != path && *f != path);
    save_settings(&app, &s);
}

/// Links a card as a device of the signed-in user; the link is written on the card itself
#[tauri::command]
async fn link_card(app: AppHandle, state: State<'_, AppState>, root: String, name: String, console_id: u64, firmware_id: u64, firmware: String, overrides: Option<String>) -> Result<u64, String> {
    let u = user(&state)?;
    let username = state.settings.lock().unwrap().username.clone().unwrap_or_default();
    // offline: a device known only when its card is connected to a computer
    let mut body = serde_json::json!({ "name": name, "firmware": firmware, "root": root, "model": name, "consoleId": console_id, "firmwareId": firmware_id, "offline": true });
    // A layout the user defined: folders and systems on top of a generic firmware
    if let Some(o) = overrides.filter(|o| !o.is_empty()) {
        body["overrides"] = Value::String(o);
    }
    let r = {
        let u = u.clone();
        tauri::async_runtime::spawn_blocking(move || u.call("POST", "/link/claim", Some(&body))).await.map_err(|e| e.to_string())?
    }
    .map_err(|e| e.to_string())?;
    persist_session(&app, &state);
    let token = r.get("token").and_then(|v| v.as_str()).ok_or("no token")?;
    let id = r.get("deviceId").and_then(|v| v.as_u64()).ok_or("no device id")?;
    card::write_own_link(Path::new(&root), &u.server, token, &username, id, false).map_err(|e| format!("cannot write on the card: {e}"))?;
    let _ = app.emit("cards-changed", ());
    Ok(id)
}

/// Links a card as one more key of a device the user already has (the SD card of that console)
#[tauri::command]
async fn attach_card(app: AppHandle, state: State<'_, AppState>, root: String, device_id: u64, label: String) -> Result<u64, String> {
    let u = user(&state)?;
    let username = state.settings.lock().unwrap().username.clone().unwrap_or_default();
    let body = serde_json::json!({ "label": label });
    let path = format!("/devices/{device_id}/card-token");
    let r = {
        let u = u.clone();
        tauri::async_runtime::spawn_blocking(move || u.call("POST", &path, Some(&body))).await.map_err(|e| e.to_string())?
    }
    .map_err(|e| e.to_string())?;
    persist_session(&app, &state);
    let token = r.get("token").and_then(|v| v.as_str()).ok_or("no token")?;
    card::write_own_link(Path::new(&root), &u.server, token, &username, device_id, true).map_err(|e| format!("cannot write on the card: {e}"))?;
    let _ = app.emit("cards-changed", ());
    Ok(device_id)
}

/// The WiFi networks this computer knows, to hand them to the consoles; nothing leaves the app until the user picks them
#[tauri::command]
async fn local_wifi() -> Result<Vec<wifi::LocalWifi>, String> {
    tauri::async_runtime::spawn_blocking(wifi::known_networks).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn unlink_card(app: AppHandle, root: String) -> Result<(), String> {
    card::remove_own_link(Path::new(&root)).map_err(|e| e.to_string())?;
    let _ = app.emit("cards-changed", ());
    Ok(())
}

/// The server's id of a linked card (cards linked by the shell client or a console only keep the token)
#[tauri::command]
async fn device_id(root: String) -> Result<u64, String> {
    let link = card::read_link(Path::new(&root)).ok_or("card not linked")?;
    if let Some(id) = link.device_id {
        return Ok(id);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let api = device_api(&root, &link);
        let who = api::pairs(&api.get_text("/agent/whoami").map_err(|e| e.to_string())?);
        who.iter().find(|r| r.len() >= 2 && r[0] == "id").and_then(|r| r[1].parse().ok()).ok_or_else(|| "unknown device".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn device_api(root: &str, link: &card::Link) -> DeviceApi {
    let header = if link.console { RootHeader::Temporary(root.to_string()) } else { RootHeader::Moves(root.to_string()) };
    DeviceApi::new(&link.server, &link.token, header)
}

#[derive(Serialize, Deserialize, Clone)]
struct Finished {
    /// The card's root, or "pc"
    root: String,
    ok: bool,
    #[serde(default)]
    cancelled: bool,
    message: String,
    outcome: sync::Outcome,
    /// When it ended (ms)
    #[serde(default)]
    at: u64,
    /// full, saves or pulls
    #[serde(default)]
    mode: String,
    /// When this device last synced without errors (ms; 0: never)
    #[serde(default)]
    ok_at: u64,
}

/// A device that syncs from here: a card (or folder) linked on itself, or this PC
#[derive(Clone)]
enum Target {
    Card { root: String, link: card::Link },
    Pc(pc::PcLink),
}

impl Target {
    fn key(&self) -> String {
        match self {
            Target::Card { root, .. } => root.clone(),
            Target::Pc(_) => pc::KEY.into(),
        }
    }
    fn root(&self) -> String {
        match self {
            Target::Card { root, .. } => root.clone(),
            Target::Pc(p) => p.root.clone(),
        }
    }
    fn token(&self) -> &str {
        match self {
            Target::Card { link, .. } => &link.token,
            Target::Pc(p) => &p.token,
        }
    }
    fn api(&self) -> DeviceApi {
        match self {
            Target::Card { root, link } => device_api(root, link),
            Target::Pc(p) => DeviceApi::new(&p.server, &p.token, RootHeader::Moves(p.root.clone())),
        }
    }
    /// Where the deletion of games in no list keeps its state: this PC's in the app's data, a card's on the card
    /// (as the shell client does in sd mode). None for the card of a console, whose own client owns the setting
    fn prune_store(&self, app: &AppHandle) -> Option<prune::PruneStore> {
        match self {
            Target::Pc(p) => Some(prune::PruneStore::new(data_dir(app).join(format!("pc-{}", p.device_id)))),
            Target::Card { link, .. } if link.console => None,
            Target::Card { root, .. } => Some(prune::PruneStore::new(Path::new(root).join(".rommancer"))),
        }
    }
    /// The roms folder this device knows for itself
    fn roms_dir(&self) -> Option<String> {
        match self {
            Target::Pc(p) => Some(p.roms_dir.clone()),
            Target::Card { .. } => None,
        }
    }
}

fn target(state: &AppState, key: &str) -> Result<Target, String> {
    if key == pc::KEY {
        return state.settings.lock().unwrap().pc.clone().map(Target::Pc).ok_or_else(|| "this PC is not set up".to_string());
    }
    let link = card::read_link(Path::new(key)).ok_or("card not linked")?;
    Ok(Target::Card { root: key.to_string(), link })
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Mode {
    /// Everything: saves, settings (cards), games in no list, games the server asked for, list games
    Full,
    /// Saves and states only (a save written here, or one waiting on the server)
    Saves,
    /// Only the games the server asked for
    Pulls,
    /// Only the deletion of games in no list (a held one the user confirmed)
    Prune,
    /// Saves, then the saves of the games deleted for being in no list
    Clean,
}

impl Mode {
    fn parse(s: &str) -> Mode {
        match s {
            "saves" => Mode::Saves,
            "pulls" => Mode::Pulls,
            "prune" => Mode::Prune,
            "clean" => Mode::Clean,
            _ => Mode::Full,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Mode::Full => "full",
            Mode::Saves => "saves",
            Mode::Pulls => "pulls",
            Mode::Prune => "prune",
            Mode::Clean => "clean",
        }
    }
}

/// No answer from the server (as opposed to an answer that says no)
fn unreachable(e: &anyhow::Error) -> bool {
    e.chain().any(|c| c.downcast_ref::<reqwest::Error>().is_some_and(|r| r.is_connect() || r.is_timeout() || r.is_request()))
}

fn set_offline(app: &AppHandle, offline: bool) {
    let state = app.state::<AppState>();
    let mut o = state.pc_offline.lock().unwrap();
    let next = if offline { Some(o.unwrap_or_else(now_ms)) } else { None };
    if *o != next {
        *o = next;
        let _ = app.emit("pc-state", ());
    }
}

/// Sync a device: a card (by its root) or this PC ("pc"). MODE: full (default), saves or pulls
#[tauri::command]
fn sync_device(app: AppHandle, state: State<AppState>, key: String, mode: Option<String>, roms: Option<bool>) -> Result<(), String> {
    start_sync(&app, &state, key, Mode::parse(mode.as_deref().unwrap_or("full")), roms)
}

fn start_sync(app: &AppHandle, state: &AppState, key: String, mode: Mode, roms: Option<bool>) -> Result<(), String> {
    let t = target(state, &key)?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut running = state.running.lock().unwrap();
        if running.contains_key(&key) {
            return Ok(());
        }
        running.insert(key.clone(), cancel.clone());
    }
    let (auto_roms, allow_pull) = {
        let s = state.settings.lock().unwrap();
        (s.auto_roms, s.allow_pull)
    };
    let with_roms = mode == Mode::Full && roms.unwrap_or(auto_roms);
    let is_pc = matches!(t, Target::Pc(_));
    let app = app.clone();
    let _ = app.emit("sync-started", &key);
    std::thread::spawn(move || {
        let report = |p: sync::Progress| {
            let _ = app.emit("progress", p);
        };
        let cancelled = || cancel.load(Ordering::Relaxed);
        let log = |line: String| push_log(&app, &key, line);
        log(format!("sync: start ({})", mode.name()));
        let cache = data_dir(&app).join(format!("hashes-{}.tsv", t.token().chars().take(12).collect::<String>()));
        let mut engine = sync::Engine::new(t.api(), key.clone(), t.root(), cache, &report, &cancelled, &log);
        engine.allow_pull = allow_pull;
        engine.prune = t.prune_store(&app);
        engine.roms_dir = t.roms_dir();
        if is_pc {
            engine.library = library(&app.state::<AppState>());
        }
        let pruning = engine.prune.as_ref().is_some_and(|p| p.active());
        engine.steps = match mode {
            Mode::Full => {
                let mut v = vec!["saves"];
                // A computer has no console settings to apply
                if !is_pc {
                    v.push("settings");
                }
                if pruning {
                    v.push("prune");
                }
                v.push("sending");
                if with_roms {
                    v.push("games");
                }
                v
            }
            Mode::Saves | Mode::Clean => vec!["saves"],
            Mode::Pulls => vec!["sending"],
            Mode::Prune => vec!["prune"],
        };
        let mut out = sync::Outcome::default();
        let mut run = || -> anyhow::Result<()> {
            if mode != Mode::Pulls && mode != Mode::Prune {
                engine.sync(&mut out)?;
                out.conflicts = engine.conflicts().map(|c| c.len() as u32).unwrap_or(0);
            }
            if mode == Mode::Clean {
                return engine.prune_clean(&mut out);
            }
            if mode == Mode::Full && !is_pc {
                engine.config(&mut out)?;
            }
            // Games in no list go before the sending step: the ones the server lacks are asked for there
            if mode == Mode::Full || mode == Mode::Prune {
                if let Err(e) = engine.prune(&mut out) {
                    if e.to_string() == "cancelled" {
                        return Err(e);
                    }
                    out.errors += 1;
                    log(format!("error: delete games in no list: {e:#}"));
                }
            }
            if mode == Mode::Prune {
                return Ok(());
            }
            if mode != Mode::Saves {
                engine.pulls(&mut out)?;
            }
            if with_roms {
                engine.roms(&mut out)?;
            }
            Ok(())
        };
        let result = run();
        let was_cancelled = matches!(&result, Err(e) if e.to_string() == "cancelled");
        if is_pc {
            set_offline(&app, matches!(&result, Err(e) if unreachable(e)));
            if mode != Mode::Pulls && mode != Mode::Prune && (result.is_ok() || out.conflicts > 0) {
                *app.state::<AppState>().pc_conflicts.lock().unwrap() = out.conflicts;
            }
        }
        for l in out.sum_lines() {
            log(l);
        }
        match &result {
            Ok(()) => log("sync: done".into()),
            Err(_) if was_cancelled => log("sync: cancelled".into()),
            Err(e) => log(format!("error: {e:#}")),
        }
        let at = now_ms();
        let ok_at = if result.is_ok() { at } else { app.state::<AppState>().last.lock().unwrap().get(&key).map(|f| f.ok_at).unwrap_or(0) };
        let fin = Finished {
            root: key.clone(),
            ok_at,
            ok: result.is_ok(),
            cancelled: was_cancelled,
            message: result.err().map(|e| format!("{e:#}")).unwrap_or_default(),
            outcome: out,
            at,
            mode: mode.name().into(),
        };
        let state = app.state::<AppState>();
        {
            let mut last = state.last.lock().unwrap();
            last.insert(key.clone(), fin.clone());
            let _ = std::fs::write(last_path(&app), serde_json::to_string(&*last).unwrap_or_default());
        }
        state.running.lock().unwrap().remove(&key);
        let _ = app.emit("sync-finished", fin);
    });
    Ok(())
}

#[tauri::command]
fn cancel_sync(state: State<AppState>, root: String) {
    if let Some(c) = state.running.lock().unwrap().get(&root) {
        c.store(true, Ordering::Relaxed);
    }
}

/// The last sync of every device synced here
#[tauri::command]
fn results(state: State<AppState>) -> HashMap<String, Finished> {
    state.last.lock().unwrap().clone()
}

/// Recent log lines of a device: (time in ms, line)
#[tauri::command]
fn log_lines(state: State<AppState>, key: String) -> Vec<(u64, String)> {
    state.logs.lock().unwrap().get(&key).map(|q| q.iter().cloned().collect()).unwrap_or_default()
}

/// Saves of a device that changed both there and on the server
#[tauri::command]
async fn conflicts(state: State<'_, AppState>, key: String) -> Result<Vec<sync::Conflict>, String> {
    let t = target(&state, &key)?;
    tauri::async_runtime::spawn_blocking(move || {
        let never = || false;
        let quiet = |_: sync::Progress| {};
        let silent = |_: String| {};
        let engine = sync::Engine::new(t.api(), t.key(), t.root(), PathBuf::new(), &quiet, &never, &silent);
        engine.conflicts().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Keeps this device's version ("device") or the server's ("server") of a conflicting save, then syncs the saves
/// so the kept version is in place
#[tauri::command]
async fn resolve_conflict(app: AppHandle, state: State<'_, AppState>, key: String, id: u64, keep: String) -> Result<(), String> {
    if keep != "device" && keep != "server" {
        return Err("keep must be device or server".into());
    }
    let t = target(&state, &key)?;
    let path = format!("/agent/conflicts/{id}?keep={keep}");
    tauri::async_runtime::spawn_blocking(move || t.api().post_text(&path, Vec::new(), &[]).map_err(|e| e.to_string())).await.map_err(|e| e.to_string())??;
    push_log(&app, &key, format!("conflict {id}: kept the {keep} version"));
    if key == pc::KEY {
        let mut n = state.pc_conflicts.lock().unwrap();
        *n = n.saturating_sub(1);
    }
    start_sync(&app, &state, key, Mode::Saves, None)
}

/// The deletion of games in no list of a device: none where this app does not own it (a console's card)
#[tauri::command]
fn prune_state(app: AppHandle, state: State<AppState>, key: String) -> Result<Option<prune::PruneInfo>, String> {
    Ok(target(&state, &key)?.prune_store(&app).map(|p| p.info()))
}

/// Turns the deletion of games in no list on or off (a change on screen, or the answer to one made in the web app);
/// the server hears it at a saves sync started at once, or at the sync running now
#[tauri::command]
fn prune_set(app: AppHandle, state: State<AppState>, key: String, on: bool) -> Result<(), String> {
    let store = target(&state, &key)?.prune_store(&app).ok_or("this device's own client keeps this setting")?;
    store.set(on);
    push_log(&app, &key, format!("prune: turned {}", if on { "on" } else { "off" }));
    start_sync(&app, &state, key, Mode::Saves, None)
}

/// The user confirmed a held deletion of more than half of the games: the server is told, then the deletion runs
#[tauri::command]
async fn prune_confirm(app: AppHandle, state: State<'_, AppState>, key: String) -> Result<(), String> {
    let t = target(&state, &key)?;
    let store = t.prune_store(&app).ok_or("this device's own client keeps this setting")?;
    let Some((count, _)) = store.hold() else { return Ok(()) };
    tauri::async_runtime::spawn_blocking(move || t.api().post_text("/agent/prune/confirm", Vec::new(), &[("X-Count", count.to_string())]).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())??;
    store.set_hold(None);
    push_log(&app, &key, format!("prune: {count} roms confirmed"));
    start_sync(&app, &state, key, Mode::Prune, None)
}

/// RetroArch installs found on this computer, the suggested games folder and the computer's name
#[tauri::command]
fn retroarch_detect() -> pc::Detected {
    pc::detect()
}

/// What a retroarch.cfg the user picked says
#[tauri::command]
fn retroarch_read(cfg: String) -> Result<pc::RetroArch, String> {
    let p = PathBuf::from(&cfg);
    if !p.is_file() {
        return Err("not a file".into());
    }
    Ok(pc::parse(&p, ""))
}

/// Makes this PC a device: console "PC" with RetroArch's layout, its saves and states where RetroArch keeps them and
/// the list games in ROMS_DIR. SAVES_DIR / STATES_DIR are none when RetroArch keeps them next to the games
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn pc_setup(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    saves_dir: Option<String>,
    states_dir: Option<String>,
    saves_layout: String,
    states_layout: String,
    roms_dir: String,
    cfg: Option<String>,
) -> Result<u64, String> {
    let u = user(&state)?;
    let clean = |p: &str| pc::wire(Path::new(p.trim()));
    let roms_dir = clean(&roms_dir);
    if roms_dir.is_empty() {
        return Err("pick the games folder".into());
    }
    let saves = saves_dir.as_deref().map(clean).filter(|s| !s.is_empty()).unwrap_or_else(|| roms_dir.clone());
    let states = states_dir.as_deref().map(clean).filter(|s| !s.is_empty()).unwrap_or_else(|| roms_dir.clone());
    let (root, saves_rel, states_rel, roms_rel) = pc::layout_of(&saves, &states, &roms_dir)?;
    std::fs::create_dir_all(&roms_dir).map_err(|e| format!("cannot create {roms_dir}: {e}"))?;
    let overrides = serde_json::json!({ "romsRoot": roms_rel, "savesRoot": saves_rel, "statesRoot": states_rel, "savesLayout": saves_layout, "statesLayout": states_layout });
    let claim = {
        let u = u.clone();
        let name = name.clone();
        let root = root.clone();
        tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<Value> {
            let consoles = u.call("GET", "/devices/consoles", None)?;
            let console_id = match consoles.as_array().and_then(|a| a.iter().find(|c| c.get("name").and_then(|n| n.as_str()).is_some_and(|n| n.eq_ignore_ascii_case("PC")))) {
                Some(c) => c.get("id").and_then(|v| v.as_u64()),
                None => u.call("POST", "/devices/consoles", Some(&serde_json::json!({ "name": "PC", "manufacturer": "PC" })))?.get("id").and_then(|v| v.as_u64()),
            }
            .ok_or_else(|| anyhow::anyhow!("no console PC on the server"))?;
            let firmwares = u.call("GET", "/devices/firmwares", None)?;
            let firmware_id = firmwares
                .as_array()
                .and_then(|a| a.iter().find(|f| f.get("slug").and_then(|s| s.as_str()) == Some("retroarch-desktop")))
                .and_then(|f| f.get("id").and_then(|v| v.as_u64()))
                .ok_or_else(|| anyhow::anyhow!("the server has no RetroArch desktop layout"))?;
            let body = serde_json::json!({
                "name": name, "firmware": "retroarch-desktop", "root": root, "model": "PC",
                "consoleId": console_id, "firmwareId": firmware_id, "offline": false, "overrides": overrides.to_string(),
            });
            u.call("POST", "/link/claim", Some(&body))
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?
    };
    persist_session(&app, &state);
    let token = claim.get("token").and_then(|v| v.as_str()).ok_or("no token")?.to_string();
    let id = claim.get("deviceId").and_then(|v| v.as_u64()).ok_or("no device id")?;
    {
        let mut s = state.settings.lock().unwrap();
        s.pc = Some(pc::PcLink { server: u.server.clone(), token, device_id: id, name, root, saves_dir: saves, states_dir: states, roms_dir, saves_layout, states_layout, cfg, launchbox: None });
        save_settings(&app, &s);
    }
    *state.pc_conflicts.lock().unwrap() = 0;
    *state.pc_offline.lock().unwrap() = None;
    state.last.lock().unwrap().remove(pc::KEY);
    let _ = app.emit("pc-state", ());
    let _ = start_sync(&app, &state, pc::KEY.into(), Mode::Full, None);
    Ok(id)
}

/// Forgets this PC's link here (the device and its saves stay on the server)
#[tauri::command]
fn pc_forget(app: AppHandle, state: State<AppState>) {
    if let Some(c) = state.running.lock().unwrap().get(pc::KEY) {
        c.store(true, Ordering::Relaxed);
    }
    let mut s = state.settings.lock().unwrap();
    s.pc = None;
    save_settings(&app, &s);
    state.last.lock().unwrap().remove(pc::KEY);
    *state.pc_conflicts.lock().unwrap() = 0;
    *state.pc_offline.lock().unwrap() = None;
    let _ = app.emit("pc-state", ());
}

/// The tray's texts and its tooltip (the state line)
#[tauri::command]
fn set_tray(app: AppHandle, tooltip: String, open: String, sync: String, quit: String) -> Result<(), String> {
    let tray = app.tray_by_id("tray").ok_or("no tray")?;
    let items = (
        MenuItem::with_id(&app, "open", open, true, None::<&str>).map_err(|e| e.to_string())?,
        MenuItem::with_id(&app, "sync", sync, true, None::<&str>).map_err(|e| e.to_string())?,
        MenuItem::with_id(&app, "quit", quit, true, None::<&str>).map_err(|e| e.to_string())?,
    );
    let menu = Menu::with_items(&app, &[&items.0, &items.1, &items.2]).map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    tray.set_tooltip(Some(tooltip)).map_err(|e| e.to_string())
}

/// "Sync now" from the tray: this PC and every linked card that is in
fn sync_everything(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (folders, has_pc) = {
        let s = state.settings.lock().unwrap();
        (s.folders.clone(), s.pc.is_some())
    };
    if has_pc {
        let _ = start_sync(app, &state, pc::KEY.into(), Mode::Full, None);
    }
    for c in card::list(&folders).into_iter().filter(|c| c.link.is_some()) {
        let _ = start_sync(app, &state, c.root, Mode::Full, None);
    }
}

/// This PC in the background, like a console: a saves sync 5 s after RetroArch stops writing, the server's requests
/// every 15 s, a full sync every 15 minutes and once at start
fn watch_pc(app: AppHandle) {
    const QUIET: Duration = Duration::from_secs(5);
    const POLL: Duration = Duration::from_secs(15);
    const FULL: Duration = Duration::from_secs(15 * 60);
    const SCAN: Duration = Duration::from_secs(2);
    std::thread::spawn(move || {
        let mut linked: Option<String> = None;
        let mut last_full: Option<Instant> = None;
        let mut last_poll: Option<Instant> = None;
        let mut last_scan: Option<Instant> = None;
        let mut baseline: Option<u64> = None;
        let mut changed_at: Option<Instant> = None;
        let mut was_running = false;
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let state = app.state::<AppState>();
            let Some(link) = state.settings.lock().unwrap().pc.clone() else {
                linked = None;
                continue;
            };
            // A new link (or another device): start over
            if linked.as_deref() != Some(link.token.as_str()) {
                linked = Some(link.token.clone());
                (last_full, last_poll, baseline, changed_at) = (None, None, None, None);
            }
            if state.user.lock().unwrap().is_none() {
                continue;
            }
            let running = state.running.lock().unwrap().contains_key(pc::KEY);
            if last_scan.is_none_or(|t| t.elapsed() >= SCAN) {
                last_scan = Some(Instant::now());
                let mut dirs = link.watched();
                if let Some(lib) = library(&state) {
                    dirs.extend(lib.watched());
                }
                let sig = pc::signature(&dirs);
                if running || was_running || baseline.is_none() {
                    // What a sync writes is not RetroArch saving
                    changed_at = None;
                } else if baseline != Some(sig) {
                    changed_at = Some(Instant::now());
                }
                baseline = Some(sig);
                was_running = running;
            }
            // A LaunchBox game is being played: its saves sync when it ends
            if running || playing(&state) {
                continue;
            }
            if last_full.is_none_or(|t| t.elapsed() >= FULL) {
                last_full = Some(Instant::now());
                changed_at = None;
                let _ = start_sync(&app, &state, pc::KEY.into(), Mode::Full, None);
                continue;
            }
            if changed_at.is_some_and(|t| t.elapsed() >= QUIET) {
                changed_at = None;
                push_log(&app, pc::KEY, "watch: saves changed".into());
                let _ = start_sync(&app, &state, pc::KEY.into(), Mode::Saves, None);
                continue;
            }
            if last_poll.is_none_or(|t| t.elapsed() >= POLL) {
                last_poll = Some(Instant::now());
                let api = Target::Pc(link.clone()).api();
                match api.get_text("/agent/poll") {
                    Ok(text) => {
                        set_offline(&app, false);
                        let lines = api::pairs(&text);
                        let has = |k: &str| lines.iter().any(|l| l[0] == k);
                        let conflicts = lines.iter().find(|l| l[0] == "conflicts" && l.len() >= 2).and_then(|l| l[1].parse().ok()).unwrap_or(0);
                        let changed = {
                            let mut n = state.pc_conflicts.lock().unwrap();
                            std::mem::replace(&mut *n, conflicts) != conflicts
                        };
                        if changed {
                            let _ = app.emit("pc-state", ());
                        }
                        let mode = if has("sync") {
                            last_full = Some(Instant::now());
                            Some(Mode::Full)
                        } else if has("saves") {
                            Some(Mode::Saves)
                        } else if has("pull") {
                            Some(Mode::Pulls)
                        } else {
                            None
                        };
                        if let Some(m) = mode {
                            push_log(&app, pc::KEY, format!("poll: {}", m.name()));
                            let _ = start_sync(&app, &state, pc::KEY.into(), m, None);
                        }
                    }
                    Err(e) => {
                        let offline = unreachable(&e);
                        set_offline(&app, offline);
                        if !offline {
                            push_log(&app, pc::KEY, format!("error: poll: {e}"));
                        }
                    }
                }
            }
        }
    });
}

/// The binary is replaced when the app is updated while it sits in the tray: tell the window so it can restart
fn watch_update(app: AppHandle) {
    let Ok(exe) = std::env::current_exe() else { return };
    let stamp = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    let start = stamp(&exe);
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(30));
        // On Linux a replaced binary leaves the running one as "(deleted)"; elsewhere its date changes
        let replaced = std::fs::read_link("/proc/self/exe").map(|p| p.to_string_lossy().ends_with(" (deleted)")).unwrap_or(false);
        if replaced || stamp(&exe) != start {
            let _ = app.emit("app-updated", ());
            break;
        }
    });
}

#[tauri::command]
fn restart_app(app: AppHandle) {
    app.restart();
}

/// Looks for cards every few seconds; a linked card that appears is synced when auto sync is on
fn watch_cards(app: AppHandle) {
    std::thread::spawn(move || loop {
        let state = app.state::<AppState>();
        let folders = state.settings.lock().unwrap().folders.clone();
        let now = card::list(&folders);
        let roots: HashSet<String> = now.iter().map(|c| c.root.clone()).collect();
        let first = state.present.lock().unwrap().is_empty();
        let new: Vec<_> = now.iter().filter(|c| !state.present.lock().unwrap().contains(&c.root)).cloned().collect();
        let changed = roots != *state.present.lock().unwrap();
        *state.present.lock().unwrap() = roots;
        if changed {
            let _ = app.emit("cards-changed", ());
        }
        // Only cards inserted while the app runs, not the ones present at start
        if !first && state.settings.lock().unwrap().auto_sync {
            for c in new.into_iter().filter(|c| c.link.is_some() && c.removable) {
                let _ = start_sync(&app, &state, c.root, Mode::Full, None);
            }
        }
        std::thread::sleep(Duration::from_secs(3));
    });
}

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show(app)))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let settings: Settings = std::fs::read_to_string(settings_path(&handle)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
            let user = settings.refresh_token.clone().map(|r| Arc::new(UserApi::new(&settings.server, Some(r))));
            let last: HashMap<String, Finished> = std::fs::read_to_string(last_path(&handle)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
            app.manage(AppState {
                settings: Mutex::new(settings),
                user: Mutex::new(user),
                running: Mutex::new(HashMap::new()),
                present: Mutex::new(HashSet::new()),
                logs: Mutex::new(HashMap::new()),
                last: Mutex::new(last),
                pc_conflicts: Mutex::new(0),
                pc_offline: Mutex::new(None),
                launchbox: Mutex::new(launchbox::Cache::default()),
                playing: Mutex::new(None),
                answer: Mutex::new(None),
            });
            {
                let h = handle.clone();
                hook::serve(move |req| game_hook(&h, req));
            }

            let open = MenuItem::with_id(app, "open", "Rommancer", true, None::<&str>)?;
            let sync_all = MenuItem::with_id(app, "sync", "Sync now", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &sync_all, &quit])?;
            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().cloned().expect("icon"))
                .tooltip("Rommancer")
                .menu(&menu)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "open" => show(app),
                    "sync" => sync_everything(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // Started with the system: straight to the tray
            if std::env::args().any(|a| a == "--hidden") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            watch_update(handle.clone());
            watch_pc(handle.clone());
            watch_cards(handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window leaves the app in the tray; "Quit" in the tray menu ends it
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            status,
            launchbox_set,
            game_answer,
            login,
            logout,
            api,
            cards,
            set_options,
            add_folder,
            remove_folder,
            link_card,
            attach_card,
            restart_app,
            unlink_card,
            device_id,
            sync_device,
            cancel_sync,
            results,
            log_lines,
            conflicts,
            resolve_conflict,
            retroarch_detect,
            retroarch_read,
            pc_setup,
            pc_forget,
            prune_state,
            prune_set,
            prune_confirm,
            set_tray,
            local_wifi
        ])
        .run(tauri::generate_context!())
        .expect("error while running Rommancer");
}
