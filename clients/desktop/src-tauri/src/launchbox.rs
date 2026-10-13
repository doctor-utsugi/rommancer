//! LaunchBox on this PC: the games it launches, the emulator each one opens with (the game's own, else its
//! platform's default) and where that emulator keeps saves and states. RetroArch is read from its command line
//! (-L core, -c config) and its retroarch.cfg; emulators Rommancer cannot read yet are counted, not guessed.

use crate::frontend::{child, home, path_in, read_xml, setup_of_retroarch, setup_of_standalone, Library, Game, Setup};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

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

pub fn read(dir: &Path) -> Library {
    let mut lib = Library { name: "LaunchBox".into(), dir: dir.to_path_buf(), ..Default::default() };
    let data = dir.join("Data");
    let mut emulators: HashMap<String, Emulator> = HashMap::new();
    let mut by_platform: HashMap<String, Vec<PlatformEmu>> = HashMap::new();
    if let Some(text) = read_xml(&data.join("Emulators.xml")) {
        if let Ok(doc) = roxmltree::Document::parse(&text) {
            for n in doc.root_element().children().filter(|n| n.is_element()) {
                if n.has_tag_name("Emulator") {
                    emulators.insert(child(n, "ID").to_lowercase(), Emulator { title: child(n, "Title").to_string(), exe: path_in(dir, child(n, "ApplicationPath")), command: child(n, "CommandLine").to_string() });
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
            let rom = path_in(dir, app);
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
