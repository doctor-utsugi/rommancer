//! One card's sync, the same protocol as the console clients: list roms (with hashes) and saves, let the
//! server decide, move the files it says; then the roms the server asked for and the roms of the lists.

use crate::api::{b64, pairs, DeviceApi};
use crate::prune::{self, PruneStore};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Roms up to this size are hashed (once, cached), so games are recognised whatever their file name
const HASH_MAX: u64 = 64 * 1024 * 1024;
const THUMB_MAX: u64 = 4 * 1024 * 1024;
const NOT_ROMS: &[&str] = &[
    ".png", ".jpg", ".jpeg", ".mp4", ".xml", ".txt", ".json", ".cfg", ".db", ".ini", ".pdf", ".srm", ".sav", ".mcd", ".mcr", ".dsv", ".cht", ".log", ".sh", ".lpl", ".part", ".pem",
];

#[derive(Serialize, Clone, Default)]
pub struct Progress {
    /// The card's root, or "pc" for this PC
    pub root: String,
    /// connecting, roms, saves, server, transfer, config, prune, pulls, roms-plan, roms-download
    pub phase: String,
    /// Numbered steps, so the bar never seems to go back: saves, settings, prune, sending, games
    pub step: u32,
    pub steps: u32,
    pub step_name: String,
    pub done: u64,
    pub total: u64,
    pub file: String,
    pub file_done: u64,
    pub file_total: u64,
}

/// What a sync did, one fact per field (the UI shows the ones that are not zero)
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct Outcome {
    pub saves_up: u32,
    pub saves_down: u32,
    pub states_up: u32,
    pub states_down: u32,
    /// List games copied here
    pub games_down: u32,
    pub games_failed: u32,
    /// Games the server asked for, sent
    pub games_sent: u32,
    /// Games deleted for being in no list
    pub games_deleted: u32,
    /// Save and state files of those games removed
    pub saves_cleaned: u32,
    pub errors: u32,
    /// Configuration work done on the card (copies, the user's settings, restores)
    pub config: u32,
    /// Saves of this device waiting for the user's choice
    pub conflicts: u32,
}

impl Outcome {
    /// The machine-readable summary lines of the console clients ("sum<TAB>key<TAB>n")
    pub fn sum_lines(&self) -> Vec<String> {
        [
            ("saves-up", self.saves_up),
            ("saves-down", self.saves_down),
            ("states-up", self.states_up),
            ("states-down", self.states_down),
            ("games-down", self.games_down),
            ("games-sent", self.games_sent),
            ("games-deleted", self.games_deleted),
            ("saves-cleaned", self.saves_cleaned),
            ("conflicts", self.conflicts),
            ("errors", self.errors + self.games_failed),
        ]
        .iter()
        .filter(|(_, n)| *n > 0)
        .map(|(k, n)| format!("sum\t{k}\t{n}"))
        .collect()
    }
}

/// A save of this device that changed here and on the server
#[derive(Serialize, Clone)]
pub struct Conflict {
    pub id: u64,
    pub game: String,
    pub kind: String,
    pub device_date: String,
    pub server_date: String,
    pub server_device: String,
    /// Both dates as people read them in the server's time zone, that zone, when both last had the same save and
    /// which is newer ("device" or "server"); empty from servers that do not send them
    pub device_when: String,
    pub server_when: String,
    pub zone: String,
    pub since: String,
    pub newer: String,
}

/// A "conflict" line of the server (its conflictLine)
pub fn conflict_of(l: &[String]) -> Option<Conflict> {
    if l.len() < 7 || l[0] != "conflict" {
        return None;
    }
    let f = |i: usize| l.get(i).filter(|v| v.as_str() != "-").cloned().unwrap_or_default();
    Some(Conflict {
        id: l[1].parse().ok()?,
        game: l[2].clone(),
        kind: l[3].clone(),
        device_date: l[4].clone(),
        server_date: l[5].clone(),
        server_device: l[6].clone(),
        device_when: f(8),
        server_when: f(9),
        zone: f(10),
        since: f(11),
        newer: f(12),
    })
}

pub struct Engine<'a> {
    pub api: DeviceApi,
    /// Name of this sync in progress events: the card's root, or "pc"
    pub key: String,
    /// Where the files are (the card's root, or the device root of this PC)
    pub root: String,
    pub cache_file: PathBuf,
    pub report: &'a dyn Fn(Progress),
    pub cancelled: &'a dyn Fn() -> bool,
    pub log: &'a dyn Fn(String),
    /// The steps of this run, in order: saves, settings, prune, sending, games
    pub steps: Vec<&'static str>,
    /// Whether the server may ask this device for games (X-Allow-Pull)
    pub allow_pull: bool,
    /// Deleting games in no list, for a device whose setting is kept here (X-Prune); none: the server is not told
    pub prune: Option<PruneStore>,
    /// The roms folder this device knows for itself (this PC): deletions stay inside it whatever the server says
    pub roms_dir: Option<String>,
    /// The games LaunchBox launches on this PC, synced with the emulator each one opens with
    pub library: Option<std::sync::Arc<crate::frontend::Library>>,
    cache: HashMap<String, (u64, u64, String)>,
}

/// The step a phase belongs to
fn step_of(phase: &str) -> &'static str {
    match phase {
        "config" => "settings",
        "prune" => "prune",
        "pulls" => "sending",
        "roms-plan" | "roms-download" => "games",
        _ => "saves",
    }
}

fn is_state(path: &str) -> bool {
    let n = lower(path);
    n.contains(".state") || n.ends_with(".st0") || n.ends_with(".sav.state")
}

fn lower(s: &str) -> String {
    s.to_lowercase()
}

fn header_size(path: &Path, size: u64) -> u64 {
    let n = lower(&path.to_string_lossy());
    if n.ends_with(".nes") || n.ends_with(".fds") {
        16
    } else if n.ends_with(".lnx") {
        64
    } else if n.ends_with(".a78") {
        128
    } else if [".smc", ".sfc", ".swc", ".fig"].iter().any(|e| n.ends_with(e)) && size % 1024 == 512 {
        512
    } else {
        0
    }
}

fn is_save(name: &str, exts: &[String]) -> bool {
    let n = lower(name);
    exts.iter().any(|e| {
        if n.ends_with(e.as_str()) || n.ends_with(&format!("{e}.auto")) {
            return true;
        }
        // RetroArch slots: .state1 .. .state9
        n.len() > e.len() && n[..n.len() - 1].ends_with(e.as_str()) && n.chars().last().is_some_and(|c| c.is_ascii_digit())
    })
}

fn is_rom(name: &str, exts: &[String]) -> bool {
    let n = lower(name);
    !n.starts_with('.') && !NOT_ROMS.iter().any(|e| n.ends_with(e)) && !n.contains(".state") && !is_save(&n, exts)
}

fn mtime(meta: &fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0)
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if e.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        match e.file_type() {
            Ok(t) if t.is_dir() => walk(&p, out),
            Ok(t) if t.is_file() => out.push(p),
            _ => {}
        }
    }
}

/// PSP memory sticks' SAVEDATA folders under DIR (a few levels down)
fn savedata_dirs(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        if !e.file_type().is_ok_and(|t| t.is_dir()) || e.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let p = e.path();
        if e.file_name() == "SAVEDATA" && dir.file_name().is_some_and(|n| n == "PSP") {
            out.push(p);
        } else if depth < 4 {
            savedata_dirs(&p, depth + 1, out);
        }
    }
}

/// A save file's content to upload; a path ending in "/" is a save folder, sent as its tar
pub fn read_save(path: &str) -> Result<Vec<u8>> {
    match path.strip_suffix('/') {
        Some(dir) => crate::folder::pack(Path::new(dir)),
        None => Ok(fs::read(path)?),
    }
}

/// Paths travel with forward slashes, as the server builds them from the root it was given
fn wire(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

impl<'a> Engine<'a> {
    pub fn new(api: DeviceApi, key: String, root: String, cache_file: PathBuf, report: &'a dyn Fn(Progress), cancelled: &'a dyn Fn() -> bool, log: &'a dyn Fn(String)) -> Self {
        let mut cache = HashMap::new();
        if let Ok(text) = fs::read_to_string(&cache_file) {
            for l in text.lines() {
                let f: Vec<&str> = l.split('\t').collect();
                if f.len() == 4 {
                    if let (Ok(s), Ok(m)) = (f[1].parse(), f[2].parse()) {
                        cache.insert(f[0].to_string(), (s, m, f[3].to_string()));
                    }
                }
            }
        }
        Self { api, key, root, cache_file, report, cancelled, log, steps: vec!["saves"], allow_pull: true, prune: None, roms_dir: None, library: None, cache }
    }

    /// A progress event with its step filled in
    fn emit(&self, mut p: Progress) {
        let name = step_of(&p.phase);
        p.root = self.key.clone();
        p.step = self.steps.iter().position(|s| *s == name).map(|i| i as u32 + 1).unwrap_or(1);
        p.steps = self.steps.len() as u32;
        p.step_name = name.into();
        (self.report)(p);
    }

    fn progress(&self, phase: &str, done: u64, total: u64) {
        self.emit(Progress { phase: phase.into(), done, total, ..Default::default() });
    }

    /// Saves of this device waiting for the user's choice
    pub fn conflicts(&self) -> Result<Vec<Conflict>> {
        Ok(pairs(&self.api.get_text("/agent/conflicts")?).iter().filter_map(|l| conflict_of(l)).collect())
    }

    fn check(&self) -> Result<()> {
        if (self.cancelled)() {
            bail!("cancelled");
        }
        Ok(())
    }

    /// sha1 of a file, skipping SKIP leading bytes; cached by size and mtime
    fn sha1(&mut self, path: &Path, skip: u64) -> Result<String> {
        let meta = fs::metadata(path)?;
        let key = if skip > 0 { format!("{}#{skip}", wire(path)) } else { wire(path) };
        if let Some((s, m, h)) = self.cache.get(&key) {
            if *s == meta.len() && *m == mtime(&meta) {
                return Ok(h.clone());
            }
        }
        let mut f = fs::File::open(path)?;
        if skip > 0 {
            std::io::copy(&mut (&mut f).take(skip), &mut std::io::sink())?;
        }
        let mut h = sha1_smol::Sha1::new();
        let mut buf = vec![0u8; 1 << 16];
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
        }
        let hex = h.digest().to_string();
        self.cache.insert(key, (meta.len(), mtime(&meta), hex.clone()));
        Ok(hex)
    }

    fn save_cache(&self) {
        let text: String = self.cache.iter().map(|(k, (s, m, h))| format!("{k}\t{s}\t{m}\t{h}\n")).collect();
        if let Some(dir) = self.cache_file.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(&self.cache_file, text);
    }

    /// Saves both ways, and the rom list (the server keeps it as this card's inventory)
    pub fn sync(&mut self, out: &mut Outcome) -> Result<()> {
        self.progress("connecting", 0, 0);
        let roots = pairs(&self.api.get_text("/agent/roots")?);
        let field = |k: &str| roots.iter().filter(|r| r.len() >= 2 && r[0] == k).map(|r| r[1].clone()).collect::<Vec<_>>();
        let roms_dir = field("roms").into_iter().next().map(PathBuf::from);
        let save_dirs: Vec<PathBuf> = field("saves").into_iter().map(PathBuf::from).collect();
        let exts: Vec<String> = field("exts").first().map(|e| e.split(' ').filter(|x| !x.is_empty()).map(str::to_string).collect()).unwrap_or_default();

        let mut request = String::new();
        let mut rom_hashes: HashMap<String, String> = HashMap::new();
        // Roms: <roms>/<system>/<file>
        let mut roms = Vec::new();
        // Flashcart cards: roms in any folder of the card
        let deep = roots.iter().any(|r| r.len() >= 2 && r[0] == "scan" && r[1] == "deep");
        if let (true, Some(dir)) = (deep, &roms_dir) {
            let mut all = Vec::new();
            walk(dir, &mut all);
            roms.extend(all.into_iter().filter(|p| p.file_name().map(|n| n.to_string_lossy()).is_some_and(|n| is_rom(&n, &exts) && !n.contains('\t'))));
        } else if let Some(dir) = &roms_dir {
            for sys in fs::read_dir(dir).into_iter().flatten().flatten() {
                if !sys.file_type().map(|t| t.is_dir()).unwrap_or(false) || sys.file_name().to_string_lossy().starts_with('.') {
                    continue;
                }
                for f in fs::read_dir(sys.path()).into_iter().flatten().flatten() {
                    let name = f.file_name().to_string_lossy().to_string();
                    if f.file_type().map(|t| t.is_file()).unwrap_or(false) && is_rom(&name, &exts) && !name.contains('\t') {
                        roms.push(f.path());
                    }
                }
            }
        }
        // LaunchBox's games, each with its platform and emulator setup (the server reads its saves there)
        let library = self.library.clone();
        let mut launched: HashMap<PathBuf, (String, String)> = HashMap::new();
        if let Some(lib) = &library {
            request.push_str(&lib.setup_lines());
            for g in &lib.games {
                if g.rom.is_file() && !g.rom.to_string_lossy().contains('\t') && launched.insert(g.rom.clone(), (g.platform.clone(), g.setup.clone())).is_none() && !roms.contains(&g.rom) {
                    roms.push(g.rom.clone());
                }
            }
        }
        for (i, rom) in roms.iter().enumerate() {
            self.check()?;
            if i % 10 == 0 {
                self.progress("roms", i as u64, roms.len() as u64);
            }
            let size = fs::metadata(rom).map(|m| m.len()).unwrap_or(0);
            let mut hashes = Vec::new();
            if size <= HASH_MAX {
                hashes.push(self.sha1(rom, 0)?);
                let hs = header_size(rom, size);
                if hs > 0 {
                    hashes.push(self.sha1(rom, hs)?);
                }
            }
            rom_hashes.insert(wire(rom), hashes.join(","));
            // rom, path, sha1, headerless sha1, size
            let h = |i: usize| hashes.get(i).cloned().unwrap_or_default();
            match launched.get(rom) {
                Some((platform, setup)) => request.push_str(&format!("rom\t{}\t{}\t{}\t{size}\t{platform}\t{setup}\n", wire(rom), h(0), h(1))),
                None => request.push_str(&format!("rom\t{}\t{}\t{}\t{size}\n", wire(rom), h(0), h(1))),
            }
        }
        let mut saves = Vec::new();
        for d in &save_dirs {
            walk(d, &mut saves);
        }
        let mut exts = exts;
        if let Some(lib) = &library {
            // RetroArch's own, whatever the server listed for this PC's layout
            exts.extend([".srm", ".state"].map(String::from));
            for (d, depth) in lib.watched() {
                if depth > 0 {
                    walk(&d, &mut saves);
                } else {
                    saves.extend(fs::read_dir(&d).into_iter().flatten().flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_file())).map(|e| e.path()));
                }
            }
        }
        saves.retain(|p| p.file_name().map(|n| is_save(&n.to_string_lossy(), &exts)).unwrap_or(false));
        // Saves that are whole folders go as one file each, never their files: PSP/SAVEDATA under the save folders
        // (PPSSPP's RetroArch core) and LaunchBox's PPSSPP setups
        let mut folder_roots = library.as_ref().map(|l| l.folder_saves()).unwrap_or_default();
        for d in &save_dirs {
            savedata_dirs(d, 0, &mut folder_roots);
        }
        folder_roots.sort();
        folder_roots.dedup();
        saves.retain(|p| !folder_roots.iter().any(|r| p.starts_with(r)));
        saves.sort();
        saves.dedup();
        for (i, s) in saves.iter().enumerate() {
            self.check()?;
            if i % 10 == 0 {
                self.progress("saves", i as u64, saves.len() as u64);
            }
            let h = self.sha1(s, 0)?;
            request.push_str(&format!("file\t{}\t{h}\n", wire(s)));
        }
        for root in &folder_roots {
            request.push_str(&format!("dir\t{}\n", wire(root)));
            let mut dirs: Vec<PathBuf> = fs::read_dir(root).into_iter().flatten().flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir()) && !e.file_name().to_string_lossy().starts_with('.')).map(|e| e.path()).collect();
            dirs.sort();
            for d in dirs {
                self.check()?;
                if let Ok(Some(h)) = self.folder_sha1(&d) {
                    request.push_str(&format!("file\t{}/\t{h}\n", wire(&d)));
                }
            }
        }
        self.save_cache();

        self.progress("server", 0, 0);
        // Free and total bytes where list games go: the server copies them only while a reserve is kept
        let space_at = roms_dir.clone().filter(|d| d.is_dir()).unwrap_or_else(|| PathBuf::from(&self.root));
        let space = crate::card::space_of(&space_at).map(|(f, t)| format!("{f} {t}")).unwrap_or_default();
        let allow = if self.allow_pull { "1" } else { "0" };
        (self.log)(format!("sync: {} roms, {} save files", roms.len(), saves.len()));
        let mut headers = vec![("X-Allow-Pull", allow.to_string()), ("X-Space", space)];
        // The setting as this device has it, and whether its user changed it (or answered) since the server last heard
        let prune_sent = self.prune.as_ref().map(|p| p.pending());
        if let (Some(p), Some(set)) = (&self.prune, prune_sent) {
            headers.push(("X-Prune", if p.on() { "1" } else { "0" }.into()));
            headers.push(("X-Prune-Set", if set { "1" } else { "0" }.into()));
        }
        let plan = pairs(&self.api.post_text("/agent/sync", request.into_bytes(), &headers)?);
        if let Some(p) = &self.prune {
            if prune_sent == Some(true) {
                p.heard();
            }
            p.answer(plan.iter().find(|l| l[0] == "prune").map(Vec::as_slice));
        }
        let steps: Vec<_> = plan.into_iter().filter(|s| s.len() >= 3 && ["put", "get", "tput", "tget", "cget"].contains(&s[0].as_str())).collect();
        for (n, s) in steps.iter().enumerate() {
            self.check()?;
            self.progress("transfer", n as u64 + 1, steps.len() as u64);
            let r = match s[0].as_str() {
                // put <file> <rom> [exact]
                "put" => read_save(&s[1]).and_then(|body| {
                    let headers = [
                        ("X-Rom-B64", b64(&s[2])),
                        ("X-Path-B64", b64(&s[1])),
                        ("X-Rom-Sha1", rom_hashes.get(&s[2]).cloned().unwrap_or_default()),
                        ("X-Save-Exact", s.get(3).cloned().unwrap_or_else(|| "0".into())),
                    ];
                    self.api.post_text("/agent/upload", body, &headers).map(|reply| {
                        if is_state(&s[1]) {
                            out.states_up += 1;
                        } else {
                            out.saves_up += 1;
                        }
                        (self.log)(format!("up: {}", s[1]));
                        // A new savestate: the server asks for its screenshot; a memory card may come back with the server's saves in it
                        for t in pairs(&reply).into_iter().filter(|t| t.len() >= 3) {
                            match t[0].as_str() {
                                "tput" => {
                                    let _ = self.thumb_put(&t[1], &t[2]);
                                }
                                "cget" => {
                                    if let Ok(true) = self.card_get(&t[1], &t[2]) {
                                        out.saves_down += 1;
                                    }
                                }
                                _ => {}
                            }
                        }
                    })
                }),
                // cget <file> <sha1|-> <rom>: a memory card with the server's newer saves put in
                "cget" => self.card_get(&s[1], &s[2]).map(|got| {
                    if got {
                        out.saves_down += 1;
                        (self.log)(format!("down: {} (memory card)", s[1]));
                    }
                }),
                // Savestate screenshots: ours when the server lacks it, the server's beside a state it sent
                "tput" => self.thumb_put(&s[1], &s[2]),
                "tget" => self.api.download(&format!("/agent/thumb?v={}", s[2]), &[], Path::new(&s[1]), &mut |_| {}, self.cancelled),
                // get <file> <version> <rom>
                _ => {
                    let headers = [("X-Rom-B64", b64(s.get(3).map(String::as_str).unwrap_or(""))), ("X-Path-B64", b64(&s[1]))];
                    self.api.download(&format!("/agent/file?v={}", s[2]), &headers, Path::new(&s[1]), &mut |_| {}, self.cancelled).map(|_| {
                        if is_state(&s[1]) {
                            out.states_down += 1;
                        } else {
                            out.saves_down += 1;
                        }
                        (self.log)(format!("down: {}", s[1]));
                    })
                }
            };
            if let Err(e) = r {
                if e.to_string() == "cancelled" {
                    return Err(e);
                }
                out.errors += 1;
                (self.log)(format!("error: {} {}: {e}", s[0], s[1]));
            }
        }
        Ok(())
    }

    /// Swaps in a memory card the server built from the file it last read, only if the file is still that one
    /// (EXPECT, "-" for none). An SD card in a computer has no emulator running on it.
    fn card_get(&mut self, path: &str, expect: &str) -> Result<bool> {
        if let Some(dir) = path.strip_suffix('/') {
            return self.folder_get(path, Path::new(dir), expect);
        }
        let target = Path::new(path);
        let tmp = target.with_file_name(format!("{}.rommancer-card", target.file_name().and_then(|n| n.to_str()).unwrap_or("card")));
        self.api.download(&format!("/agent/card?expect={expect}"), &[("X-Path-B64", b64(path))], &tmp, &mut |_| {}, self.cancelled)?;
        let size = fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
        // The file itself, not the hash cache: a card keeps its size and may keep its second
        self.cache.remove(&wire(target));
        let now = if target.is_file() { self.sha1(target, 0)? } else { "-".into() };
        if size == 0 || now != expect {
            let _ = fs::remove_file(&tmp);
            return Ok(false);
        }
        fs::rename(&tmp, target)?;
        self.cache.remove(&wire(target));
        // Tell the server at once that the card it sent is in place
        let sent = self.sha1(target, 0)?;
        let _ = self.api.post_text(&format!("/agent/card/ack?sha={sent}"), Vec::new(), &[("X-Path-B64", b64(path))]);
        Ok(true)
    }

    /// A save folder the server sent, written only if the folder is still the one it last read (EXPECT)
    fn folder_get(&mut self, path: &str, dir: &Path, expect: &str) -> Result<bool> {
        let tmp = dir.with_file_name(format!(".{}.rommancer-tar", dir.file_name().and_then(|n| n.to_str()).unwrap_or("save")));
        self.api.download(&format!("/agent/card?expect={expect}"), &[("X-Path-B64", b64(path))], &tmp, &mut |_| {}, self.cancelled)?;
        let tar = fs::read(&tmp).unwrap_or_default();
        let _ = fs::remove_file(&tmp);
        let key = format!("{}/", wire(dir));
        self.cache.remove(&key);
        let now = if dir.is_dir() { self.folder_sha1(dir)?.unwrap_or_else(|| "-".into()) } else { "-".into() };
        if tar.is_empty() || now != expect {
            return Ok(false);
        }
        crate::folder::unpack(&tar, dir)?;
        self.cache.remove(&key);
        let sent = self.folder_sha1(dir)?.unwrap_or_default();
        let _ = self.api.post_text(&format!("/agent/card/ack?sha={sent}"), Vec::new(), &[("X-Path-B64", b64(path))]);
        Ok(true)
    }

    /// A save folder's manifest hash (none when it has no files); cached by its files' sizes and newest change
    fn folder_sha1(&mut self, dir: &Path) -> Result<Option<String>> {
        let key = format!("{}/", wire(dir));
        let sig = crate::folder::signature(dir);
        if let (Some((s, m)), Some((cs, cm, h))) = (sig, self.cache.get(&key)) {
            if s == *cs && m == *cm {
                return Ok(Some(h.clone()));
            }
        }
        let hex = crate::folder::hash(dir)?;
        if let (Some((s, m)), Some(h)) = (sig, &hex) {
            self.cache.insert(key, (s, m, h.clone()));
        }
        Ok(hex)
    }

    fn thumb_put(&self, path: &str, version: &str) -> Result<()> {
        let p = Path::new(path);
        if p.is_file() && fs::metadata(p).map(|m| m.len()).unwrap_or(u64::MAX) <= THUMB_MAX {
            self.api.post_text(&format!("/agent/thumb?v={version}"), fs::read(p)?, &[])?;
        }
        Ok(())
    }

    /// Roms the server asked for from this card, one at a time; a cut transfer stays open on the server
    pub fn pulls(&mut self, out: &mut Outcome) -> Result<()> {
        let wanted: Vec<_> = pairs(&self.api.get_text("/agent/pulls")?).into_iter().filter(|p| p.len() >= 3 && p[0] == "pull").collect();
        for (i, p) in wanted.iter().enumerate() {
            self.check()?;
            let file = PathBuf::from(&p[2]);
            let size = fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
            self.emit(Progress {
                phase: "pulls".into(),
                done: i as u64 + 1,
                total: wanted.len() as u64,
                file: file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                file_total: size,
                ..Default::default()
            });
            if !file.is_file() {
                (self.log)(format!("pull: {} is not here any more", p[2]));
                let _ = self.api.post_text(&format!("/agent/pull/{}", p[1]), Vec::new(), &[("X-Missing", "1".into())]);
                continue;
            }
            match self.api.upload(&format!("/agent/pull/{}", p[1]), &file, &[]) {
                Ok(_) => {
                    out.games_sent += 1;
                    (self.log)(format!("pull: sent {}", p[2]));
                }
                Err(e) => {
                    out.errors += 1;
                    (self.log)(format!("error: pull {}: {e}", p[2]));
                }
            }
        }
        Ok(())
    }

    /// Roms of the lists assigned to this card that are not on it yet; never deletes anything
    pub fn roms(&mut self, out: &mut Outcome) -> Result<()> {
        self.progress("roms-plan", 0, 0);
        let plan: Vec<_> = pairs(&self.api.get_text("/agent/roms")?).into_iter().filter(|r| r.len() >= 4 && r[0] == "rom").collect();
        let mut arrived: Vec<PathBuf> = Vec::new();
        for (i, r) in plan.iter().enumerate() {
            self.check()?;
            let dest = PathBuf::from(&r[1]);
            let size: u64 = r[2].parse().unwrap_or(0);
            if dest.is_file() && (size == 0 || fs::metadata(&dest).map(|m| m.len()).unwrap_or(0) == size) {
                continue;
            }
            let name = dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let total = plan.len() as u64;
            let api = &self.api;
            let res = api.download(
                &format!("/agent/rom?f={}", r[3]),
                &[],
                &dest,
                &mut |done| self.emit(Progress { phase: "roms-download".into(), done: i as u64 + 1, total, file: name.clone(), file_done: done, file_total: size, ..Default::default() }),
                self.cancelled,
            );
            match res {
                Ok(()) if size == 0 || fs::metadata(&dest).map(|m| m.len()).unwrap_or(0) == size => {
                    out.games_down += 1;
                    (self.log)(format!("roms: {}", r[1]));
                    arrived.push(dest.clone());
                }
                Err(e) if e.to_string() == "cancelled" => {
                    clear_list_caches(Path::new(&self.root), &arrived);
                    return Err(e);
                }
                Err(e) => {
                    out.games_failed += 1;
                    (self.log)(format!("error: roms {}: {e}", r[1]));
                }
                _ => {
                    out.games_failed += 1;
                    (self.log)(format!("error: roms {}: size differs", r[1]));
                }
            }
        }
        clear_list_caches(Path::new(&self.root), &arrived);
        Ok(())
    }

    /// The roms folder deletions are kept inside: this device's own when it has one, otherwise the server's (only
    /// when it lies within the device root)
    fn prune_roms(&self) -> Result<Option<String>> {
        if let Some(r) = &self.roms_dir {
            return Ok(Some(r.clone()));
        }
        let roots = pairs(&self.api.get_text("/agent/roots")?);
        Ok(roots.iter().find(|r| r.len() >= 2 && r[0] == "roms").map(|r| r[1].clone()).filter(|r| prune::within(r, &self.root)))
    }

    /// Deletes the games the server names as in no list of this device (only with the setting on, only files of
    /// the roms folder). Files the server lacks are not named: it asks for them first (the sending step) and names
    /// them at a later pass. A deletion of more than half of the games waits in prune-hold for the user.
    pub fn prune(&mut self, out: &mut Outcome) -> Result<()> {
        let Some(store) = self.prune.clone() else { return Ok(()) };
        if !store.active() {
            return Ok(());
        }
        self.progress("prune", 0, 0);
        let Some(roms) = self.prune_roms()? else {
            (self.log)("prune: no roms folder".into());
            return Ok(());
        };
        let plan = pairs(&self.api.get_text("/agent/prune")?);
        if let Some(h) = plan.iter().find(|l| l.len() >= 3 && l[0] == "hold") {
            let n = h[1].parse().unwrap_or(0);
            store.set_hold(Some((n, h[2].parse().unwrap_or(0))));
            (self.log)(format!("prune: {n} roms to delete, waiting for confirmation"));
            return Ok(());
        }
        store.set_hold(None);
        let del: Vec<&Vec<String>> = plan.iter().filter(|l| l.len() >= 2 && l[0] == "del").collect();
        let mut gone = Vec::new();
        for (i, l) in del.iter().enumerate() {
            self.check()?;
            let path = &l[1];
            let file = PathBuf::from(path);
            self.emit(Progress {
                phase: "prune".into(),
                done: i as u64 + 1,
                total: del.len() as u64,
                file: file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                ..Default::default()
            });
            if !prune::deletable(path, &roms) {
                (self.log)(format!("prune: {path} is outside the roms folder, kept"));
                continue;
            }
            if !prune::is_plain_file(&file) {
                continue;
            }
            match fs::remove_file(&file) {
                Ok(()) => {
                    (self.log)(format!("prune: {path}"));
                    gone.push(path.clone());
                }
                Err(e) => {
                    out.errors += 1;
                    (self.log)(format!("error: prune {path}: {e}"));
                }
            }
        }
        store.add_pruned(&gone);
        let files: Vec<PathBuf> = gone.iter().map(PathBuf::from).collect();
        clear_list_caches(Path::new(&self.root), &files);
        if !gone.is_empty() {
            (self.log)(format!("prune: {} roms in no list deleted", gone.len()));
        }
        out.games_deleted += gone.len() as u32;
        Ok(())
    }

    /// Saves and states of the games deleted for being in no list, once a sync went through without errors (they
    /// are on the server): only save files the server names, inside the device root
    pub fn prune_clean(&mut self, out: &mut Outcome) -> Result<()> {
        let Some(store) = self.prune.clone() else { return Ok(()) };
        let gone = store.pruned();
        if gone.is_empty() || out.errors > 0 {
            return Ok(());
        }
        self.progress("prune-clean", 0, 0);
        let roots = pairs(&self.api.get_text("/agent/roots")?);
        let exts: Vec<String> = roots.iter().find(|r| r.len() >= 2 && r[0] == "exts").map(|r| r[1].split(' ').filter(|x| !x.is_empty()).map(str::to_string).collect()).unwrap_or_default();
        let reply = pairs(&self.api.post_text("/agent/prune/saves", gone.join("\n").into_bytes(), &[])?);
        let mut n = 0;
        for l in reply.iter().filter(|l| l.len() >= 2 && l[0] == "file") {
            let file = PathBuf::from(&l[1]);
            let is_save_file = file.file_name().is_some_and(|f| is_save(&f.to_string_lossy(), &exts));
            if !is_save_file || !prune::below(&l[1], &self.root, 0) || !prune::is_plain_file(&file) {
                continue;
            }
            if fs::remove_file(&file).is_ok() {
                n += 1;
                (self.log)(format!("prune: removed {}", l[1]));
            }
        }
        store.clear_pruned();
        (self.log)(format!("prune: {n} save files of deleted roms removed"));
        out.saves_cleaned += n;
        Ok(())
    }

    /// Configuration work the server asked for, on the card itself: send the files it names (relative to the
    /// card root; the console's internal memory is out of reach from here), then write what it sends back
    pub fn config(&mut self, out: &mut Outcome) -> Result<()> {
        let sd = [("X-Channel", "sd".to_string())];
        let root = PathBuf::from(&self.root);
        let inside = |rel: &str| !rel.starts_with('/') && !rel.split('/').any(|c| c == "..");
        for _ in 0..5 {
            self.check()?;
            let plan = pairs(&self.api.get_text_with("/agent/config/plan", &sd)?);
            let Some(op) = plan.iter().find(|l| l.len() >= 2 && l[0] == "op").map(|l| l[1].clone()) else { return Ok(()) };
            self.progress("config", 0, 0);
            let mut files = Vec::new();
            for l in plan.iter().filter(|l| l.len() >= 2 && inside(&l[1])) {
                match l[0].as_str() {
                    "get" => files.push(l[1].clone()),
                    "dir" => {
                        let mut found = Vec::new();
                        walk(&root.join(&l[1]), &mut found);
                        for f in found.into_iter().take(200) {
                            if let Ok(rel) = f.strip_prefix(&root) {
                                files.push(wire(rel));
                            }
                        }
                    }
                    _ => {}
                }
            }
            for rel in &files {
                let path = root.join(rel);
                let headers = [("X-Path-B64", b64(rel))];
                match fs::read(&path) {
                    Ok(body) if path.is_file() => self.api.post_text(&format!("/agent/config/file/{op}"), body, &headers)?,
                    _ => self.api.post_text(&format!("/agent/config/file/{op}"), Vec::new(), &[headers[0].clone(), ("X-Missing", "1".into())])?,
                };
            }
            let puts: Vec<_> = pairs(&self.api.post_text(&format!("/agent/config/ready/{op}"), Vec::new(), &[])?).into_iter().filter(|l| l.len() >= 3 && (l[0] == "put" || l[0] == "del")).collect();
            if puts.is_empty() {
                out.config += 1;
                continue;
            }
            let mut failed = None;
            for p in &puts {
                if !inside(&p[2]) {
                    failed = Some(p[2].clone());
                    continue;
                }
                if p[0] == "del" {
                    let target = root.join(&p[2]);
                    if target.exists() && fs::remove_file(&target).is_err() {
                        failed = Some(p[2].clone());
                    }
                    continue;
                }
                if self.api.download(&format!("/agent/config/out/{op}/{}", p[1]), &[], &root.join(&p[2]), &mut |_| {}, self.cancelled).is_err() {
                    failed = Some(p[2].clone());
                }
            }
            let body = match &failed {
                None => "ok".to_string(),
                Some(f) => format!("error\twriteFailed:{f}"),
            };
            self.api.post_text(&format!("/agent/config/done/{op}"), body.into_bytes(), &[])?;
            out.config += 1;
        }
        Ok(())
    }
}

/// Roms arrived in these files' folders: the console's game lists must show them. Onion keeps each system's list in
/// a <folder>_cache6.db beside its roms (or above, for games in their own folder) and reads the folder again once it
/// is gone; other firmwares list their folders when they start
fn clear_list_caches(root: &Path, files: &[PathBuf]) {
    let mut dirs: Vec<PathBuf> = files.iter().filter_map(|f| f.parent().map(Path::to_path_buf)).collect();
    dirs.sort();
    dirs.dedup();
    for start in dirs {
        let mut dir = Some(start.as_path());
        while let Some(d) = dir {
            if !d.starts_with(root) {
                break;
            }
            if let Ok(entries) = fs::read_dir(d) {
                for e in entries.flatten() {
                    if e.file_name().to_string_lossy().ends_with("_cache6.db") {
                        let _ = fs::remove_file(e.path());
                    }
                }
            }
            dir = d.parent();
        }
    }
}
