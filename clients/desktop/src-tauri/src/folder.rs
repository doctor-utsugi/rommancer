//! Saves that are whole folders (PPSSPP's SAVEDATA/<game code + suffix>): one travels as a tar of it, its files under
//! "<folder>/", sorted, with no dates or owners, the same tar the server makes of it. Their paths end in "/". A folder
//! is told apart by its manifest's hash (a "<path>\t<sha1>" line per file, sorted), as every client reports it.

use anyhow::{bail, Context, Result};
use std::fs;
use std::path::{Path, PathBuf};

const BLOCK: usize = 512;

fn octal(n: u64, len: usize) -> String {
    format!("{:0w$o}\0", n, w = len - 1)
}

fn header(name: &str, size: u64) -> Result<[u8; BLOCK]> {
    if name.len() > 100 {
        bail!("path too long for a save folder: {name}");
    }
    let mut h = [0u8; BLOCK];
    let mut put = |at: usize, s: &str| h[at..at + s.len()].copy_from_slice(s.as_bytes());
    put(0, name);
    put(100, &octal(0o644, 8));
    put(108, &octal(0, 8));
    put(116, &octal(0, 8));
    put(124, &octal(size, 12));
    put(136, &octal(0, 12));
    put(148, "        ");
    put(156, "0");
    put(257, "ustar\0");
    put(263, "00");
    let sum: u64 = h.iter().map(|b| *b as u64).sum();
    let chk = format!("{}{}", octal(sum, 7), ' ');
    h[148..156].copy_from_slice(chk.as_bytes());
    Ok(h)
}

fn files_of(dir: &Path, rel: &str, out: &mut Vec<(String, PathBuf)>) -> Result<()> {
    for e in fs::read_dir(dir)?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let r = if rel.is_empty() { name } else { format!("{rel}/{name}") };
        let t = e.file_type()?;
        if t.is_dir() {
            files_of(&e.path(), &r, out)?;
        } else if t.is_file() {
            out.push((r, e.path()));
        }
    }
    Ok(())
}

/// The tar of a save folder
pub fn pack(dir: &Path) -> Result<Vec<u8>> {
    let name = dir.file_name().context("save folder without a name")?.to_string_lossy().to_string();
    let mut files = Vec::new();
    files_of(dir, "", &mut files)?;
    files.sort();
    let mut out = Vec::new();
    for (rel, path) in files {
        let data = fs::read(&path)?;
        out.extend_from_slice(&header(&format!("{name}/{rel}"), data.len() as u64)?);
        out.extend_from_slice(&data);
        out.resize(out.len() + (BLOCK - data.len() % BLOCK) % BLOCK, 0);
    }
    out.resize(out.len() + BLOCK * 2, 0);
    Ok(out)
}

/// The folder's manifest hash; none for a folder without files
pub fn hash(dir: &Path) -> Result<Option<String>> {
    let mut files = Vec::new();
    files_of(dir, "", &mut files)?;
    if files.is_empty() {
        return Ok(None);
    }
    let mut lines = Vec::new();
    for (rel, path) in files {
        lines.push(format!("{rel}\t{}\n", sha1_smol::Sha1::from(fs::read(&path)?).digest()));
    }
    lines.sort();
    Ok(Some(sha1_smol::Sha1::from(lines.concat()).digest().to_string()))
}

/// Sizes and newest change of a folder's files: unchanged means its tar is too
pub fn signature(dir: &Path) -> Option<(u64, u64)> {
    let mut files = Vec::new();
    files_of(dir, "", &mut files).ok()?;
    let mut size = files.len() as u64;
    let mut newest = 0;
    for (_, p) in files {
        let m = fs::metadata(p).ok()?;
        size += m.len() << 8;
        newest = newest.max(m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos() as u64).unwrap_or(0));
    }
    Some((size, newest))
}

/// Writes the folder a tar holds as DIR, replacing what was there (the tar's own folder name is not used)
pub fn unpack(tar: &[u8], dir: &Path) -> Result<()> {
    let parent = dir.parent().context("save folder without a parent")?;
    let name = dir.file_name().context("save folder without a name")?.to_string_lossy().to_string();
    let tmp = parent.join(format!(".{name}.rommancer"));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp)?;
    let mut at = 0;
    while at + BLOCK <= tar.len() {
        let h = &tar[at..at + BLOCK];
        if h.iter().all(|b| *b == 0) {
            break;
        }
        let field = |o: usize, l: usize| {
            let raw = &h[o..o + l];
            String::from_utf8_lossy(&raw[..raw.iter().position(|b| *b == 0).unwrap_or(l)]).to_string()
        };
        let size = u64::from_str_radix(field(124, 12).trim(), 8).unwrap_or(0) as usize;
        let full = field(0, 100);
        at += BLOCK;
        if at + size > tar.len() {
            bail!("truncated save folder");
        }
        // Inside the folder only: no absolute paths or ".."
        let rel = full.split_once('/').map(|(_, r)| r).unwrap_or("");
        let safe = !rel.is_empty() && rel.split('/').all(|p| !p.is_empty() && p != "." && p != ".." && !p.contains(':') && !p.contains('\\'));
        if (h[156] == b'0' || h[156] == 0) && safe {
            let out = tmp.join(rel);
            if let Some(d) = out.parent() {
                fs::create_dir_all(d)?;
            }
            fs::write(&out, &tar[at..at + size])?;
        }
        at += size.div_ceil(BLOCK) * BLOCK;
    }
    if dir.exists() {
        fs::remove_dir_all(dir)?;
    }
    fs::rename(&tmp, dir)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_comes_back_the_same() {
        let base = std::env::temp_dir().join(format!("rommancer-folder-{}", std::process::id()));
        let src = base.join("ULUS10336DATA00");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("PARAM.SFO"), b"sfo").unwrap();
        fs::write(src.join("DATA.BIN"), vec![7u8; 1500]).unwrap();
        let tar = pack(&src).unwrap();
        assert_eq!(tar.len(), 512 * 2 + 512 + 1536 + 1024);
        let dest = base.join("other").join("ULUS10336DATA00");
        fs::create_dir_all(&dest).unwrap();
        fs::write(dest.join("OLD.BIN"), b"old").unwrap();
        unpack(&tar, &dest).unwrap();
        assert_eq!(pack(&dest).unwrap(), tar);
        assert!(!dest.join("OLD.BIN").exists());
        // printf 'DATA.BIN\t<sha1>\nPARAM.SFO\t<sha1>\n' | sha1sum, as the console client and the server compute it
        let line = |n: &str, d: &[u8]| format!("{n}\t{}\n", sha1_smol::Sha1::from(d).digest());
        let want = sha1_smol::Sha1::from(line("DATA.BIN", &[7u8; 1500]) + &line("PARAM.SFO", b"sfo")).digest().to_string();
        assert_eq!(hash(&dest).unwrap(), Some(want));
        fs::remove_dir_all(&base).unwrap();
    }
}
