//! Wait for the original Source's startup status. Root rechecks admission and readiness afterward.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;
use tokio::time::{Instant, sleep_until};

use super::source::Source;
use crate::pool::application::Sidecar;
use crate::server::{Fault, Scope};
use crate::sidecar::application::EffectFuture;

const START_WAIT: Duration = Duration::from_secs(60);

pub(crate) fn settled_start(
    source: Arc<Source>,
    scope: Scope,
) -> EffectFuture<'static, Result<(), Fault>> {
    let deadline = Instant::now() + START_WAIT;
    match source.as_ref() {
        Source::Local(local) => {
            let changes = local.source.changes();
            Box::pin(wait(source, scope, changes, deadline))
        }
        Source::Remote(remote) => {
            let changes = remote.source.changes();
            Box::pin(wait(source, scope, changes, deadline))
        }
    }
}

async fn wait<T: Send + Sync>(
    source: Arc<Source>,
    scope: Scope,
    mut changes: watch::Receiver<T>,
    deadline: Instant,
) -> Result<(), Fault> {
    let timeout = sleep_until(deadline);
    tokio::pin!(timeout);
    loop {
        if scope.cancelled() {
            return Err(Fault::cancelled());
        }
        if source.settled().is_some() {
            return Ok(());
        }
        let facts = source.facts();
        if facts["offline"].as_bool() == Some(true)
            || !matches!(facts["status"].as_str(), Some("starting" | "restarting"))
        {
            return Ok(());
        }
        tokio::select! {
            biased;
            _ = scope.on_cancel() => return Err(Fault::cancelled()),
            result = changes.changed() => if result.is_err() { return Ok(()); },
            _ = &mut timeout => return Ok(()),
        }
    }
}

#[cfg(test)]
#[path = "command_start_tests.rs"]
mod tests;
