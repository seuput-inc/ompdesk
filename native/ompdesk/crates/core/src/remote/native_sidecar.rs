//! Native handle of the existing RemoteTab actor. Its receipt joins local delivery and close cleanup,
//! never proves the execution host's omp exited; the pool must release it with `local: false`.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;
use std::time::Duration;
use tokio::sync::{mpsc, watch};

use super::application_client::{RemoteTab, TabEvent};
use super::requests::RemoteRequests;
use crate::server::Fault;
use crate::sidecar::application::EffectFuture;

/// An ordered remote event stream, without fabricated local Lane request metadata.
pub trait RemoteSink: Send + Sync {
    fn event(&self, event: TabEvent);
    fn before_response(&self);
    fn remove_listeners(&self);
}

pub type Held = EffectFuture<'static, Result<(), Fault>>;

pub struct Service {
    tab: RemoteTab,
    sink: Arc<dyn RemoteSink>,
    listening: Arc<AtomicBool>,
    keep_on_host: AtomicBool,
    completion: watch::Receiver<Option<Result<(), Fault>>>,
    delivered: watch::Receiver<u64>,
}

fn receipt(mut completion: watch::Receiver<Option<Result<(), Fault>>>) -> Held {
    Box::pin(async move {
        loop {
            if let Some(result) = completion.borrow_and_update().clone() {
                return result;
            }
            completion.changed().await.map_err(|_| {
                Fault::new(
                    "remote_actor",
                    "Remote event delivery lost its completion receipt",
                )
            })?;
        }
    })
}

impl Service {
    pub fn from_tab(
        tab: RemoteTab,
        mut events: mpsc::UnboundedReceiver<TabEvent>,
        sink: Arc<dyn RemoteSink>,
    ) -> (Arc<Self>, Held) {
        let actor = tab.when_disposed();
        let listening = Arc::new(AtomicBool::new(true));
        let delivery_listening = Arc::clone(&listening);
        let delivery_sink = Arc::clone(&sink);
        let (progress, delivered) = watch::channel(0_u64);
        let delivery = tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                if delivery_listening.load(Ordering::Acquire) {
                    delivery_sink.event(event);
                }
                progress.send_modify(|count| *count += 1);
            }
            if delivery_listening.load(Ordering::Acquire) {
                delivery_sink.before_response();
            }
        });
        let (finished, completion) = watch::channel(None);
        let original_tab = tab.clone();
        tokio::spawn(async move {
            let delivered = delivery
                .await
                .map_err(|error| Fault::new("remote_delivery", error.to_string()));
            if delivered.is_err() {
                original_tab.dispose(true);
            }
            let disposed = actor.await;
            let _ = finished.send_replace(Some(delivered.and(disposed)));
        });
        let held = receipt(completion.clone());
        (
            Arc::new(Self {
                tab,
                sink,
                listening,
                keep_on_host: AtomicBool::new(false),
                completion,
                delivered,
            }),
            held,
        )
    }
    pub(crate) fn remote_tab(&self) -> &RemoteTab {
        &self.tab
    }
    fn finish<T: Send + 'static>(
        &self,
        operation: EffectFuture<'static, Result<T, super::requests::RemoteError>>,
    ) -> EffectFuture<'static, Result<T, Fault>> {
        let tab = self.tab.clone();
        let mut delivered = self.delivered.clone();
        Box::pin(async move {
            let result = operation.await.map_err(|error| error.fault);
            let through = tab.emitted_events();
            let delivery = async {
                loop {
                    if *delivered.borrow_and_update() >= through {
                        return Ok(());
                    }
                    delivered.changed().await.map_err(|_| {
                        Fault::new(
                            "remote_delivery",
                            "Remote events ended before the response was delivered",
                        )
                    })?;
                }
            }
            .await;
            result.and_then(|value| delivery.map(|()| value))
        })
    }

    pub fn facts(&self) -> Value {
        self.tab.facts()
    }

    pub fn generation(&self) -> u64 {
        self.tab.generation()
    }
    pub fn bridge_connected(&self) -> bool {
        self.tab.bridge_connected()
    }
    pub fn start(&self) {
        self.tab.start();
    }
    pub fn stock(&self, command: Value) -> EffectFuture<'static, Result<Value, Fault>> {
        let tab = self.tab.clone();
        self.finish(Box::pin(async move {
            tab.command(command, Duration::from_secs(8)).await
        }))
    }
    pub fn restart(&self, session: Option<&str>) {
        self.tab.restart(None, session.map(str::to_owned));
    }
    pub fn relink(&self, link: RemoteRequests) {
        self.tab.relink(link);
    }
    pub fn adopt_cwd(&self, cwd: &str) -> bool {
        self.tab.adopt_cwd(cwd)
    }
    pub fn sleep(&self) -> Result<(), Fault> {
        Err(Fault::new(
            "unsupported_remote_sleep",
            "A remote tab cannot release the host's omp for local idle sleep",
        ))
    }
    /// Successful enqueue is not acknowledgement from the execution host.
    pub fn send_now(&self, frame: Value) -> Result<(), Fault> {
        self.tab
            .enqueue_side_channel(frame)
            .map(drop)
            .map_err(|error| error.fault)
    }
    pub fn send(&self, frame: Value) -> EffectFuture<'static, Result<(), Fault>> {
        match self.tab.enqueue_side_channel(frame) {
            Ok(operation) => self.finish(operation),
            Err(error) => Box::pin(async move { Err(error.fault) }),
        }
    }
    pub fn send_for_generation(
        &self,
        generation: u64,
        frame: Value,
    ) -> EffectFuture<'static, Result<(), Fault>> {
        self.finish(self.tab.side_channel_for_generation(generation, frame))
    }
    pub fn stock_for_generation(
        &self,
        generation: u64,
        command: Value,
    ) -> EffectFuture<'static, Result<Value, Fault>> {
        self.finish(
            self.tab
                .command_for_generation(generation, command, Duration::from_secs(8)),
        )
    }

    /// Shutdown can leave the original hosted execution alive; ordinary tab close does not.
    pub fn keep_on_host(&self) {
        self.keep_on_host.store(true, Ordering::Release);
    }
    pub(crate) fn keep_on_host_requested(&self) -> bool {
        self.keep_on_host.load(Ordering::Acquire)
    }
    pub fn dispose(&self) {
        self.tab.dispose(self.keep_on_host.load(Ordering::Acquire));
    }
    pub fn when_disposed(&self) -> Held {
        receipt(self.completion.clone())
    }
    pub fn before_response(&self) {
        self.sink.before_response();
    }
    pub fn remove_listeners(&self) {
        self.listening.store(false, Ordering::Release);
        self.sink.remove_listeners();
    }
    pub fn sync_settings(&self) {
        // The host owns every other omp preference, as in RemoteSidecar.syncReplyLanguage et al.
        self.tab.sync_image_generation();
    }

    /// TS RemoteSidecar's bridge exposes the capabilities probe only, not a tab.bridge protocol.
    fn bridge_request(
        &self,
        expected: Option<u64>,
        method: String,
    ) -> EffectFuture<'static, Result<Value, Fault>> {
        self.finish(self.tab.bridge(expected, method))
    }
}

impl crate::pool::application::Sidecar for Service {
    type Error = Fault;
    fn facts(&self) -> Value {
        Service::facts(self)
    }
    fn generation(&self) -> u64 {
        Service::generation(self)
    }
    fn bridge_connected(&self) -> bool {
        Service::bridge_connected(self)
    }
    fn before_response(&self) {
        Service::before_response(self);
    }
    fn start(&self) {
        Service::start(self);
    }
    fn restart(&self, session: Option<&str>) {
        Service::restart(self, session);
    }
    fn sleep(&self) -> Result<(), Fault> {
        Service::sleep(self)
    }
    fn adopt_cwd(&self, cwd: &str) -> bool {
        Service::adopt_cwd(self, cwd)
    }
    fn send_now(&self, frame: Value) -> Result<(), Fault> {
        Service::send_now(self, frame)
    }
    fn send(&self, frame: Value) -> EffectFuture<'_, Result<(), Fault>> {
        Service::send(self, frame)
    }
    fn stock(&self, command: Value) -> EffectFuture<'static, Result<Value, Fault>> {
        Service::stock(self, command)
    }
    fn send_for_generation(
        &self,
        generation: u64,
        frame: Value,
    ) -> EffectFuture<'static, Result<(), Fault>> {
        Service::send_for_generation(self, generation, frame)
    }
    fn stock_for_generation(
        &self,
        generation: u64,
        command: Value,
    ) -> EffectFuture<'static, Result<Value, Fault>> {
        Service::stock_for_generation(self, generation, command)
    }
    fn bridge_for_generation(
        &self,
        generation: u64,
        method: String,
        _params: Option<Value>,
        _timeout_ms: Option<u64>,
    ) -> EffectFuture<'static, Result<Value, Fault>> {
        self.bridge_request(Some(generation), method)
    }
    fn bridge(
        &self,
        method: String,
        _params: Option<Value>,
        _timeout_ms: Option<u64>,
    ) -> EffectFuture<'static, Result<Value, Fault>> {
        self.bridge_request(None, method)
    }
    /// This is the captured local actor receipt; Root must retain Released.local=false.
    fn exit_waiter(&self) -> EffectFuture<'static, Result<(), Fault>> {
        self.when_disposed()
    }
    fn remove_listeners(&self) {
        Service::remove_listeners(self);
    }
    fn dispose(&self) {
        Service::dispose(self);
    }
    fn sync_settings(&self) -> EffectFuture<'_, ()> {
        Service::sync_settings(self);
        Box::pin(async {})
    }
}

#[cfg(test)]
#[path = "native_sidecar_tests.rs"]
mod tests;
