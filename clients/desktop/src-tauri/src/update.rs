//! The app follows the version its server offers: an AppImage, or a binary in a folder it can write, is replaced
//! in place; on Windows the installer runs in passive mode; anything else (the .deb) is only announced.

use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

pub enum Kind {
    /// This file can be replaced by the AppImage
    Replace(PathBuf),
    /// The NSIS installer, run passively, closes the app and starts it again
    Installer,
    /// Installed where the app cannot write: the user installs the update
    Announce,
}

pub fn kind() -> Kind {
    if cfg!(windows) {
        return Kind::Installer;
    }
    // Inside an AppImage the running binary is in a read-only mount; the image itself is the file to replace
    let target = std::env::var_os("APPIMAGE").map(PathBuf::from).or_else(|| std::env::current_exe().ok());
    match target {
        Some(p) if writable_dir(&p) => Kind::Replace(p),
        _ => Kind::Announce,
    }
}

fn writable_dir(p: &std::path::Path) -> bool {
    let Some(dir) = p.parent() else { return false };
    let probe = dir.join(".rommancer-write-test");
    let ok = std::fs::write(&probe, b"").is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder().timeout(Duration::from_secs(600)).build().unwrap_or_default()
}

/// The version the server offers, when it is newer than this one
pub fn newer(server: &str) -> Option<String> {
    let url = format!("{}/api/v1/link/desktop/version", server.trim_end_matches('/'));
    let r = client().get(url).timeout(Duration::from_secs(20)).send().ok()?;
    if !r.status().is_success() {
        return None;
    }
    let text = r.text().ok()?;
    let v = text.lines().find_map(|l| l.strip_prefix("version\t"))?.trim().to_string();
    (parse(&v) > parse(env!("CARGO_PKG_VERSION"))).then_some(v)
}

fn parse(v: &str) -> Vec<u32> {
    v.split('.').map(|n| n.parse().unwrap_or(0)).collect()
}

fn download(server: &str, name: &str, to: &std::path::Path) -> anyhow::Result<()> {
    let url = format!("{}/api/v1/link/desktop/{name}", server.trim_end_matches('/'));
    let mut r = client().get(url).send()?.error_for_status()?;
    let mut buf = Vec::new();
    r.read_to_end(&mut buf)?;
    // A truncated download must not replace a working app
    if buf.len() < 1_000_000 {
        anyhow::bail!("download too small ({} bytes)", buf.len());
    }
    std::fs::write(to, buf)?;
    Ok(())
}

/// Replaces `target` with the server's AppImage (written next to it, then renamed over it)
pub fn replace(server: &str, target: &std::path::Path) -> anyhow::Result<()> {
    let tmp = target.with_extension("update");
    download(server, "rommancer-desktop.AppImage", &tmp)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
    }
    std::fs::rename(&tmp, target)?;
    Ok(())
}

/// Downloads the Windows installer and starts it: passive, it closes this app and starts the new one (/R)
pub fn install(server: &str, hidden: bool) -> anyhow::Result<()> {
    let setup = std::env::temp_dir().join("rommancer-desktop-setup.exe");
    download(server, "rommancer-desktop-setup.exe", &setup)?;
    let mut cmd = std::process::Command::new(&setup);
    cmd.args(["/P", "/UPDATE", "/R"]);
    if hidden {
        cmd.args(["/ARGS", "--hidden"]);
    }
    cmd.spawn()?;
    Ok(())
}
