//! A game LaunchBox is about to start on this PC, as the console clients do before a game: its saves changed here
//! go up, conflicts are settled on screen (or left for later, the local save plays) and newer saves come down.

use crate::api::{b64, pairs, DeviceApi};
use crate::sync::{conflict_of, Conflict};
use anyhow::Result;
use std::fs;
use std::path::Path;

fn sha1_of(p: &Path) -> Option<String> {
    let mut h = sha1_smol::Sha1::new();
    h.update(&fs::read(p).ok()?);
    Some(h.digest().to_string())
}

fn is_state(p: &str) -> bool {
    let n = p.to_lowercase();
    n.contains(".state") || n.ends_with(".st0")
}

/// ASK shows the conflicts and returns the kept side of each ("device" or "server"), none for those left for later
pub fn start(api: &DeviceApi, rom: &str, ask: &dyn Fn(&[Conflict]) -> Vec<(u64, String)>, log: &dyn Fn(String)) -> Result<()> {
    let rh = ("X-Rom-B64", b64(rom));
    let manifest = api.get_text_with("/agent/manifest", std::slice::from_ref(&rh))?;
    let plan = || -> Result<Vec<Vec<String>>> {
        let present: String = manifest.lines().filter(|p| !p.is_empty()).filter_map(|p| sha1_of(Path::new(p)).map(|h| format!("{p}\t{h}\n"))).collect();
        Ok(pairs(&api.post_text("/agent/start", present.into_bytes(), std::slice::from_ref(&rh))?))
    };
    let mut steps = plan()?;
    // Saves changed here go up first (savestates wait for the next sync): one that clashes becomes a conflict
    let ups: Vec<String> = steps.iter().filter(|s| s.len() >= 2 && s[0] == "put" && !is_state(&s[1])).map(|s| s[1].clone()).collect();
    for p in &ups {
        api.upload("/agent/upload", Path::new(p), &[rh.clone(), ("X-Path-B64", b64(p))])?;
        log(format!("game-start: sent {p}"));
    }
    if !ups.is_empty() {
        steps = plan()?;
    }
    let conflicts: Vec<Conflict> = steps.iter().filter(|s| s[0] == "conflict").filter_map(|s| conflict_of(s)).collect();
    if !conflicts.is_empty() {
        let answers = ask(&conflicts);
        for (id, keep) in &answers {
            api.post_text(&format!("/agent/conflicts/{id}?keep={keep}"), Vec::new(), &[])?;
            log(format!("conflict {id}: kept the {keep} version"));
        }
        if answers.len() < conflicts.len() {
            log("game-start: a conflict was left for later, the local save plays".into());
        }
        if !answers.is_empty() {
            steps = plan()?;
        }
    }
    let never = || false;
    for s in steps.iter().filter(|s| s.len() >= 3) {
        match s[0].as_str() {
            // A newer save is coming: the resume state would bring the old progress back, so it goes aside
            "aside" => {
                let _ = fs::rename(&s[1], format!("{}.rommancer-aside", s[1]));
            }
            "get" => {
                let target = Path::new(&s[1]);
                if let Some(d) = target.parent() {
                    fs::create_dir_all(d)?;
                }
                api.download(&format!("/agent/file?v={}", s[2]), &[rh.clone(), ("X-Path-B64", b64(&s[1]))], target, &mut |_| {}, &never)?;
                log(format!("game-start: got {}", s[1]));
            }
            "tget" => {
                let _ = api.download(&format!("/agent/thumb?v={}", s[2]), &[], Path::new(&s[1]), &mut |_| {}, &never);
            }
            _ => {}
        }
    }
    Ok(())
}
