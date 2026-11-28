//! Care and learning use ready stretches. Recall's ten-minute clock stays anchored to service open.

use std::path::PathBuf;
use std::sync::{Arc, Weak};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use super::Service;
use crate::aimemory::client::Server;
use crate::server::{Fault, Scope};
use crate::upkeep::asks::Asker;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Clients {
    care: String,
    upkeep: String,
    recall_terms_file: Option<PathBuf>,
}

pub(super) struct Schedule {
    clients: Clients,
    service: Weak<Service>,
    active: Option<Scope>,
    repaired: bool,
    recall_state: RecallState,
}

enum RecallState {
    Idle,
    Running,
    RunAgain,
}

impl Schedule {
    pub(super) fn care_name(&self) -> &str {
        &self.clients.care
    }

    pub(super) fn new(clients: Clients, service: &Arc<Service>) -> Self {
        if clients.recall_terms_file.is_some() {
            let service = Arc::clone(service);
            tokio::spawn(async move {
                let mut closed = service.closed.subscribe();
                tokio::select! {
                    biased;
                    _ = closed.wait_for(|closed| *closed) => (),
                    () = service.every(10 * 60_000, |service| {
                        if let Some(schedule) = &mut service.inner().quality {
                            schedule.recall(service);
                        }
                    }) => (),
                }
            });
        }
        Self {
            clients,
            service: Arc::downgrade(service),
            active: None,
            repaired: false,
            recall_state: RecallState::Idle,
        }
    }

    fn recall(&mut self, service: &Arc<Service>) {
        let (Some(file), Some(epoch)) = (&self.clients.recall_terms_file, &self.active) else {
            return;
        };
        if !matches!(self.recall_state, RecallState::Idle) {
            self.recall_state = RecallState::RunAgain;
            return;
        }
        self.recall_state = RecallState::Running;
        Work::Recall { file: file.clone() }.start(
            service,
            epoch,
            &Asker::new(&self.clients.upkeep, service.events.clone()),
        );
    }

    pub(super) fn ready(&mut self, ready: bool) {
        if !ready {
            if let Some(epoch) = self.active.take() {
                epoch.cancel();
            }
            return;
        }
        if self.active.is_some() {
            return;
        }
        let Some(service) = self.service.upgrade() else {
            return;
        };
        let epoch = Scope::detached();
        self.active = Some(epoch.clone());
        self.recall(&service);
        let care = Asker::new(&self.clients.care, service.events.clone());
        let upkeep = Asker::new(&self.clients.upkeep, service.events.clone());
        if !self.repaired {
            Work::Repair.start(&service, &epoch, &upkeep);
        }
        tokio::spawn(async move {
            let timers = async {
                tokio::join!(
                    async {
                        service.sleep(2 * 60_000).await;
                        Work::Learn.start(&service, &epoch, &upkeep);
                    },
                    async {
                        service.sleep(5 * 60_000).await;
                        Work::Care.start(&service, &epoch, &care);
                    },
                    service.every(15 * 60_000, |service| {
                        Work::Learn.start(service, &epoch, &upkeep);
                        Work::Care.start(service, &epoch, &care);
                    }),
                );
            };
            tokio::select! {
                biased;
                () = epoch.on_cancel() => (),
                () = timers => (),
            }
        });
    }
}

enum Work {
    Repair,
    Learn,
    Care,
    Recall { file: PathBuf },
}

impl Work {
    fn start(self, service: &Arc<Service>, epoch: &Scope, host: &Asker) {
        let (service, epoch, host) = (Arc::clone(service), epoch.clone(), host.clone());
        tokio::spawn(async move {
            let recall = matches!(self, Self::Recall { .. });
            self.execute(&service, &epoch, &host).await;
            if recall && let Some(schedule) = &mut service.inner().quality {
                let previous = std::mem::replace(&mut schedule.recall_state, RecallState::Idle);
                if matches!(previous, RecallState::RunAgain) {
                    schedule.recall(&service);
                }
            }
        });
    }

    async fn execute(mut self, service: &Service, epoch: &Scope, host: &Asker) {
        let mut closed = service.closed.subscribe();
        let timeout = match self {
            Self::Repair => Duration::from_secs(10 * 60),
            Self::Learn => Duration::from_secs(5 * 60),
            Self::Care => Duration::from_secs(30 * 60),
            Self::Recall { .. } => Duration::from_millis(i32::MAX as u64),
        };
        let scope = Scope::detached();
        let bounded = tokio::time::timeout(timeout, self.run(service, epoch, host, &scope));
        let result = tokio::select! {
            biased;
            _ = closed.wait_for(|closed| *closed) => {
                scope.cancel();
                return;
            }
            result = bounded => result,
        };
        let detail = match result {
            Ok(Ok(())) => return,
            Ok(Err(error)) => error.message,
            Err(_) => {
                scope.cancel();
                "Memory work timed out".to_owned()
            }
        };
        match self {
            Self::Recall { .. } => service.log("recall-terms-failed", json!({ "error": detail })),
            Self::Care => host.log("care-failed", json!({ "unit": "tick", "detail": detail })),
            Self::Repair | Self::Learn => host.log(
                "failed",
                json!({ "step": if matches!(self, Self::Repair) { "retitle" } else { "learn" }, "detail": detail }),
            ),
        }
    }

    async fn run(
        &mut self,
        service: &Service,
        epoch: &Scope,
        host: &Asker,
        scope: &Scope,
    ) -> Result<(), Fault> {
        // A pass admitted while ready may finish across a readiness change.
        let recall = matches!(self, Self::Recall { .. });
        let settings = tokio::select! {
            biased;
            () = epoch.on_cancel(), if !recall => return Ok(()),
            () = tokio::time::sleep(Duration::from_secs(30)), if recall => {
                return Err(Fault::new("memory_facts", "Memory recall stock host did not answer"));
            }
            settings = host.ask("settings", Value::Null) => settings?,
        };
        // Pause withdraws unstarted work, even after another ready. Once admitted, a unit must persist its undo journal.
        let server = {
            let mut inner = service.inner();
            if inner.disposed || (!recall && (inner.state.phase != "ready" || epoch.cancelled())) {
                return Ok(());
            }
            if matches!(self, Self::Repair) {
                let Some(schedule) = &mut inner.quality else {
                    return Ok(());
                };
                if std::mem::replace(&mut schedule.repaired, true) {
                    return Ok(());
                }
            }
            Server {
                url: inner.state.server_url.clone(),
                data_dir: inner.state.data_dir.clone(),
            }
        };
        match self {
            Self::Recall { file, .. } => {
                let stock_host = settings["stockHost"].as_str().ok_or_else(|| {
                    Fault::new("memory_facts", "Memory recall has no stock worker host")
                })?;
                crate::memsync::corpus::refresh(
                    std::mem::take(file),
                    server,
                    &service.events,
                    stock_host,
                    scope.clone(),
                )
                .await
            }
            Self::Care => {
                crate::care::scheduled_tick(&settings, server, &service.events, scope.clone()).await
            }
            Self::Repair | Self::Learn => {
                let repair = matches!(self, Self::Repair);
                // Main outlives the core. Only the core granted this launch's claim may start the repair.
                if repair && host.ask("claimRepair", Value::Null).await? != Value::Bool(true) {
                    return Ok(());
                }
                crate::upkeep::scheduled(&settings, server, &service.events, repair).await
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aimemory::service::{SERVICES, locked, open};
    use crate::server::{Call, Events};

    #[tokio::test(start_paused = true)]
    async fn a_tick_after_publication_survives_the_running_pass() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("recall-terms.json");
        let name = "recall-publication-test";
        let (events, _sender, mut frames) = Events::capture();
        let params = json!({
            "service": name,
            "quality": {"upkeep": name, "care": name, "recallTermsFile": file},
            "deps": {
                "platform":"win32", "arch":"x64", "automatic":false, "toolsDir":"", "noService":true,
                "home":"", "rootDir":"", "uid":0, "unitAsks":true, "codeRequirementAsks":false,
                "bunCheck":false, "beforeStart":false, "pollMs":0, "healthWaitMs":0,
                "retryDelaysMs":[], "stepMaxMs":0, "manual":true, "hubEntry":null,
                "builds":{"binaries":{}, "manifest":"", "version":"", "macStageKey":"", "requirement":""}
            }
        });
        open(&Call {
            params: serde_json::value::to_raw_value(&params).unwrap(),
            scope: Scope::detached(),
            bin: None,
            events,
        })
        .unwrap();
        let service = locked(&SERVICES).remove(name).unwrap();
        let trigger = || {
            let mut inner = service.inner();
            let schedule = inner.quality.as_mut().unwrap();
            schedule.active.get_or_insert_with(Scope::detached);
            schedule.recall(&service);
        };
        let mut settings = async || {
            while let Some(frame) = frames.recv().await {
                let event: Value = serde_json::from_slice(frame.parts().0).unwrap();
                if event["event"] == "upkeep.ask" && event["data"]["kind"] == "settings" {
                    return;
                }
            }
            panic!("service closed");
        };
        trigger();
        settings().await;
        // Hold the first pass at its host ask across publication and two ticks.
        std::fs::write(file, r#"{"store":"db1"}"#).unwrap();
        trigger();
        trigger();
        tokio::time::advance(Duration::from_secs(30)).await;
        tokio::time::timeout(Duration::from_secs(1), settings())
            .await
            .expect("a busy tick must start a fresh recall without another timer");
        service.close();
    }
}
