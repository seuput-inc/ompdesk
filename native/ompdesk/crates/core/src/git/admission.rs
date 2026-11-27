//! Main obtains the checkout's reservation before taking its repository lock. Only the core
//! connection that reserved it can consume it, once. Closing the connection abandons unspent leases.
use std::collections::{BTreeMap, HashMap, hash_map::Entry};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use ompdesk_checks::{
    Watch,
    heavy::{self, Lease, Owner, Pool, Volumes},
};
use serde::Deserialize;

use super::{
    read,
    run::Git,
    seed,
    worktree::{self, AddParams},
};
use crate::server::{Call, Events, Fault, Reply, Scope};

#[derive(serde::Serialize)]
struct WaitNotice<'a> {
    id: &'a str,
    wait: Option<heavy::WaitReason>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    id: String,
    wait_id: Option<String>,
    seed_budget_ms: Option<u64>,
    #[serde(flatten)]
    add: AddParams,
}

#[derive(Deserialize)]
struct Id {
    id: String,
}

struct Permit {
    lease: Lease,
    volumes: Volumes,
}
struct Ready {
    connection: Events,
    request: Request,
    permit: Permit,
    tree: String,
}
static READY: LazyLock<Mutex<HashMap<String, Ready>>> = LazyLock::new(Default::default);

fn refused(message: impl ToString) -> Fault {
    Fault::new("worktree_admission", message.to_string())
}

impl Permit {
    async fn acquire(
        paths: Vec<PathBuf>,
        writes: Option<BTreeMap<PathBuf, u64>>,
        label: &'static str,
        scope: Scope,
        notices: Option<(Events, String)>,
    ) -> Result<Self, Fault> {
        read::blocking(move || {
            let env = |key: &str| std::env::var(key).ok();
            let mut pool =
                Pool::new(heavy::pool_dir(&env), heavy::machine_size(&env)).map_err(refused)?;
            let cwd = paths[0].display().to_string();
            pool.volumes = Volumes::for_targets(paths, writes);
            let owner = Owner {
                pid: std::process::id(),
                command: label.into(),
                cwd,
                since: 0,
                weight: 1,
                run_id: None,
                session: None,
            };
            let mut waited = false;
            let lease = pool
                .acquire_unless(
                    1,
                    owner,
                    false,
                    |wait| {
                        eprintln!(
                            "{label}: waiting ({} ahead, {} holders, pressure: {})",
                            wait.ahead,
                            wait.holders.len(),
                            wait.pressure.map_or("none", heavy::WaitReason::label)
                        );
                        for disk in &wait.low_disk {
                            eprintln!("{label}: free {} bytes, need {}", disk.free, disk.need);
                        }
                        if let Some((events, id)) = &notices {
                            waited = true;
                            events.send(
                                "git.worktreeWait",
                                &WaitNotice {
                                    id,
                                    wait: Some(wait.reason()),
                                },
                            );
                        }
                    },
                    &|| scope.cancelled(),
                )
                .map_err(refused)?;
            if waited && let Some((events, id)) = notices {
                events.send(
                    "git.worktreeWait",
                    &WaitNotice {
                        id: &id,
                        wait: None,
                    },
                );
            }
            Ok(Self {
                lease,
                volumes: pool.volumes,
            })
        })
        .await?
    }

    async fn run<T>(
        self,
        parent: Scope,
        work: impl AsyncFnOnce(Scope, &Lease) -> Result<T, Fault>,
    ) -> Result<T, Fault> {
        let (scope, ended) = Scope::watched();
        let stop = scope.clone();
        let watch = Watch::start(
            self.volumes,
            None,
            |s| eprintln!("worktree: {s}"),
            Some(Box::new(move || stop.cancel())),
        );
        let result = {
            let running = work(scope.clone(), &self.lease);
            tokio::pin!(running);
            tokio::select! {
                biased;
                _ = parent.on_cancel() => { scope.cancel(); running.await },
                result = &mut running => result,
            }
        };
        let stopped = watch.stopped_for_disk();
        drop(watch);
        drop(scope);
        ended.wait().await;
        if stopped {
            Err(refused(
                "Stopped worktree writes at the emergency disk threshold",
            ))
        } else {
            result
        }
    }
}

async fn tree(add: &AddParams, git: &Git) -> Result<String, Fault> {
    let from = add.source_ref(git).await?;
    let output = git
        .raw(
            &add.base_cwd,
            &[
                "rev-parse",
                "--verify",
                "--end-of-options",
                &format!("{from}^{{tree}}"),
            ],
        )
        .await?;
    if output.code != 0 {
        return Err(Fault::new(
            "worktree_create_failed",
            format!("The checkout source {from} does not exist"),
        ));
    }
    Ok(output.text().trim().to_owned())
}

// ls-tree's blob sizes describe an ordinary checkout, not a quota on filters, hooks or external writers.
fn blob_bytes(list: &[u8]) -> Option<u64> {
    list.split(|b| *b == 0)
        .filter(|entry| !entry.is_empty())
        .try_fold(0u64, |sum, entry| {
            let end = entry.iter().position(|b| *b == b'\t')?;
            let header = std::str::from_utf8(&entry[..end]).ok()?;
            let size = header.split_ascii_whitespace().last()?;
            sum.checked_add(if size == "-" {
                0
            } else {
                size.parse::<u64>().ok()?
            })
        })
}

pub(super) async fn admit(call: Call) -> Result<Reply, Fault> {
    let mut request: Request = call.params()?;
    let add = &request.add;
    let git = Git::new(add.git.clone(), call.scope.clone());
    let tree = tree(add, &git).await?;
    let common = git
        .text(
            &add.base_cwd,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .await?;
    let common = PathBuf::from(read::native(common.trim()));
    let root = PathBuf::from(read::native(&add.root));
    let listing = git.raw(&add.base_cwd, &["ls-tree", "-rlz", &tree]).await?;
    let filters = git
        .raw(
            &add.base_cwd,
            &[
                "config",
                "--name-only",
                "--get-regexp",
                "^filter\\..*\\.(process|smudge)$",
            ],
        )
        .await?;
    let seed = if request.seed_budget_ms.is_some()
        && Path::new(&add.primary).join(".worktreeinclude").is_file()
    {
        seed::SEED_MAX_BYTES
    } else {
        0
    };
    let writes = (filters.code == 1 && listing.code == 0 && !listing.truncated)
        .then(|| {
            let checkout = blob_bytes(&listing.stdout)?.checked_add(seed)?;
            let index = std::fs::metadata(common.join("index"))
                .ok()?
                .len()
                .max(listing.stdout.len() as u64);
            let mut writes = BTreeMap::from([(root.clone(), checkout)]);
            let n = writes.entry(common.clone()).or_default();
            *n = n.checked_add(index)?;
            Some(writes)
        })
        .flatten();
    let permit = Permit::acquire(
        vec![root, common],
        writes,
        "git worktree add",
        call.scope.clone(),
        request.wait_id.take().map(|id| (call.events.clone(), id)),
    )
    .await?;
    let mut ready = READY.lock().unwrap_or_else(|p| p.into_inner());
    if call.scope.cancelled() {
        return Err(Fault::cancelled());
    }
    match ready.entry(request.id.clone()) {
        Entry::Occupied(_) => Err(refused("Checkout reservation id already used")),
        Entry::Vacant(e) => {
            e.insert(Ready {
                connection: call.events,
                request,
                permit,
                tree,
            });
            Reply::json(&())
        }
    }
}

fn take(call: &Call) -> Result<Option<Ready>, Fault> {
    let Id { id } = call.params()?;
    let mut ready = READY.lock().unwrap_or_else(|p| p.into_inner());
    Ok(match ready.entry(id) {
        Entry::Occupied(e) if !e.get().connection.reaches_another(&call.events) => Some(e.remove()),
        _ => None,
    })
}

pub(super) fn release(call: Call) -> Result<Reply, Fault> {
    drop(take(&call)?);
    Reply::json(&())
}
pub(crate) fn close_all(connection: &Events) {
    READY
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .retain(|_, r| r.connection.reaches_another(connection));
}

pub(super) async fn checkout(call: Call) -> Result<Reply, Fault> {
    let Ready {
        permit,
        request,
        tree: admitted,
        ..
    } = take(&call)?
        .ok_or_else(|| refused("Checkout reservation is no longer valid; retry creation"))?;
    permit.run(call.scope, async move |scope, lease| {
        let add = request.add;
        let git = Git::new(add.git.clone(), scope.clone());
        if tree(&add, &git).await? != admitted { return Err(refused("Checkout source changed while waiting; retry creation")); }
        let primary = add.primary.clone();
        let added = worktree::add(add, scope.clone()).await?;
        let seed = if let Some(ms) = request.seed_budget_ms {
            let seed = if Path::new(&primary).join(".worktreeinclude").is_file() { seed::SEED_MAX_BYTES } else { 0 };
            let result = match lease.remaining_on(Path::new(&added.path), seed) {
                Ok(()) => seed::seed(git, scope.clone(), primary, added.path.clone(), seed::Limits { budget: Duration::from_millis(ms), pretend_clones: None }).await,
                Err(error) => Err(refused(error)),
            };
            match result {
                Ok(report) => serde_json::to_value(report).map_err(refused)?,
                Err(e) if !scope.cancelled() => serde_json::json!({"copied":0,"bytes":0,"cloned":false,"skipped":[{"path":".worktreeinclude","reason":e.message}]}),
                Err(e) => return Err(e),
            }
        } else { serde_json::Value::Null };
        let mut result = serde_json::to_value(added).map_err(refused)?;
        if !seed.is_null() { result["seed"] = seed; }
        Reply::json(&result)
    }).await
}

pub(super) async fn standalone_seed(
    runner: crate::run::Runner,
    scope: Scope,
    primary: String,
    target: String,
    limits: seed::Limits,
    notices: Option<(Events, String)>,
) -> Result<Option<seed::Report>, Fault> {
    if !Path::new(&primary).join(".worktreeinclude").is_file() {
        return Ok(None);
    }
    let path = PathBuf::from(read::native(&target));
    let permit = Permit::acquire(
        vec![path.clone()],
        Some(BTreeMap::from([(path, seed::SEED_MAX_BYTES)])),
        "worktree seed",
        scope.clone(),
        notices,
    )
    .await?;
    permit
        .run(scope, async move |scope, _lease| {
            seed::seed(
                Git::new(runner, scope.clone()),
                scope,
                primary,
                target,
                limits,
            )
            .await
        })
        .await
}
