//! Talking to the Rommancer server: the user's JSON API (login, lists, collection) and the device API
//! (plain-text "key<TAB>value" lines with a device token), the same one the consoles use.

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use reqwest::blocking::{Body, Client, Response};
use serde_json::Value;
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

pub fn b64(s: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(s.as_bytes())
}

fn client() -> Client {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        // Roms can take long: no overall limit, but a dead connection is noticed
        .timeout(None)
        .tcp_keepalive(Duration::from_secs(30))
        .user_agent(concat!("rommancer-desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("http client")
}

fn api_base(server: &str) -> String {
    format!("{}/api/v1", server.trim_end_matches('/'))
}

fn error_of(resp: Response) -> anyhow::Error {
    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    let msg = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
        .unwrap_or_else(|| if body.trim().is_empty() { status.to_string() } else { body.trim().to_string() });
    anyhow!("{} ({})", msg, status.as_u16())
}

/// The signed-in user: an access token renewed with the refresh token (which rotates on every renewal)
pub struct UserApi {
    pub server: String,
    http: Client,
    access: Mutex<Option<String>>,
    pub refresh: Mutex<Option<String>>,
}

impl UserApi {
    pub fn new(server: &str, refresh: Option<String>) -> Self {
        Self { server: server.trim_end_matches('/').to_string(), http: client(), access: Mutex::new(None), refresh: Mutex::new(refresh) }
    }

    fn take_tokens(&self, v: &Value) -> Result<Value> {
        let access = v.get("accessToken").and_then(|x| x.as_str()).context("no access token")?;
        let refresh = v.get("refreshToken").and_then(|x| x.as_str()).context("no refresh token")?;
        *self.access.lock().unwrap() = Some(access.to_string());
        *self.refresh.lock().unwrap() = Some(refresh.to_string());
        Ok(v.get("user").cloned().unwrap_or(Value::Null))
    }

    pub fn login(&self, username: &str, password: &str) -> Result<Value> {
        let resp = self.http.post(format!("{}/auth/login", api_base(&self.server))).json(&serde_json::json!({ "username": username, "password": password })).send()?;
        if !resp.status().is_success() {
            return Err(error_of(resp));
        }
        self.take_tokens(&resp.json()?)
    }

    pub fn signup(&self, username: &str, email: &str, password: &str) -> Result<Value> {
        let resp = self
            .http
            .post(format!("{}/auth/signup", api_base(&self.server)))
            .json(&serde_json::json!({ "username": username, "email": email, "password": password }))
            .send()?;
        if !resp.status().is_success() {
            return Err(error_of(resp));
        }
        self.take_tokens(&resp.json()?)
    }

    fn renew(&self) -> Result<()> {
        let refresh = self.refresh.lock().unwrap().clone().context("not signed in")?;
        let resp = self.http.post(format!("{}/auth/refresh", api_base(&self.server))).json(&serde_json::json!({ "refreshToken": refresh })).send()?;
        if !resp.status().is_success() {
            *self.refresh.lock().unwrap() = None;
            bail!("session expired, sign in again");
        }
        self.take_tokens(&resp.json()?).map(|_| ())
    }

    pub fn logout(&self) {
        if let Some(r) = self.refresh.lock().unwrap().take() {
            let _ = self.http.post(format!("{}/auth/logout", api_base(&self.server))).json(&serde_json::json!({ "refreshToken": r })).send();
        }
        *self.access.lock().unwrap() = None;
    }

    /// Any JSON call of the web API, renewing the session once when it has expired
    pub fn call(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value> {
        for attempt in 0..2 {
            if self.access.lock().unwrap().is_none() {
                self.renew()?;
            }
            let token = self.access.lock().unwrap().clone().unwrap_or_default();
            let url = format!("{}{}", api_base(&self.server), path);
            let mut req = self.http.request(method.parse()?, url).bearer_auth(token);
            if let Some(b) = body {
                req = req.json(b);
            }
            let resp = req.send()?;
            if resp.status().as_u16() == 401 && attempt == 0 {
                *self.access.lock().unwrap() = None;
                continue;
            }
            if !resp.status().is_success() {
                return Err(error_of(resp));
            }
            let text = resp.text()?;
            return Ok(if text.trim().is_empty() { Value::Null } else { serde_json::from_str(&text)? });
        }
        bail!("not authorised")
    }
}

/// Which root header a card's requests carry (see the server's agent module)
#[derive(Clone)]
pub enum RootHeader {
    /// A card that only lives in computers: the server follows its mount point
    Moves(String),
    /// The card of a console that syncs by itself: only for this request
    Temporary(String),
}

/// The device API with a card's token
pub struct DeviceApi {
    base: String,
    token: String,
    root: RootHeader,
    http: Client,
}

pub fn pairs(text: &str) -> Vec<Vec<String>> {
    text.lines().filter(|l| !l.trim().is_empty()).map(|l| l.split('\t').map(str::to_string).collect()).collect()
}

impl DeviceApi {
    pub fn new(server: &str, token: &str, root: RootHeader) -> Self {
        Self { base: api_base(server), token: token.to_string(), root, http: client() }
    }

    fn req(&self, method: reqwest::Method, path: &str) -> reqwest::blocking::RequestBuilder {
        let (name, value) = match &self.root {
            RootHeader::Moves(r) => ("X-Device-Root-B64", b64(r)),
            RootHeader::Temporary(r) => ("X-Device-Root-Temp-B64", b64(r)),
        };
        self.http.request(method, format!("{}{}", self.base, path)).header("X-Device-Token", &self.token).header(name, value)
    }

    fn ok(resp: Response) -> Result<Response> {
        if resp.status().is_success() {
            Ok(resp)
        } else {
            Err(error_of(resp))
        }
    }

    pub fn get_text(&self, path: &str) -> Result<String> {
        Ok(Self::ok(self.req(reqwest::Method::GET, path).send()?)?.text()?)
    }

    pub fn post_text(&self, path: &str, body: Vec<u8>, headers: &[(&str, String)]) -> Result<String> {
        // The server only reads bodies that declare a type (curl, in the console client, always sends one)
        let mut r = self.req(reqwest::Method::POST, path).header("Content-Type", "application/octet-stream").body(body);
        for (k, v) in headers {
            r = r.header(*k, v);
        }
        Ok(Self::ok(r.send()?)?.text()?)
    }

    /// Streams a download into TARGET.part and renames it; PROGRESS gets the bytes written so far
    pub fn download(&self, path: &str, headers: &[(&str, String)], target: &Path, progress: &mut dyn FnMut(u64), cancel: &dyn Fn() -> bool) -> Result<()> {
        let mut r = self.req(reqwest::Method::GET, path);
        for (k, v) in headers {
            r = r.header(*k, v);
        }
        let mut resp = Self::ok(r.send()?)?;
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let part = target.with_file_name(format!("{}.part", target.file_name().and_then(|n| n.to_str()).unwrap_or("download")));
        let mut out = File::create(&part)?;
        let mut buf = vec![0u8; 1 << 16];
        let mut done = 0u64;
        loop {
            if cancel() {
                drop(out);
                let _ = std::fs::remove_file(&part);
                bail!("cancelled");
            }
            let n = resp.read(&mut buf)?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n])?;
            done += n as u64;
            progress(done);
        }
        out.sync_all()?;
        drop(out);
        std::fs::rename(&part, target)?;
        Ok(())
    }

    /// Sends a whole file as the request body, streamed
    pub fn upload(&self, path: &str, file: &Path, headers: &[(&str, String)]) -> Result<String> {
        let f = File::open(file)?;
        let len = f.metadata()?.len();
        let mut r = self.req(reqwest::Method::POST, path).header("Content-Type", "application/octet-stream").body(Body::sized(f, len));
        for (k, v) in headers {
            r = r.header(*k, v);
        }
        Ok(Self::ok(r.send()?)?.text()?)
    }
}
