use serde_json::{Value, json};
use tokio::sync::watch;
use tokio::time::{Duration, Instant};

use super::Timing;
use crate::git::{
    run::Git,
    triggers::{HeadRead, routine_commits, routine_head},
};
use crate::schedules::triggers::Context;
use crate::server::{Fault, Scope};

pub(super) async fn run(
    event: &Value,
    mark: Option<Value>,
    context: &Context,
    scope: &Scope,
    mut ended: watch::Receiver<u64>,
    timing: Timing,
) {
    let repo = event["repo"].as_str().unwrap_or_default();
    let branch = event["branch"].as_str().unwrap_or_default();
    let read_key = format!("git {repo} {branch}: read");
    let branch_key = format!("git {repo} {branch}: branch");
    let mut mark = mark.unwrap_or(Value::Null);
    let period = Duration::from_millis(timing.git_poll_ms.max(1));
    let mut tick = Instant::now() + period;
    let mut rebase = false;
    loop {
        let revision = *ended.borrow_and_update();
        if scope.cancelled() {
            return;
        }
        if context.running() {
            rebase = true;
        } else {
            let result: Result<(), Fault> = async {
                let git = Git::new(context.ask("git", None).await?, scope.clone());
                let read = routine_head(&git, repo, branch, &mark).await?;
                if scope.cancelled() {
                    return Ok(());
                }
                if context.running() {
                    rebase = true;
                    return Ok(());
                }
                context.failure(&read_key, None);
                let missing = matches!(read, HeadRead::Missing { .. });
                context.failure(&branch_key, missing.then_some("the branch does not exist"));
                match read {
                    HeadRead::Missing { mark: update } => {
                        if let Some(update) = update {
                            mark = json!(update);
                            context.publish(mark.clone(), &[]);
                        }
                    }
                    HeadRead::Unchanged => rebase = false,
                    HeadRead::Changed { mark: update, from } => {
                        let next = json!(update);
                        context.publish(next.clone(), &[]);
                        let suppress = std::mem::take(&mut rebase) || revision != *ended.borrow();
                        let result = if let Some(from) = from.filter(|_| !suppress) {
                            let to = next["head"].as_str().unwrap_or_default();
                            // As with the old second coreGit call, pick up a replaced git or changed PATH.
                            match context.ask("git", None).await {
                                Ok(runner) => {
                                    routine_commits(
                                        &Git::new(runner, scope.clone()),
                                        repo,
                                        branch,
                                        from,
                                        to,
                                    )
                                    .await
                                }
                                Err(error) => Err(error),
                            }
                        } else {
                            Ok(None)
                        };
                        mark = next;
                        if let Some(line) = result? {
                            context.git_changed(&line, revision);
                        }
                    }
                }
                Ok(())
            }
            .await;
            if let Err(error) = result {
                context.failure(&read_key, Some(&error.message));
            }
        }
        // setInterval skipped every tick while the previous read was busy; a run end alone asks for an immediate read.
        let now = Instant::now();
        if tick <= now {
            let wait = period.as_nanos() - (now - tick).as_nanos() % period.as_nanos();
            tick =
                now + Duration::new((wait / 1_000_000_000) as u64, (wait % 1_000_000_000) as u32);
        }
        tokio::select! {
            biased;
            _ = scope.on_cancel() => return,
            changed = ended.changed() => { if changed.is_err() { return; } rebase = true; }
            _ = tokio::time::sleep_until(tick) => { tick += period; }
        }
    }
}
