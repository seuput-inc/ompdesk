//! One schedule per ready stretch. The same service clock drives production and the test's manual timers.

use std::sync::{Arc, Weak};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use super::Service;
use crate::aimemory::client::Server;
use crate::server::{Fault, Scope};
use crate::upkeep::asks::Asker;

#[derive(Deserialize)]
pub(super) struct Clients {
    care: String,
    upkeep: String,
}

pub(super) struct Schedule {
    clients: Clients,
    service: Weak<Service>,
    active: Option<Scope>,
    repaired: bool,
}

impl Schedule {
    pub(super) fn new(clients: Clients, service: &Arc<Service>) -> Self {
        Self {
            clients,
            service: Arc::downgrade(service),
            active: None,
            repaired: false,
        }
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

#[derive(Clone, Copy)]
enum Work {
    Repair,
    Learn,
    Care,
}

impl Work {
    fn start(self, service: &Arc<Service>, epoch: &Scope, host: &Asker) {
        let (service, epoch, host) = (Arc::clone(service), epoch.clone(), host.clone());
        tokio::spawn(async move {
            let mut closed = service.closed.subscribe();
            let minutes = match self {
                Self::Repair => 10,
                Self::Learn => 5,
                Self::Care => 30,
            };
            let scope = Scope::detached();
            let bounded = tokio::time::timeout(
                Duration::from_secs(minutes * 60),
                self.run(&service, &epoch, &host, &scope),
            );
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
                Self::Care => host.log("care-failed", json!({ "unit": "tick", "detail": detail })),
                Self::Repair | Self::Learn => host.log(
                    "failed",
                    json!({ "step": if matches!(self, Self::Repair) { "retitle" } else { "learn" }, "detail": detail }),
                ),
            }
        });
    }

    async fn run(
        self,
        service: &Service,
        epoch: &Scope,
        host: &Asker,
        scope: &Scope,
    ) -> Result<(), Fault> {
        let settings = tokio::select! {
            biased;
            () = epoch.on_cancel() => return Ok(()),
            settings = host.ask("settings", Value::Null) => settings?,
        };
        // Pause withdraws unstarted work, even after another ready. Once admitted, a unit must persist its undo journal.
        let server = {
            let mut inner = service.inner();
            if inner.disposed || inner.state.phase != "ready" || epoch.cancelled() {
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
