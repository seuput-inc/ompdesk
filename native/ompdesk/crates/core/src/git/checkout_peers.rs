use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::run::Git;
use super::{OriginParams, origin, read, worktree};
use crate::fs::disk;
use crate::server::{Registry, Reply};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Place {
    toplevel: PathBuf,
    common_dir: PathBuf,
}

#[derive(Deserialize)]
struct AliasDirs {
    dirs: Vec<String>,
}

async fn real_or(path: String) -> PathBuf {
    disk::real(&path).await.unwrap_or_else(|| path.into())
}

async fn place(git: &Git, cwd: &str, timeout_ms: u64) -> Option<Place> {
    let facts = origin::facts(git, cwd, timeout_ms).await?;
    let toplevel = facts.toplevel?;
    let (toplevel, common_dir) = tokio::join!(real_or(toplevel), real_or(facts.common_dir));
    Some(Place {
        toplevel,
        common_dir,
    })
}

pub(super) fn register(registry: &mut Registry) {
    registry.add("git.checkoutPlace", |call| {
        Box::pin(async move {
            let OriginParams {
                git,
                cwd,
                timeout_ms,
            } = call.params()?;
            Reply::json(&place(&Git::new(git, call.scope), &cwd, timeout_ms).await)
        })
    });
    registry.add("git.checkoutAliasDirs", |call| {
        Box::pin(async move {
            let AliasDirs { dirs } = call.params()?;
            read::blocking(move || {
                let physical: Vec<_> = dirs.iter().map(|dir| worktree::real(dir).ok()).collect();
                Reply::json(&physical)
            })
            .await?
        })
    });
}
