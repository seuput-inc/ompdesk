//! The existing history.json and v<N> files. Tab membership comes from the window host.
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::disk::{
    saves::write_kept,
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

async fn with_catalog(
    dir: PathBuf,
    op: impl FnOnce(&mut Catalog) -> Result<Reply, Fault> + Send + 'static,
) -> Result<Reply, Fault> {
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
        let records = match fs::read(&file) {
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
        op(slot.insert(Catalog { dir, records }))
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
    fn open(&mut self, p: Open, page: Page) -> Result<Reply, Fault> {
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
            New(Record),
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
            let id = crate::hex(&bytes);
            let root = if page.kind == Kind::Inline {
                self.dir.join(&id)
            } else {
                PathBuf::new()
            };
            Selected::New(Record {
                id,
                label: page.label,
                kind: page.kind,
                target: String::new(),
                cwd: p.cwd,
                root,
                entry: String::new(),
                created_at: now,
                updated_at: now,
                versions: Vec::new(),
            })
        };
        let record = match &selected {
            Selected::Existing(i) => &self.records[*i],
            Selected::New(record) => record,
        };
        let last = record.versions.last();
        let digest = page
            .content
            .as_ref()
            .map(|b| crate::hex(&Sha256::digest(b)));
        let hash = digest.as_deref().unwrap_or(&page.target);
        let added = last.is_none_or(|v| v.hash != hash) || record.target != page.target;
        let mut number = last.map_or(0, |v| v.version);
        let version = if added {
            number = number
                .checked_add(1)
                .ok_or_else(|| Fault::new("visual", "Invalid visual version"))?;
            let mut file = String::new();
            if let Some(bytes) = page.content {
                let folder = snapshot_folder(&self.dir, &record.id)?;
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
        let mut record = match selected {
            Selected::Existing(i) => self.records.remove(i),
            Selected::New(record) => record,
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
        self.records.insert(0, record);
        let evicted = if self.records.len() > MAX_RECORDS {
            self.records.split_off(MAX_RECORDS)
        } else {
            Vec::new()
        };
        let bytes =
            serde_json::to_vec(&self.records).map_err(|e| Fault::new("internal", e.to_string()))?;
        write_kept(&self.dir.join("history.json"), &bytes, None, 0o777)?;
        let record = &self.records[0];
        if !pruned.is_empty() {
            let folder = snapshot_folder(&self.dir, &record.id)?;
            for file in pruned {
                if !file.is_empty() {
                    let path = folder.join(file);
                    remove_if_exists(fs::remove_file(&path), &path)?;
                }
            }
        }
        for r in &evicted {
            let path = self.dir.join(&r.id);
            remove_if_exists(fs::remove_dir_all(&path), &path)?;
        }
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
fn remove_if_exists(result: std::io::Result<()>, path: &Path) -> Result<(), Fault> {
    match result {
        Err(e) if e.kind() != ErrorKind::NotFound => Err(fault(&e, "rm", path)),
        _ => Ok(()),
    }
}

pub(super) fn register(registry: &mut Registry) {
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
            with_catalog(p.dir, move |c| c.open(p.open, page)).await
        })
    });
}
