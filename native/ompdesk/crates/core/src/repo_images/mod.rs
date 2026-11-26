//! What a session works in, resolved on the computer that runs it (`src/shared/session-target.ts`): the repository's
//! main checkout, the checkout's own HEAD and the repository's image. `projectMetadata.get` answers from git and the
//! image cache only, so a list never waits on the network; `projectArtwork.get` looks images up, bounded and cached.
//! Only a small normalized raster crosses transports.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize, Serializer};
use tokio::sync::{Semaphore, watch};

use crate::fs::disk::real;
use crate::git::{origin, read, run::Git};
use crate::run::Runner;
use crate::server::{Fault, Registry, Reply, Scope};

mod discovery;
// The page's tag reader, shared with the link card's page reader (`web_peek`).
pub(crate) use discovery::{attribute, tags};
mod raster;
mod worked;

#[cfg(test)]
mod test_support;

#[cfg(test)]
mod tests;

const BATCH: usize = 24;
const CACHE: usize = 256;
const KNOWN: Duration = Duration::from_secs(6 * 60 * 60);
const MISSING: Duration = Duration::from_secs(10 * 60);
const GIT_MS: u64 = 3000;

type Image = Option<Arc<Artwork>>;

#[derive(Serialize)]
pub struct MetadataBatch(HashMap<String, Option<Metadata>>);

#[derive(Serialize)]
pub struct ArtworkBatch(HashMap<String, Option<Artwork>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    path: String,
    project: String,
    repository: Option<Repository>,
    /// Absent: not looked up yet (`projectArtwork.get`); null: the repository has none.
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_known"
    )]
    image: Option<Image>,
}

fn serialize_known<S: Serializer>(image: &Option<Image>, serializer: S) -> Result<S::Ok, S::Error> {
    image
        .as_ref()
        .and_then(Option::as_deref)
        .serialize(serializer)
}

#[derive(Serialize)]
struct Repository {
    root: String,
    head: Head,
    #[serde(skip_serializing_if = "Option::is_none")]
    owner: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Head {
    Branch { name: String },
    Detached { commit: String },
    Unborn { name: String },
}

#[derive(Clone, Serialize)]
pub struct Artwork {
    #[serde(rename = "src")]
    pub data_url: String,
    pub source: Source,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Repository,
    Homepage,
    Owner,
}

struct Cached {
    until: Instant,
    image: Image,
}
#[derive(Default)]
struct Cache {
    images: HashMap<PathBuf, Cached>,
    loading: HashMap<PathBuf, watch::Receiver<Option<Image>>>,
}

pub struct Service {
    cache: Mutex<Cache>,
    slots: Arc<Semaphore>,
}

impl Default for Service {
    fn default() -> Self {
        Self {
            cache: Mutex::new(Cache::default()),
            slots: Arc::new(Semaphore::new(4)),
        }
    }
}

/// `origin`'s URL, when git answers it whole.
async fn remote_url(git: &Git, root: &Path) -> Option<String> {
    git.capped(
        &root.to_string_lossy(),
        &["config", "--get", "remote.origin.url"],
        4096,
    )
    .await
    .ok()
    .filter(|output| output.code == 0 && !output.truncated)
    .map(|output| output.text().trim().to_owned())
}

/// The main checkout `path` (canonical) belongs to, when it is that repository's root.
async fn repository_root(git: &Git, path: &Path) -> Option<PathBuf> {
    let checkout = read::repo_root(git, path.to_str()?).await.ok()??;
    let facts = origin::facts(git, &checkout, GIT_MS).await?;
    let root = facts.project_root(git, GIT_MS).await?;
    (root == path).then_some(root)
}

impl Service {
    /// Git's facts of one folder and the image cached for its repository; never waits on an image.
    async fn metadata(&self, git: &Git, input: &str) -> Option<Metadata> {
        let _permit = self.slots.acquire().await.ok()?;
        let path = real(input).await?;
        if !tokio::fs::metadata(&path).await.ok()?.is_dir() {
            return None;
        }
        let cwd = path.to_str()?;
        let project = path.file_name()?.to_string_lossy().into_owned();
        // No child-directory search. Head facts belong to this checkout, while artwork belongs to its main repository.
        let Some(checkout) = read::repo_root(git, cwd).await.ok()? else {
            return Some(Metadata {
                path: cwd.to_owned(),
                project,
                repository: None,
                image: None,
            });
        };
        let checkout = real(checkout).await?;
        let checkout = checkout.to_str()?;
        let (facts, sha) = tokio::join!(
            origin::facts(git, checkout, GIT_MS),
            read::head_sha(git, checkout),
        );
        let facts = facts?;
        let head = match (facts.branch(), sha.ok()?) {
            (Some(name), Some(_)) => Head::Branch {
                name: name.to_owned(),
            },
            (Some(name), None) => Head::Unborn {
                name: name.to_owned(),
            },
            (None, Some(commit)) => Head::Detached { commit },
            (None, None) => return None,
        };
        let root = facts.project_root(git, GIT_MS).await?;
        let owner = remote_url(git, &root)
            .await
            .as_deref()
            .and_then(discovery::github_owner);
        Some(Metadata {
            path: checkout.to_owned(),
            project: root.file_name()?.to_string_lossy().into_owned(),
            image: self.cached(&root),
            repository: Some(Repository {
                root: root.to_str()?.to_owned(),
                head,
                owner,
            }),
        })
    }

    /// A session's folder, or, when that folder is in no repository, the repository its tool calls last worked in
    /// below it.
    async fn target(&self, git: &Git, target: &Target) -> Option<Metadata> {
        let found = self.metadata(git, &target.path).await?;
        let Some(session) = target.session.as_deref() else {
            return Some(found);
        };
        if found.repository.is_some() {
            return Some(found);
        }
        for folder in worked::worked_folders(Path::new(session), Path::new(&found.path)).await {
            let Some(folder) = folder.to_str() else {
                continue;
            };
            if let Some(worked) = self.metadata(git, folder).await
                && worked.repository.is_some()
            {
                return Some(worked);
            }
        }
        Some(found)
    }

    /// The image cached for `root`: absent while it was never looked up or its entry expired.
    fn cached(&self, root: &Path) -> Option<Image> {
        let cache = self.cache.lock().unwrap_or_else(|error| error.into_inner());
        cache
            .images
            .get(root)
            .filter(|cached| cached.until > Instant::now())
            .map(|cached| cached.image.clone())
    }

    async fn image(self: &Arc<Self>, root: PathBuf, runner: &Runner) -> Image {
        let mut waiting = {
            let mut cache = self.cache.lock().unwrap_or_else(|error| error.into_inner());
            if let Some(cached) = cache.images.get(&root)
                && cached.until > Instant::now()
            {
                return cached.image.clone();
            }
            if let Some(waiting) = cache.loading.get(&root) {
                waiting.clone()
            } else {
                if cache.loading.len() >= 32 {
                    return None;
                }
                let (done, waiting) = watch::channel(None);
                cache.loading.insert(root.clone(), waiting.clone());
                let service = Arc::clone(self);
                let runner = runner.clone();
                tokio::spawn(async move {
                    let _slot = service.slots.acquire().await.ok();
                    let git = Git::new(runner, Scope::detached());
                    let remote = remote_url(&git, &root).await;
                    let image = tokio::time::timeout(
                        // Homepage 4 s, GitHub's social preview 3 s, the owner's avatar 4 s, and a second to spare.
                        Duration::from_secs(12),
                        discovery::discover(&root, remote.as_deref()),
                    )
                    .await
                    .ok()
                    .flatten()
                    .map(Arc::new);
                    let mut cache = service
                        .cache
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    if cache.images.len() >= CACHE
                        && let Some(oldest) = cache
                            .images
                            .iter()
                            .min_by_key(|(_, value)| value.until)
                            .map(|(key, _)| key.clone())
                    {
                        cache.images.remove(&oldest);
                    }
                    cache.images.insert(
                        root.clone(),
                        Cached {
                            until: Instant::now() + if image.is_some() { KNOWN } else { MISSING },
                            image: image.clone(),
                        },
                    );
                    cache.loading.remove(&root);
                    done.send_replace(Some(image));
                });
                waiting
            }
        };
        loop {
            if let Some(image) = waiting.borrow_and_update().clone() {
                return image;
            }
            if waiting.changed().await.is_err() {
                return None;
            }
        }
    }

    pub async fn batch(
        self: &Arc<Self>,
        targets: Vec<Target>,
        runner: Runner,
        scope: Scope,
    ) -> Result<MetadataBatch, Fault> {
        if targets.len() > BATCH
            || targets.iter().any(|target| {
                !absolute(&target.path)
                    || target
                        .session
                        .as_deref()
                        .is_some_and(|session| !absolute(session) || !session.ends_with(".jsonl"))
            })
        {
            return Err(Fault::new(
                "invalid_params",
                "Project metadata needs at most 24 targets, each an absolute folder and an optional .jsonl session",
            ));
        }
        let git = Git::new(bounded(runner), scope.clone());
        let results = futures_util::future::join_all(targets.into_iter().map(|target| {
            let git = &git;
            let scope = &scope;
            async move {
                if scope.cancelled() {
                    return Err(Fault::cancelled());
                }
                let metadata = self.target(git, &target).await;
                if scope.cancelled() {
                    return Err(Fault::cancelled());
                }
                Ok((target.key, metadata))
            }
        }))
        .await;
        let metadata: Result<HashMap<_, _>, _> = results.into_iter().collect();
        metadata.map(MetadataBatch)
    }

    /// Each root's image, looked up where it is not cached. A path that is not a repository's main checkout gets
    /// none: a caller names roots `projectMetadata.get` gave it, never a folder to read pictures from.
    pub async fn artwork(
        self: &Arc<Self>,
        roots: Vec<String>,
        runner: Runner,
        scope: Scope,
    ) -> Result<ArtworkBatch, Fault> {
        if roots.len() > BATCH || roots.iter().any(|root| !absolute(root)) {
            return Err(Fault::new(
                "invalid_params",
                "Project artwork needs at most 24 absolute repository roots",
            ));
        }
        let runner = bounded(runner);
        let git = Git::new(runner.clone(), scope.clone());
        let results = futures_util::future::join_all(roots.into_iter().map(|input| {
            let git = &git;
            let runner = &runner;
            let scope = &scope;
            async move {
                if scope.cancelled() {
                    return Err(Fault::cancelled());
                }
                let root = match real(&input).await {
                    Some(path) => {
                        let _permit = self.slots.acquire().await.ok();
                        repository_root(git, &path).await
                    }
                    None => None,
                };
                let image = match root {
                    Some(root) => self.image(root, runner).await,
                    None => None,
                };
                if scope.cancelled() {
                    return Err(Fault::cancelled());
                }
                Ok((input, image.as_deref().cloned()))
            }
        }))
        .await;
        let images: Result<HashMap<_, _>, _> = results.into_iter().collect();
        images.map(ArtworkBatch)
    }
}

fn absolute(path: &str) -> bool {
    path.len() <= 4096 && Path::new(path).is_absolute()
}

fn bounded(mut runner: Runner) -> Runner {
    runner.timeout_ms = runner.timeout_ms.min(GIT_MS);
    runner.max_bytes = runner.max_bytes.min(4096);
    runner
}

/// One folder to resolve, answered under `key`; `session` is its journal, read only when the folder is in no
/// repository.
#[derive(Deserialize)]
pub struct Target {
    key: String,
    path: String,
    #[serde(default)]
    session: Option<String>,
}

#[derive(Deserialize)]
struct Batch {
    targets: Vec<Target>,
    git: Runner,
}

#[derive(Deserialize)]
struct Roots {
    roots: Vec<String>,
    git: Runner,
}

static SERVICE: std::sync::LazyLock<Arc<Service>> =
    std::sync::LazyLock::new(|| Arc::new(Service::default()));

pub(crate) fn shared() -> Arc<Service> {
    Arc::clone(&SERVICE)
}

pub fn register(registry: &mut Registry) {
    registry.add("projectMetadata.get", |request| {
        let service = shared();
        Box::pin(async move {
            let batch: Batch = request.params()?;
            let targets = service
                .batch(batch.targets, batch.git, request.scope)
                .await?;
            Reply::json(&targets)
        })
    });
    registry.add("projectArtwork.get", |request| {
        let service = shared();
        Box::pin(async move {
            let batch: Roots = request.params()?;
            let images = service
                .artwork(batch.roots, batch.git, request.scope)
                .await?;
            Reply::json(&images)
        })
    });
}
