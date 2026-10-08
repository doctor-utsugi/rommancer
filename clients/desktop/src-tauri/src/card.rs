//! SD cards and folders: where they are, what firmware their layout looks like and how they are linked.
//! The link format is the one of clients/linux/rommancer-sync.sh, so the shell client and this app can
//! sync the same card.

use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// A card linked from its own console keeps the link where that console's client lives
const CONSOLE_LINKS: &[(&str, &str)] = &[("system/rommancer/.rommancer/config", "knulli"), ("App/RommancerSync/.rommancer/config", "onion")];
const OWN_LINK: &str = ".rommancer/config";

#[derive(Serialize, Clone, Debug)]
pub struct Link {
    pub server: String,
    #[serde(skip)]
    pub token: String,
    pub user: String,
    /// Linked from the console itself (its client syncs it too)
    pub console: bool,
    pub device_id: Option<u64>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Card {
    /// Root as the server sees it: forward slashes ("/media/me/CARD", "E:/")
    pub root: String,
    pub label: String,
    pub removable: bool,
    pub guess: Option<String>,
    pub link: Option<Link>,
    pub total_bytes: u64,
    pub free_bytes: u64,
}

pub fn server_root(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    if s.len() > 1 && s.ends_with('/') && !s.ends_with(":/") {
        s.trim_end_matches('/').to_string()
    } else {
        s
    }
}

fn read_kv(path: &Path) -> Option<std::collections::HashMap<String, String>> {
    let text = std::fs::read_to_string(path).ok()?;
    Some(
        text.lines()
            .filter_map(|l| l.split_once('='))
            .map(|(k, v)| (k.trim().to_string(), v.trim().trim_matches('"').to_string()))
            .collect(),
    )
}

pub fn read_link(root: &Path) -> Option<Link> {
    let own = root.join(OWN_LINK);
    let found = std::iter::once((own, false)).chain(CONSOLE_LINKS.iter().map(|(p, _)| (root.join(p), true))).find(|(p, _)| p.is_file())?;
    let kv = read_kv(&found.0)?;
    let token = kv.get("TOKEN").filter(|t| !t.is_empty())?.clone();
    Some(Link {
        server: kv.get("SERVER").cloned().unwrap_or_default(),
        token,
        user: kv.get("USER").cloned().unwrap_or_default(),
        // SHARED=1: the card of a device that has its own root (a console), linked from here
        console: found.1 || kv.get("SHARED").is_some_and(|v| v == "1"),
        device_id: kv.get("DEVICE_ID").and_then(|v| v.parse().ok()),
    })
}

pub fn write_own_link(root: &Path, server: &str, token: &str, user: &str, device_id: u64, shared: bool) -> std::io::Result<()> {
    let dir = root.join(".rommancer");
    std::fs::create_dir_all(&dir)?;
    let shared = if shared { "SHARED=1\n" } else { "" };
    std::fs::write(dir.join("config"), format!("SERVER={server}\nTOKEN={token}\nUSER={user}\nDEVICE_ID={device_id}\n{shared}"))
}

pub fn remove_own_link(root: &Path) -> std::io::Result<()> {
    let f = root.join(OWN_LINK);
    if f.is_file() {
        std::fs::remove_file(f)?;
    }
    Ok(())
}

/// Firmware suggested by the card's folders (the user can pick another when linking)
pub fn guess_firmware(root: &Path) -> Option<String> {
    let has = |p: &str| root.join(p).exists();
    if has(".tmp_update") || has("App/RommancerSync") {
        Some("onion".into())
    } else if has("MUOS") {
        Some("muos".into())
    } else if has("_nds") || has("roms/nds") {
        Some("nds-twilight".into())
    } else if has("roms") && (has("bios") || has("system")) {
        // Knulli and Batocera share this layout; Knulli is the one listed first
        Some("knulli".into())
    } else if has("ROMs") && has("RetroArch") {
        Some("android-esde".into())
    } else if has_ext(root, ".gba", 2) {
        // GBA roms loose on the card: a flashcart (SuperCard, EZ-Flash...)
        Some("gba-flashcart".into())
    } else {
        None
    }
}

fn has_ext(dir: &Path, ext: &str, depth: u32) -> bool {
    std::fs::read_dir(dir).into_iter().flatten().flatten().any(|e| {
        let name = e.file_name().to_string_lossy().to_lowercase();
        if name.starts_with('.') {
            return false;
        }
        match e.file_type() {
            Ok(t) if t.is_dir() => depth > 0 && has_ext(&e.path(), ext, depth - 1),
            Ok(_) => name.ends_with(ext),
            _ => false,
        }
    })
}

fn card(path: PathBuf, label: String, removable: bool, total: u64, free: u64) -> Card {
    Card { root: server_root(&path), guess: guess_firmware(&path), link: read_link(&path), label, removable, total_bytes: total, free_bytes: free }
}

/// Removable drives and the folders the user added
pub fn list(folders: &[String]) -> Vec<Card> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for d in disks.list() {
        let mount = d.mount_point().to_path_buf();
        let m = mount.to_string_lossy().to_string();
        let candidate = if cfg!(windows) {
            // Every drive except the system one
            !m.to_uppercase().starts_with(&std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into()).to_uppercase())
        } else {
            d.is_removable() || m.starts_with("/media/") || m.starts_with("/run/media/") || m.starts_with("/Volumes/")
        };
        if !candidate || !seen.insert(m.clone()) {
            continue;
        }
        let label = d.name().to_string_lossy().to_string();
        let label = if label.is_empty() || label.starts_with("/dev/") { mount.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(m.clone()) } else { label };
        let c = card(mount, label, d.is_removable(), d.total_space(), d.available_space());
        // Fixed disks mounted under /media only count when they look like a console card or are linked
        if c.removable || c.guess.is_some() || c.link.is_some() || cfg!(windows) {
            out.push(Card { removable: true, ..c });
        }
    }
    for f in folders {
        let p = PathBuf::from(f);
        if p.is_dir() && seen.insert(f.clone()) {
            let label = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(f.clone());
            out.push(card(p, label, false, 0, 0));
        }
    }
    out
}

/// Free and total bytes of the filesystem holding ROOT, asked of the folder itself (a disk list leaves out
/// tmpfs, network shares and other filesystems that are not "physical", and would report the parent disk)
#[cfg(unix)]
pub fn space_of(root: &Path) -> Option<(u64, u64)> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(root.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    let frag = st.f_frsize as u64;
    Some((st.f_bavail as u64 * frag, st.f_blocks as u64 * frag))
}

/// Free and total bytes of the disk holding ROOT (the mount point that contains it)
#[cfg(not(unix))]
pub fn space_of(root: &Path) -> Option<(u64, u64)> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .filter(|d| root.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| (d.available_space(), d.total_space()))
}
