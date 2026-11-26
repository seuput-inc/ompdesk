//! Sources owned by the live schedules service. Dropping a poll cancels its I/O. Its completion keeps
//! the service's close pending until the watcher, IMAP connection and any git/gh children are gone.

mod calendar;
mod email;
mod files;
mod git;
mod github;
mod google;
mod linear;
pub(crate) mod sessions;
mod slack;
mod watch;

pub(crate) use slack::wake as wake_sockets;

use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use tokio::sync::{mpsc, watch as signal};

use crate::schedules::triggers::Context;
use crate::server::Scope;

#[derive(Clone, Copy, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct Timing {
    pub github_poll_ms: u64,
    pub git_poll_ms: u64,
    pub email_poll_ms: u64,
    pub file_debounce_ms: u64,
    pub file_max_wait_ms: u64,
    pub file_retry_ms: u64,
    pub quiet_ms: i64,
    /// A bot's Linear connector reads its workspace this often.
    pub connector_poll_ms: u64,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            github_poll_ms: 5 * 60_000,
            git_poll_ms: 30_000,
            email_poll_ms: 2 * 60_000,
            file_debounce_ms: 2_000,
            file_max_wait_ms: 10_000,
            file_retry_ms: 60_000,
            quiet_ms: 3_000,
            connector_poll_ms: 60_000,
        }
    }
}

pub(crate) struct Poll {
    scope: Scope,
    ended: Option<signal::Sender<u64>>,
}

impl Poll {
    pub fn run_ended(&self) {
        if let Some(ended) = &self.ended {
            ended.send_modify(|sequence| *sequence = sequence.wrapping_add(1));
        }
    }

    pub fn git_revision(&self) -> Option<u64> {
        self.ended.as_ref().map(|ended| *ended.borrow())
    }
}

impl Drop for Poll {
    fn drop(&mut self) {
        self.scope.cancel();
    }
}

pub(crate) enum Source {
    Poll(Poll),
    Session(sessions::Session),
}

impl Source {
    pub fn start(
        event: Arc<Value>,
        mark: Option<Value>,
        context: Context,
        timing: Timing,
        drained: mpsc::Sender<()>,
    ) -> Self {
        if event["source"] == "session" {
            return Self::Session(sessions::Session::new(&event));
        }
        let (scope, gone) = Scope::watched();
        let (ended, revision) = if event["source"] == "git" {
            let (tx, rx) = signal::channel(0);
            (Some(tx), Some(rx))
        } else {
            (None, None)
        };
        let working = scope.clone();
        tokio::spawn(async move {
            let get = |name: &str| event[name].as_str().unwrap_or_default();
            match get("source") {
                "github" => github::run(&event, mark, &context, &working, timing).await,
                "git" => {
                    git::run(
                        &event,
                        mark,
                        &context,
                        &working,
                        revision.expect("git run-end signal"),
                        timing,
                    )
                    .await
                }
                "files" => files::run(get("path").into(), mark, context, &working, timing).await,
                "email" => email::run(&event, mark, &context, &working, timing).await,
                "calendar" => calendar::run(&event, mark, &context, &working, timing).await,
                "slack" => slack::run(&event, &context, &working).await,
                "google" => google::run(&event, mark, &context, &working).await,
                "linear" => linear::run(&event, mark, &context, &working, timing).await,
                _ => context.failure("could not start its trigger", Some("unknown source")),
            }
            drop(working);
            gone.wait().await;
            drop(drained);
        });
        Self::Poll(Poll { scope, ended })
    }
}

async fn wait(scope: &Scope, ms: u64) -> bool {
    tokio::select! { biased; _ = scope.on_cancel() => false, _ = tokio::time::sleep(Duration::from_millis(ms.max(1))) => true }
}
