//! The local project a checkout belongs to. A cache hit needs neither a git launch nor main's runner environment.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::OnceCell;

use super::{
    origin::{Facts, facts},
    run::Git,
};
use crate::clock::now_ms;
use crate::fs::disk::spelled;
use crate::ipc::{Handled, IpcContext};
use crate::run::Runner;
use crate::server::{Fault, Registry, Reply, Scope};

#[derive(Clone, Serialize)]
struct Project {
    root: String,
    project: String,
    worktree: Option<Worktree>,
}

#[derive(Clone, Serialize)]
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

fn worktree_kind_of(branch: Option<&str>) -> &'static str {
    match branch {
        Some(b) if b.starts_with("autopilot/") => "autopilot",
        Some(b) if b.starts_with("omp/agent/") => "agent",
        _ => "other",
    }
}

fn path_base_name(file: &str) -> &str {
    file.rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or(file)
}

fn worktree_folder_slug(folder: &str) -> String {
    let name = path_base_name(folder);
    if let Some(rest) = name.strip_prefix("gui-")
        && rest.len() > 8
        && rest.as_bytes()[rest.len() - 8] == b'-'
    {
        let (slug, hash) = (&rest[..rest.len() - 8], &rest[rest.len() - 7..]);
        if !slug.is_empty()
            && hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return slug.to_owned();
        }
    }
    name.to_owned()
}

fn project_origin_value(origin: &Project) -> Value {
    json!({
        "project": origin.project,
        "root": origin.root,
        "worktree": origin.worktree.as_ref().map(|tree| json!({
            "branch": tree.branch,
            "kind": worktree_kind_of(tree.branch.as_deref()),
            "slug": worktree_folder_slug(&tree.folder),
        })),
    })
}

const GIT_SELECTOR_VARS: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_PREFIX",
    "GIT_SUPER_PREFIX",
];

fn find_git_bin(path_env: &str) -> Option<String> {
    let names: &[&str] = if cfg!(windows) {
        &["git.exe", "git"]
    } else {
        &["git"]
    };
    for dir in std::env::split_paths(path_env) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    #[cfg(target_os = "macos")]
    for extra in ["/opt/homebrew/bin/git", "/usr/local/bin/git"] {
        if Path::new(extra).is_file() {
            return Some(extra.to_owned());
        }
    }
    None
}

async fn default_git_runner() -> Option<Runner> {
    let mut env: BTreeMap<String, String> = crate::tools::ipc::spawn_env_map()
        .await
        .into_iter()
        .filter(|(k, _)| !GIT_SELECTOR_VARS.iter().any(|s| k.eq_ignore_ascii_case(s)))
        .collect();
    let path_env = env
        .get("PATH")
        .or_else(|| env.get("Path"))
        .cloned()
        .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());
    let bin = find_git_bin(&path_env)?;
    env.insert("GIT_OPTIONAL_LOCKS".into(), "0".into());
    env.insert("GIT_TERMINAL_PROMPT".into(), "0".into());
    env.insert("GCM_INTERACTIVE".into(), "never".into());
    env.insert("GIT_PAGER".into(), "cat".into());
    env.insert("LC_ALL".into(), "C".into());
    Some(Runner {
        bin,
        args: vec![
            "-c".into(),
            "core.quotepath=false".into(),
            "-c".into(),
            "color.ui=false".into(),
        ],
        env,
        timeout_ms: 60_000,
        max_bytes: 8 * 1024 * 1024,
    })
}

async fn resolve_one_origin(cwd: &str, now: u64, runner: Option<Runner>) -> Option<Value> {
    if cwd.is_empty() {
        return None;
    }
    let abs = if Path::new(cwd).is_absolute() {
        cwd.to_owned()
    } else {
        std::env::current_dir()
            .ok()?
            .join(cwd)
            .to_string_lossy()
            .into_owned()
    };
    if tokio::fs::metadata(&abs).await.is_err() {
        CACHE.lock().unwrap().remove(&abs);
        return None;
    }
    let cell = CACHE.lock().unwrap().start(&abs, now);
    let origin = cell
        .get_or_init(|| async {
            let mut origin =
                project(facts(&Git::new(runner?, Scope::detached()), &abs, 10_000).await?)?;
            if let Ok(root) = tokio::fs::canonicalize(&origin.root).await {
                origin.root = spelled(&root);
            }
            Some(origin)
        })
        .await;
    origin.as_ref().map(project_origin_value)
}

/// Direct core IPC `project-origin:get`: resolves up to 200 unique folder paths to their git `ProjectOrigin` (or null).
pub(crate) fn ipc_project_origin_get(_ctx: IpcContext, args: Vec<Value>) -> Handled {
    Box::pin(async move {
        let mut seen = HashSet::new();
        let mut folders = Vec::new();
        if let Some(items) = args.first().and_then(Value::as_array) {
            for item in items {
                if let Some(cwd) = item.as_str()
                    && !cwd.is_empty()
                    && seen.insert(cwd.to_owned())
                {
                    folders.push(cwd.to_owned());
                    if folders.len() >= 200 {
                        break;
                    }
                }
            }
        }
        if folders.is_empty() {
            return Ok(Some(Value::Object(Map::new())));
        }
        let now = now_ms();
        let needs_git = {
            let cache = CACHE.lock().unwrap();
            folders.iter().any(|cwd| {
                let abs = if Path::new(cwd).is_absolute() {
                    cwd.clone()
                } else {
                    std::env::current_dir()
                        .ok()
                        .map(|d| d.join(cwd).to_string_lossy().into_owned())
                        .unwrap_or_else(|| cwd.clone())
                };
                cache
                    .fresh(&abs, now)
                    .and_then(|c| c.get().cloned())
                    .is_none()
            })
        };
        let runner = if needs_git {
            default_git_runner().await
        } else {
            None
        };
        let mut futures = Vec::with_capacity(folders.len());
        for cwd in &folders {
            let cwd = cwd.clone();
            let runner = runner.clone();
            futures.push(async move { resolve_one_origin(&cwd, now, runner).await });
        }
        let resolved = futures_util::future::join_all(futures).await;
        let mut out = Map::with_capacity(folders.len());
        for (cwd, origin) in folders.into_iter().zip(resolved) {
            out.insert(cwd, origin.unwrap_or(Value::Null));
        }
        Ok(Some(Value::Object(out)))
    })
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

    #[tokio::test]
    async fn ipc_project_origin_get_deduplicates_and_formats_worktree_origin() {
        use crate::ipc::Caller;
        assert_eq!(worktree_kind_of(Some("autopilot/run-1")), "autopilot");
        assert_eq!(worktree_kind_of(Some("omp/agent/fix")), "agent");
        assert_eq!(worktree_kind_of(Some("main")), "other");
        assert_eq!(worktree_kind_of(None), "other");
        assert_eq!(
            worktree_folder_slug("/Users/a/.omp/wt/gui-my-slug-1a2b3c4"),
            "my-slug"
        );
        assert_eq!(
            worktree_folder_slug("/Users/a/plain-folder"),
            "plain-folder"
        );
        let ctx = || IpcContext {
            caller: Caller {
                key: "w1".into(),
                window: Some(1),
                conn_id: None,
                device_id: None,
            },
            user_data: None,
        };
        assert_eq!(
            ipc_project_origin_get(ctx(), vec![json!("not-an-array")])
                .await
                .unwrap(),
            Some(json!({}))
        );
        let missing = "/no/such/ompdesk/folder/at/all";
        assert_eq!(
            ipc_project_origin_get(ctx(), vec![json!([missing, "", 42, missing])])
                .await
                .unwrap(),
            Some(json!({ missing: null }))
        );
    }
}
