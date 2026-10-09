//! WiFi networks this computer already knows, with their passwords, so the user can hand them to the consoles
//! without typing them again. Linux asks NetworkManager; Windows exports its WLAN profiles.

use serde::Serialize;
use std::process::Command;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct LocalWifi {
    pub ssid: String,
    /// None: an open network, or a password the system would not hand over
    pub password: Option<String>,
    /// "dual", "2.4" or "5"
    pub band: String,
    pub hidden: bool,
    /// The network needs a password and none could be read (enterprise logins included)
    pub locked: bool,
}

fn run(cmd: &mut Command) -> Option<String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window flashing for each call
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// nmcli's terse output escapes ':' and '\' with a backslash
fn unescape(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(n) = chars.next() {
                out.push(n);
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// The connection names of the WiFi profiles in `nmcli -t -f NAME,TYPE connection show`
fn nm_names(list: &str) -> Vec<String> {
    list.lines().filter_map(|l| l.strip_suffix(":802-11-wireless")).map(unescape).collect()
}

/// One profile from `nmcli -s -g ssid,hidden,band,key-mgmt,psk connection show id NAME` (one value per line)
fn nm_profile(values: &str) -> Option<LocalWifi> {
    let v: Vec<String> = values.lines().map(unescape).collect();
    let get = |i: usize| v.get(i).map(|s| s.trim().to_string()).unwrap_or_default();
    let ssid = get(0);
    if ssid.is_empty() {
        return None;
    }
    let mgmt = get(3);
    let psk = get(4);
    let protected = !mgmt.is_empty() && mgmt != "none";
    let usable = matches!(mgmt.as_str(), "" | "none" | "wpa-psk" | "sae");
    let band = match get(2).as_str() {
        "a" => "5",
        "bg" => "2.4",
        _ => "dual",
    };
    Some(LocalWifi {
        ssid,
        password: (protected && usable && !psk.is_empty()).then_some(psk),
        band: band.into(),
        hidden: get(1) == "yes",
        locked: protected && (!usable || get(4).is_empty()),
    })
}

/// Bands each nearby network was last seen on (`nmcli -t -f SSID,FREQ device wifi list`, the cached scan)
fn nm_seen(list: &str) -> std::collections::HashMap<String, (bool, bool)> {
    let mut seen = std::collections::HashMap::new();
    for line in list.lines() {
        let Some((ssid, freq)) = line.rsplit_once(':') else { continue };
        let mhz: u32 = freq.trim_end_matches(" MHz").trim().parse().unwrap_or(0);
        let e = seen.entry(unescape(ssid)).or_insert((false, false));
        if (2400..2500).contains(&mhz) {
            e.0 = true;
        } else if mhz >= 4900 {
            e.1 = true;
        }
    }
    seen
}

fn linux() -> Result<Vec<LocalWifi>, String> {
    let list = run(Command::new("nmcli").args(["-t", "-f", "NAME,TYPE", "connection", "show"])).ok_or("NetworkManager (nmcli) is not available")?;
    let seen = nm_seen(&run(Command::new("nmcli").args(["-t", "-f", "SSID,FREQ", "device", "wifi", "list", "--rescan", "no"])).unwrap_or_default());
    let mut out: Vec<LocalWifi> = Vec::new();
    for name in nm_names(&list) {
        let fields = "802-11-wireless.ssid,802-11-wireless.hidden,802-11-wireless.band,802-11-wireless-security.key-mgmt,802-11-wireless-security.psk";
        let values = run(Command::new("nmcli").args(["-s", "-g", fields, "connection", "show", "id", &name])).unwrap_or_default();
        if let Some(mut w) = nm_profile(&values) {
            // A network only ever seen on one band is that band's alone (a 5 GHz one would not reach a 2.4 GHz console)
            match seen.get(&w.ssid) {
                Some((true, false)) if w.band == "dual" => w.band = "2.4".into(),
                Some((false, true)) if w.band == "dual" => w.band = "5".into(),
                _ => {}
            }
            if !out.iter().any(|o| o.ssid == w.ssid) {
                out.push(w);
            }
        }
    }
    Ok(out)
}

/// Text of the first <tag>…</tag> in a WLAN profile XML, with its entities decoded
fn xml_tag(xml: &str, tag: &str) -> Option<String> {
    let start = xml.find(&format!("<{tag}>"))? + tag.len() + 2;
    let end = start + xml[start..].find(&format!("</{tag}>"))?;
    Some(xml[start..end].replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&"))
}

/// One profile exported by `netsh wlan export profile key=clear`
fn win_profile(xml: &str) -> Option<LocalWifi> {
    let ssid_block = &xml[xml.find("<SSID>")?..];
    let ssid = xml_tag(ssid_block, "name")?;
    let auth = xml_tag(xml, "authentication").unwrap_or_default();
    let open = auth == "open" && xml_tag(xml, "encryption").as_deref() == Some("none");
    let usable = matches!(auth.as_str(), "open" | "WPA2PSK" | "WPAPSK" | "WPA3SAE");
    let key = xml_tag(xml, "keyMaterial").filter(|k| !k.is_empty());
    Some(LocalWifi {
        ssid,
        password: if open || !usable { None } else { key.clone() },
        band: "dual".into(),
        hidden: xml_tag(xml, "nonBroadcast").as_deref() == Some("true"),
        locked: !open && (!usable || key.is_none()),
    })
}

fn windows() -> Result<Vec<LocalWifi>, String> {
    let dir = std::env::temp_dir().join(format!("rommancer-wlan-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let folder = format!("folder={}", dir.display());
    let exported = run(Command::new("netsh").args(["wlan", "export", "profile", "key=clear", &folder]));
    let mut out: Vec<LocalWifi> = Vec::new();
    for f in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
        if let Some(w) = std::fs::read_to_string(f.path()).ok().as_deref().and_then(win_profile) {
            if !out.iter().any(|o| o.ssid == w.ssid) {
                out.push(w);
            }
        }
    }
    // The exported files hold the passwords in clear text: they never stay on disk
    let _ = std::fs::remove_dir_all(&dir);
    if exported.is_none() && out.is_empty() {
        return Err("netsh could not export the WiFi profiles".into());
    }
    Ok(out)
}

pub fn known_networks() -> Result<Vec<LocalWifi>, String> {
    if cfg!(windows) {
        windows()
    } else if cfg!(target_os = "linux") {
        linux()
    } else {
        Err("Reading this computer's WiFi networks is not supported on this system yet".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn networkmanager_profiles() {
        assert_eq!(nm_names("Casa\\:2:802-11-wireless\nWired:802-3-ethernet\nPiso:802-11-wireless\n"), vec!["Casa:2", "Piso"]);
        let w = nm_profile("Casa\nno\nbg\nwpa-psk\nse\\:creta\n").unwrap();
        assert_eq!((w.ssid.as_str(), w.password.as_deref(), w.band.as_str(), w.hidden, w.locked), ("Casa", Some("se:creta"), "2.4", false, false));
        let open = nm_profile("Cafe\nyes\n\n\n\n").unwrap();
        assert_eq!((open.password, open.hidden, open.locked), (None, true, false));
        let seen = nm_seen("Casa:2437 MHz\nCasa:5180 MHz\nPlata:5500 MHz\nAzul:2412 MHz\n");
        assert_eq!((seen["Casa"], seen["Plata"], seen["Azul"]), ((true, true), (false, true), (true, false)));
        let work = nm_profile("Oficina\nno\na\nwpa-eap\n\n").unwrap();
        assert_eq!((work.password, work.band.as_str(), work.locked), (None, "5", true));
    }

    #[test]
    fn windows_profiles() {
        let xml = r#"<?xml version="1.0"?><WLANProfile><name>Casa</name><SSIDConfig><SSID><hex>43</hex><name>Casa &amp; Co</name></SSID><nonBroadcast>true</nonBroadcast></SSIDConfig>
<MSM><security><authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption></authEncryption><sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>pass&lt;1</keyMaterial></sharedKey></security></MSM></WLANProfile>"#;
        let w = win_profile(xml).unwrap();
        assert_eq!((w.ssid.as_str(), w.password.as_deref(), w.hidden, w.locked), ("Casa & Co", Some("pass<1"), true, false));
        let open = win_profile("<SSID><name>Libre</name></SSID><authentication>open</authentication><encryption>none</encryption>").unwrap();
        assert_eq!((open.password, open.locked), (None, false));
    }
}

#[cfg(test)]
mod live {
    /// `cargo test --lib live_networks -- --ignored --nocapture`: names and whether each password was readable, never the passwords
    #[test]
    #[ignore]
    fn live_networks() {
        for w in super::known_networks().unwrap() {
            println!("{} band={} hidden={} password={} locked={}", w.ssid, w.band, w.hidden, w.password.is_some(), w.locked);
        }
    }
}
