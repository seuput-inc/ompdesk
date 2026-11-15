//! The original request is a future-scoped borrowed capability, not a tab/owner registry.
//! Background run steps do not inherit page authority; their concrete Host uses execution authority.

use std::sync::Arc;

use crate::application::callers::CommandAdmission;
use crate::application::source::Source;
use crate::local_dispatch::{Commands, protocol::RpcCommand};
use crate::agentctl::service::host::Deadline;
use crate::server::Fault;
use serde_json::Value;

pub(crate) type Admission = Arc<CommandAdmission<Source>>;

#[derive(Clone)]
pub(crate) struct Binding {
    admission: Admission,
    commands: Arc<Commands<crate::sidecar::native::Service>>,
}

impl Binding {
    pub(super) fn new(
        admission: Admission,
        commands: Arc<Commands<crate::sidecar::native::Service>>,
    ) -> Self {
        Self { admission, commands }
    }

    pub(crate) fn admission(&self) -> &Admission {
        &self.admission
    }

    pub(super) async fn command(&self, command: Value, deadline: Deadline) -> Result<Value, Fault> {
        let command: RpcCommand = serde_json::from_value(command)
            .map_err(|error| Fault::new("invalid_params", error.to_string()))?;
        self.commands
            .command_with_admission(Arc::clone(&self.admission), command, deadline)
            .await
            .map_err(crate::local_dispatch::RpcError::into_fault)
    }
}

tokio::task_local! {
    static REQUEST: Binding;
}

/// Captures the same original request and per-source local-first dispatcher, never a later tab lookup.
pub(crate) fn current() -> Option<Binding> {
    REQUEST.try_with(Clone::clone).ok()
}

pub(super) async fn within<T>(request: Binding, work: impl std::future::Future<Output = T>) -> T {
    REQUEST.scope(request, work).await
}
