//! Pegasus: the collections of its metadata files (in the game folders of game_dirs.txt and in its metafiles
//! folder), the roms each one holds and the command each runs them with (a game's own, else its collection's).
//! RetroArch games are synced; games of other emulators are counted as not synced yet

use crate::frontend::{args, home, normalize, path_in, retroarch_command, Game, Library, Setup};
use crate::pc;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Pegasus's configuration folder on this OS (its flatpak's on Linux too)
pub fn detect() -> Option<PathBuf> {
    let h = home();
    let dirs = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("pegasus-frontend")).into_iter().collect()
    } else if cfg!(target_os = "macos") {
        vec![h.join("Library/Preferences/pegasus-frontend")]
    } else {
        let config = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| h.join(".config"));
        vec![config.join("pegasus-frontend"), h.join(".var/app/org.pegasus_frontend.Pegasus/config/pegasus-frontend")]
    };
    dirs.into_iter().find(|d| d.join("game_dirs.txt").is_file() || d.join("metafiles").is_dir())
}

/// A metadata file's entries: (key, value), a value's indented lines joined to it
fn entries(text: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = vec![];
    for line in text.lines() {
        if line.trim_start().starts_with('#') || line.trim().is_empty() {
            continue;
        }
        if line.starts_with(char::is_whitespace) {
            if let Some((_, v)) = out.last_mut() {
                let more = line.trim();
                if more != "." {
                    v.push('\n');
                    v.push_str(more);
                }
            }
        } else if let Some((k, v)) = line.split_once(':') {
            out.push((k.trim().to_lowercase(), v.trim().to_string()));
        }
    }
    out
}

/// The items of a list value: one per line, or comma separated on one line
fn items(v: &str) -> Vec<String> {
    v.split(['\n', ',']).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
}

#[derive(Default, Debug)]
struct Collection {
    name: String,
    shortname: String,
    launch: String,
    extensions: HashSet<String>,
    files: Vec<PathBuf>,
    directories: Vec<PathBuf>,
    ignore: HashSet<PathBuf>,
}

/// A metadata file's collections, and the commands its games run with (by rom)
fn read_metafile(path: &Path) -> (Vec<Collection>, HashMap<PathBuf, String>) {
    let base = path.parent().unwrap_or(Path::new(".")).to_path_buf();
    let text = crate::frontend::read_xml(path).unwrap_or_default();
    let (mut cols, mut own): (Vec<Collection>, HashMap<PathBuf, String>) = (vec![], HashMap::new());
    // The game block being read: its files and command
    let mut game: Option<(Vec<PathBuf>, String)> = None;
    let end_game = |g: &mut Option<(Vec<PathBuf>, String)>, own: &mut HashMap<PathBuf, String>| {
        if let Some((files, launch)) = g.take() {
            if !launch.is_empty() {
                for f in files {
                    own.insert(f, launch.clone());
                }
            }
        }
    };
    for (k, v) in entries(&text) {
        match k.as_str() {
            "collection" => {
                end_game(&mut game, &mut own);
                cols.push(Collection { name: v, directories: vec![base.clone()], ..Default::default() });
            }
            "game" => {
                end_game(&mut game, &mut own);
                game = Some((vec![], String::new()));
            }
            _ => match (&mut game, cols.last_mut()) {
                (Some((files, launch)), _) => match k.as_str() {
                    "file" | "files" => files.extend(items(&v).iter().map(|f| path_in(&base, f))),
                    "launch" | "command" => *launch = v.replace('\n', " "),
                    _ => {}
                },
                (None, Some(c)) => match k.as_str() {
                    "shortname" => c.shortname = v,
                    "launch" | "command" => c.launch = v.replace('\n', " "),
                    "extension" | "extensions" => c.extensions.extend(items(&v).iter().map(|e| format!(".{}", e.trim_start_matches('.').to_lowercase()))),
                    "file" | "files" => c.files.extend(items(&v).iter().map(|f| path_in(&base, f))),
                    "directory" | "directories" => c.directories.extend(items(&v).iter().map(|d| path_in(&base, d))),
                    "ignore-file" | "ignore-files" => c.ignore.extend(items(&v).iter().map(|f| path_in(&base, f))),
                    _ => {}
                },
                _ => {}
            },
        }
    }
    end_game(&mut game, &mut own);
    (cols, own)
}

fn walk(dir: &Path, exts: &HashSet<String>, depth: u32, out: &mut Vec<PathBuf>) {
    if depth > 8 {
        return;
    }
    for e in fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if p.is_dir() {
            walk(&p, exts, depth + 1, out);
        } else if name.rfind('.').is_some_and(|i| exts.contains(&name[i..].to_lowercase())) {
            out.push(p);
        }
    }
}

/// Pegasus's metadata files: the one of each game folder, and every one in its metafiles folder
fn metafiles(dir: &Path) -> Vec<PathBuf> {
    let mut out = vec![];
    let game_dirs = fs::read_to_string(dir.join("game_dirs.txt")).unwrap_or_default();
    for line in game_dirs.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
        let d = path_in(dir, line);
        if let Some(f) = ["metadata.pegasus.txt", "metadata.txt"].iter().map(|n| d.join(n)).find(|f| f.is_file()) {
            out.push(f);
        }
    }
    let mut extra: Vec<PathBuf> = fs::read_dir(dir.join("metafiles")).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.to_string_lossy().ends_with(".txt")).collect();
    extra.sort();
    out.extend(extra);
    out
}

/// The retroarch.cfg a command's RetroArch reads: its flatpak's, the one next to the program it names, else the one
/// RetroArch itself would use
fn default_cfg(command: &str) -> Option<PathBuf> {
    if command.contains("org.libretro.RetroArch") {
        return Some(home().join(".var/app/org.libretro.RetroArch/config/retroarch/retroarch.cfg")).filter(|p| p.is_file());
    }
    let exe = args(command).into_iter().next().map(PathBuf::from);
    exe.and_then(|e| e.parent().map(|d| d.join("retroarch.cfg"))).filter(|p| p.is_file()).or_else(|| pc::retroarch_cfgs().into_iter().next())
}

/// What runs a command: the RetroArch setup's key, or the emulator's name when Rommancer cannot read it
fn setup_of(command: &str, setups: &mut BTreeMap<String, Setup>) -> Result<String, String> {
    let program = || args(command).into_iter().next().map(|p| normalize(Path::new(&p.replace('\\', "/"))).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(p)).unwrap_or_default();
    let Some(cfg) = default_cfg(command) else { return Err(program()) };
    match retroarch_command(command, "org.libretro.RetroArch", &cfg) {
        Some((key, setup)) => {
            setups.entry(key.clone()).or_insert(setup);
            Ok(key)
        }
        None => Err(program()),
    }
}

pub fn read(dir: &Path) -> Library {
    let mut lib = Library { name: "Pegasus".into(), dir: dir.to_path_buf(), ..Default::default() };
    let mut seen = HashSet::new();
    let mut by_command: HashMap<String, Result<String, String>> = HashMap::new();
    for meta in metafiles(dir) {
        let (cols, own) = read_metafile(&meta);
        for c in cols {
            let mut files = c.files.clone();
            if !c.extensions.is_empty() {
                for d in &c.directories {
                    walk(d, &c.extensions, 0, &mut files);
                }
            }
            let platform = if c.shortname.is_empty() { c.name.clone() } else { c.shortname.clone() };
            for rom in files {
                if c.ignore.contains(&rom) || !seen.insert(rom.clone()) {
                    continue;
                }
                let command = own.get(&rom).unwrap_or(&c.launch).clone();
                if command.is_empty() {
                    continue;
                }
                let got = by_command.entry(command.clone()).or_insert_with(|| setup_of(&command, &mut lib.setups)).clone();
                match got {
                    Ok(setup) => lib.games.push(Game { rom, platform: platform.clone(), setup }),
                    Err(emulator) => *lib.unsupported.entry(emulator).or_default() += 1,
                }
            }
        }
    }
    lib
}

/// When Pegasus's game folders, metadata files or the folders they hold last changed
fn stamp(dir: &Path) -> u64 {
    let mut files = vec![dir.join("game_dirs.txt"), dir.join("metafiles")];
    for m in metafiles(dir) {
        if let Some(d) = m.parent() {
            files.extend(fs::read_dir(d).into_iter().flatten().flatten().map(|e| e.path()));
        }
        files.push(m);
    }
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

/// The library, read again when its files changed; Pegasus's folder looked for once a minute
#[derive(Default)]
pub struct Cache {
    found: Option<(std::time::Instant, Option<PathBuf>)>,
    read: Option<(PathBuf, u64, Arc<Library>)>,
}

impl Cache {
    pub fn get(&mut self) -> Option<Arc<Library>> {
        if self.found.as_ref().is_none_or(|(at, _)| at.elapsed() >= std::time::Duration::from_secs(60)) {
            self.found = Some((std::time::Instant::now(), detect()));
        }
        let Some(dir) = self.found.as_ref().and_then(|(_, d)| d.clone()) else {
            self.read = None;
            return None;
        };
        let s = stamp(&dir);
        if !self.read.as_ref().is_some_and(|(d, old, _)| *d == dir && *old == s) {
            self.read = Some((dir.clone(), s, Arc::new(read(&dir))));
        }
        self.read.as_ref().map(|(_, _, l)| l.clone())
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
    fn collections_hold_their_folders_roms_and_games_their_own_command() {
        let base = std::env::temp_dir().join(format!("rommancer-pegasus-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let ra = base.join("RetroArch");
        write(&ra.join("retroarch"), "");
        write(&ra.join("retroarch.cfg"), "savefile_directory = \"/saves\"\nsavestate_directory = \"/states\"\n");
        write(&ra.join("info/snes9x_libretro.info"), "corename = \"Snes9x\"\n");
        let roms = base.join("roms");
        write(&roms.join("snes/Mario.sfc"), "x");
        write(&roms.join("snes/sub/Zelda.smc"), "x");
        write(&roms.join("snes/Skip.sfc"), "x");
        write(&roms.join("snes/Own.sfc"), "x");
        write(
            &roms.join("snes/metadata.pegasus.txt"),
            &format!(
                "# My games\ncollection: Super Nintendo\nshortname: snes\nextensions: sfc, smc\nignore-files:\n  Skip.sfc\nlaunch: {} -L {}/cores/snes9x_libretro.so\n  \"{{file.path}}\"\n\ngame: Own\nfile: Own.sfc\nlaunch: /opt/bsnes \"{{file.path}}\"\n",
                pc::wire(&ra.join("retroarch")),
                pc::wire(&ra)
            ),
        );
        let config = base.join("pegasus-frontend");
        write(&config.join("game_dirs.txt"), &format!("{}\n", pc::wire(&roms.join("snes"))));
        let lib = read(&config);
        let mut got: Vec<(String, String, String)> = lib.games.iter().map(|g| (g.rom.file_name().unwrap().to_string_lossy().to_string(), g.platform.clone(), g.setup.clone())).collect();
        got.sort();
        let key = format!("{}|Snes9x", pc::wire(&ra.join("retroarch.cfg")));
        assert_eq!(got, vec![("Mario.sfc".into(), "snes".into(), key.clone()), ("Zelda.smc".into(), "snes".into(), key.clone())]);
        assert_eq!(lib.unsupported.get("bsnes"), Some(&1));
        assert_eq!(lib.setups[&key].emulator, "core:Snes9x");
        let _ = fs::remove_dir_all(&base);
    }
}
