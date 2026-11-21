//! The existing history.json and v<N> files. Tab membership comes from the window host.
#[cfg(test)]
mod tests;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::disk::{
    saves::{Saves, waiting_content, write_kept},
    tree::{fault, write_atomic_if},
};
use crate::server::{Fault, Registry, Reply};

const MAX_VERSIONS: usize = 20;
const MAX_RECORDS: usize = 100;

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    File,
    Inline,
    Url,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Version {
    version: u64,
    created_at: u64,
    file: String,
    hash: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    id: String,
    label: String,
    kind: Kind,
    target: String,
    cwd: String,
    root: PathBuf,
    entry: String,
    created_at: u64,
    updated_at: u64,
    versions: Vec<Version>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    retired: Vec<Retired>,
}

#[derive(Deserialize, Serialize)]
struct Retired {
    id: String,
    files: Vec<String>,
}

pub(super) fn valid_id(id: &str) -> bool {
    id.len() == 16
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

struct Catalog {
    dir: PathBuf,
    records: Vec<Record>,
}
static CATALOG: Mutex<Option<Catalog>> = Mutex::new(None);

async fn with_catalog<T: Send + 'static>(
    dir: PathBuf,
    op: impl FnOnce(&mut Catalog) -> Result<T, Fault> + Send + 'static,
) -> Result<T, Fault> {
    tokio::task::spawn_blocking(move || {
        let mut slot = CATALOG
            .lock()
            .map_err(|_| Fault::new("internal", "Visual catalog lock poisoned"))?;
        if let Some(catalog) = &mut *slot
            && catalog.dir == dir
        {
            return op(catalog);
        }
        let file = dir.join("history.json");
        let waiting = waiting_content(&file);
        let durable = waiting.is_none();
        let records = match waiting.map_or_else(|| fs::read(&file), Ok) {
            Ok(bytes) => serde_json::from_slice::<Vec<Record>>(&bytes)
                .ok()
                .filter(|records| {
                    records.iter().all(|r| {
                        valid_id(&r.id)
                            && r.versions.iter().all(|v| {
                                v.file.is_empty()
                                    || Path::new(&v.file)
                                        .file_name()
                                        .and_then(|name| name.to_str())
                                        == Some(&v.file)
                            })
                    })
                })
                .unwrap_or_default(),
            Err(e) if e.kind() == ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(fault(&e, "read", &file)),
        };
        let catalog = slot.insert(Catalog { dir, records });
        if durable {
            catalog.prune();
        }
        op(catalog)
    })
    .await
    .map_err(|e| Fault::new("internal", e.to_string()))?
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Input {
    File { raw: String, path: PathBuf },
    Inline,
    Url { url: String, host: String },
}

struct Page {
    kind: Kind,
    target: String,
    root: PathBuf,
    entry: String,
    label: String,
    content: Option<Vec<u8>>,
}

impl Input {
    async fn prepare(self, cwd: &str, bin: Option<Vec<u8>>) -> Result<Page, Fault> {
        let mut page = Page {
            kind: Kind::Inline,
            target: String::new(),
            root: PathBuf::new(),
            entry: "index.html".into(),
            label: String::new(),
            content: None,
        };
        match self {
            Self::Inline => {
                let bytes = bin.ok_or_else(|| Fault::new("visual", "Missing inline HTML"))?;
                if bytes.len() > 2 * 1024 * 1024 {
                    return Err(Fault::new("visual", "html is larger than 2 MB"));
                }
                page.content = Some(bytes);
                page.label = "Visual".into();
            }
            Self::File { raw, path } => {
                let (target, root, entry, bytes) = super::source(cwd, &raw, &path).await?;
                page.kind = Kind::File;
                page.label = target
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned();
                page.target = target.to_string_lossy().into_owned();
                page.root = root;
                page.entry = entry;
                page.content = Some(bytes);
            }
            Self::Url { url, host } => {
                page.kind = Kind::Url;
                page.target = url;
                page.label = host;
            }
        }
        Ok(page)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Open {
    cwd: String,
    label: Option<String>,
    visual: Option<String>,
    tab_ids: Vec<String>,
    tab_limit: usize,
}

fn snapshot_folder(dir: &Path, id: &str) -> Result<PathBuf, Fault> {
    fs::create_dir_all(dir).map_err(|e| fault(&e, "mkdir", dir))?;
    let folder = dir.join(id);
    match fs::create_dir(&folder) {
        Err(e) if e.kind() == ErrorKind::AlreadyExists => {
            if !fs::symlink_metadata(&folder)
                .map_err(|e| fault(&e, "lstat", &folder))?
                .is_dir()
            {
                return Err(Fault::new(
                    "visual",
                    "Visual snapshot folder is not a directory",
                ));
            }
        }
        Err(e) => return Err(fault(&e, "mkdir", &folder)),
        Ok(()) => (),
    }
    Ok(folder)
}

impl Catalog {
    fn open(
        &mut self,
        p: Open,
        page: Page,
        save: impl FnOnce(&Path, &[u8]) -> Result<bool, Fault>,
    ) -> Result<Reply, Fault> {
        let own = || {
            p.tab_ids
                .iter()
                .filter_map(|id| self.records.iter().position(|r| r.id == *id))
        };
        let existing = p
            .visual
            .as_ref()
            .and_then(|id| own().find(|&i| self.records[i].id == *id))
            .or_else(|| {
                own().find(|&i| {
                    let r = &self.records[i];
                    r.kind == page.kind
                        && if page.kind == Kind::Inline {
                            p.label.as_ref() == Some(&r.label)
                        } else {
                            r.target == page.target
                        }
                })
            });
        let now = crate::clock::now_ms();
        enum Selected {
            Existing(usize),
            New(String),
        }
        let selected = if let Some(i) = existing {
            let r = &self.records[i];
            if r.kind != page.kind {
                return Err(Fault::new(
                    "visual",
                    format!("Visual {} shows a different kind of target", r.id),
                ));
            }
            Selected::Existing(i)
        } else {
            if let Some(id) = p.visual {
                return Err(Fault::new("visual", format!("No visual {id} in this tab")));
            }
            if own().count() >= p.tab_limit {
                return Err(Fault::new(
                    "visual",
                    format!(
                        "This tab already shows {} visuals; close one first",
                        p.tab_limit
                    ),
                ));
            }
            let mut bytes = [0; 8];
            crate::sys::random(&mut bytes).map_err(|e| Fault::new("visual", e.to_string()))?;
            Selected::New(crate::hex(&bytes))
        };
        let (id, previous) = match &selected {
            Selected::Existing(i) => (&self.records[*i].id, Some(&self.records[*i])),
            Selected::New(id) => (id, None),
        };
        let last = previous.and_then(|r| r.versions.last());
        let digest = page
            .content
            .as_ref()
            .map(|b| crate::hex(&Sha256::digest(b)));
        let hash = digest.as_deref().unwrap_or(&page.target);
        let added = last.is_none_or(|v| v.hash != hash)
            || previous.is_some_and(|r| r.target != page.target);
        let mut number = last.map_or(0, |v| v.version);
        let version = if added {
            number = number
                .checked_add(1)
                .ok_or_else(|| Fault::new("visual", "Invalid visual version"))?;
            let mut file = String::new();
            if let Some(bytes) = page.content {
                let folder = snapshot_folder(&self.dir, id)?;
                let ext = Path::new(&page.entry)
                    .extension()
                    .unwrap_or_default()
                    .to_string_lossy();
                file = format!("v{number}.{}", ext.to_ascii_lowercase());
                write_atomic_if(&folder.join(&file), &bytes, None, 0o777, &|| true)?;
            }
            Some(Version {
                version: number,
                created_at: now,
                file,
                hash: digest.unwrap_or_else(|| page.target.clone()),
            })
        } else {
            None
        };
        let mut retired = self
            .records
            .first_mut()
            .map(|r| std::mem::take(&mut r.retired))
            .unwrap_or_default();
        let mut record = match selected {
            Selected::Existing(i) => self.records.remove(i),
            Selected::New(id) => Record {
                root: if page.kind == Kind::Inline {
                    self.dir.join(&id)
                } else {
                    PathBuf::new()
                },
                id,
                label: page.label,
                kind: page.kind,
                target: String::new(),
                cwd: p.cwd,
                entry: String::new(),
                created_at: now,
                updated_at: now,
                versions: Vec::new(),
                retired: Vec::new(),
            },
        };
        if let Some(label) = p.label {
            record.label = label;
        }
        if record.kind == Kind::File {
            record.root = page.root;
        }
        record.entry = page.entry;
        record.target = page.target;
        record.updated_at = now;
        let mut pruned = Vec::new();
        if let Some(v) = version {
            if record.kind == Kind::Url {
                record.versions.clear();
            }
            record.versions.push(v);
            let surplus = record.versions.len().saturating_sub(MAX_VERSIONS);
            pruned.extend(record.versions.drain(..surplus).map(|v| v.file));
        }
        if !pruned.is_empty() {
            retired.push(Retired {
                id: record.id.clone(),
                files: pruned,
            });
        }
        self.records.insert(0, record);
        let evicted = if self.records.len() > MAX_RECORDS {
            self.records.split_off(MAX_RECORDS)
        } else {
            Vec::new()
        };
        for r in &evicted {
            if !r.versions.iter().all(|v| v.file.is_empty()) {
                retired.push(Retired {
                    id: r.id.clone(),
                    files: r
                        .versions
                        .iter()
                        .filter(|v| !v.file.is_empty())
                        .map(|v| v.file.clone())
                        .collect(),
                });
            }
        }
        self.records[0].retired = retired;
        let bytes =
            serde_json::to_vec(&self.records).map_err(|e| Fault::new("internal", e.to_string()))?;
        if save(&self.dir.join("history.json"), &bytes)? {
            self.prune();
        }
        let record = &self.records[0];
        #[derive(Serialize)]
        struct Opened<'a> {
            record: &'a Record,
            version: u64,
            added: bool,
            evicted: Vec<&'a str>,
        }
        Reply::json(&Opened {
            record,
            version: number,
            added,
            evicted: evicted.iter().map(|r| r.id.as_str()).collect(),
        })
    }
}

impl Catalog {
    fn prune(&mut self) {
        let Some(head) = self.records.first_mut() else {
            return;
        };
        let mut retired = std::mem::take(&mut head.retired);
        retired.retain(|batch| match self.remove_retired(batch) {
            Ok(removed) => !removed,
            Err(error) => {
                eprintln!("ompdesk-core: visual cleanup: {}", error.message);
                true
            }
        });
        self.records[0].retired = retired;
    }

    fn remove_retired(&self, batch: &Retired) -> Result<bool, Fault> {
        if !valid_id(&batch.id) {
            return Ok(true);
        }
        let folder = self.dir.join(&batch.id);
        match fs::symlink_metadata(&folder) {
            Ok(meta) if !meta.is_dir() => return Ok(true),
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(true),
            Err(e) => return Err(fault(&e, "lstat", &folder)),
            Ok(_) => (),
        }
        let real_folder = fs::canonicalize(&folder).map_err(|e| fault(&e, "realpath", &folder))?;
        let folder = PathBuf::from(crate::fs::disk::spelled(&real_folder));
        let mut removed = true;
        for name in &batch.files {
            let Some((number, ext)) = name.strip_prefix('v').and_then(|name| name.split_once('.'))
            else {
                continue;
            };
            if number.is_empty()
                || !number.bytes().all(|n| n.is_ascii_digit())
                || !ext.bytes().all(|b| b.is_ascii_alphanumeric())
                || super::mime(Path::new(name), false).is_none()
            {
                continue;
            }
            let path = folder.join(name);
            if self.records.iter().any(|r| {
                (r.id == batch.id && r.versions.iter().any(|v| v.file.eq_ignore_ascii_case(name)))
                    || (r.kind == Kind::File
                        && Path::new(&r.target)
                            .as_os_str()
                            .eq_ignore_ascii_case(path.as_os_str()))
            }) {
                removed = false;
                continue;
            }
            remove_if_exists(fs::remove_file(&path), &path)?;
        }
        if !self.records.iter().any(|r| r.id == batch.id)
            && let Err(e) = fs::remove_dir(&folder)
            && !matches!(e.kind(), ErrorKind::NotFound | ErrorKind::DirectoryNotEmpty)
        {
            return Err(fault(&e, "rmdir", &folder));
        }
        Ok(removed)
    }

    fn retry_landed(&mut self, file: &Path, bytes: &[u8], waiting: bool) {
        if !waiting
            && self.records.first().is_some_and(|r| !r.retired.is_empty())
            && serde_json::to_vec(&self.records).ok().as_deref() == Some(bytes)
            && fs::read(file).ok().as_deref() == Some(bytes)
        {
            self.prune();
        }
    }
}

// A retry releases the saves lock first: opens hold the catalog lock before they write.
pub(crate) fn saved_after_retry(file: &Path, bytes: &[u8], saves: &Saves) {
    if file.file_name().is_none_or(|name| name != "history.json") {
        return;
    }
    if let Ok(mut slot) = CATALOG.lock()
        && let Some(catalog) = slot.as_mut()
        && file.parent() == Some(&catalog.dir)
    {
        catalog.retry_landed(file, bytes, saves.waiting_for_space(file));
    }
}

fn remove_if_exists(result: std::io::Result<()>, path: &Path) -> Result<(), Fault> {
    match result {
        Err(e) if e.kind() != ErrorKind::NotFound => Err(fault(&e, "rm", path)),
        _ => Ok(()),
    }
}

#[derive(Deserialize)]
struct FileQuery {
    dir: PathBuf,
    id: String,
    version: Option<u64>,
    relative: String,
    bytes: bool,
}

async fn file(p: FileQuery) -> Result<Reply, Fault> {
    let selected = with_catalog(p.dir, move |catalog| {
        let Some(r) = catalog
            .records
            .iter()
            .find(|r| r.id == p.id && r.kind != Kind::Url)
        else {
            return Ok(None);
        };
        let location = if p.relative == r.entry {
            let Some(v) = r
                .versions
                .iter()
                .find(|v| Some(v.version) == p.version && !v.file.is_empty())
            else {
                return Ok(None);
            };
            super::Location::Snapshot {
                dir: catalog.dir.clone(),
                id: p.id,
                file: v.file.clone(),
            }
        } else if r.kind == Kind::File {
            super::Location::Asset {
                root: r.root.clone(),
                relative: p.relative,
            }
        } else {
            return Ok(None);
        };
        Ok(Some(super::Request {
            entry: PathBuf::from(&r.entry),
            location,
        }))
    })
    .await?;
    match selected {
        Some(selected) => super::file(selected, p.bytes).await,
        None => Reply::json(&None::<()>),
    }
}

pub(crate) fn register(registry: &mut Registry) {
    registry.add("visual.file", |call| {
        Box::pin(async move { file(call.params()?).await })
    });
    #[derive(Deserialize)]
    struct Directory {
        dir: PathBuf,
    }
    registry.add("visual.history", |call| {
        Box::pin(async move {
            with_catalog(call.params::<Directory>()?.dir, |c| Reply::json(&c.records)).await
        })
    });
    #[derive(Deserialize)]
    struct Request {
        dir: PathBuf,
        input: Input,
        #[serde(flatten)]
        open: Open,
    }
    registry.add("visual.open", |call| {
        Box::pin(async move {
            let p: Request = call.params()?;
            let page = p.input.prepare(&p.open.cwd, call.bin).await?;
            with_catalog(p.dir, move |c| {
                c.open(p.open, page, |file, bytes| {
                    write_kept(file, bytes, None, 0o777)
                })
            })
            .await
        })
    });
}
