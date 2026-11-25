//! The local project a checkout belongs to. A cache hit needs neither a git launch nor main's runner environment.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use tokio::sync::OnceCell;

use super::{
    origin::{Facts, facts},
    run::Git,
};
use crate::clock::now_ms;
use crate::fs::disk::spelled;
use crate::run::Runner;
use crate::server::{Fault, Registry, Reply};

#[derive(Serialize)]
struct Project {
    root: String,
    project: String,
    worktree: Option<Worktree>,
}

#[derive(Serialize)]
struct Worktree {
    branch: Option<String>,
    folder: String,
}

fn project(f: Facts) -> Option<Project> {
    let separators = ['/', '\\'];
    let common = f.common_dir.trim_end_matches(separators);
    let root = if common.rsplit(separators).next() == Some(".git") {
        common.strip_suffix(".git")?.trim_end_matches(separators)
    } else {
        f.primary.as_deref()?
    };
    if root.is_empty() {
        return None;
    }
    let name = root
        .rsplit(separators)
        .find(|part| !part.is_empty())
        .unwrap_or(root);
    let name = name
        .strip_suffix(".git")
        .filter(|s| !s.is_empty())
        .unwrap_or(name);
    let linked = f.git_dir.trim_end_matches(separators) != common;
    Some(Project {
        project: name.to_owned(),
        root: root.to_owned(),
        worktree: linked.then(|| Worktree {
            branch: f.branch,
            folder: f.toplevel.unwrap_or(f.git_dir),
        }),
    })
}

type Cell = Arc<OnceCell<Option<Project>>>;

#[derive(Default)]
struct Cache {
    entries: HashMap<Arc<str>, (u64, Cell)>,
    order: VecDeque<Arc<str>>,
}

impl Cache {
    fn fresh(&self, cwd: &str, now: u64) -> Option<Cell> {
        let (at, cell) = self.entries.get(cwd)?;
        let ttl = if cell.get().is_some_and(Option::is_some) {
            30_000
        } else {
            5_000
        };
        (now.saturating_sub(*at) < ttl).then(|| Arc::clone(cell))
    }

    fn start(&mut self, cwd: &str, now: u64) -> Cell {
        if let Some(cell) = self.fresh(cwd, now) {
            return cell;
        }
        if self.entries.len() == 500
            && let Some(first) = self.order.pop_front()
        {
            self.entries.remove(&first);
        }
        let cell = Arc::new(OnceCell::new());
        if let Some(entry) = self.entries.get_mut(cwd) {
            *entry = (now, Arc::clone(&cell));
        } else {
            let key: Arc<str> = cwd.into();
            self.order.push_back(Arc::clone(&key));
            self.entries.insert(key, (now, Arc::clone(&cell)));
        }
        cell
    }

    fn remove(&mut self, cwd: &str) {
        if self.entries.remove(cwd).is_some() {
            self.order.retain(|entry| &**entry != cwd);
        }
    }
}

static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(Default::default);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    cwd: String,
    now: Option<u64>,
    git: Option<Runner>,
}

async fn answer(params: Params, fetch: bool, scope: crate::server::Scope) -> Result<Reply, Fault> {
    let Params { cwd, now, git } = params;
    if tokio::fs::metadata(&cwd).await.is_err() {
        CACHE.lock().unwrap().remove(&cwd);
        return Reply::json(&());
    }
    let now = now.unwrap_or_else(now_ms);
    if !fetch {
        let cell = CACHE.lock().unwrap().fresh(&cwd, now);
        return match cell.as_ref().and_then(|cell| cell.get()) {
            Some(origin) => Reply::json(origin),
            None => Reply::json(&"needsGit"),
        };
    }
    let cell = CACHE.lock().unwrap().start(&cwd, now);
    let origin = cell
        .get_or_init(|| async {
            let mut origin = project(facts(&Git::new(git?, scope), &cwd, 10_000).await?)?;
            if let Ok(root) = tokio::fs::canonicalize(&origin.root).await {
                origin.root = spelled(&root);
            }
            Some(origin)
        })
        .await;
    Reply::json(origin)
}

pub(super) fn register(registry: &mut Registry) {
    registry.add("git.cachedProjectOrigin", |call| {
        Box::pin(async move { answer(call.params()?, false, call.scope).await })
    });
    registry.add("git.projectOrigin", |call| {
        Box::pin(async move { answer(call.params()?, true, call.scope).await })
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn project_from_checkout_facts() {
        for (common, own, primary, expected) in [
            (
                "/main/.git/",
                "/main/.git",
                None,
                json!({"project":"main","root":"/main","worktree":null}),
            ),
            (
                r"C:\w\p.git",
                r"C:\w\p.git",
                Some(r"C:\w\p.git"),
                json!({"project":"p","root":r"C:\w\p.git","worktree":null}),
            ),
            (
                "/a/.git",
                "/A/.git",
                None,
                json!({"project":"a","root":"/a","worktree":{"branch":null,"folder":"/A/.git"}}),
            ),
            ("/.git", "/.git", None, json!(null)),
            ("/store", "/store", None, json!(null)),
        ] {
            let facts = Facts {
                common_dir: common.into(),
                git_dir: own.into(),
                branch: None,
                toplevel: None,
                primary: primary.map(str::to_owned),
            };
            assert_eq!(serde_json::to_value(project(facts)).unwrap(), expected);
        }
    }

    #[test]
    fn coalesces_and_expires_unanswered_and_unknown_at_five_seconds() {
        let mut cache = Cache::default();
        let cell = cache.start("repo", 100);
        assert!(Arc::ptr_eq(&cell, &cache.start("repo", 5099)));
        assert!(cell.set(None).is_ok());
        assert!(!Arc::ptr_eq(&cell, &cache.start("repo", 5100)));
    }
}
