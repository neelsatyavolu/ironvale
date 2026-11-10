//! Debug builds only, and only when IRONVALE_DEVBRIDGE_PORT and
//! IRONVALE_DEVBRIDGE_TOKEN are both set: a localhost endpoint that lets a
//! test script run JavaScript in the game's webview and read the window's
//! state. scripts/dev/app-check.mjs drives it.
//!
//! Every request must carry the token in an `x-devbridge-token` header. A web
//! page open in a browser can reach localhost too; it cannot know the token,
//! and a browser will not send the header across origins without asking first.
//!
//!   POST /eval    body: the body of an async function; replies {ok, value} or {ok, error}
//!   GET  /window  replies with focus, size, position, scale, full screen and grab state
//!   POST /hide    hides the app, as Command-H does, so the window loses focus

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::json;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::pointer::GrabState;
use crate::MAIN_WINDOW;

const PORT_VARIABLE: &str = "IRONVALE_DEVBRIDGE_PORT";
const TOKEN_VARIABLE: &str = "IRONVALE_DEVBRIDGE_TOKEN";
const TOKEN_HEADER: &str = "x-devbridge-token";
const MIN_TOKEN_LENGTH: usize = 16;
const EVAL_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_BODY: usize = 1 << 20;

/// Collects what the page logs from its first line, so a script can read it back later.
const LOG_SCRIPT: &str = r#"
(() => {
  const log = (window.__devlog = []);
  const text = (value) => {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  };
  for (const level of ['warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => { log.push(`[${level}] ${args.map(text).join(' ')}`); original(...args); };
  }
  addEventListener('error', (e) => log.push(`[pageerror] ${e.message} ${e.filename || ''}:${e.lineno || ''}`));
  addEventListener('unhandledrejection', (e) => log.push(`[rejection] ${text(e.reason)}`));
  document.addEventListener('securitypolicyviolation', (e) =>
    log.push(`[csp] ${e.effectiveDirective} blocked ${e.blockedURI} ${e.sourceFile || ''}:${e.lineNumber || ''}`));
})();
"#;

#[derive(Default)]
pub struct Bridge {
    next: AtomicU64,
    waiting: Mutex<HashMap<u64, Sender<String>>>,
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("devbridge").js_init_script(LOG_SCRIPT.to_string()).build()
}

/// The page hands back the result of an /eval.
#[tauri::command]
pub fn devbridge_reply(id: u64, json: String, bridge: State<'_, Bridge>) {
    let sender = bridge.waiting.lock().ok().and_then(|mut waiting| waiting.remove(&id));
    if let Some(sender) = sender {
        let _ = sender.send(json);
    }
}

pub fn start<R: Runtime>(app: AppHandle<R>) {
    app.manage(Bridge::default());
    let Some(port) = std::env::var(PORT_VARIABLE).ok().and_then(|value| value.parse::<u16>().ok()) else {
        return;
    };
    let token = std::env::var(TOKEN_VARIABLE).unwrap_or_default();
    if token.len() < MIN_TOKEN_LENGTH {
        eprintln!("devbridge: not started, {TOKEN_VARIABLE} must be at least {MIN_TOKEN_LENGTH} characters");
        return;
    }
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("devbridge: could not listen on 127.0.0.1:{port}: {error}");
            return;
        }
    };
    eprintln!("devbridge: listening on http://127.0.0.1:{port}");
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            let token = token.clone();
            std::thread::spawn(move || {
                if let Err(error) = serve(&app, &token, stream) {
                    eprintln!("devbridge: {error}");
                }
            });
        }
    });
}

fn serve<R: Runtime>(app: &AppHandle<R>, token: &str, stream: TcpStream) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let mut parts = request_line.split_whitespace();
    let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));

    let mut length = 0usize;
    let mut authorised = false;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().unwrap_or(0);
            } else if name.eq_ignore_ascii_case(TOKEN_HEADER) {
                authorised = value.trim() == token;
            }
        }
    }
    let mut body = vec![0u8; length.min(MAX_BODY)];
    reader.read_exact(&mut body)?;

    let (status, reply) = match (method, path) {
        _ if !authorised => ("403 Forbidden", failure("missing or wrong token")),
        ("POST", "/eval") => ("200 OK", eval(app, &String::from_utf8_lossy(&body))),
        ("GET", "/window") => ("200 OK", window_state(app)),
        ("POST", "/hide") => ("200 OK", hide(app)),
        _ => ("404 Not Found", json!({ "ok": false, "error": "unknown route" }).to_string()),
    };
    let mut stream = stream;
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
        reply.len()
    )
}

fn failure(message: impl std::fmt::Display) -> String {
    json!({ "ok": false, "error": message.to_string() }).to_string()
}

fn eval<R: Runtime>(app: &AppHandle<R>, code: &str) -> String {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return failure("no window");
    };
    let bridge = app.state::<Bridge>();
    let id = bridge.next.fetch_add(1, Ordering::SeqCst);
    let (sender, receiver) = channel();
    match bridge.waiting.lock() {
        Ok(mut waiting) => waiting.insert(id, sender),
        Err(_) => return failure("bridge state is poisoned"),
    };
    let script = format!(
        r#"(async () => {{
  let out;
  try {{ out = {{ ok: true, value: await (async () => {{ {code}
  }})() }}; }} catch (error) {{ out = {{ ok: false, error: String((error && error.stack) || error) }}; }}
  let json;
  try {{ json = JSON.stringify(out); }} catch (error) {{ json = JSON.stringify({{ ok: false, error: 'result is not JSON: ' + error }}); }}
  window.__TAURI_INTERNALS__.invoke('devbridge_reply', {{ id: {id}, json }});
}})();"#
    );
    if let Err(error) = window.eval(script) {
        return failure(error);
    }
    match receiver.recv_timeout(EVAL_TIMEOUT) {
        Ok(json) => json,
        Err(_) => {
            if let Ok(mut waiting) = bridge.waiting.lock() {
                waiting.remove(&id);
            }
            failure("the page did not answer in time")
        }
    }
}

fn hide<R: Runtime>(app: &AppHandle<R>) -> String {
    #[cfg(target_os = "macos")]
    if let Err(error) = app.hide() {
        return failure(error);
    }
    json!({ "ok": true }).to_string()
}

fn window_state<R: Runtime>(app: &AppHandle<R>) -> String {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return failure("no window");
    };
    let size = window.inner_size().unwrap_or_default();
    let position = window.inner_position().unwrap_or_default();
    json!({
        "ok": true,
        "pid": std::process::id(),
        "focused": window.is_focused().unwrap_or(false),
        "fullscreen": window.is_fullscreen().unwrap_or(false),
        "visible": window.is_visible().unwrap_or(false),
        "scaleFactor": window.scale_factor().unwrap_or(1.0),
        "innerSize": [size.width, size.height],
        "innerPosition": [position.x, position.y],
        "grabHeld": app.state::<GrabState>().is_held(),
    })
    .to_string()
}
