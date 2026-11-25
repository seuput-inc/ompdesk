use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::{Mutex, watch};

use crate::transport::Transport;
use crate::{Error, Result};

/// A paused actual target, not a native wc/view ID or another authorization registry.
#[derive(Clone)]
pub struct AttachedPage {
    pub target_id: String,
    pub session_id: String,
    pub context_id: String,
    pub(crate) transport: Transport,
}

impl AttachedPage {
    pub async fn command(&self, method: &str, params: Value) -> Result<Value> {
        self.transport
            .request(method, params, Some(&self.session_id))
            .await
    }

    pub(crate) fn from_target(
        transport: &Transport,
        target: &Value,
        session: &str,
    ) -> Result<Self> {
        let field = |name| {
            target
                .get(name)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| {
                    Error::new(
                        "cdp",
                        "Attached Preview target has no context or target identity",
                    )
                })
        };
        Ok(Self {
            target_id: field("targetId")?,
            session_id: session.to_owned(),
            context_id: field("browserContextId")?,
            transport: transport.clone(),
        })
    }
}

pub trait PageInitializer: Send + Sync {
    fn initialize(&self, page: AttachedPage) -> Pin<Box<dyn Future<Output = Result<()>> + Send>>;
}

type Ready = Option<Result<AttachedPage>>;

struct Pending {
    session: Option<String>,
    completion: watch::Sender<Ready>,
}

impl Pending {
    fn new() -> Self {
        Self {
            session: None,
            completion: watch::channel(None).0,
        }
    }
}

pub(crate) struct Initializations {
    initializer: Option<Arc<dyn PageInitializer>>,
    targets: Mutex<HashMap<String, Pending>>,
    timeout: Duration,
}

impl Initializations {
    pub(crate) fn new(initializer: Option<Arc<dyn PageInitializer>>, timeout: Duration) -> Self {
        Self {
            initializer,
            targets: Mutex::new(HashMap::new()),
            timeout,
        }
    }

    pub(crate) async fn begin(&self, target: &str, session: &str) -> (watch::Sender<Ready>, bool) {
        let mut targets = self.targets.lock().await;
        let state = targets
            .entry(target.to_owned())
            .or_insert_with(Pending::new);
        let owns_initialization = state.session.is_none();
        if owns_initialization {
            state.session = Some(session.to_owned());
        }
        (state.completion.clone(), owns_initialization)
    }

    pub(crate) async fn initialize(
        &self,
        transport: &Transport,
        target: &Value,
        session: &str,
    ) -> Result<AttachedPage> {
        let page = AttachedPage::from_target(transport, target, session)?;
        if let Some(initializer) = &self.initializer {
            tokio::time::timeout(self.timeout, initializer.initialize(page.clone()))
                .await
                .map_err(|_| Error::new("timeout", "Preview session initialization timed out"))??;
        }
        Ok(page)
    }

    pub(crate) async fn wait(&self, target: &str) -> Result<AttachedPage> {
        let mut completion = {
            let mut targets = self.targets.lock().await;
            targets
                .entry(target.to_owned())
                .or_insert_with(Pending::new)
                .completion
                .subscribe()
        };
        tokio::time::timeout(self.timeout, async {
            loop {
                if let Some(result) = completion.borrow_and_update().clone() {
                    return result;
                }
                completion.changed().await.map_err(|_| {
                    Error::new("gone", "Preview target detached during initialization")
                })?;
            }
        })
        .await
        .map_err(|_| Error::new("timeout", "Preview target initialization did not finish"))?
    }

    pub(crate) async fn detached(&self, target: &str, session: &str) {
        let mut targets = self.targets.lock().await;
        if targets
            .get(target)
            .is_some_and(|state| state.session.as_deref() == Some(session))
        {
            targets.remove(target);
        }
    }
}
