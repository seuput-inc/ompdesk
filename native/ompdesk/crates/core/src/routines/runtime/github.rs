use serde::Deserialize;
use serde_json::Value;

use super::{Timing, wait};
use crate::gh::Gh;
use crate::routines::{
    GhApi,
    github::{self, Filters, Kind, State},
};
use crate::run::Runner;
use crate::schedules::triggers::Context;
use crate::server::Scope;

#[derive(Deserialize)]
struct Tool {
    runner: Option<Runner>,
    home: String,
}

pub(super) async fn run(
    event: &Value,
    mark: Option<Value>,
    context: &Context,
    scope: &Scope,
    timing: Timing,
) {
    let repo = event["repo"].as_str().unwrap_or_default();
    // The schedule validator accepts dot-only repository names, but they are URL path segments, never API targets.
    if repo
        .split('/')
        .any(|part| part.bytes().all(|byte| byte == b'.'))
    {
        context.failure(
            &format!("github {repo}"),
            Some("not an owner/name repository"),
        );
        return;
    }
    let kinds: Vec<_> = Kind::ALL
        .into_iter()
        .filter(|kind| {
            event["events"]
                .as_array()
                .is_some_and(|events| events.iter().any(|event| event == kind.name()))
        })
        .collect();
    let filters = Filters::of(event);
    let mut state = State::restore(mark.as_ref());
    loop {
        for &kind in &kinds {
            if scope.cancelled() {
                return;
            }
            let key = format!("github {repo}: {}", kind.name());
            let result = match context.ask::<Tool>("github", None).await {
                Ok(tool) => {
                    // A trigger's read is never the person's own: it waits behind the GitHub gate (`gh/gate.rs`).
                    let gh = Gh::paced(tool.runner, scope.clone(), true);
                    github::read_with(
                        &GhApi {
                            gh: &gh,
                            home: &tool.home,
                            timeout_ms: 30_000,
                        },
                        repo,
                        kind,
                        &mut state,
                        &filters,
                    )
                    .await
                }
                Err(error) => Err(error.message),
            };
            if scope.cancelled() {
                return;
            }
            match result {
                Ok(lines) => {
                    context.failure(&key, None);
                    if !context.publish(state.mark(), &lines) {
                        return;
                    }
                }
                Err(error) => context.failure(&key, Some(&error)),
            }
        }
        if !wait(scope, timing.github_poll_ms).await {
            return;
        }
    }
}
