//! Rommancer's collections for the frontends on this PC: the games whose saves are synced, and each list given to
//! this PC, as the server tells them (/agent/collections), written as ES-DE custom collections and a Pegasus
//! metadata file

use crate::api::DeviceApi;
use crate::frontend::Library;
use std::collections::BTreeMap;
use std::sync::Arc;

/// Every collection Rommancer writes is named with it, so the ones it wrote before are told apart
pub const PREFIX: &str = "Rommancer - ";

/// Names fit for a file: no path separators or characters Windows refuses
fn clean(name: &str) -> String {
    name.chars().map(|c| if "/\\:*?\"<>|".contains(c) || c.is_control() { ' ' } else { c }).collect::<String>().trim().to_string()
}

/// Returns the frontends whose collections of lists changed (the one of synced games changes with every game played)
pub fn write(api: &DeviceApi, libs: &[Arc<Library>]) -> anyhow::Result<Vec<String>> {
    let targets: Vec<&Arc<Library>> = libs.iter().filter(|l| l.name == "ES-DE" || l.name == "Pegasus").collect();
    if targets.is_empty() {
        return Ok(vec![]);
    }
    let text = api.get_text("/agent/collections")?;
    let mut collections: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split('\t').collect();
        let (name, path) = match f[..] {
            ["saves", p] => (format!("{PREFIX}With saves"), p),
            ["list", n, p] => (format!("{PREFIX}{}", clean(n)), p),
            _ => continue,
        };
        let v = collections.entry(name).or_default();
        if !v.iter().any(|x| x == path) {
            v.push(path.to_string());
        }
    }
    let saves = format!("{PREFIX}With saves");
    let mut out = vec![];
    for l in targets {
        let changed = if l.name == "ES-DE" { crate::esde::write_collections(&l.dir, &collections) } else { crate::pegasus::write_collections(&l.dir, &collections) };
        if changed.iter().any(|n| *n != saves) {
            out.push(l.name.clone());
        }
    }
    Ok(out)
}
