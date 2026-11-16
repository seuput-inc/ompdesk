use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use serde_json::Value;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Storage {
    App,
    Persistent(String),
    Memory,
}

pub use crate::network::session::canonical_partition as canonical;

pub fn storage(partition: &str) -> Result<Storage, String> {
    match canonical(partition) {
        "app" => Ok(Storage::App),
        name if name.starts_with("persist:") => {
            let name = name.strip_prefix("persist:").expect("matched prefix");
            if name.is_empty() {
                return Err("a persistent partition needs a name".into());
            }
            Ok(Storage::Persistent(name.to_string()))
        }
        _ => Ok(Storage::Memory),
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Policy {
    pub user_agent: Option<String>,
    pub accept_languages: Option<String>,
    pub deny_permissions: bool,
    pub deny_downloads: bool,
    pub preloads: Vec<(String, String)>,
    pub schemes: HashSet<String>,
    pub spell_languages: Option<Vec<String>>,
    pub proxy: Option<Value>,
}

impl Policy {
    pub fn preload(&mut self, id: String, source: String) {
        self.preloads.retain(|(existing, _)| *existing != id);
        self.preloads.push((id, source));
    }

    pub fn preload_source(&self) -> String {
        let mut source = String::new();
        for (_, script) in &self.preloads {
            source.push_str("(function(){");
            source.push_str(script);
            source.push_str("\n})();\n");
        }
        source
    }

    pub fn deny_network(&self) -> bool {
        self.proxy.as_ref().is_some_and(|proxy| {
            proxy["mode"] == "fixed_servers"
                && proxy["proxyRules"] == "http://127.0.0.1:1"
                && proxy["proxyBypassRules"] == "<-loopback>"
        })
    }
}

pub enum Command {
    Request(crate::host::Call, tokio::sync::oneshot::Receiver<()>),
    Context(tokio::sync::oneshot::Sender<Result<shell_preview::Partition, String>>),
}

pub struct Session {
    pub storage: Storage,
    pub policy: Policy,
    pub cache: bool,
    pub app_views: Vec<tauri::Webview>,
    pub native_stream: bool,
    pub snapshot: Option<super::native::Snapshot>,
    pub snapshot_error: Option<String>,
    pub context: Option<String>,
    pub context_exposed: bool,
    pub preview_transport: Option<crate::preview_protocol::PreviewTransport>,
    pub gateway_proxy_applied: bool,
    pub preview_pages: Vec<shell_preview::AttachedPage>,
    pub script_ids: HashMap<String, Vec<String>>,
    pub cookie_arbiter: std::sync::Arc<tokio::sync::Mutex<()>>,
    pub ready: std::sync::Arc<tokio::sync::Notify>,
    pub queue: tokio::sync::mpsc::UnboundedSender<Command>,
    pub receiver: Option<tokio::sync::mpsc::UnboundedReceiver<Command>>,
}

impl Session {
    pub fn new(storage: Storage, cache: bool) -> Self {
        let (queue, receiver) = tokio::sync::mpsc::unbounded_channel();
        Self {
            storage,
            policy: Policy::default(),
            cache,
            app_views: Vec::new(),
            native_stream: false,
            snapshot: None,
            snapshot_error: None,
            context: None,
            context_exposed: false,
            preview_transport: None,
            gateway_proxy_applied: false,
            preview_pages: Vec::new(),
            script_ids: HashMap::new(),
            cookie_arbiter: std::sync::Arc::new(tokio::sync::Mutex::new(())),
            ready: std::sync::Arc::new(tokio::sync::Notify::new()),
            queue,
            receiver: Some(receiver),
        }
    }
}

pub struct Registry {
    pub user_data: PathBuf,
    pub partitions: HashMap<String, Session>,
}

impl Registry {
    pub fn ensure(&mut self, partition: &str, cache: bool) -> Result<&mut Session, String> {
        let storage = storage(partition)?;
        Ok(self
            .partitions
            .entry(canonical(partition).to_string())
            .or_insert_with(|| Session::new(storage, cache)))
    }

    pub fn get(&self, partition: &str) -> Result<&Session, String> {
        self.partitions
            .get(canonical(partition))
            .ok_or_else(|| format!("session {} does not exist", canonical(partition)))
    }

    pub fn get_mut(&mut self, partition: &str) -> Result<&mut Session, String> {
        self.partitions
            .get_mut(canonical(partition))
            .ok_or_else(|| format!("session {} does not exist", canonical(partition)))
    }
}

#[cfg(test)]
mod tests {
    use super::{Storage, storage};

    #[test]
    fn partitions_keep_app_aliases_and_persistent_names_distinct() {
        assert_eq!(storage("").unwrap(), Storage::App);
        assert_eq!(storage("app").unwrap(), Storage::App);
        assert_eq!(storage("preview").unwrap(), Storage::Memory);
        assert_eq!(
            storage("persist:preview:one").unwrap(),
            Storage::Persistent("preview:one".into())
        );
        assert!(storage("persist:").is_err());
    }
}
