//! Browsing the server's games (docs/browse.md): systems and games the server can send, the space check of a pick and
//! adding it to the device's picks. The download is the list download of a sync (Engine::roms).

use crate::api::{pairs, DeviceApi};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// A system the server can send: GAMES sendable, BYTES their size, HERE of them on the device or queued, NEW_BYTES the
/// size of the rest
#[derive(Serialize)]
pub struct System {
    pub slug: String,
    pub name: String,
    pub games: u64,
    pub bytes: u64,
    pub here: u64,
    pub new_bytes: u64,
}

/// A game the server can send; STATE "here", "queued" or "new"
#[derive(Serialize)]
pub struct Game {
    pub id: String,
    pub bytes: u64,
    pub state: String,
    pub system: String,
    pub title: String,
}

/// One page of games; TOTAL of the whole query
#[derive(Serialize)]
pub struct Page {
    pub total: u64,
    pub games: Vec<Game>,
}

/// The games ticked one by one, and whole systems with the games unticked inside them
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct Pick {
    pub games: Vec<String>,
    pub systems: HashMap<String, Vec<String>>,
}

impl Pick {
    pub fn body(&self) -> String {
        let mut out = String::new();
        for g in &self.games {
            out.push_str(&format!("game\t{g}\n"));
        }
        for (slug, skip) in &self.systems {
            out.push_str(&format!("system\t{slug}\n"));
            for s in skip {
                out.push_str(&format!("skip\t{s}\n"));
            }
        }
        out
    }
}

/// The server's check of a pick: NEED what it adds, HAVE picked games already here or queued, PENDING what the lists
/// still download first, USABLE (none: space unknown) = FREE - KEPT; NOSPACE when an add was refused, ADDED the games
/// an add put in the device's picks
#[derive(Serialize, Default)]
pub struct Check {
    pub need_bytes: u64,
    pub need_games: u64,
    pub have: u64,
    pub pending: u64,
    pub usable: Option<u64>,
    pub free: u64,
    pub kept: u64,
    pub fits: bool,
    pub nospace: bool,
    pub added: Option<u64>,
}

/// The answer's rows; outcomes come as text lines, "denied" (no right to download games) among them
fn rows(text: &str) -> Result<Vec<Vec<String>>> {
    let rows = pairs(text);
    if rows.first().is_some_and(|r| r[0].trim() == "denied") {
        bail!("denied");
    }
    Ok(rows)
}

fn num(r: Option<&Vec<String>>, i: usize) -> u64 {
    r.and_then(|r| r.get(i)).and_then(|v| v.parse().ok()).unwrap_or(0)
}

/// "free total" bytes where the roms go: the roms folder this device knows (else the server's), or its nearest
/// existing parent, else the device root
pub fn space(api: &DeviceApi, roms_dir: Option<&str>, root: &str) -> Option<String> {
    let dir = match roms_dir {
        Some(d) => Some(PathBuf::from(d)),
        None => api.get_text("/agent/roots").ok().and_then(|t| pairs(&t).into_iter().find(|r| r.len() >= 2 && r[0] == "roms").map(|r| PathBuf::from(&r[1]))),
    };
    let start = dir.unwrap_or_else(|| PathBuf::from(root));
    let near = start.ancestors().find(|p| p.is_dir()).map(Path::to_path_buf)?;
    crate::card::space_of(&near).map(|(f, t)| format!("{f} {t}"))
}

pub fn systems(api: &DeviceApi) -> Result<Vec<System>> {
    Ok(rows(&api.get_text("/agent/browse/systems")?)?
        .into_iter()
        .filter(|r| r.len() >= 6 && r[0] == "system")
        .map(|r| {
            let n = |i: usize| r.get(i).and_then(|v| v.parse::<u64>().ok());
            let (games, bytes, here) = (n(2).unwrap_or(0), n(3).unwrap_or(0), n(4).unwrap_or(0));
            // A server without the 7th field: the share of the games not here yet
            let new_bytes = n(6).unwrap_or_else(|| if games > 0 { bytes * games.saturating_sub(here) / games } else { 0 });
            System { slug: r[1].clone(), name: r[5].clone(), games, bytes, here, new_bytes }
        })
        .collect())
}

/// SYSTEM none: every system this device knows; Q under 2 characters lists by title; ALL also the games already here
pub fn games(api: &DeviceApi, system: Option<&str>, q: &str, offset: u64, limit: u64, all: bool) -> Result<Page> {
    let enc = |s: &str| urlencoding::encode(s).into_owned();
    let mut query = format!("?q={}&offset={offset}&limit={limit}", enc(q));
    if let Some(s) = system.filter(|s| !s.is_empty()) {
        query.push_str(&format!("&system={}", enc(s)));
    }
    if !all {
        query.push_str("&show=new");
    }
    let rows = rows(&api.get_text(&format!("/agent/browse/games{query}"))?)?;
    let total = num(rows.iter().find(|r| r.len() >= 2 && r[0] == "total"), 1);
    let games = rows
        .into_iter()
        .filter(|r| r.len() >= 6 && r[0] == "game")
        .map(|r| Game { id: r[1].clone(), bytes: r[2].parse().unwrap_or(0), state: r[3].clone(), system: r[4].clone(), title: r[5..].join("\t") })
        .collect();
    Ok(Page { total, games })
}

fn check_of(rows: &[Vec<String>]) -> Check {
    let row = |k: &str| rows.iter().find(|r| r[0] == k);
    let space = row("space");
    let usable = space.and_then(|r| r.get(1)).and_then(|v| v.parse().ok());
    Check {
        need_bytes: num(row("need"), 1),
        need_games: num(row("need"), 2),
        have: num(row("have"), 1),
        pending: num(row("pending"), 1),
        usable,
        free: num(space, 2),
        kept: num(space, 3),
        fits: row("fits").and_then(|r| r.get(1)).is_some_and(|v| v == "1") && usable.is_some(),
        nospace: row("nospace").is_some(),
        added: row("added").and_then(|r| r.get(1)).and_then(|v| v.parse().ok()),
    }
}

/// SPACE: the "free total" header; none when it could not be measured
pub fn check(api: &DeviceApi, pick: &Pick, space: Option<&str>) -> Result<Check> {
    let headers: Vec<(&str, String)> = space.map(|s| ("X-Space", s.to_string())).into_iter().collect();
    Ok(check_of(&rows(&api.post_text("/agent/browse/check", pick.body().into_bytes(), &headers)?)?))
}

/// Puts the pick in the device's picks when it fits; refused here when the space could not be measured
pub fn add(api: &DeviceApi, pick: &Pick, space: Option<&str>) -> Result<Check> {
    let Some(space) = space else {
        return Ok(Check { usable: None, fits: false, nospace: true, ..check(api, pick, None)? });
    };
    Ok(check_of(&rows(&api.post_text("/agent/browse/add", pick.body().into_bytes(), &[("X-Space", space.to_string())])?)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_lines() {
        let text = "need\t4000\t2\nhave\t1\npending\t100\nspace\t900\t1000\t100\nfits\t1\nadded\t2\t4000\n";
        let c = check_of(&pairs(text));
        assert_eq!((c.need_bytes, c.need_games, c.have, c.pending, c.usable, c.free, c.kept, c.fits, c.nospace, c.added), (4000, 2, 1, 100, Some(900), 1000, 100, true, false, Some(2)));
        let c = check_of(&pairs("need\t1\t1\nspace\t-\nfits\t0\nnospace\n"));
        assert_eq!((c.usable, c.fits, c.nospace, c.added), (None, false, true, None));
        assert!(rows("denied\n").is_err());
    }

    #[test]
    fn pick_body() {
        let p = Pick { games: vec!["7".into()], systems: HashMap::from([("gb".to_string(), vec!["9".to_string()])]) };
        assert_eq!(p.body(), "game\t7\nsystem\tgb\nskip\t9\n");
    }

    /// Browse, add and download against a real server; backend/test/browse.test.ts runs it with ROMMANCER_DESKTOP=1
    #[test]
    #[ignore]
    fn browse_against_server() {
        let var = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k} not set"));
        let root = var("ROMMANCER_TEST_ROOT");
        let api = DeviceApi::new(&var("ROMMANCER_TEST_SERVER"), &var("ROMMANCER_TEST_TOKEN"), crate::api::RootHeader::Temporary(root.clone()));
        let system = var("ROMMANCER_TEST_SYSTEM");
        let q = var("ROMMANCER_TEST_QUERY");
        let s = systems(&api).unwrap();
        let sys = s.iter().find(|x| x.slug == system).expect("system offered");
        println!("SYSTEM {} games={} new_bytes={}", sys.slug, sys.games, sys.new_bytes);
        let page = games(&api, Some(&system), &q, 0, 50, false).unwrap();
        let g = page.games.first().expect("a game found");
        println!("GAME {} {} {} {}", g.id, g.bytes, g.state, g.title);
        let pick = Pick { games: vec![g.id.clone()], ..Default::default() };
        let space = space(&api, None, &root);
        assert!(space.is_some(), "space measured");
        let c = check(&api, &pick, space.as_deref()).unwrap();
        println!("CHECK need={} games={} fits={}", c.need_bytes, c.need_games, c.fits);
        let a = add(&api, &pick, space.as_deref()).unwrap();
        println!("ADDED {}", a.added.unwrap_or(0));
        // The download the app starts after an add: the list games, then the inventory pass
        let (report, cancelled, log) = (|_p: crate::sync::Progress| {}, || false, |l: String| println!("LOG {l}"));
        let cache = Path::new(&root).with_extension("cache.tsv");
        let mut e = crate::sync::Engine::new(api, "card".into(), root.clone(), cache, &report, &cancelled, &log);
        let mut out = crate::sync::Outcome::default();
        e.roms(&mut out).unwrap();
        e.sync(&mut out).unwrap();
        println!("OUT games_down={} failed={}", out.games_down, out.games_failed);
        let after = games(&e.api, Some(&system), &q, 0, 50, true).unwrap();
        println!("STATE {}", after.games.iter().find(|x| x.id == g.id).map(|x| x.state.as_str()).unwrap_or("-"));
    }
}
