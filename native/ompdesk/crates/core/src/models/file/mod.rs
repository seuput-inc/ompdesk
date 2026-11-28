//! The agent's `models.yml` (was `src/main/models-config.ts`): the Settings page's provider list, its edits and the
//! in-app text editor's read and save. Main passes the agent folder and its stock helper's `host`.
//!
//! - `models.list {dir, host}` → the providers' views, keys masked.
//! - `models.upsert {dir, host, input, onlyIfAbsent?}` → whether it wrote (false: `onlyIfAbsent` found the id).
//! - `models.extend {dir, host, stamp, additions}` appends discovered models to existing routes at that file stamp.
//! - `models.delete {dir, host, id}`, `models.override {dir, host, provider, model, input|null}`.
//! - `models.text {dir}` → `{path, text, exists, stamp}`; `models.saveText {dir, host, text, stamp}` → the new stamp.
//! - `models.path {dir, create?}` → `{path}`, the skeleton written first when `create` finds no file.
//!
//! Stock owns what the file means: it reads models.yml with Bun.YAML and normalizes it with ModelsConfigSchema, so
//! every read asks the stock lane (`models.validate {text}` → `{raw, config}`) and the views come from the normalized
//! config. An edit changes the text in place (`yaml.rs`) and is checked twice before anything is written: the edited
//! text must read, under stock's parse, as exactly the intended config, and the text with stock's normalization
//! written back must read as that normalization. A text yaml-edit misreads or misedits is refused, never written.
//!
//! Edits run one at a time (one lock), and one whose file changed on disk since it was read writes nothing. The swap
//! is atomic and lands on a symlink's target, keeping the target's mode (a new file is 0600: it can hold API keys).

#[cfg(test)]
mod tests;
mod view;

use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::disk::tree::write_atomic_if;
use crate::server::{Call, Events, Fault, Registry, Reply};
use crate::yaml;
use view::Roster;

/// A file the editor opens while none exists.
const SKELETON: &str = "# Custom model providers.\nproviders: {}\n";
/// Permissions of a models file the app creates.
const NEW_FILE_MODE: u32 = 0o600;
/// A stock request not answered in this long fails, as `stockHelperRequest`'s default.
const STOCK_TIMEOUT: Duration = Duration::from_secs(30);

/// One edit at a time, its read and its write in one turn (an entry added meanwhile is never overwritten).
static EDITS: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

use super::claude_route::is_claude_key_id as claude_key_id;

pub fn register(registry: &mut Registry) {
    registry.add("models.list", |call| {
        Box::pin(async move { Reply::json(&list(&lane(&call)?, &dir(&call)?).await?) })
    });
    registry.add("models.upsert", |call| {
        Box::pin(async move {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Params {
                input: Value,
                #[serde(default)]
                only_if_absent: bool,
            }
            let params: Params = call.params()?;
            Reply::json(
                &upsert(
                    &lane(&call)?,
                    &dir(&call)?,
                    &params.input,
                    params.only_if_absent,
                )
                .await?,
            )
        })
    });
    registry.add("models.extend", |call| {
        Box::pin(async move {
            #[derive(Deserialize)]
            struct Params {
                stamp: String,
                additions: std::collections::BTreeMap<String, Vec<Value>>,
            }
            let params: Params = call.params()?;
            let _edit = EDITS.lock().await;
            let stock = lane(&call)?;
            let loaded = load(&stock, &dir(&call)?).await?;
            if stamp(loaded.bytes.as_deref()) != params.stamp {
                return Err(Fault::new(
                    "changed_on_disk",
                    "Model providers changed during discovery",
                ));
            }
            let mut intended = loaded.raw.clone();
            for (id, extra) in params.additions {
                if !claude_key_id(&id) {
                    return Err(Fault::new("models_config", "Not a dedicated Claude key"));
                }
                let models = intended
                    .get_mut("providers")
                    .and_then(|providers| providers.get_mut(&id))
                    .and_then(|provider| provider.get_mut("models"))
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| {
                        Fault::new("models_config", "No configured model list to extend")
                    })?;
                models.extend(extra);
            }
            Reply::json(&stamp(Some(&save(&stock, &loaded, Some(&intended)).await?)))
        })
    });
    registry.add("models.delete", |call| {
        Box::pin(async move {
            #[derive(Deserialize)]
            struct Params {
                id: String,
            }
            let params: Params = call.params()?;
            delete(&lane(&call)?, &dir(&call)?, &params.id).await?;
            Reply::json(&Value::Null)
        })
    });
    registry.add("models.override", |call| {
        Box::pin(async move {
            #[derive(Deserialize)]
            struct Params {
                provider: String,
                model: String,
                input: Option<Value>,
            }
            let params: Params = call.params()?;
            set_override(
                &lane(&call)?,
                &dir(&call)?,
                &params.provider,
                &params.model,
                params.input.as_ref(),
            )
            .await?;
            Reply::json(&Value::Null)
        })
    });
    registry.add("models.text", |call| {
        Box::pin(async move {
            let dir = dir(&call)?;
            Reply::json(&blocking(move || text(&dir)).await?)
        })
    });
    registry.add("models.saveText", |call| {
        Box::pin(async move {
            #[derive(Deserialize)]
            struct Params {
                text: String,
                stamp: String,
            }
            let params: Params = call.params()?;
            Reply::json(&save_text(&lane(&call)?, &dir(&call)?, params.text, &params.stamp).await?)
        })
    });
    registry.add("models.path", |call| {
        Box::pin(async move {
            #[derive(Deserialize)]
            struct Params {
                #[serde(default)]
                create: bool,
            }
            let create = call.params::<Params>()?.create;
            let dir = dir(&call)?;
            Reply::json(
                &blocking(move || {
                    let file = models_path(&dir);
                    if create && read(&file)?.is_none() {
                        write(&file, None, SKELETON.as_bytes())?;
                    }
                    Ok(json!({ "path": file }))
                })
                .await?,
            )
        })
    });
}

pub(super) fn dir(call: &Call) -> Result<PathBuf, Fault> {
    #[derive(Deserialize)]
    struct Params {
        dir: PathBuf,
    }
    Ok(call.params::<Params>()?.dir)
}

pub(super) fn lane(call: &Call) -> Result<StockLane, Fault> {
    #[derive(Deserialize)]
    struct Params {
        host: String,
    }
    Ok(StockLane {
        events: call.events.clone(),
        host: call.params::<Params>()?.host,
    })
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, Fault> + Send + 'static,
) -> Result<T, Fault> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| Fault::new("internal", "The models file's work panicked"))?
}

/// What stock read of a text: as parsed, and normalized.
pub(super) struct Checked {
    raw: Value,
    config: Value,
}

/// Stock's side of models.yml; tests stand in for it.
pub(super) trait Stock: Sync {
    fn roster(&self) -> impl Future<Output = Result<Roster, Fault>> + Send;
    /// Fails with stock's reason when the text does not parse or does not satisfy the schema.
    fn check(&self, text: &str) -> impl Future<Output = Result<Checked, Fault>> + Send;
}

pub(super) struct StockLane {
    events: Events,
    host: String,
}

impl Stock for StockLane {
    async fn roster(&self) -> Result<Roster, Fault> {
        let answer = crate::stock::request_in_process(
            &self.events,
            &self.host,
            "catalog.roster",
            &json!({}),
            STOCK_TIMEOUT,
        )
        .await?;
        let roster: Roster = serde_json::from_value(answer).map_err(|_| {
            Fault::new(
                "models_roster",
                "Installed omp cannot determine models.yml provider roster or option vocabularies",
            )
        })?;
        let lists = [
            &roster.builtin_providers,
            &roster.apis,
            &roster.auth,
            &roster.discovery,
            &roster.thinking_modes,
            &roster.efforts,
        ];
        if lists.iter().any(|list| list.is_empty()) {
            return Err(Fault::new(
                "models_roster",
                "Installed omp cannot determine models.yml provider roster or option vocabularies",
            ));
        }
        Ok(roster)
    }

    async fn check(&self, text: &str) -> Result<Checked, Fault> {
        #[derive(Deserialize)]
        struct Answer {
            raw: Option<Value>,
            config: Option<Value>,
            error: Option<String>,
        }
        let answer = crate::stock::request_in_process(
            &self.events,
            &self.host,
            "models.validate",
            &json!({ "text": text }),
            STOCK_TIMEOUT,
        )
        .await?;
        let answer: Answer = serde_json::from_value(answer)
            .map_err(|_| Fault::new("stock_answer", "Invalid models.yml check"))?;
        match answer {
            Answer {
                error: Some(error), ..
            } => Err(Fault::new("models_config", error)),
            Answer {
                raw: Some(raw),
                config: Some(config),
                ..
            } => Ok(Checked { raw, config }),
            _ => Err(Fault::new("stock_answer", "Invalid models.yml check")),
        }
    }
}

/// `models.yml` in the agent folder, `models.yaml` while only that exists.
fn models_path(dir: &Path) -> PathBuf {
    let preferred = dir.join("models.yml");
    let legacy = dir.join("models.yaml");
    if !preferred.exists() && legacy.exists() {
        legacy
    } else {
        preferred
    }
}

/// The file's bytes; `None` when there is none.
fn read(file: &Path) -> Result<Option<Vec<u8>>, Fault> {
    match std::fs::read(file) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(Fault::new(
            "models_io",
            format!("{}: {error}", file.display()),
        )),
    }
}

/// Names the file as read: a save refuses when it no longer is.
fn stamp(bytes: Option<&[u8]>) -> String {
    match bytes {
        None => "missing".into(),
        Some(bytes) => Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    }
}

/// The file as an edit starts from.
struct Loaded {
    file: PathBuf,
    bytes: Option<Vec<u8>>,
    text: String,
    raw: Value,
    config: Value,
}

async fn load(stock: &impl Stock, dir: &Path) -> Result<Loaded, Fault> {
    let file = models_path(dir);
    let bytes = {
        let file = file.clone();
        blocking(move || read(&file)).await?
    };
    let Some(present) = &bytes else {
        return Ok(Loaded {
            file,
            bytes,
            text: String::new(),
            raw: json!({}),
            config: json!({}),
        });
    };
    let text = String::from_utf8_lossy(present).into_owned();
    yaml::parse(&text)
        .map_err(|error| Fault::new("models_config", format!("{}: {error}", file.display())))?;
    let Checked { raw, config } = stock.check(&text).await?;
    Ok(Loaded {
        file,
        bytes,
        text,
        raw,
        config,
    })
}

/// What `old` with `providers.<id>` set to `entry`, or removed for `None`, reads as.
fn with_provider(old: &Value, id: &str, entry: Option<Value>) -> Value {
    let mut root = old.as_object().cloned().unwrap_or_default();
    let mut providers = root
        .get("providers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    match entry {
        Some(entry) => {
            providers.insert(id.to_owned(), entry);
        }
        None => {
            providers.shift_remove(id);
        }
    }
    root.insert("providers".into(), Value::Object(providers));
    Value::Object(root)
}

fn providers(config: &Value) -> serde_json::Map<String, Value> {
    config
        .get("providers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// The providers' views with the vocabularies the form offers (`CustomProvidersConfig`).
pub(super) async fn list(stock: &impl Stock, dir: &Path) -> Result<Value, Fault> {
    let roster = stock.roster().await?;
    let loaded = load(stock, dir).await?;
    let providers: Vec<Value> = providers(&loaded.config)
        .iter()
        .map(|(id, raw)| view::provider(id, raw, &roster))
        .collect();
    Ok(json!({ "providers": providers, "options": roster }))
}

pub(super) async fn upsert(
    stock: &impl Stock,
    dir: &Path,
    input: &Value,
    only_if_absent: bool,
) -> Result<bool, Fault> {
    let _edit = EDITS.lock().await;
    let roster = stock.roster().await?;
    let id = input.get("id").and_then(Value::as_str).unwrap_or_default();
    if roster.builtin(id) {
        return Err(Fault::new(
            "provider_id_builtin",
            format!("\"{id}\" is a built-in provider id; choose a distinct custom id."),
        ));
    }
    let loaded = load(stock, dir).await?;
    let existing = providers(&loaded.config).get(id).cloned();
    if only_if_absent && existing.is_some() {
        return Ok(false);
    }
    let entry = view::provider_entry(existing.as_ref(), input);
    let intended = with_provider(&loaded.raw, id, Some(entry));
    save(stock, &loaded, Some(&intended)).await?;
    Ok(true)
}

pub(super) async fn delete(stock: &impl Stock, dir: &Path, id: &str) -> Result<(), Fault> {
    let _edit = EDITS.lock().await;
    let roster = stock.roster().await?;
    if roster.builtin(id) {
        return Err(Fault::new(
            "provider_builtin_delete",
            format!("\"{id}\" is a built-in provider and cannot be removed from the GUI."),
        ));
    }
    let loaded = load(stock, dir).await?;
    if !providers(&loaded.config).contains_key(id) {
        return Ok(());
    }
    let intended = with_provider(&loaded.raw, id, None);
    save(stock, &loaded, Some(&intended)).await.map(drop)
}

/// One model's `modelOverrides` entry under any provider, built-in ones included; a built-in provider's entry left
/// with nothing is removed, so resetting the last override leaves models.yml as it was.
async fn set_override(
    stock: &impl Stock,
    dir: &Path,
    provider: &str,
    model: &str,
    input: Option<&Value>,
) -> Result<(), Fault> {
    let _edit = EDITS.lock().await;
    let loaded = load(stock, dir).await?;
    let before = loaded
        .raw
        .get("providers")
        .and_then(|providers| providers.get(provider));
    let intended = match view::override_entry(before, model, input) {
        Some(entry) => with_provider(&loaded.raw, provider, Some(entry)),
        None if before.is_some() => with_provider(&loaded.raw, provider, None),
        None => loaded.raw.clone(),
    };
    save(stock, &loaded, Some(&intended)).await.map(drop)
}

#[derive(serde::Serialize)]
struct Text {
    path: PathBuf,
    text: String,
    exists: bool,
    stamp: String,
}

fn text(dir: &Path) -> Result<Text, Fault> {
    let file = models_path(dir);
    let bytes = read(&file)?;
    Ok(Text {
        stamp: stamp(bytes.as_deref()),
        exists: bytes.is_some(),
        text: bytes.map_or_else(
            || SKELETON.to_owned(),
            |bytes| String::from_utf8_lossy(&bytes).into_owned(),
        ),
        path: file,
    })
}

/// Text an editor produced, through the same checks and writer as every edit. Every refusal is `invalid_content`
/// with its reason, for the editor to show.
async fn save_text(
    stock: &impl Stock,
    dir: &Path,
    text: String,
    given: &str,
) -> Result<String, Fault> {
    let _edit = EDITS.lock().await;
    let invalid = |message: String| Fault::new("invalid_content", message);
    let file = models_path(dir);
    let bytes = {
        let file = file.clone();
        blocking(move || read(&file)).await?
    };
    if stamp(bytes.as_deref()) != given {
        return Err(invalid(format!(
            "{} changed on disk since it was opened. Nothing was written; reopen it.",
            file.display()
        )));
    }
    yaml::parse(&text).map_err(|error| invalid(format!("models.yml: {error}")))?;
    let Checked { raw, config } = stock
        .check(&text)
        .await
        .map_err(|fault| invalid(fault.message))?;
    let loaded = Loaded {
        file,
        bytes,
        text,
        raw,
        config,
    };
    let written = save(stock, &loaded, None)
        .await
        .map_err(|fault| invalid(fault.message))?;
    Ok(stamp(Some(&written)))
}

/// Writes `loaded`'s text edited to read as `intended` (`None`: as it is), with stock's normalization written back.
/// Answers the bytes written.
async fn save(
    stock: &impl Stock,
    loaded: &Loaded,
    intended: Option<&Value>,
) -> Result<Vec<u8>, Fault> {
    let unchanged = || {
        Fault::new(
            "models_edit",
            format!(
                "{} could not be edited without changing what else it says. Nothing was written.",
                loaded.file.display()
            ),
        )
    };
    let edit = |text: &str, before: &Value, after: &Value| {
        yaml::edit(text, before, after).map_err(|error| {
            Fault::new("models_edit", format!("{}: {error}", loaded.file.display()))
        })
    };
    let (edited, read_as) = match intended {
        Some(intended) => {
            let edited = edit(&loaded.text, &loaded.raw, intended)?;
            let read_as = stock.check(&edited).await?;
            if !same(&read_as.raw, intended) {
                return Err(unchanged());
            }
            (edited, read_as)
        }
        None => (
            loaded.text.clone(),
            Checked {
                raw: loaded.raw.clone(),
                config: loaded.config.clone(),
            },
        ),
    };
    let normalized = edit(&edited, &read_as.raw, &read_as.config)?;
    if normalized != edited && !same(&stock.check(&normalized).await?.raw, &read_as.config) {
        return Err(unchanged());
    }
    let file = loaded.file.clone();
    let was = loaded.bytes.clone();
    blocking(move || {
        write(&file, was.as_deref(), normalized.as_bytes())?;
        Ok(normalized.into_bytes())
    })
    .await
}

/// Equal as JSON values, a number by its value (`1` and `1.0` are one number to YAML and JavaScript).
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, value)| b.get(key).is_some_and(|other| same(value, other)))
        }
        _ => a == b,
    }
}

/// Swaps `bytes` in for `file`, which read as `was` (`None`: missing). The agent live-reloads this file, so the swap is
/// atomic. A file changed since it was read is left alone; a symlink stays a link and its target takes the write with
/// its mode kept; a link whose target is gone is reported, never replaced by a file.
fn write(file: &Path, was: Option<&[u8]>, bytes: &[u8]) -> Result<(), Fault> {
    if stamp(read(file)?.as_deref()) != stamp(was) {
        return Err(Fault::new(
            "models_changed",
            format!(
                "{} changed on disk while it was being saved. Nothing was written; try again.",
                file.display()
            ),
        ));
    }
    let linked = std::fs::symlink_metadata(file).is_ok_and(|meta| meta.file_type().is_symlink());
    if was.is_none() && linked {
        let dangling = file
            .parent()
            .unwrap_or(Path::new(""))
            .join(std::fs::read_link(file).unwrap_or_default());
        return Err(Fault::new(
            "models_link",
            format!(
                "{} links to {}, which does not exist. Nothing was written; fix or remove the link.",
                file.display(),
                dangling.display()
            ),
        ));
    }
    let (target, mode) = match was {
        None => (file.to_path_buf(), NEW_FILE_MODE),
        Some(_) => {
            let target = std::fs::canonicalize(file)
                .map_err(|error| Fault::new("models_io", format!("{}: {error}", file.display())))?;
            (target.clone(), file_mode(&target)?)
        }
    };
    write_atomic_if(&target, bytes, cfg!(unix).then_some(mode), 0o700, &|| true)?;
    Ok(())
}

#[cfg(unix)]
fn file_mode(target: &Path) -> Result<u32, Fault> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(target)
        .map(|meta| meta.permissions().mode() & 0o7777)
        .map_err(|error| Fault::new("models_io", format!("{}: {error}", target.display())))
}

#[cfg(not(unix))]
fn file_mode(_target: &Path) -> Result<u32, Fault> {
    Ok(NEW_FILE_MODE)
}
