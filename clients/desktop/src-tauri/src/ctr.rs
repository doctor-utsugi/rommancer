//! 3DS saves (Azahar, Citra and its forks): each game's save folder sits in the emulator's SD card at
//! "sdmc/Nintendo 3DS/<id0>/<id1>/title/00040000/<title id low>/data/", named after the game's title id, which the
//! server learns from the roms' headers ("tid" lines). A folder travels as save folders do (see folder.rs).

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

fn read_at(f: &mut File, at: u64, n: usize) -> Option<Vec<u8>> {
    let mut b = vec![0u8; n];
    f.seek(SeekFrom::Start(at)).ok()?;
    f.read_exact(&mut b).ok()?;
    Some(b)
}

/// The title id of a .3ds or .cci rom (its NCSD header's media id) or of a .cia (its TMD's), 16 hex digits
pub fn title_id(rom: &Path) -> Option<String> {
    let ext = rom.extension()?.to_string_lossy().to_lowercase();
    let mut f = File::open(rom).ok()?;
    let id = match ext.as_str() {
        "3ds" | "cci" => {
            let h = read_at(&mut f, 0x100, 0x10)?;
            if &h[..4] != b"NCSD" {
                return None;
            }
            h[8..16].iter().rev().copied().collect::<Vec<_>>()
        }
        // Header, certificate chain and ticket, each aligned to 64 bytes, then the TMD: its signature's size depends
        // on its type, and the title id sits 0x4C into the header after it (big-endian)
        "cia" => {
            let h = read_at(&mut f, 0, 0x20)?;
            let le = |at: usize| u32::from_le_bytes([h[at], h[at + 1], h[at + 2], h[at + 3]]) as u64;
            let align = |n: u64| n.div_ceil(64) * 64;
            let tmd = align(align(align(le(0)) + le(8)) + le(12));
            let t = read_at(&mut f, tmd, 4)?;
            let sig = match u32::from_be_bytes([t[0], t[1], t[2], t[3]]) {
                0x10003 => 0x23C,
                0x10004 => 0x13C,
                0x10005 => 0x7C,
                _ => return None,
            };
            read_at(&mut f, tmd + 4 + sig + 0x4C, 8)?
        }
        _ => return None,
    };
    Some(id.iter().map(|b| format!("{b:02X}")).collect())
}

/// The emulators' user folders on this PC: their own and Flatpak's on Linux, Application Support on macOS,
/// AppData on Windows
fn user_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
    if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
        out.extend(["Azahar", "Citra", "Lime3DS"].map(|n| appdata.join(n)));
    }
    if let Some(home) = home {
        out.extend(["Azahar", "Citra", "Lime3DS"].map(|n| home.join("Library/Application Support").join(n)));
        out.extend(["azahar-emu", "citra-emu", "lime3ds-emu"].map(|n| home.join(".local/share").join(n)));
        for app in fs::read_dir(home.join(".var/app")).into_iter().flatten().flatten() {
            out.extend(fs::read_dir(app.path().join("data")).into_iter().flatten().flatten().map(|e| e.path()));
        }
    }
    out
}

/// The folders games' saves go in: "<user folder>/sdmc/Nintendo 3DS/<id0>/<id1>/title/00040000", whether or not a
/// game saved yet
pub fn title_dirs() -> Vec<PathBuf> {
    let hex32 = |p: &Path| p.file_name().is_some_and(|n| n.len() == 32 && n.to_string_lossy().chars().all(|c| c.is_ascii_hexdigit()));
    let subdirs = |d: &Path| fs::read_dir(d).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir() && hex32(p)).collect::<Vec<_>>();
    let mut out = Vec::new();
    for user in user_dirs() {
        for id0 in subdirs(&user.join("sdmc/Nintendo 3DS")) {
            out.extend(subdirs(&id0).into_iter().map(|id1| id1.join("title/00040000")));
        }
    }
    out.sort();
    out.dedup();
    out
}

/// The save folders that hold a save (a game that never saved leaves its archive empty)
pub fn save_folders(titles: &Path) -> Vec<PathBuf> {
    let has_save = |data: &Path| fs::read_dir(data).into_iter().flatten().flatten().any(|e| e.path().is_dir() && fs::read_dir(e.path()).into_iter().flatten().flatten().next().is_some());
    let mut out: Vec<PathBuf> = fs::read_dir(titles).into_iter().flatten().flatten().map(|e| e.path().join("data")).filter(|d| has_save(d)).collect();
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_ids_of_3ds_and_cia_roms() {
        let dir = std::env::temp_dir().join(format!("rommancer-ctr-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let mut ncsd = vec![0u8; 0x200];
        ncsd[0x100..0x104].copy_from_slice(b"NCSD");
        ncsd[0x108..0x110].copy_from_slice(&0x0004_0000_0018_F800u64.to_le_bytes());
        fs::write(dir.join("game.3ds"), &ncsd).unwrap();
        // Header 0x2020, certificates 0xA00, ticket 0x350: the TMD starts at 0x2DC0, RSA-2048 signed
        let mut cia = vec![0u8; 0x4000];
        cia[0..4].copy_from_slice(&0x2020u32.to_le_bytes());
        cia[8..12].copy_from_slice(&0xA00u32.to_le_bytes());
        cia[12..16].copy_from_slice(&0x350u32.to_le_bytes());
        cia[0x2DC0..0x2DC4].copy_from_slice(&0x10004u32.to_be_bytes());
        cia[0x2DC0 + 4 + 0x13C + 0x4C..][..8].copy_from_slice(&0x0004_0000_05A1_3E00u64.to_be_bytes());
        fs::write(dir.join("game.cia"), &cia).unwrap();
        assert_eq!(title_id(&dir.join("game.3ds")).as_deref(), Some("000400000018F800"));
        assert_eq!(title_id(&dir.join("game.cia")).as_deref(), Some("0004000005A13E00"));
        fs::write(dir.join("other.3ds"), [0u8; 0x200]).unwrap();
        assert_eq!(title_id(&dir.join("other.3ds")), None);
        fs::remove_dir_all(&dir).unwrap();
    }
}
