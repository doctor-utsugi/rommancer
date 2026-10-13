//! LaunchBox on this PC: the games it launches, the emulator each one opens with (the game's own, else its
//! platform's default) and where that emulator keeps saves and states. RetroArch is read from its command line
//! (-L core, -c config) and its retroarch.cfg; emulators Rommancer cannot read yet are counted, not guessed.

use crate::pc;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

/// Where an emulator setup keeps saves and states (none: next to each game), as the server's layouts name them
#[derive(Clone, Debug, PartialEq)]
pub struct Setup {
    /// "core:<RetroArch core name>" or an emulator the server knows
    pub emulator: String,
    pub saves: Option<PathBuf>,
    pub states: Option<PathBuf>,
    pub saves_layout: String,
    pub states_layout: String,
}

#[derive(Clone, Debug)]
pub struct Game {
    pub rom: PathBuf,
    /// The platform as LaunchBox names it (its "scrape as" name when the user renamed it)
    pub platform: String,
    pub setup: String,
}

#[derive(Default, Debug)]
pub struct Library {
    pub dir: PathBuf,
    pub games: Vec<Game>,
    pub setups: BTreeMap<String, Setup>,
    /// Games whose emulator Rommancer cannot read, by emulator title
    pub unsupported: BTreeMap<String, u32>,
}

/// What the app shows about LaunchBox
#[derive(Serialize, Clone, Debug, Default)]
pub struct Summary {
    pub dir: String,
    /// Rommancer's plugin was put in while LaunchBox was open: it loads plugins when it starts
    pub restart: bool,
    pub games: usize,
    pub synced: usize,
    pub unsupported: Vec<(String, u32)>,
}

struct Emulator {
    title: String,
    exe: PathBuf,
    command: String,
}

struct PlatformEmu {
    emulator: String,
    command: String,
    default: bool,
}

fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

pub fn is_launchbox(dir: &Path) -> bool {
    dir.join("Data").join("Emulators.xml").is_file() && dir.join("Data").join("Platforms").is_dir()
}

/// LaunchBox is portable: its usual folders in the user's home and at the root of each drive
pub fn detect() -> Option<PathBuf> {
    let h = home();
    let mut dirs = vec![h.join("LaunchBox"), h.join("Desktop").join("LaunchBox"), h.join("Documents").join("LaunchBox")];
    if cfg!(windows) {
        for d in b'C'..=b'Z' {
            let root = PathBuf::from(format!("{}:\\", d as char));
            dirs.push(root.join("LaunchBox"));
            dirs.push(root.join("Games").join("LaunchBox"));
        }
    }
    dirs.into_iter().find(|d| is_launchbox(d))
}

/// A path LaunchBox stores: absolute, or relative to its own folder, with either slash
fn lb_path(base: &Path, p: &str) -> PathBuf {
    let p = p.trim().replace('\\', "/");
    let path = PathBuf::from(&p);
    let absolute = path.is_absolute() || p.as_bytes().get(1) == Some(&b':') || p.starts_with('/');
    let joined = if absolute { path } else { base.join(p) };
    normalize(&joined)
}

/// "a/b/../c" as "a/c" without touching the disk (LaunchBox writes "..\Roms\..." paths)
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn child<'a>(n: roxmltree::Node<'a, 'a>, name: &str) -> &'a str {
    n.children().find(|c| c.has_tag_name(name)).and_then(|c| c.text()).unwrap_or("").trim()
}

fn read_xml(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    Some(text.trim_start_matches('\u{feff}').to_string())
}

/// Arguments of a command line, quotes kept together ("-L "cores\x.dll" -f")
fn args(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for c in command.chars() {
        match c {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn flag(args: &[String], names: &[&str]) -> Option<String> {
    args.iter().position(|a| names.contains(&a.as_str())).and_then(|i| args.get(i + 1)).cloned()
}

/// The name RetroArch gives a core (its save folder when saves are sorted by core): the info file's "corename",
/// else the file name without "_libretro"
fn core_name(ra_dir: &Path, core: &Path) -> String {
    let stem = core.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let info = ra_dir.join("info").join(format!("{stem}.info"));
    fs::read_to_string(info)
        .ok()
        .and_then(|t| t.lines().filter_map(|l| l.split_once('=')).find(|(k, _)| k.trim() == "corename").map(|(_, v)| v.trim().trim_matches('"').to_string()))
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| stem.trim_end_matches("_libretro").to_string())
}

fn setup_of_retroarch(exe: &Path, command: &str) -> Option<(String, Setup)> {
    let ra_dir = exe.parent()?.to_path_buf();
    let a = args(command);
    let core = flag(&a, &["-L", "--libretro"])?;
    let core_path = lb_path(&ra_dir, &core);
    let cfg = flag(&a, &["-c", "--config"]).map(|c| lb_path(&ra_dir, &c)).unwrap_or_else(|| ra_dir.join("retroarch.cfg"));
    let ra = pc::parse(&cfg, "portable");
    let name = core_name(&ra_dir, &core_path);
    let setup = Setup {
        emulator: format!("core:{name}"),
        saves: ra.saves_dir.map(PathBuf::from),
        states: ra.states_dir.map(PathBuf::from),
        saves_layout: ra.saves_layout,
        states_layout: ra.states_layout,
    };
    Some((format!("{}|{name}", pc::wire(&cfg)), setup))
}

/// A value of an INI or TOML file: KEY in SECTION ("" for the keys before any section), quotes taken off
fn ini_get(path: &Path, section: &str, key: &str) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let mut current = String::new();
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with('[') && l.ends_with(']') {
            current = l[1..l.len() - 1].trim().to_string();
        } else if let Some((k, v)) = l.split_once('=') {
            if current.eq_ignore_ascii_case(section) && k.trim().eq_ignore_ascii_case(key) {
                return Some(v.trim().trim_matches('"').to_string());
            }
        }
    }
    None
}

fn env_dir(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).map(PathBuf::from)
}

fn documents() -> PathBuf {
    home().join("Documents")
}

/// A folder setting: none when empty, relative ones under BASE
fn setting_dir(value: Option<String>, base: &Path) -> Option<PathBuf> {
    let v = value?.trim().to_string();
    (!v.is_empty()).then(|| normalize(&base.join(v.replace('\\', "/"))))
}

/// Saves of the game next to its rom, or in DIR, with no savestates (each emulator writes its own kind)
fn plain(emulator: &str, dir: Option<PathBuf>) -> Setup {
    Setup { emulator: emulator.into(), saves: dir, states: None, saves_layout: "flat".into(), states_layout: "none".into() }
}

/// Emulators other than RetroArch, by their program's name, each read from its own settings
fn setup_of_standalone(exe: &Path, name: &str) -> Option<(String, Setup)> {
    let dir = exe.parent()?.to_path_buf();
    let setup = if name.starts_with("duckstation") {
        // Portable next to the program, else the old Documents folder when it exists, else local app data
        let root = if dir.join("portable.txt").is_file() || dir.join("settings.ini").is_file() {
            dir.clone()
        } else if documents().join("DuckStation").is_dir() {
            documents().join("DuckStation")
        } else {
            env_dir("LOCALAPPDATA").unwrap_or_else(|| home().join("AppData").join("Local")).join("DuckStation")
        };
        let ini = root.join("settings.ini");
        let cards = setting_dir(ini_get(&ini, "MemoryCards", "Directory"), &root).unwrap_or_else(|| root.join("memcards"));
        // How it names a game's card: by title (its default), the rom file's title, the disc serial or one shared card
        let kind = match ini_get(&ini, "MemoryCards", "Card1Type").unwrap_or_default().as_str() {
            "PerGameFileTitle" => "card-filetitle",
            "PerGame" => "card-serial",
            "Shared" => "card-shared",
            "None" | "NonPersistent" => return None,
            _ => "card-title",
        };
        Setup { emulator: "duckstation".into(), saves: Some(cards), states: None, saves_layout: kind.into(), states_layout: "none".into() }
    } else if name == "dolphin.exe" {
        let user = if dir.join("portable.txt").is_file() {
            dir.join("User")
        } else if let Some(p) = registry("HKCU\\Software\\Dolphin Emulator", "UserConfigPath") {
            PathBuf::from(p)
        } else if documents().join("Dolphin Emulator").is_dir() {
            documents().join("Dolphin Emulator")
        } else {
            env_dir("APPDATA").map(|a| a.join("Dolphin Emulator")).filter(|d| d.is_dir()).unwrap_or_else(|| dir.join("User"))
        };
        // GameCube cards: GC\<region>\Card A folders (its default) or MemoryCardA.<region>.raw images
        Setup { emulator: "dolphin-gci".into(), saves: Some(user.join("GC")), states: None, saves_layout: "card-gc".into(), states_layout: "none".into() }
    } else if name == "mgba.exe" {
        let cfg = if dir.join("portable.ini").is_file() { dir.clone() } else { env_dir("APPDATA").unwrap_or_else(|| home().join("AppData").join("Roaming")).join("mGBA") };
        let ini = cfg.join("config.ini");
        let path = ini_get(&ini, "ports.qt", "savegamePath").filter(|v| !v.is_empty()).or_else(|| ini_get(&ini, "", "savegamePath"));
        plain("mgba", setting_dir(path, &cfg))
    } else if name == "melonds.exe" {
        let cfg = if dir.join("portable").is_dir() { dir.join("portable") } else { dir.clone() };
        let path = ini_get(&cfg.join("melonDS.toml"), "Instance0", "SaveFilePath").or_else(|| ini_get(&cfg.join("melonDS.ini"), "", "SaveFilePath"));
        plain("melonds", setting_dir(path, &dir))
    } else if name.starts_with("pcsx2") {
        // Portable next to the program, else Documents; its first slot's card, every game's saves in it
        let root = if dir.join("portable.ini").is_file() || dir.join("portable.txt").is_file() { dir.clone() } else { documents().join("PCSX2") };
        let ini = [root.join("inis").join("PCSX2.ini"), root.join("inis").join("PCSX2_ui.ini")].into_iter().find(|p| p.is_file()).unwrap_or_default();
        let cards = setting_dir(ini_get(&ini, "Folders", "MemoryCards"), &root).unwrap_or_else(|| root.join("memcards"));
        Setup { emulator: "pcsx2".into(), saves: Some(cards), states: None, saves_layout: "card-shared".into(), states_layout: "none".into() }
    } else if name.starts_with("ppsspp") {
        // installed.txt names the memory stick (empty: Documents\PPSSPP); without it, the memstick folder beside it
        let stick = match fs::read_to_string(dir.join("installed.txt")) {
            Ok(text) => setting_dir(text.lines().next().map(|l| l.trim_start_matches('\u{feff}').to_string()), &dir).unwrap_or_else(|| documents().join("PPSSPP")),
            Err(_) => dir.join("memstick"),
        };
        // A folder per save in SAVEDATA, each synced whole
        Setup { emulator: "ppsspp".into(), saves: Some(stick.join("PSP").join("SAVEDATA")), states: None, saves_layout: "card-folder".into(), states_layout: "none".into() }
    } else if name.starts_with("snes9x") {
        let path = ini_get(&dir.join("snes9x.conf"), "Settings\\Win\\Files", "Dir:SRAM").or_else(|| Some(".\\Saves".into()));
        plain("snes9x", setting_dir(path, &dir))
    } else {
        return None;
    };
    Some((format!("{}|{}", setup.emulator, pc::wire(exe)), setup))
}

/// A value of the Windows registry (none elsewhere, or when missing)
fn registry(key: &str, value: &str) -> Option<String> {
    if !cfg!(windows) {
        return None;
    }
    let mut cmd = std::process::Command::new("reg");
    cmd.args(["query", key, "/v", value]);
    // No console window flashing up
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0800_0000);
    let out = cmd.output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    text.lines().find_map(|l| l.split_once("REG_SZ").map(|(_, v)| v.trim().to_string())).filter(|v| !v.is_empty())
}

pub fn read(dir: &Path) -> Library {
    let mut lib = Library { dir: dir.to_path_buf(), ..Default::default() };
    let data = dir.join("Data");
    let mut emulators: HashMap<String, Emulator> = HashMap::new();
    let mut by_platform: HashMap<String, Vec<PlatformEmu>> = HashMap::new();
    if let Some(text) = read_xml(&data.join("Emulators.xml")) {
        if let Ok(doc) = roxmltree::Document::parse(&text) {
            for n in doc.root_element().children().filter(|n| n.is_element()) {
                if n.has_tag_name("Emulator") {
                    emulators.insert(child(n, "ID").to_lowercase(), Emulator { title: child(n, "Title").to_string(), exe: lb_path(dir, child(n, "ApplicationPath")), command: child(n, "CommandLine").to_string() });
                } else if n.has_tag_name("EmulatorPlatform") {
                    by_platform.entry(child(n, "Platform").to_string()).or_default().push(PlatformEmu {
                        emulator: child(n, "Emulator").to_lowercase(),
                        command: child(n, "CommandLine").to_string(),
                        default: child(n, "Default").eq_ignore_ascii_case("true"),
                    });
                }
            }
        }
    }
    let mut scrape_as: HashMap<String, String> = HashMap::new();
    if let Some(text) = read_xml(&data.join("Platforms.xml")) {
        if let Ok(doc) = roxmltree::Document::parse(&text) {
            for n in doc.root_element().children().filter(|n| n.has_tag_name("Platform")) {
                let s = child(n, "ScrapeAs");
                if !s.is_empty() {
                    scrape_as.insert(child(n, "Name").to_string(), s.to_string());
                }
            }
        }
    }
    let mut files: Vec<PathBuf> = fs::read_dir(data.join("Platforms")).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("xml"))).collect();
    files.sort();
    let mut resolved: HashMap<(String, String), Option<(String, Setup)>> = HashMap::new();
    for f in files {
        let Some(text) = read_xml(&f) else { continue };
        let Ok(doc) = roxmltree::Document::parse(&text) else { continue };
        for g in doc.root_element().children().filter(|n| n.has_tag_name("Game")) {
            let app = child(g, "ApplicationPath");
            let platform = child(g, "Platform");
            if app.is_empty() || platform.is_empty() {
                continue;
            }
            let rom = lb_path(dir, app);
            let ext = rom.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
            // PC games and shortcuts launch by themselves: no emulator, no saves to sync
            if ["exe", "bat", "cmd", "lnk", "url"].contains(&ext.as_str()) {
                continue;
            }
            let rows = by_platform.get(platform).map(Vec::as_slice).unwrap_or(&[]);
            let own = child(g, "Emulator").to_lowercase();
            let row = if own.is_empty() { rows.iter().find(|r| r.default).or_else(|| rows.first()) } else { rows.iter().find(|r| r.emulator == own) };
            let emu_id = if own.is_empty() { row.map(|r| r.emulator.clone()).unwrap_or_default() } else { own };
            let Some(emu) = emulators.get(&emu_id) else { continue };
            // The game's own command line, else its platform's, else the emulator's
            let game_cmd = child(g, "CommandLine");
            let command = [game_cmd, row.map(|r| r.command.as_str()).unwrap_or(""), emu.command.as_str()].into_iter().find(|c| !c.trim().is_empty()).unwrap_or("").to_string();
            let entry = resolved.entry((emu_id.clone(), command.clone())).or_insert_with(|| {
                let exe = emu.exe.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
                if exe.starts_with("retroarch") {
                    setup_of_retroarch(&emu.exe, &command)
                } else {
                    setup_of_standalone(&emu.exe, &exe)
                }
            });
            match entry {
                Some((key, setup)) => {
                    lib.setups.entry(key.clone()).or_insert_with(|| setup.clone());
                    let platform = scrape_as.get(platform).cloned().unwrap_or_else(|| platform.to_string());
                    lib.games.push(Game { rom, platform, setup: key.clone() });
                }
                None => *lib.unsupported.entry(if emu.title.is_empty() { emu_id.clone() } else { emu.title.clone() }).or_default() += 1,
            }
        }
    }
    lib
}

/// Dates and sizes of LaunchBox's data files: a change means it saved its library
fn data_stamp(dir: &Path) -> u64 {
    let data = dir.join("Data");
    let mut files = vec![data.join("Emulators.xml"), data.join("Platforms.xml")];
    files.extend(fs::read_dir(data.join("Platforms")).into_iter().flatten().flatten().map(|e| e.path()));
    let mut h = sha1_smol::Sha1::new();
    for f in files {
        if let Ok(m) = fs::metadata(&f) {
            let t = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
            h.update(f.to_string_lossy().as_bytes());
            h.update(&t.to_le_bytes());
            h.update(&m.len().to_le_bytes());
        }
    }
    let d = h.digest().bytes();
    u64::from_le_bytes([d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7]])
}

/// Rommancer's plugin for LaunchBox, built from clients/launchbox (it tells the app when games start and end)
const PLUGIN: &[u8] = include_bytes!("../resources/Rommancer.LaunchBox.dll");

fn launchbox_running() -> bool {
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    sys.processes().values().any(|p| {
        let n = p.name().to_string_lossy().to_lowercase();
        n == "launchbox.exe" || n == "bigbox.exe"
    })
}

/// Puts the plugin in LaunchBox's Plugins folder when it is missing or older; true when LaunchBox must restart for
/// it. A plugin LaunchBox has loaded cannot be overwritten, but it can be renamed out of the way
pub fn install_plugin(dir: &Path) -> std::io::Result<bool> {
    let folder = dir.join("Plugins").join("Rommancer");
    let file = folder.join("Rommancer.LaunchBox.dll");
    if fs::read(&file).is_ok_and(|b| b == PLUGIN) {
        return Ok(false);
    }
    fs::create_dir_all(&folder)?;
    if file.exists() && fs::write(&file, PLUGIN).is_ok() {
        return Ok(launchbox_running());
    }
    let old = folder.join("Rommancer.LaunchBox.dll.old");
    let _ = fs::remove_file(&old);
    if file.exists() {
        fs::rename(&file, &old)?;
    }
    fs::write(&file, PLUGIN)?;
    Ok(launchbox_running())
}

/// The library, read again only when LaunchBox saved it; its folder looked for once a minute when none was picked
#[derive(Default)]
pub struct Cache {
    found: Option<(std::time::Instant, Option<PathBuf>)>,
    read: Option<(PathBuf, u64, std::sync::Arc<Library>)>,
    /// LaunchBox folders the plugin was checked in, and whether LaunchBox has to restart there
    plugin: HashMap<PathBuf, bool>,
}

impl Cache {
    pub fn get(&mut self, chosen: Option<&str>) -> Option<std::sync::Arc<Library>> {
        let dir = match chosen {
            Some(c) => Some(PathBuf::from(c)).filter(|d| is_launchbox(d)),
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
        if !self.plugin.contains_key(&dir) {
            let restart = install_plugin(&dir).unwrap_or(false);
            self.plugin.insert(dir.clone(), restart);
        }
        let stamp = data_stamp(&dir);
        if !self.read.as_ref().is_some_and(|(d, s, _)| *d == dir && *s == stamp) {
            self.read = Some((dir.clone(), stamp, std::sync::Arc::new(read(&dir))));
        }
        self.read.as_ref().map(|(_, _, l)| l.clone())
    }

    /// LaunchBox was open when its plugin was put in, and has not been seen closed since
    pub fn needs_restart(&mut self, dir: &Path) -> bool {
        let Some(r) = self.plugin.get_mut(dir) else { return false };
        if *r && !launchbox_running() {
            *r = false;
        }
        *r
    }
}

impl Library {
    pub fn summary(&self) -> Summary {
        Summary {
            dir: pc::wire(&self.dir),
            games: self.games.len() + self.unsupported.values().sum::<u32>() as usize,
            synced: self.games.len(),
            restart: false,
            unsupported: self.unsupported.iter().map(|(k, v)| (k.clone(), *v)).collect(),
        }
    }

    /// "setup" lines for the server's sync (see readLauncher in the server's agent.ts)
    pub fn setup_lines(&self) -> String {
        let dir = |p: &Option<PathBuf>| p.as_ref().map(|d| pc::wire(d)).unwrap_or_else(|| "-".into());
        self.setups.iter().map(|(k, s)| format!("setup\t{k}\t{}\t{}\t{}\t{}\t{}\n", s.emulator, dir(&s.saves), dir(&s.states), s.saves_layout, s.states_layout)).collect()
    }

    /// Folders whose every subfolder is one save (PPSSPP's SAVEDATA), synced whole as one file
    pub fn folder_saves(&self) -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = self.setups.values().filter(|s| s.saves_layout == "card-folder").filter_map(|s| s.saves.clone()).collect();
        v.sort();
        v.dedup();
        v
    }

    /// Folders where the emulators write saves and states, with how deep to look: their own folders fully, the
    /// folders of games whose saves sit next to them only at their top
    pub fn watched(&self) -> Vec<(PathBuf, u32)> {
        let mut v: Vec<(PathBuf, u32)> = Vec::new();
        for s in self.setups.values() {
            for d in [&s.saves, &s.states].into_iter().flatten() {
                v.push((d.clone(), 4));
            }
        }
        for g in &self.games {
            let s = &self.setups[&g.setup];
            if s.saves.is_none() || s.states.is_none() {
                if let Some(d) = g.rom.parent() {
                    v.push((d.to_path_buf(), 0));
                }
            }
        }
        v.sort();
        v.dedup();
        v
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
    fn games_get_their_platform_default_or_own_emulator() {
        let dir = std::env::temp_dir().join(format!("rommancer-lb-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let lb = dir.join("LaunchBox");
        write(&lb.join("Emulators/RetroArch/retroarch.exe"), "");
        write(&lb.join("Emulators/RetroArch/retroarch.cfg"), "savefile_directory = \":\\saves\"\nsort_savefiles_enable = \"true\"\nsavestate_directory = \"default\"\n");
        write(&lb.join("Emulators/RetroArch/info/snes9x_libretro.info"), "corename = \"Snes9x\"\n");
        write(
            &lb.join("Data/Emulators.xml"),
            r#"<?xml version="1.0" standalone="yes"?>
<LaunchBox>
  <Emulator><ID>AAA</ID><Title>RetroArch</Title><ApplicationPath>Emulators\RetroArch\retroarch.exe</ApplicationPath><CommandLine>-f</CommandLine></Emulator>
  <Emulator><ID>BBB</ID><Title>PCSX2</Title><ApplicationPath>Emulators\PCSX2\pcsx2-qt.exe</ApplicationPath></Emulator>
  <EmulatorPlatform><Emulator>AAA</Emulator><Platform>SNES</Platform><CommandLine>-L "cores\snes9x_libretro.dll"</CommandLine><Default>true</Default></EmulatorPlatform>
  <EmulatorPlatform><Emulator>AAA</Emulator><Platform>Sony Playstation 2</Platform><CommandLine>-L "cores\pcsx2_libretro.dll"</CommandLine><Default>false</Default></EmulatorPlatform>
  <EmulatorPlatform><Emulator>BBB</Emulator><Platform>Sony Playstation 2</Platform><Default>true</Default></EmulatorPlatform>
</LaunchBox>"#,
        );
        write(&lb.join("Data/Platforms.xml"), "<LaunchBox><Platform><Name>SNES</Name><ScrapeAs>Super Nintendo Entertainment System</ScrapeAs></Platform></LaunchBox>");
        write(
            &lb.join("Data/Platforms/SNES.xml"),
            r#"<LaunchBox><Game><ApplicationPath>..\Roms\SNES\Zelda.sfc</ApplicationPath><Platform>SNES</Platform><Emulator></Emulator></Game>
<Game><ApplicationPath>Games\Doom.exe</ApplicationPath><Platform>SNES</Platform></Game></LaunchBox>"#,
        );
        write(
            &lb.join("Data/Platforms/Sony Playstation 2.xml"),
            r#"<LaunchBox><Game><ApplicationPath>D:\PS2\Ico.iso</ApplicationPath><Platform>Sony Playstation 2</Platform></Game>
<Game><ApplicationPath>D:\PS2\Okami.iso</ApplicationPath><Platform>Sony Playstation 2</Platform><Emulator>aaa</Emulator></Game></LaunchBox>"#,
        );
        write(&lb.join("Emulators/PCSX2/portable.ini"), "");
        write(&lb.join("Emulators/PCSX2/inis/PCSX2.ini"), "[Folders]\nMemoryCards = cards\n");
        let lib = read(&lb);
        assert_eq!(lib.games.len(), 3, "{lib:?}");
        let zelda = lib.games.iter().find(|g| g.rom.ends_with("Zelda.sfc")).unwrap();
        assert_eq!(zelda.rom, dir.join("Roms/SNES/Zelda.sfc"));
        assert_eq!(zelda.platform, "Super Nintendo Entertainment System");
        let s = &lib.setups[&zelda.setup];
        assert_eq!(s.emulator, "core:Snes9x");
        assert_eq!(s.saves.as_deref(), Some(lb.join("Emulators/RetroArch/saves").as_path()));
        assert_eq!((s.saves_layout.as_str(), s.states.is_none()), ("core", true));
        let okami = lib.games.iter().find(|g| g.rom.to_string_lossy().ends_with("Okami.iso")).unwrap();
        assert_eq!(lib.setups[&okami.setup].emulator, "core:pcsx2");
        let ico = lib.games.iter().find(|g| g.rom.to_string_lossy().ends_with("Ico.iso")).unwrap();
        let s = &lib.setups[&ico.setup];
        assert_eq!((s.emulator.as_str(), s.saves_layout.as_str()), ("pcsx2", "card-shared"));
        assert_eq!(s.saves.as_deref(), Some(lb.join("Emulators/PCSX2/cards").as_path()));
        assert!(lib.unsupported.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod real {
    /// ROMMANCER_LAUNCHBOX=<folder>: what this PC's LaunchBox library reads as
    #[test]
    #[ignore]
    fn read_a_real_library() {
        let Some(dir) = std::env::var_os("ROMMANCER_LAUNCHBOX") else { return };
        let lib = super::read(std::path::Path::new(&dir));
        for g in &lib.games {
            println!("{} | {} | {}", g.rom.display(), g.platform, g.setup);
        }
        print!("{}", lib.setup_lines());
        println!("unsupported: {:?}", lib.unsupported);
    }
}
