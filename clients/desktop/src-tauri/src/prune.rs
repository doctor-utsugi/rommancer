//! Deleting games that are in none of a device's lists: the device owns the setting, as on the consoles. Its
//! state is kept in files of the same names as the shell client's ($STATE/settings PRUNE_ROMS, prune-set,
//! prune-ask, prune-hold, prune-intro, pruned), so a card synced by the shell client in sd mode and by this app
//! shares it.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct PruneStore {
    dir: PathBuf,
}

/// What the screens need: the setting, the questions waiting for the user and the saves that can be cleaned
#[derive(Serialize, Clone, Debug, Default)]
pub struct PruneInfo {
    pub on: bool,
    /// Turned on from the web app: (games, bytes) it would delete, waiting for the user's answer
    pub ask: Option<(u64, u64)>,
    /// A deletion of more than half of the games, waiting for confirmation: (games, games on the device)
    pub hold: Option<(u64, u64)>,
    /// The choice was offered once
    pub intro: bool,
    /// Games deleted whose saves can still be cleaned
    pub cleanable: u32,
}

fn pair(text: &str) -> Option<(u64, u64)> {
    let mut f = text.trim().split('\t');
    Some((f.next()?.trim().parse().ok()?, f.next().unwrap_or("0").trim().parse().unwrap_or(0)))
}

impl PruneStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn file(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    fn write(&self, name: &str, text: &str) {
        let _ = fs::create_dir_all(&self.dir);
        let _ = fs::write(self.file(name), text);
    }

    fn remove(&self, name: &str) {
        let _ = fs::remove_file(self.file(name));
    }

    fn flag(&self, name: &str) -> bool {
        self.file(name).is_file()
    }

    pub fn on(&self) -> bool {
        fs::read_to_string(self.file("settings"))
            .unwrap_or_default()
            .lines()
            .filter_map(|l| l.split_once('='))
            .filter(|(k, _)| k.trim() == "PRUNE_ROMS")
            .next_back()
            .is_some_and(|(_, v)| v.trim().trim_matches('"') == "1")
    }

    /// PRUNE_ROMS in the settings file, keeping its other lines
    fn set_on(&self, on: bool) {
        let rest: String = fs::read_to_string(self.file("settings")).unwrap_or_default().lines().filter(|l| !l.starts_with("PRUNE_ROMS=")).map(|l| format!("{l}\n")).collect();
        self.write("settings", &format!("{rest}PRUNE_ROMS={}\n", u8::from(on)));
    }

    /// A change the server has not heard yet (X-Prune-Set)
    pub fn pending(&self) -> bool {
        self.flag("prune-set")
    }

    pub fn heard(&self) {
        self.remove("prune-set");
    }

    pub fn ask(&self) -> Option<(u64, u64)> {
        pair(&fs::read_to_string(self.file("prune-ask")).ok()?)
    }

    pub fn hold(&self) -> Option<(u64, u64)> {
        pair(&fs::read_to_string(self.file("prune-hold")).ok()?)
    }

    pub fn set_hold(&self, hold: Option<(u64, u64)>) {
        match hold {
            Some((n, total)) => self.write("prune-hold", &format!("{n}\t{total}\n")),
            None => self.remove("prune-hold"),
        }
    }

    /// A change made here, or the answer to one made in the web app: the server hears it at the next sync
    pub fn set(&self, on: bool) {
        self.set_on(on);
        self.write("prune-set", "");
        self.write("prune-intro", "");
        self.remove("prune-ask");
        if !on {
            self.remove("prune-hold");
        }
    }

    /// The server's "prune<TAB>value<TAB>files<TAB>bytes" line (a change made in the web app), or none: off applies
    /// at once, on waits for the user
    pub fn answer(&self, line: Option<&[String]>) {
        let Some(f) = line else {
            self.remove("prune-ask");
            return;
        };
        if f.get(1).map(String::as_str) == Some("1") {
            let n = |i: usize| f.get(i).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
            self.write("prune-ask", &format!("{}\t{}\n", n(2), n(3)));
        } else {
            self.remove("prune-ask");
            self.set_on(false);
            self.remove("prune-hold");
            self.write("prune-set", "");
        }
    }

    /// Deletion runs only with the setting on and no question from the web app waiting
    pub fn active(&self) -> bool {
        self.on() && !self.flag("prune-ask")
    }

    pub fn pruned(&self) -> Vec<String> {
        fs::read_to_string(self.file("pruned")).unwrap_or_default().lines().filter(|l| !l.trim().is_empty()).map(str::to_string).collect()
    }

    pub fn add_pruned(&self, paths: &[String]) {
        if paths.is_empty() {
            return;
        }
        let mut text = fs::read_to_string(self.file("pruned")).unwrap_or_default();
        for p in paths {
            text.push_str(p);
            text.push('\n');
        }
        self.write("pruned", &text);
    }

    pub fn clear_pruned(&self) {
        self.remove("pruned");
    }

    pub fn info(&self) -> PruneInfo {
        PruneInfo { on: self.on(), ask: self.ask(), hold: self.hold(), intro: self.flag("prune-intro"), cleanable: self.pruned().len() as u32 }
    }
}

/// Forward slashes and no trailing one ("/" and "E:/" trim to "" and "E:")
fn norm(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_string()
}

/// PATH is a file below DIR, with no "." or ".." on the way; DEPTH: the folders it must be in below DIR at least
pub fn below(path: &str, dir: &str, depth: usize) -> bool {
    let (path, dir) = (path.replace('\\', "/"), norm(dir));
    let Some(rest) = path.strip_prefix(&format!("{dir}/")) else { return false };
    let parts: Vec<&str> = rest.split('/').collect();
    parts.len() > depth && parts.iter().all(|c| !c.is_empty() && *c != "." && *c != "..")
}

/// DIR is ROOT itself or a folder below it
pub fn within(dir: &str, root: &str) -> bool {
    norm(dir) == norm(root) || below(dir, root, 0)
}

/// A game of the roms folder the server's plan names: <roms>/<system>/<file> (or deeper), nothing above
pub fn deletable(path: &str, roms: &str) -> bool {
    !norm(roms).is_empty() && below(path, roms, 1)
}

/// The file itself, never a link or a folder
pub fn is_plain_file(p: &Path) -> bool {
    fs::symlink_metadata(p).map(|m| m.file_type().is_file()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deletable_only_inside_a_system_folder() {
        assert!(deletable("/home/me/Games/snes/Mario.sfc", "/home/me/Games"));
        assert!(deletable("/home/me/Games/snes/sub/Mario.sfc", "/home/me/Games/"));
        assert!(deletable("E:/Games/gba/x.gba", "E:/Games"));
        assert!(deletable("E:/roms/gba/x.gba", "E:\\roms"));
        // Loose in the roms folder, outside it, a sibling with the same prefix, climbing out
        assert!(!deletable("/home/me/Games/Mario.sfc", "/home/me/Games"));
        assert!(!deletable("/home/me/Other/snes/Mario.sfc", "/home/me/Games"));
        assert!(!deletable("/home/me/Games2/snes/Mario.sfc", "/home/me/Games"));
        assert!(!deletable("/home/me/Games/snes/../../.bashrc", "/home/me/Games"));
        assert!(!deletable("/home/me/Games/snes/./x", "/home/me/Games"));
        assert!(!deletable("/home/me/Games//x", "/home/me/Games"));
        assert!(!deletable("/home/me/Games/snes/", "/home/me/Games"));
        // No roms folder known: nothing goes
        assert!(!deletable("/snes/x.sfc", "/"));
        assert!(!deletable("/snes/x.sfc", ""));
    }

    #[test]
    fn within_the_device_root() {
        assert!(within("/home/me/Games", "/home/me"));
        assert!(within("/home/me", "/home/me/"));
        assert!(within("/media/card/Roms", "/"));
        assert!(within("E:/Roms", "E:/"));
        assert!(!within("/home/meow", "/home/me"));
        assert!(!within("/home/me/../x", "/home/me"));
    }

    #[test]
    fn store_follows_the_shell_client() {
        let dir = std::env::temp_dir().join(format!("rommancer-prune-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let s = PruneStore::new(dir.clone());
        assert!(!s.on() && !s.info().intro);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("settings"), "AUTO_ROMS=1\nPRUNE_ROMS=0\n").unwrap();
        s.set(true);
        assert!(s.on() && s.pending() && s.info().intro && s.active());
        assert_eq!(fs::read_to_string(dir.join("settings")).unwrap(), "AUTO_ROMS=1\nPRUNE_ROMS=1\n");
        s.heard();
        assert!(!s.pending());
        // Turned on from the web app: waits for the user
        s.set(false);
        s.heard();
        let line: Vec<String> = ["prune", "1", "12", "3456"].iter().map(|x| x.to_string()).collect();
        s.answer(Some(&line));
        assert_eq!(s.ask(), Some((12, 3456)));
        assert!(!s.active());
        // Turned off from the web app: at once
        s.set(true);
        s.set_hold(Some((9, 10)));
        let off: Vec<String> = ["prune", "0", "0", "0"].iter().map(|x| x.to_string()).collect();
        s.answer(Some(&off));
        assert!(!s.on() && s.pending() && s.hold().is_none() && s.ask().is_none());
        s.add_pruned(&["/a/b/c.sfc".into(), "/a/b/d.sfc".into()]);
        assert_eq!(s.info().cleanable, 2);
        s.clear_pruned();
        assert_eq!(s.info().cleanable, 0);
        let _ = fs::remove_dir_all(&dir);
    }
}
