/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * OpenCRVS is also distributed under the terms of the Civil Registration
 * & Healthcare Disclaimer located at http://opencrvs.org/license.
 *
 * Copyright (C) The OpenCRVS Authors located at https://github.com/opencrvs/opencrvs-core/blob/master/AUTHORS.
 */

//! The desktop shell.
//!
//! 1. It starts the backend: a bundled Node binary that runs `backend/index.cjs`
//!    on a random port of 127.0.0.1. Every launch gets a new secret, and the
//!    backend refuses requests without it.
//! 2. It opens a window on the `opencrvs` scheme and sends every request of that
//!    scheme to the backend. The backend serves the client build, the API and
//!    the country config proxy.
//! 3. The initialization script of the window comes from the backend. It
//!    writes the token and replaces `navigator.serviceWorker`, which custom
//!    schemes do not have.

// Hide the console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::http::{Request, Response, StatusCode};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

const SCHEME: &str = "opencrvs";
const SECRET_HEADER: &str = "x-opencrvs-desktop-secret";
const ORIGIN_HEADER: &str = "x-opencrvs-desktop-origin";
const READY_PREFIX: &str = "OPENCRVS_DESKTOP_READY ";
const ERROR_PREFIX: &str = "OPENCRVS_DESKTOP_ERROR ";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(120);

/// The origin of the page. WebView2 on Windows serves custom schemes as
/// `http://<scheme>.localhost`.
#[cfg(windows)]
const ORIGIN: &str = "http://opencrvs.localhost";
#[cfg(not(windows))]
const ORIGIN: &str = "opencrvs://localhost";

/// Request and response headers that apply to one connection only.
const HOP_BY_HOP_HEADERS: [&str; 5] = [
    "connection",
    "keep-alive",
    "transfer-encoding",
    "content-length",
    "host",
];

struct Backend {
    base_url: String,
    secret: Option<String>,
    agent: ureq::Agent,
    process: Mutex<Option<(Child, Option<ChildStdin>)>>,
}

enum BackendState {
    Running(Backend),
    Failed(String),
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .redirects(0)
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(300))
        .build()
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from)
}

/// Tauri copies `externalBin` files next to the app executable, without the target triple.
fn sidecar_path(name: &str) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe
        .parent()
        .ok_or_else(|| "The app executable has no parent directory".to_string())?;
    Ok(dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX)))
}

fn random_secret() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn start_backend(app: &tauri::App) -> Result<Backend, String> {
    // For development: use a backend that already runs, e.g. `pnpm start`.
    if let Ok(url) = std::env::var("OPENCRVS_DESKTOP_BACKEND_URL") {
        println!("Using the backend at {url}");
        return Ok(Backend {
            base_url: url.trim_end_matches('/').to_string(),
            secret: None,
            agent: agent(),
            process: Mutex::new(None),
        });
    }

    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let bundle = env_path("OPENCRVS_DESKTOP_BACKEND_BUNDLE")
        .unwrap_or_else(|| resource_dir.join("backend").join("index.cjs"));
    let client_dir = env_path("OPENCRVS_DESKTOP_CLIENT_DIR")
        .unwrap_or_else(|| resource_dir.join("client"));
    let node = match env_path("OPENCRVS_DESKTOP_NODE") {
        Some(path) => path,
        None => sidecar_path("node")?,
    };
    let secret = random_secret()?;

    println!(
        "Starting the backend: {} {} (data in {})",
        node.display(),
        bundle.display(),
        data_dir.display()
    );

    let mut command = Command::new(&node);
    command
        .arg("--disable-warning=ExperimentalWarning")
        .arg(&bundle)
        .arg("--data-dir")
        .arg(&data_dir)
        .arg("--client-dir")
        .arg(&client_dir)
        .arg("--port")
        .arg("0")
        .arg("--exit-on-stdin-close")
        .env("OPENCRVS_DESKTOP_SECRET", &secret)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start {}: {e}", node.display()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "The backend has no stdout".to_string())?;
    let stdin = child.stdin.take();

    // The backend writes one line when it is ready or when it fails.
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    std::thread::spawn(move || {
        let mut reported = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if !reported {
                if let Some(port) = line.strip_prefix(READY_PREFIX) {
                    let _ = tx.send(Ok(port.trim().to_string()));
                    reported = true;
                    continue;
                }
                if let Some(message) = line.strip_prefix(ERROR_PREFIX) {
                    let _ = tx.send(Err(message.to_string()));
                    reported = true;
                    continue;
                }
            }
            println!("[backend] {line}");
        }
        if !reported {
            let _ = tx.send(Err("The backend stopped before it was ready".to_string()));
        }
    });

    let started = Instant::now();
    let port = match rx.recv_timeout(STARTUP_TIMEOUT) {
        Ok(Ok(port)) => port,
        Ok(Err(message)) => {
            let _ = child.kill();
            return Err(message);
        }
        Err(_) => {
            let _ = child.kill();
            return Err("The backend did not start in time".to_string());
        }
    };
    println!(
        "The backend is ready on port {port} after {} ms",
        started.elapsed().as_millis()
    );

    Ok(Backend {
        base_url: format!("http://127.0.0.1:{port}"),
        secret: Some(secret),
        agent: agent(),
        process: Mutex::new(Some((child, stdin))),
    })
}

impl Backend {
    fn request(&self, method: &str, path_and_query: &str) -> ureq::Request {
        let request = self
            .agent
            .request(method, &format!("{}{}", self.base_url, path_and_query))
            .set(ORIGIN_HEADER, ORIGIN);
        match &self.secret {
            Some(secret) => request.set(SECRET_HEADER, secret),
            None => request,
        }
    }

    /// The script that writes the token and installs the service worker stub.
    fn initialization_script(&self) -> Result<String, String> {
        self.request("GET", "/__desktop/bootstrap.js")
            .call()
            .map_err(|e| e.to_string())?
            .into_string()
            .map_err(|e| e.to_string())
    }

    fn stop(&self) {
        let Some((mut child, stdin)) = self.process.lock().ok().and_then(|mut p| p.take()) else {
            return;
        };
        // Closing stdin tells the backend to stop. Kill it if it does not.
        drop(stdin);
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
    }
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn error_page(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    let html = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>OpenCRVS</title>\
         <body style=\"font-family: sans-serif; padding: 2em\">\
         <h1>OpenCRVS could not start</h1><pre style=\"white-space: pre-wrap\">{}</pre></body>",
        escape_html(message)
    );
    Response::builder()
        .status(status)
        .header("content-type", "text/html; charset=utf-8")
        .body(html.into_bytes())
        .expect("a valid error response")
}

/// Sends a request of the `opencrvs` scheme to the backend and returns its response.
fn forward(state: &BackendState, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let backend = match state {
        BackendState::Running(backend) => backend,
        BackendState::Failed(message) => {
            return error_page(StatusCode::SERVICE_UNAVAILABLE, message)
        }
    };

    let path_and_query = request
        .uri()
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/");
    let method = request.method().as_str();
    let mut call = backend.request(method, path_and_query);
    for (name, value) in request.headers() {
        if HOP_BY_HOP_HEADERS.contains(&name.as_str()) {
            continue;
        }
        if let Ok(value) = value.to_str() {
            call = call.set(name.as_str(), value);
        }
    }

    let body = request.body();
    let result = if body.is_empty() && (method == "GET" || method == "HEAD") {
        call.call()
    } else {
        call.send_bytes(body)
    };
    let response = match result {
        Ok(response) => response,
        // ureq treats 4xx and 5xx as errors. The page needs those responses too.
        Err(ureq::Error::Status(_, response)) => response,
        Err(error) => {
            return error_page(
                StatusCode::BAD_GATEWAY,
                &format!("The local backend did not answer {method} {path_and_query}: {error}"),
            )
        }
    };

    let mut builder = Response::builder().status(response.status());
    for name in response.headers_names() {
        if HOP_BY_HOP_HEADERS.contains(&name.as_str()) {
            continue;
        }
        for value in response.all(&name) {
            builder = builder.header(name.as_str(), value);
        }
    }
    let mut bytes = Vec::new();
    if let Err(error) = response.into_reader().read_to_end(&mut bytes) {
        return error_page(
            StatusCode::BAD_GATEWAY,
            &format!("Could not read the response to {method} {path_and_query}: {error}"),
        );
    }
    builder.body(bytes).unwrap_or_else(|error| {
        error_page(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })
}

fn main() {
    let app = tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol(SCHEME, |ctx, request, responder| {
            let state = ctx.app_handle().state::<Arc<BackendState>>().inner().clone();
            // The backend call blocks, so it must not run on the main thread.
            std::thread::spawn(move || responder.respond(forward(&state, request)));
        })
        .setup(|app| {
            let state = match start_backend(app) {
                Ok(backend) => BackendState::Running(backend),
                Err(message) => {
                    eprintln!("The backend could not start: {message}");
                    BackendState::Failed(message)
                }
            };
            let script = match &state {
                BackendState::Running(backend) => backend
                    .initialization_script()
                    .unwrap_or_else(|error| {
                        eprintln!("Could not read the initialization script: {error}");
                        String::new()
                    }),
                BackendState::Failed(_) => String::new(),
            };
            app.manage(Arc::new(state));

            let url = format!("{ORIGIN}/").parse().expect("a valid URL");
            let mut window = WebviewWindowBuilder::new(app, "main", WebviewUrl::CustomProtocol(url))
                .title("OpenCRVS")
                .inner_size(1280.0, 860.0)
                .min_inner_size(800.0, 600.0);
            if !script.is_empty() {
                window = window.initialization_script(&script);
            }
            window.build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the app");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<Arc<BackendState>>() {
                if let BackendState::Running(backend) = state.inner().as_ref() {
                    backend.stop();
                }
            }
        }
    });
}
