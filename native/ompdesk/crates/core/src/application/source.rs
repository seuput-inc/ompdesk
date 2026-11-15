//! One retained execution handle. Root owns admission and construction; this enum owns
//! the original local or remote handle's final cleanup, never an Owner or tab registry.

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::Value;

use super::exits::Receipt;
use super::launch_host::LaunchHost;
use super::launch_ingress::LaunchIngress;
use super::local_sources::Created;
use crate::pool::application::Sidecar;
use crate::remote::application_devices::TabRelease;
use crate::remote::native_sidecar::Service as RemoteSidecar;
use crate::server::Fault;
use crate::sidecar::application::{Application, EffectFuture};
use crate::sidecar::native::{Held, Service as LocalSidecar};

struct Retirement {
    held: Receipt,
    completion: OnceLock<Receipt>,
}

impl Retirement {
    fn new(held: Held) -> Self {
        Self {
            held: Receipt::join(held),
            completion: OnceLock::new(),
        }
    }
}

pub(crate) struct Local {
    pub(super) source: Arc<LocalSidecar>,
    application: Arc<Application<LaunchHost>>,
    ingress: Arc<LaunchIngress<LaunchHost>>,
    commands: Arc<crate::local_dispatch::Commands<LocalSidecar>>,
    retirement: Retirement,
}

pub(crate) struct Remote {
    pub(super) source: Arc<RemoteSidecar>,
    release: Mutex<Option<TabRelease>>,
    retirement: Retirement,
}

pub(crate) enum Source {
    Local(Local),
    Remote(Remote),
}

impl Source {
    pub(crate) fn from_local(created: Created) -> Self {
        Self::Local(Local {
            source: created.source,
            application: created.application,
            ingress: created.ingress,
            commands: created.commands,
            retirement: Retirement::new(created.held),
        })
    }

    pub(crate) fn from_remote(source: Arc<RemoteSidecar>, held: Held, release: TabRelease) -> Self {
        Self::Remote(Remote {
            source,
            retirement: Retirement::new(held),
            release: Mutex::new(Some(release)),
        })
    }

    pub(crate) fn local(&self) -> Option<&Arc<LocalSidecar>> {
        match self {
            Self::Local(local) => Some(&local.source),
            Self::Remote(_) => None,
        }
    }

    pub(crate) fn local_commands(&self) -> Option<&Arc<crate::local_dispatch::Commands<LocalSidecar>>> {
        match self {
            Self::Local(local) => Some(&local.commands),
            Self::Remote(_) => None,
        }
    }

    pub(crate) fn local_application(&self) -> Option<&Arc<Application<LaunchHost>>> {
        match self {
            Self::Local(local) => Some(&local.application),
            Self::Remote(_) => None,
        }
    }

    pub(crate) fn remote(&self) -> Option<&Arc<RemoteSidecar>> {
        match self {
            Self::Local(_) => None,
            Self::Remote(remote) => Some(&remote.source),
        }
    }

    /// A remote receipt joins this computer's actor and delivery, not the execution host's omp.
    pub(crate) fn is_local(&self) -> bool {
        matches!(self, Self::Local(_))
    }

    pub(crate) fn original_origin(&self) -> Option<Value> {
        match self {
            Self::Local(local) => local.application.original_origin(),
            Self::Remote(_) => None,
        }
    }


    pub(crate) fn adopt_cwd_for_generation(
        &self,
        generation: u64,
        cwd: String,
    ) -> EffectFuture<'static, Result<bool, Fault>> {
        match self {
            Self::Local(local) => local.source.adopt_cwd_for_generation(generation, cwd),
            Self::Remote(remote) => remote.source.adopt_cwd_for_generation(generation, cwd),
        }
    }

    pub(crate) fn sync_image_generation_for_generation(
        &self,
        generation: u64,
    ) -> EffectFuture<'static, Result<Value, Fault>> {
        match self {
            Self::Local(local) => local.source.bridge_for_generation(
                generation, "image_generation_sync".into(), None, None,
            ),
            Self::Remote(remote) => remote.source.sync_image_generation_for_generation(generation),
        }
    }

    fn sidecar(&self) -> &dyn Sidecar<Error = Fault> {
        match self {
            Self::Local(local) => local.source.as_ref(),
            Self::Remote(remote) => remote.source.as_ref(),
        }
    }

    fn retirement(&self) -> &Retirement {
        match self {
            Self::Local(local) => &local.retirement,
            Self::Remote(remote) => &remote.retirement,
        }
    }

    /// Wait only. Obtaining or dropping this receipt neither disposes nor changes the run.
    pub(crate) fn settled(&self) -> Option<Receipt> {
        self.retirement().completion.get().cloned()
    }

    /// Capture cleanup once, synchronously before the caller can drop its returned waiter.
    /// Every owned effect is joined even when another effect fails.
    pub(crate) fn retire(&self) -> Receipt {
        let retirement = self.retirement();
        retirement
            .completion
            .get_or_init(|| {
                let work: Held = match self {
                    Self::Local(local) => {
                        let source = Arc::clone(&local.source);
                        let application = Arc::clone(&local.application);
                        let ingress = Arc::clone(&local.ingress);
                        let exited = source.when_exited();
                        let joined = ingress.close();
                        let held = retirement.held.wait();
                        source.dispose(Duration::ZERO);
                        Box::pin(async move {
                            let (exited, held, joined) = tokio::join!(exited, held, joined);
                            source.remove_listeners();
                            let drained = source.reply_barrier().await;
                            // Keep the application through both launch dispatch and final event delivery.
                            drop(application);
                            drop(ingress);
                            drop(source);
                            exited.and(held).and(joined).and(drained)
                        })
                    }
                    Self::Remote(remote) => {
                        let source = Arc::clone(&remote.source);
                        let disposed = source.when_disposed();
                        let held = retirement.held.wait();
                        let release = remote
                            .release
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .take()
                            .expect("one Source retirement owns its original tab release");
                        release.release(source.keep_on_host_requested());
                        Box::pin(async move {
                            let (disposed, held) = tokio::join!(disposed, held);
                            source.remove_listeners();
                            let drained = source.reply_barrier().await;
                            drop(source);
                            disposed.and(held).and(drained)
                        })
                    }
                };
                Receipt::join(work)
            })
            .clone()
    }
}

impl Drop for Source {
    fn drop(&mut self) {
        let receipt = self.retire();
        tokio::spawn(async move {
            if let Err(error) = receipt.wait().await {
                eprintln!("ompdesk-core: source retirement failed: {}", error.message);
            }
        });
    }
}

impl Sidecar for Source {
    type Error = Fault;

    fn facts(&self) -> Value {
        self.sidecar().facts()
    }
    fn generation(&self) -> u64 {
        self.sidecar().generation()
    }
    fn bridge_connected(&self) -> bool {
        self.sidecar().bridge_connected()
    }
    fn before_response(&self) {
        self.sidecar().before_response();
    }
    fn start(&self) {
        self.sidecar().start();
    }
    fn restart(&self, session: Option<&str>) {
        self.sidecar().restart(session);
    }
    fn sleep(&self) -> Result<(), Fault> {
        self.sidecar().sleep()
    }
    fn adopt_cwd(&self, cwd: &str) -> bool {
        self.sidecar().adopt_cwd(cwd)
    }
    fn send_now(&self, frame: Value) -> Result<(), Fault> {
        self.sidecar().send_now(frame)
    }
    fn send(&self, frame: Value) -> EffectFuture<'_, Result<(), Fault>> {
        self.sidecar().send(frame)
    }
    fn stock(&self, command: Value) -> EffectFuture<'static, Result<Value, Fault>> {
        self.sidecar().stock(command)
    }
    fn send_for_generation(
        &self,
        generation: u64,
        frame: Value,
    ) -> EffectFuture<'static, Result<(), Fault>> {
        self.sidecar().send_for_generation(generation, frame)
    }
    fn stock_for_generation(
        &self,
        generation: u64,
        command: Value,
        deadline: crate::agentctl::service::host::Deadline,
    ) -> EffectFuture<'static, Result<Value, Fault>> {
        self.sidecar()
            .stock_for_generation(generation, command, deadline)
    }
    fn bridge_for_generation(
        &self,
        generation: u64,
        method: String,
        params: Option<Value>,
        timeout_ms: Option<u64>,
    ) -> EffectFuture<'static, Result<Value, Fault>> {
        self.sidecar()
            .bridge_for_generation(generation, method, params, timeout_ms)
    }
    fn bridge(
        &self,
        method: String,
        params: Option<Value>,
        timeout_ms: Option<u64>,
    ) -> EffectFuture<'static, Result<Value, Fault>> {
        self.sidecar().bridge(method, params, timeout_ms)
    }
    /// This remains the original variant's captured run receipt, not the whole Source lifetime.
    fn exit_waiter(&self) -> EffectFuture<'static, Result<(), Fault>> {
        self.sidecar().exit_waiter()
    }
    fn reply_barrier(&self) -> Held {
        self.sidecar().reply_barrier()
    }
    fn remove_listeners(&self) {
        self.sidecar().remove_listeners();
    }
    fn dispose(&self) {
        drop(self.retire());
    }
    fn sync_settings(&self) -> EffectFuture<'_, ()> {
        self.sidecar().sync_settings()
    }
}

#[cfg(test)]
#[path = "source_tests.rs"]
pub(crate) mod tests;
