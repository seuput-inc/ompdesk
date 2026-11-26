//! The disk running low (was `src/main/health-watch.ts`, Orca D136, U176): the free space of the volume holding the
//! app's data, asked by main 2 minutes after launch and every 6 hours (`disk.lowSpace {path, prefs, now}`). Under
//! `LOW_DISK_BYTES` the person gets one OS notice, at most once a day, before writes start failing: the answer is the
//! free bytes when a notice is due (its time is then kept as `lowDiskNoticeAt` in prefs.json, across launches), else
//! null, and main shows it. The disk-full notice (`saves.rs`) is for writes that already failed and is never held back
//! by this one.

use std::path::Path;

use serde::Deserialize;
use serde_json::Value;

use crate::git::read::blocking;
use crate::server::{Call, Fault, Reply};

const LOW_DISK_BYTES: u64 = 10 * 1024 * 1024 * 1024;
const NOTICE_EVERY_MS: f64 = 24.0 * 60.0 * 60_000.0;
const NOTICE_KEY: &str = "lowDiskNoticeAt";

#[derive(Deserialize)]
struct Params {
    /// The folder whose volume is read (userData).
    path: String,
    /// The prefs file that keeps the last notice's time.
    prefs: String,
    /// Main's clock, epoch milliseconds.
    now: i64,
}

/// Whether a notice is due: the volume could be read, it is short of room, and no notice was shown in the last day.
fn due(free: Option<u64>, last: Option<f64>, now: i64) -> bool {
    free.is_some_and(|free| free < LOW_DISK_BYTES)
        && last.is_none_or(|last| now as f64 - last >= NOTICE_EVERY_MS)
}

pub(super) async fn handle(call: Call) -> Result<Reply, Fault> {
    let Params { path, prefs, now } = call.params()?;
    let free = blocking(move || ompdesk_checks::disk_space(Path::new(&path)).map(|(free, _)| free))
        .await?;
    let mut shown = false;
    crate::prefs::update(&prefs, NOTICE_KEY, |last| {
        shown = due(free, last.and_then(Value::as_f64), now);
        shown.then(|| Value::from(now))
    })?;
    Reply::json(&free.filter(|_| shown))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOW: u64 = 3 * 1024 * 1024 * 1024;

    #[test]
    fn says_nothing_while_there_is_room() {
        assert!(!due(Some(LOW_DISK_BYTES), None, 1_000_000));
    }

    #[test]
    fn tells_once_a_day_while_the_disk_stays_low() {
        let first = 1_000_000;
        assert!(due(Some(LOW), None, first));
        let day = NOTICE_EVERY_MS as i64;
        assert!(!due(Some(LOW), Some(first as f64), first + day - 1));
        assert!(due(Some(LOW), Some(first as f64), first + day));
    }

    #[test]
    fn says_nothing_when_the_volume_cannot_be_read() {
        assert!(!due(None, None, 1_000_000));
    }

    #[test]
    fn a_due_notice_is_kept_in_prefs_and_holds_the_next_one_back() {
        let dir =
            std::env::temp_dir().join(format!("ompdesk-core-low-space-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let prefs = dir.join("prefs.json");
        let prefs = prefs.to_str().unwrap();
        let mut shown = false;
        crate::prefs::update(prefs, NOTICE_KEY, |last| {
            shown = due(Some(LOW), last.and_then(Value::as_f64), 5_000);
            shown.then(|| Value::from(5_000))
        })
        .unwrap();
        assert!(shown);
        assert_eq!(
            crate::prefs::get(prefs, NOTICE_KEY).unwrap(),
            Some(Value::from(5_000))
        );
        crate::prefs::update(prefs, NOTICE_KEY, |last| {
            shown = due(Some(LOW), last.and_then(Value::as_f64), 6_000);
            shown.then(|| Value::from(6_000))
        })
        .unwrap();
        assert!(!shown);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
