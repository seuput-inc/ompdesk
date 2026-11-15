//! Repository artwork is resolved once on the execution host. Only a small normalized raster crosses transports.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize, Serializer};
use tokio::sync::{Semaphore, watch};

use crate::git::{origin, read, run::Git};
use crate::run::Runner;
use crate::server::{Fault, Registry, Reply, Scope};

mod discovery;
mod raster;

#[cfg(all(test, unix))]
mod test_support;

#[cfg(test)]
mod tests;

const BATCH: usize = 24;
const CACHE: usize = 256;
const KNOWN: Duration = Duration::from_secs(6 * 60 * 60);
const MISSING: Duration = Duration::from_secs(10 * 60);

type Image = Option<Arc<Artwork>>;

#[derive(Serialize)]
pub struct MetadataBatch(HashMap<String, Option<Metadata>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    path: String,
    project: String,
    repository: Option<Repository>,
    #[serde(serialize_with = "serialize_image")]
    image: Image,
}

fn serialize_image<S: Serializer>(image: &Image, serializer: S) -> Result<S::Ok, S::Error> {
    image.as_deref().serialize(serializer)
}

#[derive(Serialize)]
struct Repository {
    root: String,
    head: Head,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Head {
    Branch { name: String },
    Detached { sha: String },
    Unborn { name: String },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Artwork {
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
    #[cfg(test)]
    image_waiting: tokio::sync::Notify,
}

impl Default for Service {
    fn default() -> Self {
        Self {
            cache: Mutex::new(Cache::default()),
            slots: Arc::new(Semaphore::new(4)),
            #[cfg(test)]
            image_waiting: tokio::sync::Notify::new(),
        }
    }
}

impl Service {
    async fn metadata(
        self: &Arc<Self>,
        git: &Git,
        input: &str,
        runner: &Runner,
    ) -> Option<Metadata> {
        let permit = self.slots.acquire().await.ok()?;
        let path = tokio::fs::canonicalize(input).await.ok()?;
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
        let checkout = tokio::fs::canonicalize(checkout).await.ok()?;
        let checkout = checkout.to_str()?;
        let (facts, sha) = tokio::join!(
            origin::facts(git, checkout, 3000),
            read::head_sha(git, checkout),
        );
        let facts = facts?;
        let branch = facts.branch().map(str::to_owned);
        let sha = sha.ok()?;
        let head = match (branch.as_deref(), sha.as_deref()) {
            (Some(name), Some(_)) => Head::Branch {
                name: name.to_owned(),
            },
            (Some(name), None) => Head::Unborn {
                name: name.to_owned(),
            },
            (None, Some(sha)) => Head::Detached {
                sha: sha.to_owned(),
            },
            (None, None) => return None,
        };
        let root = facts.project_root(git, 3000).await?;
        let project = root.file_name()?.to_string_lossy().into_owned();
        let repository = Some(Repository {
            root: root.to_str()?.to_owned(),
            head,
        });
        drop(permit);
        let image = self.image(root.clone(), runner).await;
        // Discovery may wait on public I/O. Reject a checkout/head replacement instead of attaching its old facts
        // to a completed image. No retries or current-target reselection occur here.
        let _permit = self.slots.acquire().await.ok()?;
        let current_path = tokio::fs::canonicalize(input).await.ok()?;
        if current_path != path {
            return None;
        }
        let (current_checkout, current_facts, current_sha) = tokio::join!(
            read::repo_root(git, cwd),
            origin::facts(git, checkout, 3000),
            read::head_sha(git, checkout),
        );
        let current_checkout = tokio::fs::canonicalize(current_checkout.ok()??)
            .await
            .ok()?;
        let current_facts = current_facts?;
        let current_root = current_facts.project_root(git, 3000).await?;
        if current_checkout.to_str()? != checkout
            || current_root != root
            || current_facts.branch() != branch.as_deref()
            || current_sha.ok()? != sha
        {
            return None;
        }
        Some(Metadata {
            path: checkout.to_owned(),
            project,
            repository,
            image,
        })
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
                    let remote = git
                        .capped(
                            &root.to_string_lossy(),
                            &["config", "--get", "remote.origin.url"],
                            4096,
                        )
                        .await
                        .ok()
                        .filter(|output| output.code == 0 && !output.truncated)
                        .map(|output| output.text());
                    let image = tokio::time::timeout(
                        Duration::from_secs(10),
                        discovery::discover(&root, remote.as_deref().map(str::trim)),
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
        #[cfg(test)]
        self.image_waiting.notify_one();
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
        paths: Vec<String>,
        mut runner: Runner,
        scope: Scope,
    ) -> Result<MetadataBatch, Fault> {
        if paths.len() > BATCH
            || paths
                .iter()
                .any(|path| path.len() > 4096 || !Path::new(path).is_absolute())
        {
            return Err(Fault::new(
                "invalid_params",
                "Project metadata needs at most 24 absolute checkout paths",
            ));
        }
        runner.timeout_ms = runner.timeout_ms.min(3000);
        runner.max_bytes = runner.max_bytes.min(4096);
        let git = Git::new(runner.clone(), scope.clone());
        let paths: std::collections::HashSet<_> = paths.into_iter().collect();
        let results = futures_util::future::join_all(paths.into_iter().map(|path| {
            let git = &git;
            let runner = &runner;
            let scope = &scope;
            async move {
                if scope.cancelled() {
                    return Err(Fault::cancelled());
                }
                // Metadata and artwork share a bounded work pool, never holding one permit while waiting for another.
                let metadata = self.metadata(git, &path, runner).await;
                if scope.cancelled() {
                    return Err(Fault::cancelled());
                }
                Ok((path, metadata))
            }
        }))
        .await;
        let metadata: Result<HashMap<_, _>, _> = results.into_iter().collect();
        metadata.map(MetadataBatch)
    }
}

#[derive(Deserialize)]
struct Batch {
    paths: Vec<String>,
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
            let images = service.batch(batch.paths, batch.git, request.scope).await?;
            Reply::json(&images)
        })
    });
}
