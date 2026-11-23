use std::collections::{HashMap, hash_map::Entry};
use std::fmt::Write;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::{
    Timing,
    watch::{self, Event},
};
use crate::routines::{files, text::clip};
use crate::schedules::triggers::Context;
use crate::server::{Fault, Scope};

const PATHS_MAX: usize = 1_000;
const SHOWN_MAX: usize = 10;

type Scan = JoinHandle<(Result<files::Scan, Fault>, Option<Value>)>;

struct Burst {
    names: HashMap<String, ()>,
    listed: usize,
    shown: String,
    first: Option<Instant>,
    due: Option<Instant>,
}

impl Burst {
    fn new() -> Self {
        Self {
            names: HashMap::new(),
            listed: 0,
            shown: String::new(),
            first: None,
            due: None,
        }
    }
    fn note(&mut self, name: String, now: Instant, config: Timing) {
        if self.names.len() >= PATHS_MAX {
            return;
        }
        let first = *self.first.get_or_insert(now);
        if let Entry::Vacant(entry) = self.names.entry(name) {
            if !entry.key().is_empty() {
                if self.listed < SHOWN_MAX {
                    if self.listed != 0 {
                        self.shown.push_str(", ");
                    }
                    self.shown.push_str(&clip(entry.key(), 200));
                }
                self.listed += 1;
            }
            entry.insert(());
        }
        self.due = Some(
            (now + Duration::from_millis(config.file_debounce_ms))
                .min(first + Duration::from_millis(config.file_max_wait_ms)),
        );
    }
    fn take(&mut self, path: &str) -> Option<String> {
        self.due = None;
        self.first = None;
        if self.names.is_empty() {
            return None;
        }
        self.names.clear();
        let listed = std::mem::take(&mut self.listed);
        if listed == 0 {
            return Some(format!("Something under {path} changed"));
        }
        let mut line = std::mem::take(&mut self.shown);
        line.push_str(" changed");
        if listed > SHOWN_MAX {
            let _ = write!(line, ", and {} more", listed - SHOWN_MAX);
        }
        Some(line)
    }
}

pub(super) async fn run(
    path: String,
    mark: Option<Value>,
    sink: Context,
    scope: &Scope,
    config: Timing,
) {
    let (events, mut changes) = mpsc::unbounded_channel();
    let mut watcher = None;
    let mut retry = Some(Instant::now());
    let mut list_due = Some(Instant::now());
    let mut listing: Option<Scan> = None;
    let mut again = false;
    let mut before = mark;
    let mut burst = Burst::new();
    let watch_key = format!("files {path}: watch");
    let list_key = format!("files {path}: list");
    loop {
        if scope.cancelled() || !sink.current() {
            break;
        }
        let now = Instant::now();
        if retry.is_some_and(|at| at <= now) {
            retry = None;
            if let Some(old) = watcher.take() {
                drop(old);
            }
            match watch::start(PathBuf::from(&path), events.clone(), scope.clone()).await {
                Ok(attached) => {
                    sink.failure(&watch_key, None);
                    watcher = Some(attached);
                }
                Err(error) => {
                    sink.failure(&watch_key, Some(&error.message));
                    retry = Some(Instant::now() + Duration::from_millis(config.file_retry_ms));
                }
            }
        }
        if list_due.is_some_and(|at| at <= Instant::now()) {
            list_due = None;
            if listing.is_some() {
                again = true;
            } else {
                let path = path.clone();
                let mut mark = before.take();
                listing = Some(tokio::task::spawn_blocking(move || {
                    (files::scan(&path, &watch::IGNORED, &mut mark), mark)
                }));
            }
        }
        if burst.due.is_some_and(|at| at <= Instant::now()) {
            if let Some(line) = burst.take(&path) {
                sink.file_changed(&line);
            }
        }
        let deadline = retry.into_iter().chain(list_due).chain(burst.due).min();
        tokio::select! {
            biased;
            _ = scope.on_cancel() => break,
            result = scan_result(&mut listing) => {
                listing.take();
                if scope.cancelled() || !sink.current() { break; }
                let (result, mark) = result;
                match result {
                    Ok(scan) => {
                        sink.failure(&list_key, None);
                        sink.publish(json!({"listing":scan.listing}), &[]);
                        if let Some(changed) = scan.changed && !sink.quiet() {
                            for name in changed { burst.note(name, Instant::now(), config); }
                        }
                    }
                    Err(error) => { before = mark; sink.failure(&list_key, Some(&error.message)); }
                }
                if again { again = false; list_due = Some(Instant::now()); }
            }
            event = changes.recv() => match event {
                Some(Event::Lost(error)) => {
                    if let Some(old) = watcher.take() { drop(old); }
                    sink.failure(&watch_key, Some(&error));
                    retry = Some(Instant::now() + Duration::from_millis(config.file_retry_ms));
                }
                Some(Event::Names(names)) => {
                    for name in names {
                        let name = if name.contains('\\') { name.replace('\\', "/") } else { name };
                        if name.split('/').any(|part| watch::IGNORED.iter().any(|ignore| ignore == part)) { continue; }
                        list_due = Some(Instant::now() + Duration::from_millis(config.file_debounce_ms));
                        if !sink.quiet() { burst.note(name, Instant::now(), config); }
                    }
                }
                None => break,
            },
            _ = until(deadline) => {}
        }
    }
    drop(changes);
    if let Some(watcher) = watcher {
        drop(watcher);
    }
    if let Some(listing) = listing {
        let _ = listing.await;
    }
}

async fn until(deadline: Option<Instant>) {
    if let Some(deadline) = deadline {
        tokio::time::sleep_until(deadline).await;
    } else {
        std::future::pending::<()>().await;
    }
}

async fn scan_result(task: &mut Option<Scan>) -> (Result<files::Scan, Fault>, Option<Value>) {
    match task {
        Some(task) => task
            .await
            .unwrap_or_else(|error| (Err(Fault::new("scan_failed", error.to_string())), None)),
        None => std::future::pending().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn a_burst_keeps_order_deduplicates_and_bounds_a_steady_stream() {
        let config = Timing::default();
        let start = Instant::now();
        let mut burst = Burst::new();
        burst.note("a.txt".into(), start, config);
        burst.note("a.txt".into(), start, config);
        for seconds in 1..10 {
            burst.note(
                format!("b{seconds}.txt"),
                start + std::time::Duration::from_secs(seconds),
                config,
            );
        }
        assert_eq!(
            burst.due,
            Some(start + Duration::from_millis(config.file_max_wait_ms))
        );
        assert_eq!(
            burst.take("/work").unwrap(),
            "a.txt, b1.txt, b2.txt, b3.txt, b4.txt, b5.txt, b6.txt, b7.txt, b8.txt, b9.txt changed"
        );
        assert!(burst.take("/work").is_none());
    }
}
