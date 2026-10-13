//! What frontends (LaunchBox, ES-DE, Pegasus) say about the games they launch: each game's rom, platform and
//! emulator setup, and where each setup keeps saves and states. Shared by every frontend's reader; RetroArch is read
//! from its command line (-L core, -c config) and its retroarch.cfg, other emulators from their own settings

use crate::pc;
use serde::Serialize;
use std::collections::BTreeMap;
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
    /// The frontend, as the app names it
    pub name: String,
    pub dir: PathBuf,
    pub games: Vec<Game>,
    pub setups: BTreeMap<String, Setup>,
    /// Games whose emulator Rommancer cannot read, by emulator title
    pub unsupported: BTreeMap<String, u32>,
}

/// What the app shows about a frontend
#[derive(Serialize, Clone, Debug, Default)]
pub struct Summary {
    pub name: String,
    pub dir: String,
    /// Rommancer's plugin was put in while LaunchBox was open: it loads plugins when it starts
    pub restart: bool,
    pub games: usize,
    pub synced: usize,
    pub unsupported: Vec<(String, u32)>,
}

pub fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}


/// A path a frontend stores: absolute, or relative to BASE, with either slash
pub fn path_in(base: &Path, p: &str) -> PathBuf {
    let p = p.trim().replace('\\', "/");
    let path = PathBuf::from(&p);
    let absolute = path.is_absolute() || p.as_bytes().get(1) == Some(&b':') || p.starts_with('/');
    let joined = if absolute { path } else { base.join(p) };
    normalize(&joined)
}

/// "a/b/../c" as "a/c" without touching the disk (LaunchBox writes "..\Roms\..." paths)
pub fn normalize(p: &Path) -> PathBuf {
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

pub fn child<'a>(n: roxmltree::Node<'a, 'a>, name: &str) -> &'a str {
    n.children().find(|c| c.has_tag_name(name)).and_then(|c| c.text()).unwrap_or("").trim()
}

pub fn read_xml(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    Some(text.trim_start_matches('\u{feff}').to_string())
}

/// Arguments of a command line, quotes kept together ("-L "cores\x.dll" -f")
pub fn args(command: &str) -> Vec<String> {
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

pub fn flag(args: &[String], names: &[&str]) -> Option<String> {
    args.iter().position(|a| names.contains(&a.as_str())).and_then(|i| args.get(i + 1)).cloned()
}

/// The name RetroArch gives a core (its save folder when saves are sorted by core): the info file's "corename",
/// else the file name without "_libretro"
pub fn core_name(info_dirs: &[PathBuf], stem: &str) -> String {
    info_dirs
        .iter()
        .find_map(|d| fs::read_to_string(d.join(format!("{stem}.info"))).ok())
        .and_then(|t| t.lines().filter_map(|l| l.split_once('=')).find(|(k, _)| k.trim() == "corename").map(|(_, v)| v.trim().trim_matches('"').to_string()))
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| stem.trim_end_matches("_libretro").to_string())
}

/// A RetroArch setup: the core (its file name without extension) and the retroarch.cfg it runs with, whose folder
/// settings say where saves and states go; the core's name from its info file in INFO_DIRS
pub fn retroarch_setup(cfg: &Path, info_dirs: &[PathBuf], core_stem: &str) -> (String, Setup) {
    let ra = pc::parse(cfg, "portable");
    let name = core_name(info_dirs, core_stem);
    let setup = Setup {
        emulator: format!("core:{name}"),
        saves: ra.saves_dir.map(PathBuf::from),
        states: ra.states_dir.map(PathBuf::from),
        saves_layout: ra.saves_layout,
        states_layout: ra.states_layout,
    };
    (format!("{}|{name}", pc::wire(cfg)), setup)
}

/// Where a RetroArch's core info files are: its libretro_info_path, its own info folder, the system's
pub fn info_dirs(cfg: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = pc::cfg_folder(cfg, "libretro_info_path").into_iter().collect();
    if let Some(d) = cfg.parent() {
        v.push(d.join("info"));
    }
    v.push(PathBuf::from("/usr/share/libretro/info"));
    v
}

/// A frontend's command that runs RetroArch (its program named with "retroarch", or MARKER in it) with a core: the
/// setup with its own -c config, else with DEFAULT_CFG
pub fn retroarch_command(command: &str, marker: &str, default_cfg: &Path) -> Option<(String, Setup)> {
    let a = args(command);
    let retroarch = command.contains(marker) || a.iter().take(3).any(|e| e.to_lowercase().contains("retroarch"));
    let core = flag(&a, &["-L", "--libretro"]).filter(|_| retroarch)?.replace('\\', "/");
    let own_cfg = flag(&a, &["-c", "--config"]).filter(|c| !c.contains('%') && !c.contains('{')).map(PathBuf::from).filter(|p| p.is_file());
    let cfg = own_cfg.as_deref().unwrap_or(default_cfg);
    let stem = Path::new(&core).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let stem = if stem.ends_with("_libretro") { stem } else { format!("{stem}_libretro") };
    Some(retroarch_setup(cfg, &info_dirs(cfg), &stem))
}

pub fn setup_of_retroarch(exe: &Path, command: &str) -> Option<(String, Setup)> {
    let ra_dir = exe.parent()?.to_path_buf();
    let a = args(command);
    let core = flag(&a, &["-L", "--libretro"])?;
    let core_path = path_in(&ra_dir, &core);
    let cfg = flag(&a, &["-c", "--config"]).map(|c| path_in(&ra_dir, &c)).unwrap_or_else(|| ra_dir.join("retroarch.cfg"));
    let stem = core_path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    Some(retroarch_setup(&cfg, &[ra_dir.join("info")], &stem))
}

/// A value of an INI or TOML file: KEY in SECTION ("" for the keys before any section), quotes taken off
pub fn ini_get(path: &Path, section: &str, key: &str) -> Option<String> {
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

pub fn env_dir(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).map(PathBuf::from)
}

pub fn documents() -> PathBuf {
    home().join("Documents")
}

/// A folder setting: none when empty, relative ones under BASE
pub fn setting_dir(value: Option<String>, base: &Path) -> Option<PathBuf> {
    let v = value?.trim().to_string();
    (!v.is_empty()).then(|| normalize(&base.join(v.replace('\\', "/"))))
}

/// Saves of the game next to its rom, or in DIR, with no savestates (each emulator writes its own kind)
pub fn plain(emulator: &str, dir: Option<PathBuf>) -> Setup {
    Setup { emulator: emulator.into(), saves: dir, states: None, saves_layout: "flat".into(), states_layout: "none".into() }
}

/// Emulators other than RetroArch, by their program's name, each read from its own settings
pub fn setup_of_standalone(exe: &Path, name: &str) -> Option<(String, Setup)> {
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
pub fn registry(key: &str, value: &str) -> Option<String> {
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

impl Library {

    /// Several frontends' games as one library (a rom two frontends launch keeps the first one's setup)
    pub fn merge(libs: &[std::sync::Arc<Library>]) -> Option<Library> {
        if libs.is_empty() {
            return None;
        }
        let mut out = Library { name: libs.iter().map(|l| l.name.clone()).collect::<Vec<_>>().join(", "), dir: libs[0].dir.clone(), ..Default::default() };
        for l in libs {
            out.games.extend(l.games.iter().cloned());
            for (k, s) in &l.setups {
                out.setups.entry(k.clone()).or_insert_with(|| s.clone());
            }
            for (k, n) in &l.unsupported {
                *out.unsupported.entry(k.clone()).or_default() += n;
            }
        }
        Some(out)
    }
    pub fn summary(&self) -> Summary {
        Summary {
            name: self.name.clone(),
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

