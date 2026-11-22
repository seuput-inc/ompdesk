use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;

use super::catalog::{CONFIG, Catalog};
use super::take;

pub(super) struct Entry {
    pub client: String,
    pub initialize: Arc<Value>,
    pub catalog: Arc<Catalog>,
    pub prompts: Option<Arc<Value>>,
}

pub(crate) struct Store {
    file: Option<PathBuf>,
    startup: OnceLock<Mutex<Option<Arc<Entry>>>>,
}

impl Store {
    pub(crate) fn new(dir: Option<PathBuf>) -> Self {
        Self {
            file: dir
                .filter(|d| !d.as_os_str().is_empty())
                .map(|dir| dir.join(format!("rea-{}.json", CONFIG.version))),
            startup: OnceLock::new(),
        }
    }

    fn load(path: &Path) -> Option<Entry> {
        let mut data: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
        if data["version"].as_str() != Some(&CONFIG.version) || !data["initialize"].is_object() {
            return None;
        }
        let Value::String(client) = take(&mut data, "client")? else {
            return None;
        };
        let mut catalog = Catalog::default();
        catalog.append(take(&mut data, "tools")?).ok()?;
        Some(Entry {
            client,
            initialize: Arc::new(data["initialize"].take()),
            catalog: Arc::new(catalog),
            prompts: take(&mut data, "prompts").map(Arc::new),
        })
    }

    fn startup(&self) -> &Mutex<Option<Arc<Entry>>> {
        self.startup
            .get_or_init(|| Mutex::new(self.file.as_deref().and_then(Self::load).map(Arc::new)))
    }

    pub(super) fn get(&self) -> Option<Arc<Entry>> {
        self.startup().lock().expect("REA cache lock").clone()
    }

    pub(super) fn enabled(&self) -> bool {
        self.file.is_some()
    }

    pub(super) fn write(&self, entry: Entry) {
        #[derive(Serialize)]
        struct Disk<'a> {
            version: &'a str,
            client: &'a str,
            initialize: &'a Value,
            tools: Vec<&'a Value>,
            #[serde(skip_serializing_if = "Option::is_none")]
            prompts: Option<&'a Value>,
        }
        let Some(file) = &self.file else { return };
        let mut cached = self.startup().lock().expect("REA cache lock");
        let stage = file.with_extension(format!("json.{}.tmp", std::process::id()));
        let result = (|| -> std::io::Result<()> {
            let disk = Disk {
                version: &CONFIG.version,
                client: &entry.client,
                initialize: &entry.initialize,
                tools: entry.catalog.0.values().collect(),
                prompts: entry.prompts.as_deref(),
            };
            if let Some(parent) = file.parent() {
                fs::create_dir_all(parent)?
            }
            fs::write(&stage, serde_json::to_vec(&disk)?)?;
            fs::rename(&stage, file)
        })();
        if result.is_ok() {
            *cached = Some(Arc::new(entry));
        } else {
            let _ = fs::remove_file(stage);
        }
    }

    pub(super) fn forget(&self) {
        let mut cached = self.startup().lock().expect("REA cache lock");
        *cached = None;
        if let Some(path) = &self.file {
            let _ = fs::remove_file(path);
        }
    }
}
