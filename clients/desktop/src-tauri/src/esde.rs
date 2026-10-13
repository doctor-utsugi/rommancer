//! ES-DE (EmulationStation Desktop Edition, also the frontend of EmuDeck and RetroDECK): its systems, the roms in
//! each system's folder and the emulator each game runs with (the game's own pick, else its system's, else the
//! system's first command). RetroArch games are synced; games of other emulators are counted as not synced yet

use crate::frontend::{child, home, normalize, path_in, retroarch_command, standalone_of_command, Game, Library, Setup};
use crate::pc;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The systems ES-DE ships with on this OS (its resources/systems/<os>/es_systems.xml)
#[cfg(target_os = "windows")]
const BUNDLED: &str = include_str!("../resources/esde/es_systems_windows.xml");
#[cfg(target_os = "macos")]
const BUNDLED: &str = include_str!("../resources/esde/es_systems_macos.xml");
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
const BUNDLED: &str = include_str!("../resources/esde/es_systems_linux.xml");

#[derive(Clone, Debug)]
struct System {
    name: String,
    path: String,
    extensions: HashSet<String>,
    /// (label, command), the first one the default
    commands: Vec<(String, String)>,
}

pub fn is_esde(dir: &Path) -> bool {
    dir.join("settings").join("es_settings.xml").is_file()
}

/// ES-DE's data folder: the one its ESDE_APPDATA_DIR names, else the home folder's, RetroDECK's or EmuDeck's
pub fn detect() -> Option<PathBuf> {
    let h = home();
    let mut dirs: Vec<PathBuf> = std::env::var_os("ESDE_APPDATA_DIR").map(PathBuf::from).into_iter().collect();
    dirs.push(h.join("ES-DE"));
    dirs.push(h.join(".var/app/net.retrodeck.retrodeck/config/ES-DE"));
    if let Some(a) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(a).join("EmuDeck").join("Emulators").join("ES-DE").join("ES-DE"));
    }
    dirs.into_iter().find(|d| is_esde(d))
}

/// ES-DE's own folder (where it is installed): a portable copy keeps its data folder in it
fn es_path(dir: &Path) -> Option<PathBuf> {
    dir.parent().filter(|p| p.join("portable.txt").is_file()).map(Path::to_path_buf)
}

/// An ES-DE file holding several top-level elements (gamelists, es_settings.xml): wrapped in one
fn read_loose_xml(path: &Path) -> Option<String> {
    let text = crate::frontend::read_xml(path)?;
    let body = match text.find("?>") {
        Some(i) if text.trim_start().starts_with("<?xml") => &text[i + 2..],
        _ => &text[..],
    };
    Some(format!("<root>{body}</root>"))
}

fn settings(dir: &Path) -> HashMap<String, String> {
    let Some(text) = read_loose_xml(&dir.join("settings").join("es_settings.xml")) else { return HashMap::new() };
    let Ok(doc) = roxmltree::Document::parse(&text) else { return HashMap::new() };
    doc.descendants().filter_map(|n| Some((n.attribute("name")?.to_string(), n.attribute("value")?.to_string()))).collect()
}

/// "~" the home folder (ES-DE's own folder when portable), "%ESPATH%" ES-DE's own folder
fn expand(dir: &Path, value: &str) -> PathBuf {
    let own = es_path(dir);
    let home_dir = own.clone().unwrap_or_else(home);
    let v = value.trim().replace('\\', "/");
    let v = match &own {
        Some(o) => v.replace("%ESPATH%", &pc::wire(o)),
        None => v,
    };
    if let Some(rest) = v.strip_prefix('~') {
        return normalize(&home_dir.join(rest.trim_start_matches('/')));
    }
    path_in(&home_dir, &v)
}

fn rom_dir(dir: &Path, settings: &HashMap<String, String>) -> PathBuf {
    match settings.get("ROMDirectory").map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(v) => expand(dir, v),
        None => expand(dir, "~/ROMs"),
    }
}

fn parse_systems(text: &str) -> (Vec<System>, bool) {
    let Ok(doc) = roxmltree::Document::parse(text) else { return (vec![], false) };
    let exclusive = doc.descendants().any(|n| n.has_tag_name("loadExclusive"));
    let systems = doc
        .descendants()
        .filter(|n| n.has_tag_name("system"))
        .map(|n| System {
            name: child(n, "name").to_string(),
            path: child(n, "path").to_string(),
            extensions: child(n, "extension").split_whitespace().map(|e| e.to_lowercase()).collect(),
            commands: n.children().filter(|c| c.has_tag_name("command")).map(|c| (c.attribute("label").unwrap_or("").to_string(), c.text().unwrap_or("").trim().to_string())).collect(),
        })
        .filter(|s| !s.name.is_empty() && !s.commands.is_empty())
        .collect();
    (systems, exclusive)
}

/// The bundled systems with the user's custom_systems/es_systems.xml over them (a system of the same name replaced,
/// all of them when it says loadExclusive)
fn systems(dir: &Path) -> Vec<System> {
    let (mut list, _) = parse_systems(BUNDLED);
    let custom = crate::frontend::read_xml(&dir.join("custom_systems").join("es_systems.xml")).map(|t| parse_systems(&t));
    if let Some((mine, exclusive)) = custom {
        if exclusive {
            return mine;
        }
        for s in mine {
            match list.iter_mut().find(|o| o.name == s.name) {
                Some(o) => *o = s,
                None => list.push(s),
            }
        }
    }
    list
}

/// A system's gamelist: the emulator picked for the whole system and for single games (by rom)
fn picks(dir: &Path, system: &str, system_dir: &Path) -> (Option<String>, HashMap<PathBuf, String>) {
    let Some(text) = read_loose_xml(&dir.join("gamelists").join(system).join("gamelist.xml")) else { return (None, HashMap::new()) };
    let Ok(doc) = roxmltree::Document::parse(&text) else { return (None, HashMap::new()) };
    let whole = doc.descendants().find(|n| n.has_tag_name("alternativeEmulator")).map(|n| child(n, "label").to_string()).filter(|l| !l.is_empty());
    let games = doc
        .descendants()
        .filter(|n| n.has_tag_name("game"))
        .filter_map(|g| {
            let alt = child(g, "altemulator");
            (!alt.is_empty()).then(|| (path_in(system_dir, child(g, "path")), alt.to_string()))
        })
        .collect();
    (whole, games)
}

/// The roms of a system's folder as ES-DE finds them: files with its extensions, in subfolders too, skipping hidden
/// ones and folders holding a noload.txt
fn roms(dir: &Path, exts: &HashSet<String>, depth: u32, out: &mut Vec<PathBuf>) {
    if depth > 8 || dir.join("noload.txt").exists() {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let ext = name.rfind('.').map(|i| name[i..].to_lowercase()).unwrap_or_default();
        let p = e.path();
        if p.is_dir() {
            // A folder named with an extension is one game (a PS3 or Windows game folder)
            if !exts.contains(&ext) {
                roms(&p, exts, depth + 1, out);
            }
        } else if exts.contains(&ext) {
            out.push(p);
        }
    }
}

/// The retroarch.cfg ES-DE's RetroArch runs with: RetroDECK's beside ES-DE's data, a portable RetroArch next to a
/// portable ES-DE (where ES-DE looks for it), EmuDeck's on Windows, else the one RetroArch itself would use
fn retroarch_cfg(dir: &Path) -> Option<PathBuf> {
    let mut cfgs = vec![];
    if let Some(p) = dir.parent() {
        cfgs.push(p.join("retroarch").join("retroarch.cfg"));
    }
    if let Some(own) = es_path(dir) {
        for d in [own.join("Emulators").join("RetroArch"), own.join("RetroArch"), own.join("..").join("RetroArch")] {
            cfgs.push(d.join("retroarch.cfg"));
        }
    }
    if let Some(a) = std::env::var_os("APPDATA") {
        cfgs.push(PathBuf::from(a).join("EmuDeck").join("Emulators").join("RetroArch").join("retroarch.cfg"));
    }
    cfgs.into_iter().map(|p| normalize(&p)).find(|p| p.is_file()).or_else(|| pc::retroarch_cfgs().into_iter().next())
}

/// The setup of a command: RetroArch's core (from -L), the label for other emulators; none for shortcuts and
/// scripts, which are no games
fn setup_of(dir: &Path, command: &str, label: &str, cfg: Option<&Path>, setups: &mut BTreeMap<String, Setup>) -> Option<Result<String, String>> {
    if command.contains("%EMULATOR_OS-SHELL%") {
        return None;
    }
    let found = if command.contains("%EMULATOR_RETROARCH%") {
        cfg.and_then(|c| retroarch_command(command, "%EMULATOR_RETROARCH%", c))
    } else {
        // Where ES-DE looks for emulators on Windows: its own Emulators folder, EmuDeck's
        let mut exe_dirs: Vec<PathBuf> = es_path(dir).map(|o| o.join("Emulators")).into_iter().collect();
        exe_dirs.extend(std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("EmuDeck").join("Emulators")));
        standalone_of_command(command, &exe_dirs)
    };
    match found {
        Some((key, setup)) => {
            setups.entry(key.clone()).or_insert(setup);
            Some(Ok(key))
        }
        None if cfg.is_none() && command.contains("%EMULATOR_RETROARCH%") => Some(Err(format!("{label} (no retroarch.cfg found)"))),
        None => Some(Err(label.to_string())),
    }
}

pub fn read(dir: &Path) -> Library {
    let mut lib = Library { name: "ES-DE".into(), dir: dir.to_path_buf(), ..Default::default() };
    let roms_root = rom_dir(dir, &settings(dir));
    let cfg = retroarch_cfg(dir);
    for sys in systems(dir) {
        let system_dir = if sys.path.contains("%ROMPATH%") {
            normalize(&PathBuf::from(sys.path.replace('\\', "/").replace("%ROMPATH%", &pc::wire(&roms_root))))
        } else {
            expand(dir, &sys.path)
        };
        let mut files = vec![];
        roms(&system_dir, &sys.extensions, 0, &mut files);
        if files.is_empty() {
            continue;
        }
        let (whole, games) = picks(dir, &sys.name, &system_dir);
        let command = |label: Option<&String>| label.and_then(|l| sys.commands.iter().find(|(c, _)| c == l)).unwrap_or(&sys.commands[0]).clone();
        let mut setup_by_label: HashMap<String, Option<Result<String, String>>> = HashMap::new();
        for rom in files {
            let (label, cmd) = command(games.get(&rom).or(whole.as_ref()));
            let got = setup_by_label.entry(label.clone()).or_insert_with(|| setup_of(dir, &cmd, &label, cfg.as_deref(), &mut lib.setups)).clone();
            match got {
                Some(Ok(setup)) => lib.games.push(Game { rom, platform: sys.name.clone(), setup }),
                Some(Err(emulator)) => *lib.unsupported.entry(emulator).or_default() += 1,
                None => {}
            }
        }
    }
    lib
}

/// ES-DE's event scripts telling the app a game starts (ES-DE waits for it, while the app syncs the game's saves)
/// or ended; HOOK is where the app writes its port and key
fn script(event: &str, hook: &Path) -> (&'static str, String) {
    let wait = if event == "game-start" { 240 } else { 10 };
    if cfg!(windows) {
        let ps = format!(
            "try {{ $h = Get-Content -Raw -LiteralPath '{}' | ConvertFrom-Json; Invoke-WebRequest -UseBasicParsing -Method Post -TimeoutSec {wait} -Uri ('http://127.0.0.1:' + $h.port + '/{event}') -Headers @{{ 'X-Rommancer-Key' = $h.key }} -ContentType 'text/plain; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($env:ROMMANCER_ROM)) | Out-Null }} catch {{}}",
            hook.display()
        );
        ("rommancer.bat", format!("@echo off\r\nrem Written by the Rommancer app: it syncs the game's saves\r\nset \"ROMMANCER_ROM=%~1\"\r\npowershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command \"{ps}\"\r\n"))
    } else {
        let f = pc::wire(hook);
        (
            "rommancer.sh",
            format!(
                "#!/bin/sh\n# Written by the Rommancer app: it syncs the game's saves\nf='{f}'\n[ -f \"$f\" ] || exit 0\nport=$(sed -n 's/.*\"port\":\\([0-9]*\\).*/\\1/p' \"$f\")\nkey=$(sed -n 's/.*\"key\":\"\\([^\"]*\\)\".*/\\1/p' \"$f\")\ncurl -s -m {wait} -X POST -H \"X-Rommancer-Key: $key\" -H 'Content-Type: text/plain' --data-binary \"$1\" \"http://127.0.0.1:$port/{event}\" >/dev/null 2>&1\nexit 0\n"
            ),
        )
    }
}

fn esde_running() -> bool {
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    sys.processes().values().any(|p| {
        let n = p.name().to_string_lossy().to_lowercase();
        n == "es-de" || n == "es-de.exe" || n.starts_with("es-de.") || n == "emulationstation" || n == "emulationstation.exe"
    })
}

/// Puts Rommancer's event scripts in ES-DE and turns its custom event scripts on (only while ES-DE is closed: it
/// writes its settings back when it quits); true when they are on
pub fn install_scripts(dir: &Path, hook: &Path) -> bool {
    for event in ["game-start", "game-end"] {
        let (name, text) = script(event, hook);
        let file = dir.join("scripts").join(event).join(name);
        if fs::read_to_string(&file).ok().as_deref() != Some(text.as_str()) {
            if fs::create_dir_all(file.parent().unwrap()).and_then(|_| fs::write(&file, &text)).is_err() {
                return false;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&file, fs::Permissions::from_mode(0o755));
            }
        }
    }
    if settings(dir).get("CustomEventScripts").is_some_and(|v| v == "true") {
        return true;
    }
    if esde_running() {
        return false;
    }
    let file = dir.join("settings").join("es_settings.xml");
    let Ok(text) = fs::read_to_string(&file) else { return false };
    let line = "<bool name=\"CustomEventScripts\" value=\"true\" />";
    let out = match text.lines().position(|l| l.contains("name=\"CustomEventScripts\"")) {
        Some(i) => text.lines().enumerate().map(|(j, l)| if j == i { line.to_string() } else { l.to_string() }).collect::<Vec<_>>().join("\n") + "\n",
        None => format!("{}\n{line}\n", text.trim_end()),
    };
    fs::write(&file, out).is_ok()
}

/// When the roms folder or ES-DE's settings and gamelists last changed
fn stamp(dir: &Path) -> u64 {
    let mut files = vec![dir.join("settings").join("es_settings.xml"), dir.join("custom_systems").join("es_systems.xml")];
    files.extend(fs::read_dir(dir.join("gamelists")).into_iter().flatten().flatten().map(|e| e.path().join("gamelist.xml")));
    let roms_root = rom_dir(dir, &settings(dir));
    files.push(roms_root.clone());
    files.extend(fs::read_dir(&roms_root).into_iter().flatten().flatten().map(|e| e.path()));
    let mut h = sha1_smol::Sha1::new();
    for f in files {
        if let Ok(m) = fs::metadata(&f) {
            let t = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
            h.update(f.to_string_lossy().as_bytes());
            h.update(&t.to_le_bytes());
        }
    }
    let d = h.digest().bytes();
    u64::from_le_bytes([d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7]])
}

/// The library, read again when ES-DE's files or the system folders changed; its folder looked for once a minute
#[derive(Default)]
pub struct Cache {
    found: Option<(std::time::Instant, Option<PathBuf>)>,
    read: Option<(PathBuf, u64, Arc<Library>)>,
    /// ES-DE folders whose event scripts are on
    scripts: HashSet<PathBuf>,
    tried: Option<std::time::Instant>,
}

impl Cache {
    /// CHOSEN: the folder the user picked (none: found by itself)
    pub fn get(&mut self, chosen: Option<&str>) -> Option<Arc<Library>> {
        let dir = match chosen {
            Some(c) => Some(PathBuf::from(c)).filter(|d| is_esde(d)),
            None => {
                if self.found.as_ref().is_none_or(|(at, _)| at.elapsed() >= std::time::Duration::from_secs(60)) {
                    self.found = Some((std::time::Instant::now(), detect()));
                }
                self.found.as_ref().and_then(|(_, d)| d.clone())
            }
        };
        let Some(dir) = dir else {
            self.read = None;
            return None;
        };
        // Tried again once a minute while ES-DE is open
        if !self.scripts.contains(&dir) && self.tried.is_none_or(|t| t.elapsed() >= std::time::Duration::from_secs(60)) {
            self.tried = Some(std::time::Instant::now());
            if install_scripts(&dir, &crate::hook::info_file()) {
                self.scripts.insert(dir.clone());
            }
        }
        let s = stamp(&dir);
        if !self.read.as_ref().is_some_and(|(d, old, _)| *d == dir && *old == s) {
            self.read = Some((dir.clone(), s, Arc::new(read(&dir))));
        }
        self.read.as_ref().map(|(_, _, l)| l.clone())
    }

    /// ES-DE has to be closed for Rommancer's event scripts to be turned on
    pub fn needs_restart(&self, dir: &Path) -> bool {
        !self.scripts.contains(dir)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(p: &Path, text: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    #[test]
    fn games_run_with_their_own_their_systems_or_the_first_emulator() {
        let base = std::env::temp_dir().join(format!("rommancer-esde-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let dir = base.join("config").join("ES-DE");
        let roms = base.join("roms");
        write(
            &dir.join("settings/es_settings.xml"),
            &format!("<?xml version=\"1.0\"?>\n<string name=\"ROMDirectory\" value=\"{}\" />\n<bool name=\"Other\" value=\"true\" />\n", pc::wire(&roms)),
        );
        write(&base.join("config/retroarch/retroarch.cfg"), "savefile_directory = \"/saves\"\nsort_savefiles_enable = \"true\"\nsavestate_directory = \"/states\"\n");
        write(&base.join("config/retroarch/info/snes9x_libretro.info"), "corename = \"Snes9x\"\n");
        write(&roms.join("snes/Mario.sfc"), "x");
        write(&roms.join("snes/sub/Zelda.SFC"), "x");
        write(&roms.join("snes/skip/noload.txt"), "");
        write(&roms.join("snes/skip/Hidden.sfc"), "x");
        write(&roms.join("snes/notes.txt"), "x");
        write(&roms.join("gba/Pokemon.gba"), "x");
        write(&roms.join("psx/Crash.chd"), "x");
        write(&roms.join("psx/Spyro.chd"), "x");
        // The system's pick for GBA, a single game's for PlayStation
        write(&dir.join("gamelists/gba/gamelist.xml"), "<?xml version=\"1.0\"?>\n<alternativeEmulator>\n<label>gpSP</label>\n</alternativeEmulator>\n<gameList>\n</gameList>\n");
        write(
            &dir.join("gamelists/psx/gamelist.xml"),
            "<?xml version=\"1.0\"?>\n<gameList>\n<game><path>./Spyro.chd</path><altemulator>DuckStation (Standalone)</altemulator></game>\n</gameList>\n",
        );
        let lib = read(&dir);
        let mut got: Vec<(String, String, String)> = lib.games.iter().map(|g| (g.rom.file_name().unwrap().to_string_lossy().to_string(), g.platform.clone(), g.setup.clone())).collect();
        got.sort();
        let cfg_path = base.join("config/retroarch/retroarch.cfg");
        let cfg = pc::wire(&cfg_path);
        let name = |stem: &str| crate::frontend::core_name(&crate::frontend::info_dirs(&cfg_path), stem);
        assert_eq!(got.len(), 4, "{got:?}");
        assert_eq!(got[0], ("Crash.chd".into(), "psx".into(), format!("{cfg}|{}", name("mednafen_psx_libretro"))));
        assert_eq!(got[1], ("Mario.sfc".into(), "snes".into(), format!("{cfg}|Snes9x")));
        assert_eq!(got[2], ("Pokemon.gba".into(), "gba".into(), format!("{cfg}|{}", name("gpsp_libretro"))));
        assert_eq!(got[3].0, "Zelda.SFC");
        assert_eq!(lib.unsupported.get("DuckStation (Standalone)"), Some(&1));
        let s = &lib.setups[&format!("{cfg}|Snes9x")];
        assert_eq!((s.emulator.as_str(), s.saves_layout.as_str()), ("core:Snes9x", "core"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn event_scripts_are_put_in_and_turned_on() {
        let dir = std::env::temp_dir().join(format!("rommancer-esde-scripts-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        write(&dir.join("settings/es_settings.xml"), "<?xml version=\"1.0\"?>\n<bool name=\"CustomEventScripts\" value=\"false\" />\n<string name=\"ROMDirectory\" value=\"\" />\n");
        if esde_running() {
            return;
        }
        assert!(install_scripts(&dir, Path::new("/x/hook.json")));
        assert_eq!(settings(&dir).get("CustomEventScripts").map(String::as_str), Some("true"));
        assert_eq!(settings(&dir).get("ROMDirectory").map(String::as_str), Some(""));
        let (name, _) = script("game-start", Path::new("/x"));
        assert!(fs::read_to_string(dir.join("scripts/game-start").join(name)).unwrap().contains("/x/hook.json"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn custom_systems_replace_bundled_ones() {
        let (bundled, _) = parse_systems(BUNDLED);
        assert!(bundled.len() > 150);
        let (mine, exclusive) = parse_systems("<systemList><loadExclusive/><system><name>snes</name><path>/x</path><extension>.sfc</extension><command label=\"A\">retroarch -L /c/snes9x_libretro.so %ROM%</command></system></systemList>");
        assert!(exclusive);
        assert_eq!(mine[0].commands[0].0, "A");
    }
}
