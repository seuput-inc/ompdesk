//! Worktrees (was the git side of `src/main/local/git/worktree.ts` and `session-worktree.ts`): a new worktree's base
//! and branch, its `worktree add` with the branch rolled back when the add fails, the checks before a removal and
//! the removal itself, and a session worktree's snapshot and removal. Each method is one whole step: main runs the
//! ones that change the repository under its lock (`withRepoLock`), so a stopped holder cancels the request and the
//! lock's next holder starts once its gits and disk work have ended. Main gets the worktree root and repo hash
//! from omp's `git.worktree_location`. A refusal carries the code the TypeScript caller exposes.

use std::collections::HashMap;
use std::hash::{DefaultHasher, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::parse;
use super::read::{self, blocking};
use super::run::{Git, failure};
use crate::disk::tree::live;
use crate::fs::disk;
use crate::fs::error::{Codes, NodeError};
use crate::fs::order::js_trim;
use crate::run::{Opts, Output, Runner};
use crate::server::{Fault, Scope};

fn refuse(code: &'static str, message: impl Into<String>) -> Fault {
    Fault::new(code, message)
}

/// `fs.realpath` as node spells the answer.
pub(super) fn real(path: &str) -> Result<String, NodeError> {
    disk::realpath(path).map(|resolved| disk::spelled(&resolved))
}

/// `rev-parse --verify --quiet <ref>`: the object it names, none when git says no.
async fn rev_parse(git: &Git, cwd: &str, reference: &str) -> Result<Option<String>, Fault> {
    let output = git
        .raw(cwd, &["rev-parse", "--verify", "--quiet", reference])
        .await?;
    let text = output.text();
    let sha = js_trim(&text);
    Ok((output.code == 0 && !sha.is_empty()).then(|| sha.to_owned()))
}

async fn branch_exists(git: &Git, cwd: &str, branch: &str) -> Result<bool, Fault> {
    let reference = format!("refs/heads/{branch}");
    let output = git
        .raw(cwd, &["show-ref", "--verify", "--quiet", &reference])
        .await?;
    Ok(output.code == 0)
}

/// `-c checkout.workers=4` unless the person set `checkout.workers` at any scope (Orca
/// `src/main/git/worktrees/creation/checkout-workers-git-args.ts:8-23`): git 2.32+ then checks out with four workers,
/// an older git ignores the key. `config --get` exits 1 only when the key is unset; any other answer keeps git's own.
async fn checkout_workers(git: &Git, cwd: &str) -> Result<&'static [&'static str], Fault> {
    let set = git
        .raw(cwd, &["config", "--get", "checkout.workers"])
        .await?;
    Ok(if set.code == 1 {
        &["-c", "checkout.workers=4"]
    } else {
        &[]
    })
}

/// `worktree add <add…>` with its own timeout (minutes on a large repository: it checks out the whole tree). With
/// `sparse` folders it checks out only those (Orca `worktree-sparse-add.ts:28-57`): `--no-checkout`, then in the new
/// worktree `sparse-checkout init --cone`, `set -- <folders>` and `checkout <branch>`; a failure there removes the
/// worktree again (the caller deletes a branch it made).
async fn add_worktree(
    git: &Git,
    primary: &str,
    add: &[&str],
    target: &str,
    branch: &str,
    sparse: &[String],
    timeout_ms: u64,
) -> Result<(), Fault> {
    let opts = || Opts {
        timeout_ms: Some(timeout_ms),
        ..Opts::default()
    };
    let workers = checkout_workers(git, primary).await?;
    let mut args: Vec<&str> = Vec::new();
    if sparse.is_empty() {
        args.extend_from_slice(workers);
    }
    args.extend(["worktree", "add"]);
    if !sparse.is_empty() {
        args.push("--no-checkout");
    }
    args.extend_from_slice(add);
    git.text_with(primary, &args, opts()).await?;
    if sparse.is_empty() {
        return Ok(());
    }
    let materialized = async {
        git.text(target, &["sparse-checkout", "init", "--cone"])
            .await?;
        let mut set: Vec<&str> = vec!["sparse-checkout", "set", "--"];
        set.extend(sparse.iter().map(String::as_str));
        git.text_with(target, &set, opts()).await?;
        let mut checkout: Vec<&str> = workers.to_vec();
        checkout.extend(["checkout", branch]);
        git.text_with(target, &checkout, opts()).await.map(drop)
    }
    .await;
    if let Err(error) = materialized {
        if error != Fault::cancelled() {
            let _ = git_remove(git, primary, &["--force"], target, Opts::default()).await;
        }
        return Err(error);
    }
    Ok(())
}

/// A fetch of the remote default branch younger than this is not repeated (the dialog's prefetch, then its create).
const FETCH_FRESH: Duration = Duration::from_secs(30);
const FETCH_TIMEOUT_MS: u64 = 60_000;
/// Each `ls-remote` of `rename_unpushed` (main's budget for the rename counts two per remote).
const LS_REMOTE_MS: u64 = 30_000;

/// Per main checkout, when its default branch was last fetched. One fetch at a time per repository: a create that
/// follows a prefetch still running waits for it, then skips its own.
type LastFetch = Arc<tokio::sync::Mutex<Option<Instant>>>;
static FETCHES: LazyLock<Mutex<HashMap<(String, String), LastFetch>>> =
    LazyLock::new(Default::default);

/// What fetching the remote default branch before a `default`-based worktree did: `behind` counts the commits the
/// fetch brought, `subjects` the newest three of them; `fetched` is false when a fetch under 30 s old was reused or
/// the fetch failed (`error`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseFetch {
    #[serde(rename = "ref")]
    reference: String,
    fetched: bool,
    behind: u32,
    subjects: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// The remote's default branch as `origin/<name>`, none when `origin/HEAD` names none.
async fn default_branch(git: &Git, primary: &str) -> Result<Option<String>, Fault> {
    let output = git
        .raw(
            primary,
            &[
                "symbolic-ref",
                "--quiet",
                "--short",
                "refs/remotes/origin/HEAD",
            ],
        )
        .await?;
    let text = output.text();
    let name = js_trim(&text);
    Ok((output.code == 0 && !name.is_empty()).then(|| name.to_owned()))
}

/// `git fetch origin <branch>` for the remote-tracking `reference` (`origin/main`): only that ref moves, never a
/// local branch or a checkout. A failed or timed-out fetch is reported, never a fault.
async fn fetch_base(git: &Git, primary: &str, reference: &str) -> Result<BaseFetch, Fault> {
    let mut report = BaseFetch {
        reference: reference.to_owned(),
        fetched: false,
        behind: 0,
        subjects: Vec::new(),
        error: None,
    };
    let Some(branch) = reference.strip_prefix("origin/") else {
        return Ok(report);
    };
    let slot = FETCHES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .entry((primary.to_owned(), reference.to_owned()))
        .or_default()
        .clone();
    let mut last = slot.lock().await;
    if last.is_some_and(|at| at.elapsed() < FETCH_FRESH) {
        return Ok(report);
    }
    let before = rev_parse(git, primary, reference).await?;
    let args = ["fetch", "--quiet", "--no-tags", "origin", branch];
    let opts = Opts {
        timeout_ms: Some(FETCH_TIMEOUT_MS),
        ..Opts::default()
    };
    match git.run(primary, &args, opts).await {
        Ok(output) if output.code == 0 => {}
        Ok(output) => {
            report.error = Some(failure(&args, &output).message);
            return Ok(report);
        }
        Err(fault) if fault == Fault::cancelled() => return Err(fault),
        Err(fault) => {
            report.error = Some(fault.message);
            return Ok(report);
        }
    }
    *last = Some(Instant::now());
    report.fetched = true;
    let after = rev_parse(git, primary, reference).await?;
    if let (Some(old), Some(new)) = (before, after)
        && old != new
    {
        let range = format!("{old}..{new}");
        let count = git.text(primary, &["rev-list", "--count", &range]).await?;
        report.behind = js_trim(&count).parse().unwrap_or(0);
        report.subjects = git
            .text(primary, &["log", "--format=%s", "-3", &range])
            .await?
            .lines()
            .map(str::to_owned)
            .collect();
    }
    Ok(report)
}

/// The worktree dialog's prefetch when it opens: the fetch `plan` makes for `default`, so the create that follows
/// within 30 s skips its own. None outside a repository or without a remote default branch.
pub async fn prefetch(git: &Git, cwd: &str) -> Result<Option<BaseFetch>, Fault> {
    if read::repo_root(git, cwd).await?.is_none() {
        return Ok(None);
    }
    let primary = read::primary_root(git, cwd).await?;
    match default_branch(git, &primary).await? {
        Some(reference) => fetch_base(git, &primary, &reference).await.map(Some),
        None => Ok(None),
    }
}

/// The main checkout a new worktree is cut from and the commit its branch starts at; `base` only for `default`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    primary: String,
    main_checkout: String,
    start_point: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    base: Option<BaseFetch>,
}

/// Before a worktree is made: `cwd` is in a repository, its main checkout, and the start point `base_ref` names:
/// `HEAD` (the default), `default` (the remote's default branch, fetched first, else HEAD), or any branch, tag or
/// commit the repository resolves. A ref that resolves to no commit, or reads as a git option, is refused.
pub async fn plan(
    git: &Git,
    cwd: &str,
    checkout_spelling: String,
    base_ref: Option<&str>,
) -> Result<Plan, Fault> {
    if read::repo_root(git, cwd).await?.is_none() {
        return Err(refuse("not_a_repo", format!("Not a git repository: {cwd}")));
    }
    let primary = read::primary_root(git, cwd).await?;
    let mut fetch = None;
    let start_point = match base_ref {
        None if super::ompdesk_origin(git, &primary).await? => {
            let report = fetch_base(git, &primary, "origin/dev").await?;
            if let Some(error) = report.error {
                return Err(refuse("invalid_base", error));
            }
            fetch = Some(report);
            "origin/dev".to_owned()
        }
        None | Some("HEAD") => "HEAD".to_owned(),
        Some("default") => match default_branch(git, &primary).await? {
            Some(name) => {
                fetch = Some(fetch_base(git, &primary, &name).await?);
                name
            }
            None => "HEAD".to_owned(),
        },
        Some(base) => {
            let resolves = !base.starts_with('-')
                && rev_parse(git, cwd, &format!("{base}^{{commit}}"))
                    .await?
                    .is_some();
            if !resolves {
                return Err(refuse(
                    "invalid_base",
                    format!(
                        "The base \"{base}\" is not a branch, tag or commit of {cwd}. Use \"HEAD\" (default), \"default\" (the remote's default branch) or a ref the repository has."
                    ),
                ));
            }
            base.to_owned()
        }
    };
    // Node's path.resolve spelling is the identity held by tabs (notably a Windows 8.3 path).
    let (given, main) = tokio::join!(disk::real(cwd), disk::real(&primary));
    let same = match (given, main) {
        (Some(a), Some(b)) if cfg!(windows) => {
            a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
        }
        (Some(a), Some(b)) => a == b,
        _ => false,
    };
    Ok(Plan {
        main_checkout: if same {
            checkout_spelling
        } else {
            primary.clone()
        },
        primary,
        start_point,
        base: fetch,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AddParams {
    pub(super) git: Runner,
    pub(super) primary: String,
    pub(super) base_cwd: String,
    pub(super) root: String,
    hash: String,
    slug: String,
    branch_prefix: String,
    start_point: String,
    source: Option<Source>,
    add_timeout_ms: u64,
    /// A preset of the main checkout's `.ompdesk/sparse` (`sparse.rs`): only its folders are checked out.
    #[serde(default)]
    sparse: Option<String>,
    /// Folders saved sessions recorded as their working folder: never a new worktree's (`taken`).
    #[serde(default)]
    taken: Vec<String>,
}

impl AddParams {
    pub(super) async fn source_ref(&self, git: &Git) -> Result<String, Fault> {
        if let Some(source) = &self.source {
            match source.mode {
                Mode::Remote => {
                    return Ok(format!(
                        "refs/remotes/{}/{}",
                        source.remote.as_deref().unwrap_or_default(),
                        source.name
                    ));
                }
                Mode::Local => return Ok(format!("refs/heads/{}", source.name)),
                Mode::Reuse if branch_exists(git, &self.primary, &source.name).await? => {
                    return Ok(format!("refs/heads/{}", source.name));
                }
                _ => return Ok(source.from.as_ref().unwrap_or(&self.start_point).clone()),
            }
        }
        Ok(self.start_point.clone())
    }
}

/// How a worktree is checked out: the sparse folders (none: the whole tree) and `worktree add`'s timeout.
struct Checkout<'a> {
    sparse: &'a [String],
    timeout_ms: u64,
}

/// Whether a saved session recorded `path` as its folder (FX22; Orca `retired-name-registry.ts` keeps retired names
/// for the same reason): stock keys a session's history by its folder, so a new worktree in a removed one's folder
/// would show that history as its own, and the removed session would open in it.
fn taken(taken: &[String], path: &Path) -> bool {
    let spelled = path.to_string_lossy();
    taken.iter().any(|folder| {
        let folder = read::native(folder);
        if cfg!(windows) {
            folder.to_lowercase() == spelled.to_lowercase()
        } else {
            folder == spelled
        }
    })
}

#[derive(Serialize)]
pub(super) struct Added {
    pub(super) path: String,
    branch: String,
}

/// An existing folder (even empty) is occupied. Never start a mkdir or git after a cancelled disk wait.
fn free_folder(scope: Scope, path: PathBuf) -> Result<Option<String>, Fault> {
    live(&scope)?;
    if path.exists() {
        return Ok(None);
    }
    let parent = path.parent().expect("a candidate has a folder name");
    live(&scope)?;
    let parent_text = parent.to_string_lossy();
    if parent_text.contains('\0') {
        return Err(NodeError::nul_in_path("path", &parent_text).fault(Codes::None));
    }
    std::fs::create_dir_all(parent)
        .map_err(|error| NodeError::new(&error, "mkdir", Some(&parent_text)).fault(Codes::None))?;
    live(&scope)?;
    Ok(Some(
        path.into_os_string()
            .into_string()
            .expect("UTF-8 worktree location"),
    ))
}

pub(super) async fn add(params: AddParams, scope: Scope) -> Result<Added, Fault> {
    let git = Git::new(params.git, scope.clone());
    let root = PathBuf::from(read::native(&params.root));
    let sparse = match &params.sparse {
        None => Vec::new(),
        Some(name) => super::sparse::of_primary(&params.primary)
            .await?
            .into_iter()
            .find(|preset| preset.name == *name)
            .map(|preset| preset.folders)
            .ok_or_else(|| {
                refuse(
                    "worktree_create_failed",
                    format!(
                        "No sparse checkout preset \"{name}\" in {}.",
                        super::sparse::PRESETS_FILE
                    ),
                )
            })?,
    };
    let checkout = Checkout {
        sparse: &sparse,
        timeout_ms: params.add_timeout_ms,
    };
    for suffix in 1..=100 {
        let suffixed;
        let candidate = if suffix == 1 {
            &params.slug
        } else {
            suffixed = format!("{}-{suffix}", params.slug);
            &suffixed
        };
        let path = root.join(format!("gui-{candidate}-{}", params.hash));
        if taken(&params.taken, &path) {
            continue;
        }
        let held = scope.clone();
        let Some(path) = blocking(move || free_folder(held, path)).await?? else {
            continue;
        };
        let branch = if let Some(source) = params.source {
            add_named(
                &git,
                &params.primary,
                &params.base_cwd,
                &path,
                &source,
                &params.start_point,
                &checkout,
            )
            .await?;
            source.name
        } else {
            let branch = format!("{}{candidate}", params.branch_prefix);
            if branch_exists(&git, &params.primary, &branch).await? {
                continue;
            }
            add_new(
                &git,
                &params.primary,
                &params.base_cwd,
                &path,
                &branch,
                &params.start_point,
                &checkout,
            )
            .await?;
            branch
        };
        return Ok(Added { path, branch });
    }
    Err(refuse(
        "worktree_create_failed",
        "No available worktree name after 100 attempts",
    ))
}

async fn add_new(
    git: &Git,
    primary: &str,
    base_cwd: &str,
    target: &str,
    branch: &str,
    start_point: &str,
    checkout: &Checkout<'_>,
) -> Result<(), Fault> {
    git.text(base_cwd, &["branch", "--no-track", branch, start_point])
        .await?;
    if let Err(error) = add_worktree(
        git,
        primary,
        &[target, branch],
        target,
        branch,
        checkout.sparse,
        checkout.timeout_ms,
    )
    .await
    {
        if !super::permanent_branch(git, primary, branch).await? {
            let _ = git.raw(primary, &["branch", "-D", branch]).await;
        }
        return Err(error);
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Mode {
    New,
    Local,
    Remote,
    /// The local branch when it exists (a work item started again), else a new one as `New` makes it.
    Reuse,
}

/// The branch a caller names (main checked its shape: `worktreeBranchSource`).
#[derive(Deserialize)]
struct Source {
    name: String,
    mode: Mode,
    remote: Option<String>,
    from: Option<String>,
}

/// A worktree at `target` on exactly the branch the caller names: a new one (from `from`, else the create's start
/// point), an existing local one, either of those as the branch exists (`reuse`), or a new local one tracking
/// `<remote>/<name>`. The name is never changed: a taken, missing or invalid one is refused, and a new branch whose
/// `worktree add` failed is deleted again.
async fn add_named(
    git: &Git,
    primary: &str,
    base_cwd: &str,
    target: &str,
    source: &Source,
    start_point: &str,
    checkout: &Checkout<'_>,
) -> Result<(), Fault> {
    let name = source.name.as_str();
    let valid = !name.starts_with('-')
        && git
            .raw(primary, &["check-ref-format", "--branch", name])
            .await?
            .code
            == 0;
    if !valid {
        return Err(refuse(
            "invalid_name",
            format!("\"{name}\" is not a valid branch name."),
        ));
    }
    let exists = branch_exists(git, primary, name).await?;
    let failed = |message: String| refuse("worktree_create_failed", message);
    match source.mode {
        Mode::New | Mode::Reuse if !exists => {
            // Without its own `from`, a named branch starts where the create's base points (HEAD, the fetched
            // default branch or the ref), as a generated one does.
            let from = source.from.as_deref().unwrap_or(start_point);
            add_new(git, primary, base_cwd, target, name, from, checkout).await
        }
        Mode::New => Err(failed(format!("The branch {name} already exists."))),
        Mode::Local | Mode::Reuse => {
            if !exists {
                return Err(failed(format!("The branch {name} does not exist.")));
            }
            add_worktree(
                git,
                primary,
                &[target, name],
                target,
                name,
                checkout.sparse,
                checkout.timeout_ms,
            )
            .await
        }
        Mode::Remote => {
            if exists {
                return Err(failed(format!("The branch {name} already exists locally.")));
            }
            let upstream = format!("{}/{name}", source.remote.as_deref().unwrap_or_default());
            let tracked = format!("refs/remotes/{upstream}");
            let found = git
                .raw(primary, &["show-ref", "--verify", "--quiet", &tracked])
                .await?;
            if found.code != 0 {
                return Err(failed(format!(
                    "The remote branch {upstream} does not exist."
                )));
            }
            let added = add_worktree(
                git,
                primary,
                &["--track", "-b", name, target, &upstream],
                target,
                name,
                checkout.sparse,
                checkout.timeout_ms,
            )
            .await;
            // A sparse checkout that failed after `-b` made the branch takes it back; it did not exist before.
            if added.is_err()
                && !super::permanent_branch(git, primary, name).await?
                && branch_exists(git, primary, name).await.unwrap_or(false)
            {
                let _ = git.raw(primary, &["branch", "-D", name]).await;
            }
            added
        }
    }
}

/// The branch a new task's worktree got its name for (FS91; Orca `first-work-branch-rename.ts:185-271`): the checkout
/// at `cwd` renamed from `from` to `to` (else `to-2`… while those are taken), only while `from` is still what the
/// checkout has out and it was never published: no upstream, no remote-tracking ref of that name, and no remote that
/// `ls-remote` finds holding it (a remote that cannot be read counts as holding it). Main runs it under the lock its
/// pushes take; an agent's own `git push` takes none, so the same test runs again after `git branch -m`, and a push
/// that landed in between puts the old name back. None when any of that does not hold; nothing stays renamed then.
pub async fn rename_unpushed(
    git: &Git,
    cwd: &str,
    from: &str,
    to: &str,
) -> Result<Option<String>, Fault> {
    rename_unpushed_around(git, cwd, from, to, || {}).await
}

/// `rename_unpushed` with `between` run after the last check and before `git branch -m` (a test's push lands there).
async fn rename_unpushed_around(
    git: &Git,
    cwd: &str,
    from: &str,
    to: &str,
    between: impl FnOnce(),
) -> Result<Option<String>, Fault> {
    if super::permanent_branch(git, cwd, from).await? {
        return Ok(None);
    }
    let head = git
        .raw(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .await?;
    if head.code != 0 || js_trim(&head.text()) != from {
        return Ok(None);
    }
    let valid = !to.starts_with('-')
        && git
            .raw(cwd, &["check-ref-format", "--branch", to])
            .await?
            .code
            == 0;
    if !valid || to == from {
        return Ok(None);
    }
    let mut candidate = None;
    for suffix in 1..=100 {
        let name = if suffix == 1 {
            to.to_owned()
        } else {
            format!("{to}-{suffix}")
        };
        if name == from {
            return Ok(None);
        }
        if !branch_exists(git, cwd, &name).await? {
            candidate = Some(name);
            break;
        }
    }
    let Some(candidate) = candidate else {
        return Ok(None);
    };
    if published(git, cwd, from, from).await? {
        return Ok(None);
    }
    between();
    git.text(cwd, &["branch", "-m", from, &candidate]).await?;
    // `branch -m` carries a `push -u`'s upstream over to the new name.
    if published(git, cwd, &candidate, from).await? {
        git.text(cwd, &["branch", "-m", &candidate, from]).await?;
        return Ok(None);
    }
    Ok(Some(candidate))
}

/// Whether the branch `local` (its upstream) or the name `name` (a remote-tracking ref, or a remote's branch by
/// `ls-remote`) was published. The network read goes last, so the local reads stay next to the rename.
async fn published(git: &Git, cwd: &str, local: &str, name: &str) -> Result<bool, Fault> {
    let remotes = git.text(cwd, &["remote"]).await?;
    let head = format!("refs/heads/{name}");
    for remote in remotes.split('\n').map(js_trim).filter(|r| !r.is_empty()) {
        let opts = Opts {
            timeout_ms: Some(LS_REMOTE_MS),
            ..Opts::default()
        };
        match git
            .run(cwd, &["ls-remote", "--heads", remote, &head], opts)
            .await
        {
            Ok(found) if found.code == 0 && js_trim(&found.text()).is_empty() => {}
            Ok(_) => return Ok(true),
            Err(fault) if fault.code == "cancelled" => return Err(fault),
            Err(_) => return Ok(true),
        }
    }
    let upstream = format!("{local}@{{upstream}}");
    let tracked = git
        .raw(cwd, &["rev-parse", "--verify", "--quiet", &upstream])
        .await?;
    if tracked.code == 0 {
        return Ok(true);
    }
    let pattern = format!("refs/remotes/*/{name}");
    let tracking = git
        .text(cwd, &["for-each-ref", "--format=%(refname)", &pattern])
        .await?;
    Ok(!js_trim(&tracking).is_empty())
}

#[derive(Serialize)]
pub struct Removal {
    primary: String,
    path: String,
}

/// Both paths must resolve; a symlink in the root may not authorize removal of another checkout.
async fn removable_path(root: &str, path: &str) -> Option<String> {
    if !read::is_absolute(path) {
        return None;
    }
    let (root, path) = tokio::join!(disk::real(root), disk::real(path));
    let path = path?.into_os_string().into_string().ok()?;
    super::orphans::inside(root?.to_str()?, &path).then_some(path)
}

/// git's output kept for a checkout's index listing.
const INDEX_MAX_BYTES: usize = 64 * 1024 * 1024;

/// What removing the checkout at `path` loses that its status does not show, in one clause; none when nothing.
/// Submodule checkouts: `worktree remove --force` deletes them with every commit only they hold, while the person's
/// `submodule.<name>.ignore` can hide their edits from status (Orca `worktree-removal-preflight.ts:295-361`).
/// Ignored files no other copy holds (`disk::local_files`), which git deletes forced or not.
pub(crate) async fn removal_risk(
    git: &Git,
    path: &str,
    primary: &str,
) -> Result<Option<String>, Fault> {
    if holds_submodules(git, path).await? {
        return Ok(Some(
            "it holds submodule checkouts, which go with it along with any commit only they have"
                .into(),
        ));
    }
    let files = crate::disk::local_files::unsaved(git, path, primary).await?;
    Ok((!files.safe()).then(|| files.describe()))
}

/// git's own test before it refuses an unforced removal: a submodule repository under the checkout's git dir, or a
/// gitlink checked out with its own `.git`. An index git cannot list whole counts as holding one.
async fn holds_submodules(git: &Git, path: &str) -> Result<bool, Fault> {
    let admin = git.text(path, &["rev-parse", "--absolute-git-dir"]).await?;
    let modules = PathBuf::from(js_trim(&admin)).join("modules");
    let index = git
        .capped(path, &["ls-files", "--stage", "-z"], INDEX_MAX_BYTES)
        .await?;
    if index.code != 0 || index.truncated {
        return Ok(true);
    }
    let listed = index.text();
    let gitlinks: Vec<PathBuf> = listed
        .split_terminator('\0')
        .filter_map(|entry| entry.strip_prefix("160000 "))
        .filter_map(|rest| rest.split_once('\t'))
        .map(|(_, file)| Path::new(path).join(file).join(".git"))
        .collect();
    blocking(move || {
        std::fs::symlink_metadata(&modules).is_ok()
            || gitlinks
                .iter()
                .any(|dot_git| std::fs::symlink_metadata(dot_git).is_ok())
    })
    .await
}

/// The checked target and its repository lock: a linked checkout under `root`, clean unless forced.
pub async fn removal(git: &Git, path: &str, root: &str, force: bool) -> Result<Removal, Fault> {
    let target = removable_path(root, path).await.ok_or_else(|| {
        let name = if path.is_empty() { "(no path)" } else { path };
        refuse("worktree_outside_root", format!("Refusing to remove {name}: only registered linked worktrees under {root} can be removed (check worktree.base)."))
    })?;
    let path = target.as_str();
    let not_a_worktree = |what: &str| refuse("not_a_worktree", format!("{what}: {path}"));
    let checkout_root = read::repo_root(git, path).await.ok().flatten();
    let Some(checkout_root) = checkout_root else {
        return Err(not_a_worktree("Not a git checkout root"));
    };
    let wanted = path.to_owned();
    let (own, root) = blocking(move || (real(&wanted), real(&checkout_root))).await?;
    let own = own.map_err(|error| error.fault(Codes::None))?;
    if root.map_err(|error| error.fault(Codes::None))? != own {
        return Err(not_a_worktree("Not a git checkout root"));
    }
    let primary = read::primary_root(git, path).await?;
    let list = git
        .text(&primary, &["worktree", "list", "--porcelain", "-z"])
        .await?;
    let linked: Vec<String> = parse::worktree_paths(&list)
        .into_iter()
        .skip(1)
        .map(str::to_owned)
        .collect();
    let main = primary.clone();
    let (main, linked) = blocking(move || {
        let linked: Vec<Option<String>> = linked.iter().map(|file| real(file).ok()).collect();
        (real(&main), linked)
    })
    .await?;
    if main.map_err(|error| error.fault(Codes::None))? == own
        || !linked.iter().flatten().any(|file| *file == own)
    {
        return Err(not_a_worktree("Not a registered linked worktree"));
    }
    if !force {
        let parse::Summary {
            staged,
            unstaged,
            untracked,
            ..
        } = read::status(git, path).await?.summary;
        if staged > 0 || unstaged > 0 || untracked > 0 {
            return Err(refuse(
                "worktree_dirty",
                format!(
                    "Worktree has uncommitted changes: {staged} staged, {unstaged} unstaged, {untracked} untracked."
                ),
            ));
        }
        if let Some(risk) = removal_risk(git, path, &primary).await? {
            return Err(refuse(
                "worktree_dirty",
                format!("Removing this worktree would lose work: {risk}."),
            ));
        }
    }
    Ok(Removal {
        primary,
        path: target,
    })
}

/// omp's service broker keeps its project's folder as its working folder for 3 s after the project's last omp exits
/// (stock launch/broker.ts `DEFAULT_IDLE_GRACE_MS`); a removal right after a tab closed waits that out, with room.
#[cfg(windows)]
const HELD_FOLDER_MS: u64 = 10_000;

/// `git worktree remove <flags> <target>`, every removal of a session's checkout. On Windows git cannot delete a folder
/// some process still has as its working folder (omp's service broker in the moments after its tab closed; omp 19's
/// per-user daemon, which takes the folder of the session that first needed it, for as long as any omp is connected):
/// it empties the folder, drops the worktree from its list ("there's no going back from here", builtin/worktree.c)
/// and fails with `failed to delete '<folder>': Permission denied` after well under a second. The folder left behind,
/// no longer a worktree, is then removed once its holder lets go (within `HELD_FOLDER_MS`), and the answer is git's
/// success. A holder that stays past that leaves only an empty folder, written down for disk care's later pass
/// (`left_behind.rs`), and the answer is success too; a folder with anything still in it, or one the core cannot
/// write down, keeps git's failure. A worktree git still lists is never touched here.
pub(crate) async fn git_remove(
    git: &Git,
    primary: &str,
    flags: &[&str],
    target: &str,
    opts: Opts<'_>,
) -> Result<Output, Fault> {
    let mut args = vec!["worktree", "remove"];
    args.extend_from_slice(flags);
    args.push(target);
    let output = git.run(primary, &args, opts).await?;
    #[cfg(windows)]
    if output.code != 0 && left_behind(git, primary, target).await? {
        let succeeded = || Output {
            code: 0,
            stdout: Vec::new(),
            stderr: String::new(),
            truncated: false,
        };
        let folder = std::path::PathBuf::from(target);
        let held = folder.clone();
        if blocking(move || remove_when_free(&folder)).await? {
            return Ok(succeeded());
        }
        if let Some(file) = super::left_behind::file()
            && blocking(move || super::left_behind::is_empty_folder(&held)).await?
        {
            let entry = super::left_behind::Entry {
                path: target.to_owned(),
                primary: primary.to_owned(),
            };
            match super::left_behind::record(&file, entry) {
                Ok(()) => {
                    eprintln!(
                        "[left-behind] {target}: removed for git; its empty folder is still some process's working folder and is left for disk care"
                    );
                    return Ok(succeeded());
                }
                Err(error) => eprintln!("[left-behind] {target} not written down: {error}"),
            }
        }
    }
    Ok(output)
}

/// `target` is still there and git no longer lists it as a worktree of `primary`.
#[cfg(windows)]
async fn left_behind(git: &Git, primary: &str, target: &str) -> Result<bool, Fault> {
    let list = git
        .raw(primary, &["worktree", "list", "--porcelain", "-z"])
        .await?;
    if list.code != 0 {
        return Ok(false);
    }
    let listed: Vec<String> = parse::worktree_paths(&list.text())
        .into_iter()
        .map(str::to_owned)
        .collect();
    let target = target.to_owned();
    blocking(move || {
        let Ok(own) = real(&target) else {
            return false;
        };
        !listed
            .iter()
            .any(|path| real(path).is_ok_and(|path| path == own))
    })
    .await
}

/// Removes `folder` (never following a link out of it) once no process holds it, trying until `HELD_FOLDER_MS` ran out:
/// the holder's exit has no event to wait on.
#[cfg(windows)]
fn remove_when_free(folder: &Path) -> bool {
    use std::time::{Duration, Instant};
    let deadline = Instant::now() + Duration::from_millis(HELD_FOLDER_MS);
    let scope = crate::server::Scope::detached();
    loop {
        if crate::disk::tree::remove(folder, false, &scope).is_ok() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// `worktree remove --force` with its own timeout, which a person sees refused with git's reason.
async fn remove_worktree(
    git: &Git,
    primary: &str,
    target: &str,
    timeout_ms: u64,
) -> Result<Output, Fault> {
    let opts = Opts {
        timeout_ms: Some(timeout_ms),
        ..Opts::default()
    };
    git_remove(git, primary, &["--force"], target, opts).await
}

#[derive(Serialize)]
pub struct Removed {
    removed: bool,
}

/// The removal `removal` cleared: the checkout goes, its branch stays, git's list is pruned.
pub async fn remove(
    git: &Git,
    primary: &str,
    path: &str,
    timeout_ms: u64,
) -> Result<Removed, Fault> {
    let removed = remove_worktree(git, primary, path, timeout_ms).await?;
    if removed.code != 0 {
        let reason = js_trim(&removed.stderr);
        let reason = if reason.is_empty() {
            String::new()
        } else {
            format!(" ({reason})")
        };
        return Err(refuse(
            "worktree_remove_failed",
            format!("git worktree remove failed: {path}{reason}"),
        ));
    }
    git.raw(primary, &["worktree", "prune"]).await?;
    Ok(Removed { removed: true })
}

/// A worktree omp's `worktree.onStart` made for a session (main's `LifecycleWorktree`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lifecycle {
    path: String,
    branch: String,
    source_cwd: String,
    base_commit: String,
    root: String,
}

/// Whether `dir` is itself a checkout root (a parent repository does not count).
async fn is_checkout_root(git: &Git, dir: &str) -> Result<bool, Fault> {
    let top = read::repo_root(git, dir).await.ok().flatten();
    let dir = dir.to_owned();
    blocking(move || {
        let (Some(top), Ok(own)) = (top, real(&dir)) else {
            return false;
        };
        real(&top).unwrap_or(top) == own
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    dirty: bool,
    moved: bool,
    off_branch: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExitPolicy {
    Keep,
    Ask,
    Remove,
}

impl ExitPolicy {
    fn action(self, state: &State) -> &'static str {
        match self {
            Self::Keep => "keep",
            Self::Remove if !state.dirty && !state.moved && !state.off_branch => "remove",
            Self::Ask | Self::Remove => "prompt",
        }
    }
}

#[derive(Serialize)]
pub struct Snapshot {
    action: &'static str,
    state: State,
    fingerprint: String,
    present: bool,
}

/// One value per part, each followed by a NUL; only ever compared with this process's own answers.
fn hash_parts(parts: &[String]) -> String {
    let mut hasher = DefaultHasher::new();
    for part in parts {
        hasher.write(part.as_bytes());
        hasher.write_u8(0);
    }
    format!("{:016x}", hasher.finish())
}

/// The worktree's state at a session's exit (stock `snapshotSessionWorktree`) and a fingerprint that changes whenever
/// any file, ref or `HEAD` in it does. A missing worktree is not dirty and not off its branch; a deleted branch has
/// not moved; a missing source repository counts as moved, so the branch is never deleted.
pub async fn snapshot(
    git: &Git,
    worktree: &Lifecycle,
    policy: ExitPolicy,
) -> Result<Snapshot, Fault> {
    let mut moved = true;
    let mut tip = None;
    if read::repo_root(git, &worktree.source_cwd)
        .await
        .ok()
        .flatten()
        .is_some()
    {
        let reference = format!("refs/heads/{}", worktree.branch);
        tip = rev_parse(git, &worktree.source_cwd, &reference).await?;
        moved = tip.as_ref().is_some_and(|tip| *tip != worktree.base_commit);
    }
    let tip = tip.unwrap_or_default();
    if !is_checkout_root(git, &worktree.path).await? {
        let state = State {
            dirty: false,
            moved,
            off_branch: false,
        };
        return Ok(Snapshot {
            action: policy.action(&state),
            state,
            fingerprint: format!("missing\0{tip}"),
            present: false,
        });
    }
    let status = git
        .raw(
            &worktree.path,
            &["status", "--porcelain", "-z", "--untracked-files=all"],
        )
        .await?;
    if status.code != 0 {
        let reason = js_trim(&status.stderr);
        let reason = if reason.is_empty() {
            String::new()
        } else {
            format!(": {reason}")
        };
        return Err(Fault::new(
            "git_exit",
            format!("git status failed in {}{reason}", worktree.path),
        ));
    }
    let status = status.text();
    let head = rev_parse(git, &worktree.path, "HEAD").await?;
    let state = State {
        dirty: !status.is_empty(),
        moved,
        off_branch: head.as_ref().is_some_and(|head| *head != tip),
    };
    let mut parts = vec![head.unwrap_or_default(), tip, status];
    let root = worktree.path.clone();
    // Porcelain codes do not change when an already-modified file is edited again, so each changed path's size and
    // mtime count too.
    let parts = blocking(move || {
        let stated: Vec<String> = parse::status_v1_paths(&parts[2])
            .into_iter()
            .map(|file| {
                let at = Path::new(&root).join(file.as_ref());
                match disk::stat(&at.to_string_lossy()) {
                    Ok(meta) => format!(
                        "{file}:{}:{}",
                        meta.len(),
                        parse::js_number(disk::mtime_ms(&meta))
                    ),
                    Err(_) => format!("{file}:-"),
                }
            })
            .collect();
        parts.extend(stated);
        parts
    })
    .await?;
    Ok(Snapshot {
        action: policy.action(&state),
        state,
        fingerprint: hash_parts(&parts),
        present: true,
    })
}

#[derive(Serialize)]
pub struct SessionRemoval {
    primary: String,
    target: Option<String>,
}

/// A present checkout must pass the same confinement check as a manual removal. A vanished one is only pruned.
pub async fn session_removal(git: &Git, worktree: &Lifecycle) -> Result<SessionRemoval, Fault> {
    let primary = read::primary_root(git, &worktree.source_cwd).await?;
    let target = if is_checkout_root(git, &worktree.path).await? {
        let Some(target) = removable_path(&worktree.root, &worktree.path).await else {
            return Err(refuse(
                "worktree_outside_root",
                format!(
                    "Refusing to remove {}: only worktrees under {} can be removed.",
                    worktree.path, worktree.root
                ),
            ));
        };
        Some(target)
    } else {
        None
    };
    Ok(SessionRemoval { primary, target })
}

/// Force-removes the session worktree at `target` (none when it already vanished: git's list is only pruned) and
/// deletes its branch unless it `moved` (stock `removeSessionWorktree`). `path` and `branch` name it in a refusal.
pub async fn session_remove(
    git: &Git,
    primary: &str,
    path: &str,
    branch: &str,
    target: Option<&str>,
    moved: bool,
    timeout_ms: u64,
) -> Result<(), Fault> {
    let failed = |message: String| refuse("worktree_remove_failed", message);
    if let Some(target) = target
        && remove_worktree(git, primary, target, timeout_ms)
            .await?
            .code
            != 0
    {
        return Err(failed(format!(
            "Failed to remove worktree {path}; branch '{branch}' kept."
        )));
    }
    git.raw(primary, &["worktree", "prune"]).await?;
    if !moved
        && !super::permanent_branch(git, primary, branch).await?
        && git.raw(primary, &["branch", "-D", branch]).await?.code != 0
    {
        return Err(failed(format!(
            "Removed worktree {path} but failed to delete branch '{branch}'."
        )));
    }
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::git::run::tests::git;
    use crate::git::scm::tests::{repo, sh};

    /// omp's service broker takes its omp's working folder and stays about 3 s after the tab's omp exits, so a worktree
    /// removed right after its tab closed is still some process's working folder. The holder here is that process:
    /// its lifetime (`ping` for about 2 s) is the clock being modelled, nothing the test waits out on its own.
    #[tokio::test]
    async fn removes_a_worktree_a_process_still_holds_as_its_working_folder() {
        let primary = repo("held-worktree");
        let tree = primary.with_file_name(format!(
            "{}-tree",
            primary.file_name().unwrap().to_string_lossy()
        ));
        let _ = std::fs::remove_dir_all(&tree);
        sh(
            &primary,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "held",
                tree.to_str().unwrap(),
            ],
        );
        let mut holder = std::process::Command::new("cmd")
            .args(["/c", "ping -n 3 127.0.0.1 >NUL"])
            .current_dir(&tree)
            .spawn()
            .unwrap();
        let removed = remove(
            &git(),
            primary.to_str().unwrap(),
            tree.to_str().unwrap(),
            60_000,
        )
        .await;
        let _ = holder.wait();
        let listed = sh(&primary, &["worktree", "list", "--porcelain"]);
        assert!(
            removed.is_ok(),
            "{:?}; folder left: {}; listed: {listed}",
            removed.as_ref().err().map(|fault| &fault.message),
            tree.exists()
        );
        assert!(!tree.exists());
        assert!(!listed.contains("refs/heads/held"), "{listed}");
        let _ = std::fs::remove_dir_all(&primary);
    }
}

#[cfg(test)]
mod fetch_tests {
    use super::*;
    use crate::git::run::tests::git;
    use crate::git::scm::tests::{repo_at, sh};
    use std::path::PathBuf;

    /// A bare `origin`, a clone of it (so `origin/HEAD` names `origin/main`), and the repository that pushes to it.
    fn remote_and_clone(name: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "ompdesk-core-wt-fetch-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let pusher = dir.join("pusher");
        repo_at(&pusher);
        sh(&dir, &["init", "-q", "--bare", "-b", "main", "origin.git"]);
        sh(&pusher, &["remote", "add", "origin", "../origin.git"]);
        sh(&pusher, &["push", "-q", "origin", "main"]);
        sh(&dir, &["clone", "-q", "origin.git", "clone"]);
        (pusher, dir.join("clone"))
    }

    fn push_commit(pusher: &Path, subject: &str) -> String {
        sh(pusher, &["commit", "-q", "--allow-empty", "-m", subject]);
        sh(pusher, &["push", "-q", "origin", "main"]);
        sh(pusher, &["rev-parse", "HEAD"])
    }

    fn s(path: &Path) -> &str {
        path.to_str().unwrap()
    }

    #[tokio::test]
    async fn only_an_implicit_ompdesk_worker_starts_at_dev() {
        let (pusher, clone) = remote_and_clone("ompdesk-dev");
        assert_eq!(
            plan(&git(), s(&clone), s(&clone).to_owned(), None)
                .await
                .unwrap()
                .start_point,
            "HEAD"
        );
        let canonical = "https://github.com/seuput-inc/ompdesk.git";
        let bare = pusher.parent().unwrap().join("origin.git");
        sh(
            &clone,
            &[
                "config",
                &format!("url.{}.insteadOf", bare.display()),
                canonical,
            ],
        );
        sh(&clone, &["remote", "set-url", "origin", canonical]);
        sh(
            &pusher,
            &["commit", "-q", "--allow-empty", "-m", "dev work"],
        );
        sh(&pusher, &["push", "-q", "origin", "HEAD:dev"]);
        prefetch(&git(), s(&clone)).await.unwrap();
        let made = plan(&git(), s(&clone), s(&clone).to_owned(), None)
            .await
            .unwrap();
        assert_eq!(
            sh(&clone, &["rev-parse", &made.start_point]),
            sh(&pusher, &["rev-parse", "HEAD"])
        );
        assert_eq!(
            plan(&git(), s(&clone), s(&clone).to_owned(), Some("HEAD"))
                .await
                .unwrap()
                .start_point,
            "HEAD"
        );
        sh(&clone, &["branch", "dev", "origin/dev"]);
        let before = sh(&clone, &["rev-parse", "dev"]);
        session_remove(&git(), s(&clone), "unused", "dev", None, false, 30_000)
            .await
            .unwrap();
        assert_eq!(sh(&clone, &["rev-parse", "dev"]), before);
        super::super::branches::drop_landed_remote(&git(), s(&clone), "dev", None)
            .await
            .unwrap();
        assert_eq!(sh(&bare, &["rev-parse", "dev"]), before);
    }

    #[tokio::test]
    async fn a_default_base_starts_at_the_freshly_fetched_tip_and_a_second_plan_reuses_the_fetch() {
        let (pusher, clone) = remote_and_clone("default");
        let fresh = push_commit(&pusher, "fresh work");
        let made = plan(&git(), s(&clone), s(&clone).to_owned(), Some("default"))
            .await
            .unwrap();
        assert_eq!(made.start_point, "origin/main");
        assert_eq!(sh(&clone, &["rev-parse", "origin/main"]), fresh);
        let base = made.base.unwrap();
        assert_eq!(
            (base.reference.as_str(), base.fetched, base.behind),
            ("origin/main", true, 1)
        );
        assert_eq!(base.subjects, ["fresh work"]);
        assert!(base.error.is_none());
        assert_ne!(
            sh(&clone, &["rev-parse", "main"]),
            fresh,
            "the local branch stays where it was"
        );

        push_commit(&pusher, "later work");
        let again = plan(&git(), s(&clone), s(&clone).to_owned(), Some("default"))
            .await
            .unwrap();
        let base = again.base.unwrap();
        assert_eq!((base.fetched, base.behind), (false, 0));
        assert_eq!(sh(&clone, &["rev-parse", "origin/main"]), fresh);
    }

    #[tokio::test]
    async fn a_prefetch_spares_the_create_that_follows_its_fetch() {
        let (pusher, clone) = remote_and_clone("prefetch");
        let fresh = push_commit(&pusher, "fresh work");
        let fetched = prefetch(&git(), s(&clone)).await.unwrap().unwrap();
        assert_eq!((fetched.fetched, fetched.behind), (true, 1));
        let made = plan(&git(), s(&clone), s(&clone).to_owned(), Some("default"))
            .await
            .unwrap();
        let base = made.base.unwrap();
        assert_eq!((base.fetched, base.behind), (false, 0));
        assert_eq!(sh(&clone, &["rev-parse", made.start_point.as_str()]), fresh);
    }

    #[tokio::test]
    async fn a_head_base_never_fetches() {
        let (pusher, clone) = remote_and_clone("head");
        let before = sh(&clone, &["rev-parse", "origin/main"]);
        push_commit(&pusher, "fresh work");
        let made = plan(&git(), s(&clone), s(&clone).to_owned(), None)
            .await
            .unwrap();
        assert_eq!(made.start_point, "HEAD");
        assert!(made.base.is_none());
        assert_eq!(sh(&clone, &["rev-parse", "origin/main"]), before);
    }

    #[tokio::test]
    async fn an_unreachable_origin_is_reported_and_the_plan_goes_on_from_the_local_ref() {
        let (_pusher, clone) = remote_and_clone("unreachable");
        let before = sh(&clone, &["rev-parse", "origin/main"]);
        sh(
            &clone,
            &["remote", "set-url", "origin", "../no-such-origin.git"],
        );
        let made = plan(&git(), s(&clone), s(&clone).to_owned(), Some("default"))
            .await
            .unwrap();
        assert_eq!(made.start_point, "origin/main");
        let base = made.base.unwrap();
        assert!(!base.fetched);
        assert!(base.error.is_some_and(|error| !error.is_empty()));
        assert_eq!(sh(&clone, &["rev-parse", "origin/main"]), before);
    }
}

#[cfg(test)]
mod add_tests {
    use super::*;
    use crate::git::run::tests::runner;
    use crate::git::scm::tests::{repo_at, sh};

    /// A repository with `apps/web`, `docs` and a root file, and its `.ompdesk/sparse` naming `web`.
    fn monorepo(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ompdesk-core-wt-add-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let primary = dir.join("repo");
        repo_at(&primary);
        for file in ["apps/web/a.txt", "docs/b.txt"] {
            let at = primary.join(file);
            std::fs::create_dir_all(at.parent().unwrap()).unwrap();
            std::fs::write(at, "x\n").unwrap();
        }
        sh(&primary, &["add", "-A"]);
        sh(&primary, &["commit", "-qm", "tree"]);
        std::fs::create_dir_all(primary.join(".ompdesk")).unwrap();
        std::fs::write(primary.join(".ompdesk/sparse"), "[web]\napps/web\n").unwrap();
        primary
    }

    fn params(primary: &Path, sparse: Option<&str>, taken: Vec<String>) -> AddParams {
        let primary = primary.to_str().unwrap().to_owned();
        AddParams {
            git: runner(),
            base_cwd: primary.clone(),
            root: Path::new(&primary)
                .with_file_name("wt")
                .to_str()
                .unwrap()
                .into(),
            primary,
            hash: "abc1234".into(),
            slug: "task".into(),
            branch_prefix: "omp/gui/".into(),
            start_point: "HEAD".into(),
            source: None,
            add_timeout_ms: 60_000,
            sparse: sparse.map(str::to_owned),
            taken,
        }
    }

    #[tokio::test]
    async fn a_sparse_preset_checks_out_its_folders_and_a_recorded_folder_is_passed_over() {
        let primary = monorepo("sparse");
        let used = primary.with_file_name("wt").join("gui-task-abc1234");
        let taken = vec![used.to_str().unwrap().to_owned()];
        let added = add(params(&primary, Some("web"), taken), Scope::detached())
            .await
            .unwrap();
        let path = PathBuf::from(&added.path);
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("gui-task-2-abc1234")
        );
        assert_eq!(added.branch, "omp/gui/task-2");
        assert!(path.join("apps/web/a.txt").exists());
        assert!(
            path.join("README.md").exists(),
            "cone mode keeps root files"
        );
        assert!(!path.join("docs").exists());
        assert!(!used.exists());
    }

    #[tokio::test]
    async fn an_unknown_preset_is_refused_before_any_branch_or_folder() {
        let primary = monorepo("unknown");
        let fault = add(params(&primary, Some("api"), Vec::new()), Scope::detached())
            .await
            .err()
            .unwrap();
        assert_eq!(fault.code, "worktree_create_failed");
        assert!(!primary.with_file_name("wt").exists());
        let branches = sh(&primary, &["branch", "--list", "omp/gui/*"]);
        assert!(branches.is_empty(), "{branches}");
    }

    #[tokio::test]
    async fn an_unpublished_branch_takes_its_name_and_a_published_one_keeps_it() {
        let primary = monorepo("rename");
        let tree = primary.with_file_name("tree");
        let tree_path = tree.to_str().unwrap();
        sh(
            &primary,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "omp/gui/task-ab12",
                tree_path,
            ],
        );
        sh(&primary, &["branch", "omp/gui/fix-login"]);
        let git = crate::git::run::tests::git();
        let renamed = rename_unpushed(&git, tree_path, "omp/gui/task-ab12", "omp/gui/fix-login")
            .await
            .unwrap();
        assert_eq!(renamed.as_deref(), Some("omp/gui/fix-login-2"));
        assert_eq!(
            sh(&tree, &["symbolic-ref", "--short", "HEAD"]),
            "omp/gui/fix-login-2"
        );
        let stale = rename_unpushed(&git, tree_path, "omp/gui/task-ab12", "omp/gui/other")
            .await
            .unwrap();
        assert_eq!(stale, None, "a branch no longer out is not renamed");

        sh(
            &primary,
            &[
                "update-ref",
                "refs/remotes/origin/omp/gui/fix-login-2",
                "HEAD",
            ],
        );
        let published = rename_unpushed(&git, tree_path, "omp/gui/fix-login-2", "omp/gui/later")
            .await
            .unwrap();
        assert_eq!(published, None);
        assert_eq!(
            sh(&tree, &["symbolic-ref", "--short", "HEAD"]),
            "omp/gui/fix-login-2"
        );
    }

    #[tokio::test]
    async fn a_named_branch_without_its_own_start_takes_the_create_base() {
        let primary = monorepo("named");
        let older = sh(&primary, &["rev-parse", "HEAD~1"]);
        let mut named = params(&primary, None, Vec::new());
        named.start_point = "HEAD~1".into();
        named.source = Some(Source {
            name: "jinseo/eng-12-fix-login".into(),
            mode: Mode::New,
            remote: None,
            from: None,
        });
        let added = add(named, Scope::detached()).await.unwrap();
        assert_eq!(added.branch, "jinseo/eng-12-fix-login");
        assert_eq!(
            sh(&primary, &["rev-parse", "jinseo/eng-12-fix-login"]),
            older
        );
    }

    #[tokio::test]
    async fn a_push_that_lands_between_the_check_and_the_rename_keeps_the_old_name() {
        let primary = monorepo("rename-race");
        let bare = primary.with_file_name("origin.git");
        sh(&primary, &["init", "-q", "--bare", bare.to_str().unwrap()]);
        sh(
            &primary,
            &["remote", "add", "origin", bare.to_str().unwrap()],
        );
        let tree = primary.with_file_name("tree");
        let tree_path = tree.to_str().unwrap();
        let from = "omp/gui/task-cd34";
        sh(&primary, &["worktree", "add", "-q", "-b", from, tree_path]);
        let git = crate::git::run::tests::git();

        let raced = rename_unpushed_around(&git, tree_path, from, "omp/gui/fix-race", || {
            sh(&tree, &["push", "-q", "-u", "origin", from]);
        })
        .await
        .unwrap();
        assert_eq!(raced, None);
        assert_eq!(sh(&tree, &["symbolic-ref", "--short", "HEAD"]), from);
        assert!(sh(&primary, &["branch", "--list", "omp/gui/fix-race*"]).is_empty());
        assert_eq!(
            sh(&tree, &["rev-parse", "--abbrev-ref", "@{upstream}"]),
            format!("origin/{from}"),
            "the upstream the push set stays with its branch"
        );

        // Published from elsewhere: no upstream and no remote-tracking ref here, only the remote's own branch.
        let other = "omp/gui/task-ef56";
        let other_tree = primary.with_file_name("tree-2");
        let other_path = other_tree.to_str().unwrap();
        sh(
            &primary,
            &["worktree", "add", "-q", "-b", other, other_path],
        );
        sh(
            &primary,
            &["push", "-q", "origin", &format!("{other}:{other}")],
        );
        sh(
            &primary,
            &["update-ref", "-d", &format!("refs/remotes/origin/{other}")],
        );
        let elsewhere = rename_unpushed(&git, other_path, other, "omp/gui/fix-else")
            .await
            .unwrap();
        assert_eq!(elsewhere, None, "ls-remote finds the branch on origin");

        let fresh = "omp/gui/task-gh78";
        let fresh_tree = primary.with_file_name("tree-3");
        let fresh_path = fresh_tree.to_str().unwrap();
        sh(
            &primary,
            &["worktree", "add", "-q", "-b", fresh, fresh_path],
        );
        let renamed = rename_unpushed(&git, fresh_path, fresh, "omp/gui/fix-fresh")
            .await
            .unwrap();
        assert_eq!(renamed.as_deref(), Some("omp/gui/fix-fresh"));
    }

    #[tokio::test]
    async fn a_work_item_started_again_reuses_its_branch_where_a_new_one_is_refused() {
        let primary = monorepo("reuse");
        let named = |mode| {
            let mut params = params(&primary, None, Vec::new());
            params.source = Some(Source {
                name: "jin/lin-12-fix-login".into(),
                mode,
                remote: None,
                from: None,
            });
            params
        };
        let first = add(named(Mode::Reuse), Scope::detached()).await.unwrap();
        let tree = PathBuf::from(&first.path);
        sh(&tree, &["commit", "-q", "--allow-empty", "-m", "work"]);
        let worked = sh(&tree, &["rev-parse", "HEAD"]);
        sh(&primary, &["worktree", "remove", first.path.as_str()]);

        let refused = add(named(Mode::New), Scope::detached())
            .await
            .err()
            .unwrap();
        assert_eq!(refused.code, "worktree_create_failed");
        let again = add(named(Mode::Reuse), Scope::detached()).await.unwrap();
        assert_eq!(again.branch, "jin/lin-12-fix-login");
        assert_eq!(sh(Path::new(&again.path), &["rev-parse", "HEAD"]), worked);
    }
}
