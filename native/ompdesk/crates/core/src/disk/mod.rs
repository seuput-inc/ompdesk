//! Disk care's disk work and gits (was the logic of `src/main/disk/`): folder sizes and the reading kept between runs
//! (`sizes`), which ignored paths a project makes again (`regenerable`), a worktree's facts (`facts`), saving,
//! archiving, restoring and dropping (`saved`), clearing a tool's cache (`cache`) and a session's scratch folder
//! (`scratch`), each step one request main sends (`disk.*`). Main keeps the order of the steps, the saved
//! records and last run, open tabs and removal claims, the secret check (the central redactor is TypeScript),
//! the repository lock around each step, and the profile and session paths. The core locates tool caches
//! and checks which processes need them. A git request carries main's runner (`git`); a cancelled request starts no more disk work and
//! no git, and answers only once the call the system already has returned and every git it ran exited (`tree::live`,
//! each worker holds the request's scope).

mod cache;
mod cache_policy;
mod facts;
pub(crate) mod local_files;
mod low_space;
mod regenerable;
mod run_state;
mod saved;
mod saved_records;
pub(crate) mod saves;
mod scratch;
mod sizes;
pub(crate) mod tree;
mod usage;

use std::sync::{Arc, LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::git::read::blocking;
use crate::git::run::Git;
use crate::ipc::{Handled, IpcContext};
use crate::ports::Port;
use crate::run::Runner;
use crate::server::{Fault, Registry, Reply};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenParams {
    file: String,
    /// Main's clock (tests move it).
    now: f64,
}

#[derive(Serialize)]
struct Opened {
    reading: u64,
    reused: bool,
}

/// `reading` none: a full walk that keeps nothing. `path` resolved by main.
#[derive(Deserialize)]
struct BytesParams {
    reading: Option<u64>,
    path: String,
    reuse: bool,
}

#[derive(Deserialize)]
struct SaveSizesParams {
    reading: u64,
    now: f64,
}

#[derive(Deserialize)]
struct WorktreeParams {
    git: Runner,
    worktree: String,
}

#[derive(Deserialize)]
struct ActivityParams {
    git: Runner,
    worktree: String,
    activity: facts::Activity,
}

#[derive(Deserialize)]
struct DropParams {
    worktree: String,
    entries: Vec<saved::Droppable>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckParams {
    git: Runner,
    worktree: String,
    untracked_files: Vec<String>,
    exclude: Vec<String>,
}

#[derive(Deserialize)]
struct BlobParams {
    git: Runner,
    worktree: String,
    path: String,
}

#[derive(Deserialize)]
struct ScratchRoot {
    root: std::path::PathBuf,
}

#[derive(Deserialize)]
struct ScratchIdle {
    dir: String,
    known: bool,
    now: f64,
    days: u32,
}

#[derive(Deserialize)]
struct ScratchSessions {
    candidates: Option<Vec<scratch::SessionCopies>>,
    idle: bool,
}

#[derive(Deserialize)]
struct ScratchParams {
    dir: String,
    running: Option<bool>,
    sessions: Vec<String>,
}

#[derive(Serialize)]
struct Complete {
    bytes: usize,
    complete: bool,
}

#[derive(Deserialize)]
struct CheckoutParams {
    git: Runner,
    #[serde(flatten)]
    record: saved::Checkout,
}

pub fn register(registry: &mut Registry) {
    run_state::register(registry);
    registry.add("disk.usage", |call| Box::pin(usage::handle(call)));
    saved_records::register(registry);
    registry.add("disk.lowSpace", |call| Box::pin(low_space::handle(call)));
    registry.add("disk.sizesOpen", |call| {
        Box::pin(async move {
            let OpenParams { file, now } = call.params()?;
            let (reading, reused) =
                blocking(move || sizes::open(std::path::Path::new(&file), now)).await?;
            Reply::json(&Opened { reading, reused })
        })
    });
    registry.add("disk.sizesBytes", |call| {
        Box::pin(async move {
            let BytesParams {
                reading,
                path,
                reuse,
            } = call.params()?;
            let scope = call.scope;
            let walked = blocking(move || sizes::bytes(reading, &path, reuse, &scope)).await??;
            Reply::json(&walked)
        })
    });
    registry.add("disk.sizesSave", |call| {
        Box::pin(async move {
            let SaveSizesParams { reading, now } = call.params()?;
            let scope = call.scope;
            blocking(move || sizes::save(reading, now, &scope)).await??;
            Reply::json(&())
        })
    });
    registry.add("disk.processFolders", |call| {
        Box::pin(async move { Reply::json(&facts::process_folders(&call.scope).await?) })
    });
    registry.add("disk.worktreeFiles", |call| {
        Box::pin(async move {
            let WorktreeParams { git, worktree } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&facts::files(&git, &worktree).await?)
        })
    });
    registry.add("disk.inProgress", |call| {
        Box::pin(async move {
            let WorktreeParams { git, worktree } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&facts::in_progress(&git, &worktree).await?)
        })
    });
    registry.add("disk.head", |call| {
        Box::pin(async move {
            let WorktreeParams { git, worktree } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&facts::head(&git, &worktree).await?)
        })
    });
    registry.add("disk.lastActivity", |call| {
        Box::pin(async move {
            let ActivityParams {
                git,
                worktree,
                activity,
            } = call.params()?;
            let scope = call.scope.clone();
            let git = Git::new(git, call.scope);
            Reply::json(&facts::last_activity(&git, &worktree, activity, &scope).await?)
        })
    });
    registry.add("disk.dropArtifacts", |call| {
        Box::pin(async move {
            let DropParams { worktree, entries } = call.params()?;
            let scope = call.scope;
            Reply::json(&blocking(move || saved::drop_entries(&worktree, entries, &scope)).await??)
        })
    });
    registry.add("disk.pruneCheckInputs", |call| {
        Box::pin(async move {
            let scope = call.scope;
            let bytes = blocking(move || {
                tree::live(&scope)?;
                let bytes = ompdesk_checks::check::prune_idle_inputs(
                    &ompdesk_checks::check::checks_dir(),
                    crate::clock::now_ms(),
                    || scope.cancelled(),
                );
                tree::live(&scope)?;
                Ok::<_, crate::server::Fault>(bytes)
            })
            .await??;
            Reply::json(&bytes)
        })
    });
    registry.add("disk.locateCaches", |call| {
        Box::pin(cache_policy::locate(call))
    });
    registry.add("disk.cacheHolds", |call| {
        Box::pin(cache_policy::holds(call))
    });
    registry.add("disk.clearCache", |call| {
        Box::pin(cache_policy::clear(call))
    });
    registry.add("disk.scratchTags", |call| {
        Box::pin(async move {
            let ScratchRoot { root } = call.params()?;
            let scope = call.scope;
            Reply::json(&blocking(move || scratch::tags(&root, &scope)).await??)
        })
    });
    registry.add("disk.scratchSessions", |call| {
        Box::pin(async move {
            let ScratchSessions { candidates, idle } = call.params()?;
            let scope = call.scope;
            blocking(move || Reply::json(&scratch::sessions(candidates.as_deref(), idle, &scope)?))
                .await?
        })
    });
    registry.add("disk.scratchIdle", |call| {
        Box::pin(async move {
            let ScratchIdle {
                dir,
                known,
                now,
                days,
            } = call.params()?;
            let scope = call.scope;
            Reply::json(&blocking(move || scratch::idle(&dir, known, now, days, &scope)).await??)
        })
    });
    registry.add("disk.scratchSweep", |call| {
        Box::pin(async move {
            let ScratchParams {
                dir,
                sessions,
                running,
            } = call.params()?;
            scratch::check_processes(running)?;
            let scope = call.scope;
            Reply::json(&blocking(move || scratch::sweep(&dir, &sessions, &scope)).await??)
        })
    });
    registry.add("disk.saveCheck", |call| {
        Box::pin(async move {
            let CheckParams {
                git,
                worktree,
                untracked_files,
                exclude,
            } = call.params()?;
            let scope = call.scope.clone();
            let git = Git::new(git, call.scope);
            Reply::json(&saved::check(&git, &worktree, untracked_files, exclude, &scope).await?)
        })
    });
    registry.add("disk.stagedBlob", |call| {
        Box::pin(async move {
            let BlobParams {
                git,
                worktree,
                path,
            } = call.params()?;
            let git = Git::new(git, call.scope);
            let (complete, bytes) = saved::staged_blob(&git, &worktree, &path).await?;
            Ok(Reply::json(&Complete {
                complete,
                bytes: bytes.len(),
            })?
            .with_bin(bytes))
        })
    });
    registry.add("disk.restoreCheckout", |call| {
        Box::pin(async move {
            let CheckoutParams { git, record } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&saved::checkout(&git, record).await?)
        })
    });
    registry.add("disk.carePort", |call| {
        Box::pin(async move {
            let CarePortParams { port } = call.params()?;
            let opened = Port::open(&call.events, port, Value::Null)?;
            *CARE_PORT.lock().unwrap_or_else(|p| p.into_inner()) = Some(opened);
            Reply::json(&())
        })
    });
}

#[derive(Deserialize)]
struct CarePortParams {
    port: u64,
}

static CARE_PORT: LazyLock<Mutex<Option<Arc<Port<Value>>>>> = LazyLock::new(Default::default);

async fn ask_care(method: &str) -> Result<Option<Value>, Fault> {
    let port = CARE_PORT.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let Some(port) = port else {
        return Err(Fault::new(
            "disk_care_unavailable",
            "Disk care service is not connected",
        ));
    };
    let val: Value = port.ask(method, &json!({})).await?;
    Ok(Some(val))
}

/// Direct core IPC `disk-care:get-state`.
pub(crate) fn ipc_get_state(_ctx: IpcContext, _args: Vec<Value>) -> Handled {
    Box::pin(async move { ask_care("state").await })
}

/// Direct core IPC `disk-care:run`.
pub(crate) fn ipc_run(_ctx: IpcContext, _args: Vec<Value>) -> Handled {
    Box::pin(async move { ask_care("run").await })
}
