//! Rommancer companion: sits in the tray, notices SD cards (and folders the user added), syncs the linked
//! ones when they appear, and lets the user link cards, assign lists, copy roms and send missing games.

mod api;
mod card;
mod sync;
mod wifi;

use api::{DeviceApi, RootHeader, UserApi};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

#[derive(Serialize, Deserialize, Clone)]
struct Settings {
    server: String,
    username: Option<String>,
    refresh_token: Option<String>,
    /// Sync linked cards as soon as they are inserted
    auto_sync: bool,
    /// Copy the roms of a card's lists on every sync
    auto_roms: bool,
    folders: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self { server: "https://".into(), username: None, refresh_token: None, auto_sync: true, auto_roms: true, folders: vec![] }
    }
}

struct AppState {
    settings: Mutex<Settings>,
    user: Mutex<Option<Arc<UserApi>>>,
    /// Cards being synced, with their cancel flag
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Roots present at the last look, to notice insertions
    present: Mutex<HashSet<String>>,
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
struct Status {
    server: String,
    username: Option<String>,
    signed_in: bool,
    auto_sync: bool,
    auto_roms: bool,
    syncing: Vec<String>,
}

#[tauri::command]
fn status(state: State<AppState>) -> Status {
    let s = state.settings.lock().unwrap();
    Status {
        server: s.server.clone(),
        username: s.username.clone(),
        signed_in: state.user.lock().unwrap().is_some(),
        auto_sync: s.auto_sync,
        auto_roms: s.auto_roms,
        syncing: state.running.lock().unwrap().keys().cloned().collect(),
    }
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
fn set_options(app: AppHandle, state: State<AppState>, auto_sync: Option<bool>, auto_roms: Option<bool>) {
    let mut s = state.settings.lock().unwrap();
    if let Some(v) = auto_sync {
        s.auto_sync = v;
    }
    if let Some(v) = auto_roms {
        s.auto_roms = v;
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

/// Interface language from the system: the first of the locale variables that says one
/// The WiFi networks this computer knows, to hand them to the consoles; nothing leaves the app until the user picks them
#[tauri::command]
async fn local_wifi() -> Result<Vec<wifi::LocalWifi>, String> {
    tauri::async_runtime::spawn_blocking(wifi::known_networks).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn system_lang() -> String {
    ["LANGUAGE", "LC_ALL", "LC_MESSAGES", "LANG", "LC_TIME"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .filter(|v| !v.is_empty())
        .find(|v| v.starts_with("es"))
        .map(|_| "es".to_string())
        .unwrap_or_default()
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

#[derive(Serialize, Clone)]
struct Finished {
    root: String,
    ok: bool,
    message: String,
    outcome: sync::Outcome,
}

/// Sync a card in the background: saves, the roms the server asked for, then the lists' roms (AUTO_ROMS)
#[tauri::command]
fn sync_card(app: AppHandle, state: State<AppState>, root: String, roms: Option<bool>) -> Result<(), String> {
    start_sync(&app, &state, root, roms)
}

fn start_sync(app: &AppHandle, state: &AppState, root: String, roms: Option<bool>) -> Result<(), String> {
    let link = card::read_link(Path::new(&root)).ok_or("card not linked")?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut running = state.running.lock().unwrap();
        if running.contains_key(&root) {
            return Ok(());
        }
        running.insert(root.clone(), cancel.clone());
    }
    let with_roms = roms.unwrap_or(state.settings.lock().unwrap().auto_roms);
    let app = app.clone();
    std::thread::spawn(move || {
        let report = |p: sync::Progress| {
            let _ = app.emit("progress", p);
        };
        let cancelled = || cancel.load(Ordering::Relaxed);
        let cache = data_dir(&app).join(format!("hashes-{}.tsv", link.token.chars().take(12).collect::<String>()));
        let mut engine = sync::Engine::new(device_api(&root, &link), root.clone(), cache, &report, &cancelled);
        let mut out = sync::Outcome::default();
        let result = engine.sync(&mut out).and_then(|_| engine.config(&mut out)).and_then(|_| engine.pulls(&mut out)).and_then(|_| if with_roms { engine.roms(&mut out) } else { Ok(()) });
        let fin = Finished { root: root.clone(), ok: result.is_ok(), message: result.err().map(|e| e.to_string()).unwrap_or_default(), outcome: out };
        app.state::<AppState>().running.lock().unwrap().remove(&root);
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
                let _ = start_sync(&app, &state, c.root, None);
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
            app.manage(AppState { settings: Mutex::new(settings), user: Mutex::new(user), running: Mutex::new(HashMap::new()), present: Mutex::new(HashSet::new()) });

            let open = MenuItem::with_id(app, "open", "Rommancer", true, None::<&str>)?;
            let sync_all = MenuItem::with_id(app, "sync", "Sync cards / Sincronizar tarjetas", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit / Salir", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &sync_all, &quit])?;
            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().cloned().expect("icon"))
                .tooltip("Rommancer")
                .menu(&menu)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "open" => show(app),
                    "sync" => {
                        let state = app.state::<AppState>();
                        let folders = state.settings.lock().unwrap().folders.clone();
                        for c in card::list(&folders).into_iter().filter(|c| c.link.is_some()) {
                            let _ = start_sync(app, &state, c.root, None);
                        }
                    }
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
        .invoke_handler(tauri::generate_handler![status, login, logout, api, cards, set_options, add_folder, remove_folder, link_card, attach_card, system_lang, restart_app, unlink_card, device_id, sync_card, cancel_sync, local_wifi])
        .run(tauri::generate_context!())
        .expect("error while running Rommancer");
}
