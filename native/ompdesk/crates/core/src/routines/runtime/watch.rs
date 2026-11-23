use std::io;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use tokio::sync::mpsc;

use crate::server::{Fault, Scope};

pub(super) static IGNORED: LazyLock<Vec<String>> =
    LazyLock::new(|| vec![".git".into(), "node_modules".into()]);

pub(super) enum Event {
    Names(Vec<String>),
    Lost(String),
}

#[cfg(any(windows, target_os = "macos"))]
type Watch = crate::sessions::source::Source;
#[cfg(not(any(windows, target_os = "macos")))]
type Watch = notify::RecommendedWatcher;

pub(super) async fn start(
    path: PathBuf,
    events: mpsc::UnboundedSender<Event>,
    scope: Scope,
) -> Result<Watch, Fault> {
    tokio::task::spawn_blocking(move || {
        let fault = |error: std::io::Error| crate::disk::tree::fault(&error, "watch", &path);
        let root = std::fs::canonicalize(&path).map_err(fault)?;
        let is_file = !std::fs::metadata(&root).map_err(fault)?.is_dir();
        let file = is_file.then(|| {
            root.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
        let directory = if is_file {
            root.parent().unwrap_or(&root)
        } else {
            &root
        };
        let watched = directory.to_owned();
        open(directory, is_file, move |mut event| {
            // The callback holds a scope receipt: even a backend whose Drop only signals its thread must finish before close.
            if scope.cancelled() {
                return;
            }
            if let Event::Names(names) = &event
                && names.iter().any(String::is_empty)
                && watched.try_exists().is_ok_and(|exists| !exists)
            {
                let _ = events.send(Event::Lost("the watched path no longer exists".into()));
                return;
            }
            if let (Some(file), Event::Names(names)) = (&file, &mut event) {
                names.retain(|name| {
                    name.is_empty()
                        || name == file
                        || (cfg!(windows) && name.eq_ignore_ascii_case(file))
                });
                if names.is_empty() {
                    return;
                }
            }
            let _ = events.send(event);
        })
        .map_err(fault)
    })
    .await
    .map_err(|error| Fault::new("watch_failed", error.to_string()))?
}

// The packaged hosts already own recursive FSEvents/ReadDirectoryChangesW watches with joined shutdown;
// in particular, their Windows source reports a lost directory instead of silently dropping its handle.
#[cfg(any(windows, target_os = "macos"))]
fn open(directory: &Path, _file: bool, send: impl Fn(Event) + Send + 'static) -> io::Result<Watch> {
    use crate::sessions::source::{self, Raw};
    source::start(directory, move |raw| {
        send(match raw {
            Raw::Names(names) => Event::Names(names),
            Raw::Anything => Event::Names(vec![String::new()]),
            Raw::Ended(error) => Event::Lost(error),
        })
    })
}

#[cfg(not(any(windows, target_os = "macos")))]
fn open(directory: &Path, file: bool, send: impl Fn(Event) + Send + 'static) -> io::Result<Watch> {
    use notify::{EventKind, RecursiveMode, Watcher};
    let root = directory.to_owned();
    let mut watcher =
        notify::recommended_watcher(move |event: notify::Result<notify::Event>| match event {
            Ok(event) if event.need_rescan() => send(Event::Names(vec![String::new()])),
            Ok(event) if !matches!(event.kind, EventKind::Access(_)) => {
                let names: Vec<_> = event
                    .paths
                    .iter()
                    .filter_map(|path| {
                        path.strip_prefix(&root)
                            .ok()
                            .map(|name| name.to_string_lossy().into_owned())
                    })
                    .collect();
                if !names.is_empty() {
                    send(Event::Names(names));
                }
            }
            Err(error) => send(Event::Lost(error.to_string())),
            _ => {}
        })
        .map_err(io::Error::other)?;
    watcher
        .watch(
            directory,
            if file {
                RecursiveMode::NonRecursive
            } else {
                RecursiveMode::Recursive
            },
        )
        .map_err(|error| match error.kind {
            notify::ErrorKind::Io(error) => error,
            notify::ErrorKind::PathNotFound => io::ErrorKind::NotFound.into(),
            other => io::Error::other(format!("{other:?}")),
        })?;
    Ok(watcher)
}
