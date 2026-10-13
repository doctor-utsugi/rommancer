//! Playnite (Windows): Rommancer's extension in it writes its emulated games, each rom with its platform and the
//! emulator command it runs with, to playnite.tsv next to the app's hook.json, and tells the app when games start
//! and end. RetroArch and the emulators frontend.rs reads are synced; others are counted as not synced yet

use crate::frontend::{retroarch_command, setup_of_standalone, Game, Library};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Rommancer's extension for Playnite, built from clients/playnite
const PLUGIN: &[u8] = include_bytes!("../resources/playnite/Rommancer.Playnite.dll");
const MANIFEST: &str = include_str!("../resources/playnite/extension.yaml");

fn running_exe() -> Option<PathBuf> {
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    sys.processes()
        .values()
        .find(|p| {
            let n = p.name().to_string_lossy().to_lowercase();
            n == "playnite.desktopapp.exe" || n == "playnite.fullscreenapp.exe"
        })
        .and_then(|p| p.exe().map(Path::to_path_buf))
}

/// Playnite's folders that load extensions: the user's (an installed Playnite) and the one beside the running
/// program (a portable one)
fn extension_dirs() -> Vec<PathBuf> {
    let mut v = vec![];
    if let Some(a) = std::env::var_os("APPDATA").map(PathBuf::from).map(|a| a.join("Playnite")).filter(|d| d.is_dir()) {
        v.push(a.join("Extensions"));
    }
    if let Some(d) = running_exe().and_then(|e| e.parent().map(|p| p.join("Extensions"))).filter(|d| d.is_dir()) {
        v.push(d);
    }
    v.dedup();
    v
}

/// Puts the extension in DIR when it is missing or older (a loaded one is renamed out of the way); true when it
/// was written
fn install(dir: &Path) -> std::io::Result<bool> {
    let folder = dir.join("Rommancer");
    let file = folder.join("Rommancer.Playnite.dll");
    let manifest = folder.join("extension.yaml");
    if fs::read(&file).is_ok_and(|b| b == PLUGIN) && fs::read_to_string(&manifest).is_ok_and(|t| t == MANIFEST) {
        return Ok(false);
    }
    fs::create_dir_all(&folder)?;
    if fs::write(&file, PLUGIN).is_err() {
        let old = folder.join("Rommancer.Playnite.dll.old");
        let _ = fs::remove_file(&old);
        fs::rename(&file, &old)?;
        fs::write(&file, PLUGIN)?;
    }
    fs::write(&manifest, MANIFEST)?;
    Ok(true)
}

fn export_file() -> PathBuf {
    crate::hook::info_file().with_file_name("playnite.tsv")
}

pub fn read(file: &Path, dir: &Path) -> Library {
    let mut lib = Library { name: "Playnite".into(), dir: dir.to_path_buf(), ..Default::default() };
    let text = fs::read_to_string(file).unwrap_or_default();
    let mut by_command: HashMap<(String, String), Result<String, String>> = HashMap::new();
    let mut seen = HashSet::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split('\t').collect();
        let [kind, rom, platform, exe, cmd_args] = f[..] else { continue };
        if kind != "game" || !seen.insert(rom.to_string()) {
            continue;
        }
        let exe_path = PathBuf::from(exe.replace('\\', "/"));
        let name = exe_path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        let got = by_command
            .entry((exe.to_string(), cmd_args.to_string()))
            .or_insert_with(|| {
                let found = if name.contains("retroarch") {
                    // A portable RetroArch keeps its retroarch.cfg beside it, an installed one where RetroArch looks
                    let beside = exe_path.parent().map(|d| d.join("retroarch.cfg")).unwrap_or_default();
                    let cfg = if beside.is_file() { beside } else { crate::pc::retroarch_cfgs().into_iter().next().unwrap_or(beside) };
                    retroarch_command(&format!("\"{exe}\" {cmd_args}"), "retroarch", &cfg)
                } else {
                    setup_of_standalone(&exe_path, &name)
                };
                match found {
                    Some((key, setup)) => {
                        lib.setups.entry(key.clone()).or_insert(setup);
                        Ok(key)
                    }
                    None => Err(exe_path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| exe.to_string())),
                }
            })
            .clone();
        match got {
            Ok(setup) => lib.games.push(Game { rom: PathBuf::from(rom), platform: platform.to_string(), setup }),
            Err(emulator) => *lib.unsupported.entry(emulator).or_default() += 1,
        }
    }
    lib
}

fn stamp(file: &Path) -> Option<(u64, std::time::SystemTime)> {
    fs::metadata(file).ok().map(|m| (m.len(), m.modified().unwrap_or(std::time::UNIX_EPOCH)))
}

/// The extension put in Playnite once a minute, the library read again when the extension wrote it
#[derive(Default)]
pub struct Cache {
    checked: Option<std::time::Instant>,
    /// Written while Playnite ran: it loads extensions when it starts
    restart: bool,
    read: Option<(Option<(u64, std::time::SystemTime)>, Arc<Library>)>,
}

impl Cache {
    pub fn get(&mut self) -> Option<Arc<Library>> {
        if !cfg!(windows) {
            return None;
        }
        if self.checked.is_none_or(|t| t.elapsed() >= std::time::Duration::from_secs(60)) {
            self.checked = Some(std::time::Instant::now());
            let running = running_exe().is_some();
            let wrote = extension_dirs().iter().any(|d| install(d).unwrap_or(false));
            self.restart = (self.restart || wrote) && running;
        }
        let file = export_file();
        let s = stamp(&file)?;
        if !self.read.as_ref().is_some_and(|(old, _)| *old == Some(s)) {
            let dir = std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("Playnite")).unwrap_or_default();
            self.read = Some((Some(s), Arc::new(read(&file, &dir))));
        }
        self.read.as_ref().map(|(_, l)| l.clone())
    }

    pub fn needs_restart(&self) -> bool {
        self.restart
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn games_get_the_setup_of_their_emulator() {
        let base = std::env::temp_dir().join(format!("rommancer-playnite-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let ra = base.join("RetroArch");
        fs::create_dir_all(ra.join("info")).unwrap();
        fs::write(ra.join("retroarch.exe"), "").unwrap();
        fs::write(ra.join("retroarch.cfg"), "savefile_directory = \"/saves\"\n").unwrap();
        fs::write(ra.join("info/snes9x_libretro.info"), "corename = \"Snes9x\"\n").unwrap();
        let exe = crate::pc::wire(&ra.join("retroarch.exe"));
        let file = base.join("playnite.tsv");
        fs::write(
            &file,
            format!("game\t/roms/Mario.sfc\tNintendo SNES\t{exe}\t-L \".\\cores\\snes9x_libretro.dll\" \"{{ImagePath}}\" \ngame\t/roms/Other.iso\tSony PlayStation 2\tC:/Emus/Other/other.exe\t\"{{ImagePath}}\"\n"),
        )
        .unwrap();
        let lib = read(&file, &base);
        assert_eq!(lib.games.len(), 1);
        assert_eq!(lib.games[0].platform, "Nintendo SNES");
        assert_eq!(lib.setups[&lib.games[0].setup].emulator, "core:Snes9x");
        assert_eq!(lib.unsupported.get("other"), Some(&1));
        let _ = fs::remove_dir_all(&base);
    }
}
