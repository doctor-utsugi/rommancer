//! One card's sync, the same protocol as the console clients: list roms (with hashes) and saves, let the
//! server decide, move the files it says; then the roms the server asked for and the roms of the lists.

use crate::api::{b64, pairs, DeviceApi};
use anyhow::{bail, Result};
use serde::Serialize;
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
    pub root: String,
    /// connecting, roms, saves, server, transfer, pulls, roms-plan, roms-download, finished
    pub phase: String,
    pub done: u64,
    pub total: u64,
    pub file: String,
    pub file_done: u64,
    pub file_total: u64,
}

#[derive(Serialize, Clone, Default)]
pub struct Outcome {
    pub up: u32,
    pub down: u32,
    pub errors: u32,
    pub sent: u32,
    pub roms: u32,
    pub roms_failed: u32,
    /// Configuration work done on the card (copies, the user's settings, restores)
    pub config: u32,
}

pub struct Engine<'a> {
    pub api: DeviceApi,
    pub root: String,
    pub cache_file: PathBuf,
    pub report: &'a dyn Fn(Progress),
    pub cancelled: &'a dyn Fn() -> bool,
    cache: HashMap<String, (u64, u64, String)>,
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

/// Paths travel with forward slashes, as the server builds them from the root it was given
fn wire(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

impl<'a> Engine<'a> {
    pub fn new(api: DeviceApi, root: String, cache_file: PathBuf, report: &'a dyn Fn(Progress), cancelled: &'a dyn Fn() -> bool) -> Self {
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
        Self { api, root, cache_file, report, cancelled, cache }
    }

    fn progress(&self, phase: &str, done: u64, total: u64) {
        (self.report)(Progress { root: self.root.clone(), phase: phase.into(), done, total, ..Default::default() });
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
            request.push_str(&format!("rom\t{}\t{}\t{}\t{size}\n", wire(rom), h(0), h(1)));
        }
        let mut saves = Vec::new();
        for d in &save_dirs {
            walk(d, &mut saves);
        }
        saves.retain(|p| p.file_name().map(|n| is_save(&n.to_string_lossy(), &exts)).unwrap_or(false));
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
        self.save_cache();

        self.progress("server", 0, 0);
        // Free and total bytes of the card: the server copies list roms only while a reserve is kept
        let space = crate::card::space_of(Path::new(&self.root)).map(|(f, t)| format!("{f} {t}")).unwrap_or_default();
        let plan = pairs(&self.api.post_text("/agent/sync", request.into_bytes(), &[("X-Allow-Pull", "1".into()), ("X-Space", space)])?);
        let steps: Vec<_> = plan.into_iter().filter(|s| s.len() >= 3 && ["put", "get", "tput", "tget", "cget"].contains(&s[0].as_str())).collect();
        for (n, s) in steps.iter().enumerate() {
            self.check()?;
            self.progress("transfer", n as u64 + 1, steps.len() as u64);
            let r = match s[0].as_str() {
                // put <file> <rom> [exact]
                "put" => fs::read(&s[1]).map_err(anyhow::Error::from).and_then(|body| {
                    let headers = [
                        ("X-Rom-B64", b64(&s[2])),
                        ("X-Path-B64", b64(&s[1])),
                        ("X-Rom-Sha1", rom_hashes.get(&s[2]).cloned().unwrap_or_default()),
                        ("X-Save-Exact", s.get(3).cloned().unwrap_or_else(|| "0".into())),
                    ];
                    self.api.post_text("/agent/upload", body, &headers).map(|reply| {
                        out.up += 1;
                        // A new savestate: the server asks for its screenshot; a memory card may come back with the server's saves in it
                        for t in pairs(&reply).into_iter().filter(|t| t.len() >= 3) {
                            match t[0].as_str() {
                                "tput" => {
                                    let _ = self.thumb_put(&t[1], &t[2]);
                                }
                                "cget" => {
                                    if let Ok(true) = self.card_get(&t[1], &t[2]) {
                                        out.down += 1;
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
                        out.down += 1;
                    }
                }),
                // Savestate screenshots: ours when the server lacks it, the server's beside a state it sent
                "tput" => self.thumb_put(&s[1], &s[2]),
                "tget" => self.api.download(&format!("/agent/thumb?v={}", s[2]), &[], Path::new(&s[1]), &mut |_| {}, self.cancelled),
                // get <file> <version> <rom>
                _ => {
                    let headers = [("X-Rom-B64", b64(s.get(3).map(String::as_str).unwrap_or(""))), ("X-Path-B64", b64(&s[1]))];
                    self.api.download(&format!("/agent/file?v={}", s[2]), &headers, Path::new(&s[1]), &mut |_| {}, self.cancelled).map(|_| out.down += 1)
                }
            };
            if r.is_err() {
                out.errors += 1;
            }
        }
        Ok(())
    }

    /// Swaps in a memory card the server built from the file it last read, only if the file is still that one
    /// (EXPECT, "-" for none). An SD card in a computer has no emulator running on it.
    fn card_get(&mut self, path: &str, expect: &str) -> Result<bool> {
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
            (self.report)(Progress {
                root: self.root.clone(),
                phase: "pulls".into(),
                done: i as u64 + 1,
                total: wanted.len() as u64,
                file: file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                ..Default::default()
            });
            if !file.is_file() {
                let _ = self.api.post_text(&format!("/agent/pull/{}", p[1]), Vec::new(), &[("X-Missing", "1".into())]);
                continue;
            }
            if self.api.upload(&format!("/agent/pull/{}", p[1]), &file, &[]).is_ok() {
                out.sent += 1;
            }
        }
        Ok(())
    }

    /// Roms of the lists assigned to this card that are not on it yet; never deletes anything
    pub fn roms(&mut self, out: &mut Outcome) -> Result<()> {
        self.progress("roms-plan", 0, 0);
        let plan: Vec<_> = pairs(&self.api.get_text("/agent/roms")?).into_iter().filter(|r| r.len() >= 4 && r[0] == "rom").collect();
        for (i, r) in plan.iter().enumerate() {
            self.check()?;
            let dest = PathBuf::from(&r[1]);
            let size: u64 = r[2].parse().unwrap_or(0);
            if dest.is_file() && (size == 0 || fs::metadata(&dest).map(|m| m.len()).unwrap_or(0) == size) {
                continue;
            }
            let name = dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let report = self.report;
            let root = self.root.clone();
            let total = plan.len() as u64;
            let res = self.api.download(
                &format!("/agent/rom?f={}", r[3]),
                &[],
                &dest,
                &mut |done| report(Progress { root: root.clone(), phase: "roms-download".into(), done: i as u64 + 1, total, file: name.clone(), file_done: done, file_total: size }),
                self.cancelled,
            );
            match res {
                Ok(()) if size == 0 || fs::metadata(&dest).map(|m| m.len()).unwrap_or(0) == size => out.roms += 1,
                Err(e) if e.to_string() == "cancelled" => return Err(e),
                _ => out.roms_failed += 1,
            }
        }
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
