//! One Changes-panel watch per requested folder. Readers of the same generation share a cell;
//! invalidation detaches it, so an older read can finish but cannot replace its successor.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use tokio::runtime::Handle;
use tokio::sync::OnceCell;
use tokio::time::{Instant, sleep_until};

use super::checkout;
use super::read::{self, Fingerprint};
use super::run::Git;
use crate::server::{Fault, Reply};
use crate::sessions::source::{self, Raw};

const IDLE: Duration = Duration::from_secs(15);
const MAX_AGE: Duration = Duration::from_secs(30);

type Sample = OnceCell<(Instant, Result<Fingerprint, Fault>)>;

#[derive(Default)]
struct Watch {
    sources: Vec<source::Source>,
    sample: Option<Arc<Sample>>,
}

struct Entry {
    root: OnceCell<Option<String>>,
    watch: Mutex<Option<Watch>>,
}

impl Entry {
    fn new() -> Self {
        Self {
            root: OnceCell::new(),
            watch: Mutex::new(Some(Watch::default())),
        }
    }

    fn event(&self, event: Raw, runtime: &Handle) {
        match event {
            Raw::Ended(_) => self.close(runtime),
            Raw::Names(_) | Raw::Anything => {
                if let Some(watch) = self.watch.lock().unwrap().as_mut() {
                    watch.sample = None;
                }
            }
        }
    }

    fn close(&self, runtime: &Handle) {
        let watch = self.watch.lock().unwrap().take();
        if let Some(watch) = watch
            && !watch.sources.is_empty()
        {
            // The Windows source joins its thread on drop. Never drop it from its own error callback.
            runtime.spawn_blocking(move || drop(watch));
        }
    }

    async fn open(self: &Arc<Self>, git: &Git, cwd: &str) -> Option<String> {
        let mut dirs = checkout::dirs(git, cwd).await.ok()??;
        let entry = Arc::clone(self);
        read::blocking(move || {
            if entry.watch.lock().unwrap().is_none() {
                return None;
            }
            let mut sources = Vec::new();
            for (index, dir) in dirs.iter().enumerate() {
                let dir = Path::new(dir);
                if dirs[..index].iter().any(|prior| dir.starts_with(prior)) {
                    continue;
                }
                let entry = Arc::downgrade(&entry);
                let runtime = Handle::current();
                let source = source::start(dir, move |event| {
                    if let Some(entry) = entry.upgrade() {
                        entry.event(event, &runtime);
                    }
                })
                .ok()?;
                sources.push(source);
            }
            entry.watch.lock().unwrap().as_mut()?.sources = sources;
            Some(dirs.swap_remove(0))
        })
        .await
        .ok()?
    }

    fn sample(&self) -> Option<Arc<Sample>> {
        let mut watch = self.watch.lock().unwrap();
        let slot = &mut watch.as_mut()?.sample;
        if let Some(sample) = slot
            && sample
                .get()
                .is_none_or(|(at, value)| value.is_ok() && at.elapsed() < MAX_AGE)
        {
            return Some(Arc::clone(sample));
        }
        Some(Arc::clone(slot.insert(Arc::new(Sample::new()))))
    }
}

type Entries = HashMap<Arc<str>, (Instant, Arc<Entry>)>;
static ENTRIES: LazyLock<Mutex<Entries>> = LazyLock::new(Mutex::default);

fn entry(cwd: &str) -> Arc<Entry> {
    let mut entries = ENTRIES.lock().unwrap();
    let now = Instant::now();
    let mut deadline = now + IDLE;
    if let Some((expires, entry)) = entries.get_mut(cwd) {
        if *expires > now {
            *expires = deadline;
            return Arc::clone(entry);
        }
        entry.close(&Handle::current());
    }
    let key: Arc<str> = Arc::from(cwd);
    let entry = Arc::new(Entry::new());
    entries.insert(Arc::clone(&key), (deadline, Arc::clone(&entry)));
    let opened = Arc::clone(&entry);
    tokio::spawn(async move {
        loop {
            sleep_until(deadline).await;
            let mut entries = ENTRIES.lock().unwrap();
            let Some((expires, current)) = entries.get(&key) else {
                return;
            };
            if !Arc::ptr_eq(current, &opened) {
                return;
            }
            if *expires <= Instant::now() {
                entries.remove(&key);
                opened.close(&Handle::current());
                return;
            }
            deadline = *expires;
        }
    });
    entry
}

async fn sampled(
    cell: &Sample,
    load: impl Future<Output = Result<Fingerprint, Fault>>,
) -> Result<Reply, Fault> {
    let (_, value) = cell
        .get_or_init(|| async {
            let value = load.await;
            (Instant::now(), value)
        })
        .await;
    Reply::json(value.as_ref().map_err(Clone::clone)?)
}

pub(super) async fn read(
    git: &Git,
    cwd: &str,
    key: &str,
    known: Option<&str>,
) -> Result<Reply, Fault> {
    if cfg!(any(windows, target_os = "macos")) {
        let entry = entry(key);
        if let Some(root) = entry.root.get_or_init(|| entry.open(git, key)).await
            && let Some(cell) = entry.sample()
        {
            return sampled(&cell, read::fingerprint(git, cwd, known.or(Some(root)))).await;
        }
    }
    Reply::json(&read::fingerprint(git, cwd, known).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(n: &str) -> Fingerprint {
        Fingerprint {
            fingerprint: n.into(),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn shares_a_read_but_an_event_starts_a_new_generation_before_the_old_one_finishes() {
        let entry = Entry::new();
        let first = entry.sample().unwrap();
        let (release, gate) = tokio::sync::oneshot::channel();
        let reading = sampled(&first, async {
            gate.await.unwrap();
            Ok(answer("first"))
        });
        tokio::pin!(reading);
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        assert!(reading.as_mut().poll(&mut cx).is_pending());
        let second = entry.sample().unwrap();
        let joining = sampled(&second, async { panic!("read twice") });
        tokio::pin!(joining);
        assert!(joining.as_mut().poll(&mut cx).is_pending());
        entry.event(Raw::Anything, &Handle::current());
        let later = entry.sample().unwrap();
        let fresh = sampled(&later, async { Ok(answer("new")) }).await.unwrap();
        release.send(()).unwrap();
        let expected = r#"{"fingerprint":"first"}"#;
        assert_eq!(reading.await.unwrap().result.get(), expected);
        assert_eq!(joining.await.unwrap().result.get(), expected);
        tokio::time::advance(Duration::from_millis(29_999)).await;
        let kept = entry.sample().unwrap();
        let result = sampled(&kept, async { panic!("lost fresh answer") })
            .await
            .unwrap();
        assert_eq!(result.result.get(), fresh.result.get());
    }

    #[tokio::test(start_paused = true)]
    async fn expires_at_thirty_seconds_retries_a_failed_read_and_distrusts_a_broken_watch() {
        let entry = Entry::new();
        let first = entry.sample().unwrap();
        sampled(&first, async { Ok(answer("initial")) })
            .await
            .unwrap();
        tokio::time::advance(Duration::from_secs(30)).await;
        let stale = entry.sample().unwrap();
        let failure = sampled(&stale, async { Err(Fault::new("git_exit", "failed")) }).await;
        assert!(matches!(failure, Err(fault) if fault.code == "git_exit"));
        let retry = entry.sample().unwrap();
        let recovered = sampled(&retry, async { Ok(answer("recovered")) })
            .await
            .unwrap();
        assert_eq!(recovered.result.get(), r#"{"fingerprint":"recovered"}"#);
        entry.event(Raw::Ended("watch failed".into()), &Handle::current());
        assert!(entry.sample().is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn closes_an_idle_entry_even_without_another_request() {
        let key = "fingerprint-idle-fixture";
        let first = entry(key);
        tokio::time::advance(Duration::from_secs(14)).await;
        assert!(Arc::ptr_eq(&entry(key), &first));
        tokio::time::advance(Duration::from_secs(14)).await;
        assert!(first.sample().is_some());
        tokio::time::advance(Duration::from_millis(1_001)).await;
        tokio::task::yield_now().await;
        assert!(first.sample().is_none());
        assert!(!ENTRIES.lock().unwrap().contains_key(key));
    }
}
