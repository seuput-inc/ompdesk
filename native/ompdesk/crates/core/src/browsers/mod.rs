//! The Chromium browsers the Default browser setting can point agents at, as this computer has them (was
//! `src/main/agent-browsers.ts`): each one in its standard install place (`browsers.find`), the installed ones with
//! ego-browser and the browsers stock's native host serves (`browsers.status`), writing a browser's copy of the omp
//! Browser Relay extension (`browsers.installRelay`, `relay.rs`) and opening the browser at its extensions page
//! (`browsers.openExtensions`).
//!
//! Main hands over what it also spells for the page: the browsers in `auto` order with their names
//! (`src/shared/default-browser.ts`), where this machine keeps things (`systemBrowserPlaces`), and how it runs omp.
//! The core caches ego-browser's path and the status snapshot, including its automatic browser choice.

mod ego;
mod relay;
mod status;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::server::{Fault, Registry, Reply, Scope};

/// A browser the setting can name.
#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Id {
    Chrome,
    Edge,
    Brave,
    Arc,
    Chromium,
}

/// Where a browser is installed and keeps its profiles.
struct Definition {
    /// macOS bundle name.
    app: Option<&'static str>,
    /// Windows exe under a program folder.
    exe: Option<&'static [&'static str]>,
    /// User data folder under `~/Library/Application Support`.
    mac_data: &'static [&'static str],
    /// User data folder under `%LOCALAPPDATA%`.
    win_data: Option<&'static [&'static str]>,
    /// The scheme its extensions page answers to.
    scheme: &'static str,
}

impl Id {
    fn name(self) -> &'static str {
        match self {
            Id::Chrome => "chrome",
            Id::Edge => "edge",
            Id::Brave => "brave",
            Id::Arc => "arc",
            Id::Chromium => "chromium",
        }
    }

    fn definition(self) -> Definition {
        match self {
            Id::Chrome => Definition {
                app: Some("Google Chrome.app"),
                exe: Some(&["Google", "Chrome", "Application", "chrome.exe"]),
                mac_data: &["Google", "Chrome"],
                win_data: Some(&["Google", "Chrome", "User Data"]),
                scheme: "chrome",
            },
            Id::Edge => Definition {
                app: Some("Microsoft Edge.app"),
                exe: Some(&["Microsoft", "Edge", "Application", "msedge.exe"]),
                mac_data: &["Microsoft Edge"],
                win_data: Some(&["Microsoft", "Edge", "User Data"]),
                scheme: "edge",
            },
            Id::Brave => Definition {
                app: Some("Brave Browser.app"),
                exe: Some(&["BraveSoftware", "Brave-Browser", "Application", "brave.exe"]),
                mac_data: &["BraveSoftware", "Brave-Browser"],
                win_data: Some(&["BraveSoftware", "Brave-Browser", "User Data"]),
                scheme: "brave",
            },
            // Arc ships as a Store app on Windows, with no standard install place to look in.
            Id::Arc => Definition {
                app: Some("Arc.app"),
                exe: None,
                mac_data: &["Arc", "User Data"],
                win_data: None,
                scheme: "arc",
            },
            Id::Chromium => Definition {
                app: Some("Chromium.app"),
                exe: Some(&["Chromium", "Application", "chrome.exe"]),
                mac_data: &["Chromium"],
                win_data: Some(&["Chromium", "User Data"]),
                scheme: "chrome",
            },
        }
    }
}

/// One browser as main names it.
#[derive(Deserialize)]
struct Named {
    id: Id,
    name: String,
}

/// Where the machine keeps things; a test points these at a temp folder.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Places {
    /// Whose install places are read: `darwin` or `win32` (any other has none).
    platform: String,
    home: String,
    /// macOS folders holding `.app` bundles.
    app_dirs: Vec<String>,
    /// Windows `%ProgramFiles%`, `%ProgramFiles(x86)%` and `%LOCALAPPDATA%` roots for installed exes.
    program_dirs: Vec<String>,
    /// Windows `%LOCALAPPDATA%`.
    local_app_data: String,
}

#[derive(Deserialize)]
struct FindParams {
    places: Places,
    /// In `auto` order.
    browsers: Vec<Named>,
}

/// A browser found on disk: what the launch needs.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Found {
    id: Id,
    name: String,
    /// The `.app` bundle (macOS) or the exe (Windows).
    app: String,
    data_dir: String,
    extensions_url: String,
}

/// An installed browser as the status names it.
#[derive(Serialize)]
struct Installed {
    id: Id,
    name: String,
}

fn joined(root: &str, parts: &[&str]) -> PathBuf {
    parts
        .iter()
        .fold(PathBuf::from(root), |path, part| path.join(part))
}

fn text(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

/// The first of `roots` holding `parts`, as a path that stats (a link is followed).
fn first_in(roots: &[String], parts: &[&str]) -> Option<PathBuf> {
    roots
        .iter()
        .map(|root| joined(root, parts))
        .find(|candidate| std::fs::metadata(candidate).is_ok())
}

fn find_one(named: Named, places: &Places) -> Option<Found> {
    let definition = named.id.definition();
    let (app, data_dir) = match places.platform.as_str() {
        "darwin" => (
            first_in(&places.app_dirs, &[definition.app?])?,
            joined(&places.home, &["Library", "Application Support"])
                .join(joined("", definition.mac_data)),
        ),
        "win32" => (
            first_in(&places.program_dirs, definition.exe?)?,
            joined(&places.local_app_data, definition.win_data?),
        ),
        _ => return None,
    };
    Some(Found {
        id: named.id,
        name: named.name,
        app: text(app),
        data_dir: text(data_dir),
        extensions_url: format!("{}://extensions", definition.scheme),
    })
}

/// The installed browsers of `browsers`, in their order.
fn find(params: FindParams) -> Vec<Found> {
    params
        .browsers
        .into_iter()
        .filter_map(|named| find_one(named, &params.places))
        .collect()
}

/// File work on tokio's blocking pool.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, Fault> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| Fault::new("internal", "The browser read panicked"))
}

#[derive(Deserialize)]
struct OpenParams {
    /// The `.app` bundle (macOS) or the exe (Windows).
    app: String,
    url: String,
}

#[cfg(windows)]
async fn open(params: OpenParams, _scope: Scope) -> Result<(), Fault> {
    crate::user_app::launch(std::process::Command::new(params.app).arg(params.url))
}

/// `open -a <app> <url>`, answered once `open` exits, as `execFile` answered it.
#[cfg(not(windows))]
async fn open(params: OpenParams, scope: Scope) -> Result<(), Fault> {
    use crate::run::{Exec, Opts, Runner};

    let runner = Runner {
        bin: "open".to_owned(),
        args: Vec::new(),
        env: std::env::vars_os()
            .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
            .collect(),
        timeout_ms: 30_000,
        max_bytes: 1024 * 1024,
    };
    let output = Exec::new(runner, scope, "open")
        .run(".", &["-a", &params.app, &params.url], Opts::default())
        .await?;
    if output.code != 0 {
        return Err(Fault::new(
            "open_failed",
            format!(
                "Command failed: open -a {} {}\n{}",
                params.app, params.url, output.stderr
            ),
        ));
    }
    Ok(())
}

pub fn register(registry: &mut Registry) {
    ego::register(registry);
    registry.add("browsers.find", |call| {
        Box::pin(async move {
            let params: FindParams = call.params()?;
            Reply::json(&blocking(move || find(params)).await?)
        })
    });
    registry.add("browsers.status", |call| {
        Box::pin(async move { status::read(call.params()?).await })
    });
    registry.add("browsers.installRelay", |call| {
        Box::pin(async move { Reply::json(&relay::install(call.params()?, call.scope).await?) })
    });
    registry.add("browsers.openExtensions", |call| {
        Box::pin(async move {
            open(call.params()?, call.scope).await?;
            Reply::json(&())
        })
    });
}
