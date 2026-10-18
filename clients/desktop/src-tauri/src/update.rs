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
    match own_file() {
        Some(p) if writable_dir(&p) => Kind::Replace(p),
        _ => Kind::Announce,
    }
}

/// The file this app runs from: inside an AppImage the binary sits in a read-only mount, the image is the file
pub fn own_file() -> Option<PathBuf> {
    std::env::var_os("APPIMAGE").map(PathBuf::from).or_else(|| std::env::current_exe().ok())
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

/// The protocol of the server this app was built with (backend/src/lib/version.ts)
pub const PROTOCOL: i64 = 1;

/// What the server offers (GET /api/v1/version): its protocol and feature names. The app can be newer than its server;
/// before using something a server gained later, check its feature name and leave it out when it is missing. A server
/// from before 1.98 has no such route: protocol 0, no features. None when the server could not be reached.
pub fn server_info(server: &str) -> Option<(i64, Vec<String>)> {
    let url = format!("{}/api/v1/version", server.trim_end_matches('/'));
    let r = client().get(url).timeout(Duration::from_secs(20)).send().ok()?;
    if r.status() == reqwest::StatusCode::NOT_FOUND {
        return Some((0, Vec::new()));
    }
    let v: serde_json::Value = r.error_for_status().ok()?.json().ok()?;
    let features = v["features"].as_array().map(|a| a.iter().filter_map(|f| f.as_str().map(String::from)).collect()).unwrap_or_default();
    Some((v["protocol"].as_i64().unwrap_or(0), features))
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

/// Starts the app again from `target` and ends this one. Descriptors this process inherited are not passed on: an
/// AppImage runtime writes to its pipe until every holder closes it, so the old image would stay mounted
pub fn relaunch(app: &tauri::AppHandle, target: &std::path::Path) {
    let mut cmd = std::process::Command::new(target);
    cmd.args(std::env::args_os().skip(1));
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            for fd in 3..1024 {
                let flags = libc::fcntl(fd, libc::F_GETFD);
                if flags >= 0 && flags & libc::FD_CLOEXEC == 0 {
                    libc::close(fd);
                }
            }
            Ok(())
        });
    }
    app.cleanup_before_exit();
    let _ = cmd.spawn();
    std::process::exit(0);
}
