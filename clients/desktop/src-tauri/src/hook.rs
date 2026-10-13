//! The channel LaunchBox's Rommancer plugin talks to: HTTP on 127.0.0.1 with a key, both written to a file the
//! plugin reads (hook.json in the user's local app data, Rommancer folder). "POST /game-start" answers once the
//! game's saves are ready (the plugin holds the game until then); "POST /game-end" only tells the app.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;

pub struct Request {
    pub path: String,
    pub body: String,
}

/// Where the plugin finds the port and key
pub fn info_file() -> PathBuf {
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share")))
    };
    base.unwrap_or_else(std::env::temp_dir).join("Rommancer").join("hook.json")
}

fn key() -> String {
    let mut h = sha1_smol::Sha1::new();
    h.update(format!("{:?}{}{:?}", std::time::SystemTime::now(), std::process::id(), std::thread::current().id()).as_bytes());
    h.update(&std::fs::read(info_file()).unwrap_or_default());
    h.digest().to_string()
}

fn read(stream: &TcpStream) -> Option<(Request, String)> {
    let mut r = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    r.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let (method, path) = (parts.next()?.to_string(), parts.next()?.to_string());
    let (mut len, mut key) = (0usize, String::new());
    loop {
        let mut h = String::new();
        if r.read_line(&mut h).ok()? == 0 || h.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            match k.trim().to_ascii_lowercase().as_str() {
                "content-length" => len = v.trim().parse().ok()?,
                "x-rommancer-key" => key = v.trim().to_string(),
                _ => {}
            }
        }
    }
    if method != "POST" || len > 64 * 1024 {
        return None;
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).ok()?;
    Some((Request { path, body: String::from_utf8_lossy(&body).to_string() }, key))
}

fn reply(mut stream: TcpStream, status: &str, body: &str) {
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
}

/// Serves requests one thread each; HANDLE answers the text sent back
pub fn serve(handle: impl Fn(Request) -> String + Send + Sync + 'static) {
    let Ok(listener) = TcpListener::bind("127.0.0.1:0") else { return };
    let Ok(port) = listener.local_addr().map(|a| a.port()) else { return };
    let secret = key();
    let file = info_file();
    if let Some(d) = file.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let _ = std::fs::write(&file, serde_json::json!({ "port": port, "key": secret }).to_string());
    let handle = std::sync::Arc::new(handle);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let handle = handle.clone();
            let secret = secret.clone();
            std::thread::spawn(move || match read(&stream) {
                Some((req, k)) if k == secret => {
                    let out = handle(req);
                    reply(stream, "200 OK", &out);
                }
                Some(_) => reply(stream, "403 Forbidden", "wrong key"),
                None => reply(stream, "400 Bad Request", "bad request"),
            });
        }
    });
}
