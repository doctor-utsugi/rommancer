//! This PC as a device of its own: the RetroArch it finds (save and state folders from retroarch.cfg), the folder
//! the user picked for list games, and the background work that keeps it synced like a console does.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Key of this PC in progress events, results and logs (cards use their root)
pub const KEY: &str = "pc";

/// The link of this PC, kept in the app's settings (not inside any folder)
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PcLink {
    pub server: String,
    #[serde(skip_serializing_if = "String::is_empty", default)]
    pub token: String,
    pub device_id: u64,
    pub name: String,
    /// The device root the server joins its folders to: the deepest folder holding saves, states and roms
    pub root: String,
    pub saves_dir: String,
    pub states_dir: String,
    pub roms_dir: String,
    pub saves_layout: String,
    pub states_layout: String,
    pub cfg: Option<String>,
}

/// What a retroarch.cfg says about where saves and states go
#[derive(Serialize, Clone, Debug)]
pub struct RetroArch {
    pub cfg: String,
    /// "flatpak", "portable" or "" (a plain install)
    pub kind: String,
    /// None: next to each game (RetroArch's "content directory")
    pub saves_dir: Option<String>,
    pub states_dir: Option<String>,
    pub saves_layout: String,
    pub states_layout: String,
}

#[derive(Serialize)]
pub struct Detected {
    pub found: Vec<RetroArch>,
    pub roms_default: String,
    pub hostname: String,
}

fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

/// Forward slashes, as the server builds its paths
pub fn wire(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    if s.len() > 1 && s.ends_with('/') && !s.ends_with(":/") {
        s.trim_end_matches('/').to_string()
    } else {
        s
    }
}

fn candidates() -> Vec<(PathBuf, &'static str)> {
    let h = home();
    let mut out = Vec::new();
    if cfg!(target_os = "macos") {
        out.push((h.join("Library/Application Support/RetroArch/config/retroarch.cfg"), ""));
        out.push((h.join("Library/Application Support/RetroArch/retroarch.cfg"), ""));
    } else if cfg!(windows) {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            out.push((PathBuf::from(appdata).join("RetroArch").join("retroarch.cfg"), ""));
        }
        // Installs and portable copies keep retroarch.cfg next to retroarch.exe
        let mut dirs: Vec<PathBuf> = ["ProgramFiles", "ProgramFiles(x86)", "SystemDrive"].iter().filter_map(std::env::var_os).map(PathBuf::from).collect();
        dirs.push(PathBuf::from("C:\\"));
        for base in dirs {
            let base = if base.to_string_lossy().ends_with(':') { PathBuf::from(format!("{}\\", base.to_string_lossy())) } else { base };
            for name in ["RetroArch", "RetroArch-Win64", "RetroArch-Win32"] {
                let dir = base.join(name);
                if dir.join("retroarch.exe").is_file() {
                    out.push((dir.join("retroarch.cfg"), "portable"));
                }
            }
        }
        if let Some(p) = which("retroarch.exe") {
            if let Some(d) = p.parent() {
                out.push((d.join("retroarch.cfg"), "portable"));
            }
        }
    } else {
        let config = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| h.join(".config"));
        out.push((config.join("retroarch/retroarch.cfg"), ""));
        out.push((h.join(".var/app/org.libretro.RetroArch/config/retroarch/retroarch.cfg"), "flatpak"));
        out.push((h.join("snap/retroarch/current/.config/retroarch/retroarch.cfg"), "snap"));
    }
    out
}

fn which(exe: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| std::env::split_paths(&paths).map(|d| d.join(exe)).find(|p| p.is_file()))
}

fn read_cfg(path: &Path) -> HashMap<String, String> {
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.trim().to_string(), v.trim().trim_matches('"').to_string()))
        .collect()
}

/// A folder setting of retroarch.cfg: "~" is the home folder, ":" RetroArch's own folder; "default" or empty
/// means next to the content
fn resolve(value: Option<&String>, cfg_dir: &Path) -> Option<PathBuf> {
    let v = value?.trim();
    if v.is_empty() || v == "default" {
        return None;
    }
    let rest = |s: &str| s.trim_start_matches(['/', '\\']).to_string();
    Some(if let Some(r) = v.strip_prefix('~') {
        home().join(rest(r))
    } else if let Some(r) = v.strip_prefix(':') {
        cfg_dir.join(rest(r))
    } else {
        PathBuf::from(v)
    })
}

fn layout(in_content: bool, by_content: bool, by_core: bool) -> String {
    match (in_content, by_content, by_core) {
        (true, _, _) => "rom",
        (_, true, true) => "content-core",
        (_, true, false) => "content",
        (_, false, true) => "core",
        _ => "flat",
    }
    .into()
}

pub fn parse(cfg: &Path, kind: &str) -> RetroArch {
    let kv = read_cfg(cfg);
    let dir = cfg.parent().unwrap_or(Path::new(".")).to_path_buf();
    let on = |k: &str| kv.get(k).is_some_and(|v| v == "true");
    // A key missing from the file is RetroArch's default: <config>/saves and <config>/states
    let saves = if kv.contains_key("savefile_directory") { resolve(kv.get("savefile_directory"), &dir) } else { Some(dir.join("saves")) };
    let states = if kv.contains_key("savestate_directory") { resolve(kv.get("savestate_directory"), &dir) } else { Some(dir.join("states")) };
    let saves_in_content = on("savefiles_in_content_dir") || saves.is_none();
    let states_in_content = on("savestates_in_content_dir") || states.is_none();
    RetroArch {
        cfg: wire(cfg),
        kind: kind.into(),
        saves_dir: if saves_in_content { None } else { saves.map(|p| wire(&p)) },
        states_dir: if states_in_content { None } else { states.map(|p| wire(&p)) },
        saves_layout: layout(saves_in_content, on("sort_savefiles_by_content_enable"), on("sort_savefiles_enable")),
        states_layout: layout(states_in_content, on("sort_savestates_by_content_enable"), on("sort_savestates_enable")),
    }
}

pub fn detect() -> Detected {
    let mut seen = std::collections::HashSet::new();
    let found = candidates().into_iter().filter(|(p, _)| p.is_file() && seen.insert(p.clone())).map(|(p, k)| parse(&p, k)).collect();
    Detected { found, roms_default: wire(&home().join("Games").join("roms")), hostname: hostname() }
}

#[cfg(unix)]
pub fn hostname() -> String {
    let mut buf = [0u8; 256];
    if unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) } != 0 {
        return "PC".into();
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    let name = String::from_utf8_lossy(&buf[..end]).trim().to_string();
    if name.is_empty() { "PC".into() } else { name }
}

#[cfg(not(unix))]
pub fn hostname() -> String {
    std::env::var("COMPUTERNAME").ok().filter(|n| !n.is_empty()).unwrap_or_else(|| "PC".into())
}

/// The device root and the folders relative to it, as the server's layout takes them. Every path of the server
/// is the root joined with a relative folder, so the root is the deepest folder holding all three (on Windows they
/// must share a drive)
pub fn layout_of(saves: &str, states: &str, roms: &str) -> Result<(String, String, String, String), String> {
    let parts = |p: &str| p.split('/').map(str::to_string).collect::<Vec<_>>();
    let all = [parts(saves), parts(states), parts(roms)];
    let mut common = Vec::new();
    for (i, c) in all[0].iter().enumerate() {
        if all.iter().all(|p| p.get(i).is_some_and(|x| if cfg!(windows) { x.eq_ignore_ascii_case(c) } else { x == c })) {
            common.push(c.clone());
        } else {
            break;
        }
    }
    let root = match common.as_slice() {
        [] => return Err("different drives".into()),
        [first] if first.is_empty() => "/".to_string(),
        [drive] if drive.ends_with(':') => format!("{drive}/"),
        _ => common.join("/"),
    };
    let rel = |p: &str| p.split('/').skip(common.len()).collect::<Vec<_>>().join("/");
    Ok((root, rel(saves), rel(states), rel(roms)))
}

/// Files that look like saves or states in the watched folders, with their size and date: a change means RetroArch
/// wrote one. Folders next to the roms are looked at for saves and states only
pub fn signature(dirs: &[PathBuf]) -> u64 {
    let mut acc: u64 = 0;
    let mut stack: Vec<(PathBuf, u32)> = dirs.iter().map(|d| (d.clone(), 0)).collect();
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_lowercase();
            if name.starts_with('.') {
                continue;
            }
            let Ok(t) = e.file_type() else { continue };
            if t.is_dir() {
                if depth < 4 {
                    stack.push((e.path(), depth + 1));
                }
            } else if t.is_file() && (name.contains(".state") || [".srm", ".sav", ".mcd", ".mcr", ".fs", ".dsv", ".eep", ".fla", ".rtc", ".png"].iter().any(|x| name.ends_with(x))) {
                if let Ok(m) = e.metadata() {
                    let mtime = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos() as u64).unwrap_or(0);
                    let mut h = sha1_smol::Sha1::new();
                    h.update(e.path().to_string_lossy().as_bytes());
                    h.update(&m.len().to_le_bytes());
                    h.update(&mtime.to_le_bytes());
                    let d = h.digest().bytes();
                    // Order-free: the walk order of a folder may change
                    acc = acc.wrapping_add(u64::from_le_bytes([d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7]]));
                }
            }
        }
    }
    acc
}

impl PcLink {
    /// Folders RetroArch writes saves and states to (the games folder when they go next to the games)
    pub fn watched(&self) -> Vec<PathBuf> {
        let mut v = vec![PathBuf::from(&self.saves_dir)];
        if self.states_dir != self.saves_dir {
            v.push(PathBuf::from(&self.states_dir));
        }
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_is_the_deepest_shared_folder() {
        let (root, s, st, r) = layout_of("/home/me/.config/retroarch/saves", "/home/me/.config/retroarch/states", "/home/me/Games/roms").unwrap();
        assert_eq!((root.as_str(), s.as_str(), st.as_str(), r.as_str()), ("/home/me", ".config/retroarch/saves", ".config/retroarch/states", "Games/roms"));
        let (root, _, _, r) = layout_of("/home/me/saves", "/home/me/saves", "/mnt/roms").unwrap();
        assert_eq!((root.as_str(), r.as_str()), ("/", "mnt/roms"));
    }

    #[test]
    fn retroarch_settings() {
        let dir = std::env::temp_dir().join(format!("rommancer-ra-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let cfg = dir.join("retroarch.cfg");
        fs::write(&cfg, "savefile_directory = \":/saves\"\nsavestate_directory = \"default\"\nsort_savefiles_enable = \"true\"\nsort_savefiles_by_content_enable = \"true\"\n").unwrap();
        let ra = parse(&cfg, "");
        assert_eq!(ra.saves_dir.as_deref(), Some(wire(&dir.join("saves")).as_str()));
        assert_eq!(ra.saves_layout, "content-core");
        assert_eq!(ra.states_dir, None);
        assert_eq!(ra.states_layout, "rom");
        let _ = fs::remove_dir_all(dir);
    }
}
