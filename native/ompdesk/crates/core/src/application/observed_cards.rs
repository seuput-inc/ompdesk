//! Native host-observed cards. The transport reply is evidence only while its original source, card,
//! connection and recipient still pass their existing authorities in the synchronous keep effect.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use ompdesk_app_contract::Owner;
use serde_json::{Value, json};

use crate::pool::application::native::{Host as PoolHost, ObservedTargets, Service as Pool};
use crate::remote::application_devices::{Host as DeviceHost, Service as Devices};
use crate::remote::native_sidecar::Service as RemoteSource;
use crate::remote::requests::RemoteRequests;
use crate::server::Fault;

use super::prefs::Prefs;
use super::session_authority::SessionAuthority;
use super::source::Source;

pub(crate) struct Service<P: PoolHost<Sidecar = Source>, D: DeviceHost> {
    pool: Arc<Pool<P>>,
    devices: Arc<Devices<D>>,
    prefs: Arc<Prefs>,
    authority: Arc<SessionAuthority>,
    observer_host: Arc<str>,
}

/// No Deserialize or public constructor. Neither a UI ask nor JSON producer fields issue this proof.
pub(crate) struct RemoteCard<P: PoolHost<Sidecar = Source>, D: DeviceHost> {
    service: Arc<Service<P, D>>,
    targets: Arc<ObservedTargets<Source>>,
    remote: Arc<RemoteSource>,
    connection: RemoteRequests,
    generation: u64,
    omp: String,
    rtab: String,
}

/// Borrowed only inside the final, non-async admission. The caller must persist its own source obligation
/// there; a later transport loss does not withdraw an already accepted durable obligation.
pub(crate) struct VerifiedCard<'a> {
    _admitted: (),
    pub observer_host: &'a str,
    pub execution_owner: &'a Owner,
    pub source_incarnation: u64,
    pub source_generation: u64,
    pub recipient_owner: &'a Owner,
    pub subject_title: &'a str,
    pub subject_task: Option<&'a str>,
    pub subject_tab: &'a str,
    pub subject_host: &'a str,
    pub subject_path: &'a str,
    pub omp_epoch: &'a str,
    pub card_id: &'a str,
    pub request: &'a Value,
    pub recipient_host: Option<&'a str>,
    pub recipient_path: &'a str,
    pub recipient_tab: &'a str,
}

fn changed() -> Fault {
    Fault::new(
        "observed_card_changed",
        "The original remote question or its recipient has changed",
    )
}

impl<P: PoolHost<Sidecar = Source>, D: DeviceHost> Service<P, D> {
    pub(crate) fn new(
        pool: Arc<Pool<P>>,
        devices: Arc<Devices<D>>,
        prefs: Arc<Prefs>,
        authority: Arc<SessionAuthority>,
        observer_host: Arc<str>,
    ) -> Arc<Self> {
        Arc::new(Self {
            pool,
            devices,
            prefs,
            authority,
            observer_host,
        })
    }

    pub(crate) async fn capture(
        self: &Arc<Self>,
        child_owner: &Owner,
        child_tab: &str,
        recipient_tab: &str,
        card_id: &str,
    ) -> Result<RemoteCard<P, D>, Fault> {
        let targets = self
            .pool
            .capture_observed_targets(child_owner, child_tab, card_id, recipient_tab)?
            .await?;
        let remote = targets.child.source.remote().cloned().ok_or_else(changed)?;
        let host = targets.child.device.as_deref().ok_or_else(changed)?;
        let run = remote.remote_tab().observed_run()?;
        if run.path != targets.child.path || run.generation != targets.source_generation {
            return Err(changed());
        }
        let rtab = self
            .devices
            .observed_tab_id(host, remote.remote_tab(), &run.connection)?;
        let reply = run
            .connection
            .request(
                "tab.observeCard",
                json!({
                    "rtab":rtab,"expectedOmp":run.omp,"cardId":card_id,
                }),
                Duration::from_secs(8),
            )
            .await
            .map_err(|error| error.fault)?;
        if reply["sessionPath"].as_str() != Some(targets.child.path.as_str())
            || reply["ompEpoch"].as_str() != Some(run.omp.as_str())
            || reply["cardId"].as_str() != Some(targets.card_id.as_str())
            || reply.get("request") != Some(&targets.request)
        {
            return Err(changed());
        }
        let card = RemoteCard {
            service: Arc::clone(self),
            targets,
            remote,
            connection: run.connection,
            generation: run.generation,
            omp: run.omp,
            rtab,
        };
        card.admit(|_| Ok(())).await?;
        Ok(card)
    }
}

impl<P: PoolHost<Sidecar = Source>, D: DeviceHost> RemoteCard<P, D> {
    pub(crate) async fn admit<T: Send + 'static>(
        &self,
        effect: impl FnOnce(&VerifiedCard<'_>) -> Result<T, Fault> + Send + 'static,
    ) -> Result<T, Fault> {
        let service = Arc::clone(&self.service);
        let remote = Arc::clone(&self.remote);
        let connection = self.connection.clone();
        let generation = self.generation;
        let omp = self.omp.clone();
        let rtab = self.rtab.clone();
        self.service
            .pool
            .admit_observed_targets(Arc::clone(&self.targets), move |targets| {
                let host = targets.child.device.as_deref().ok_or_else(changed)?;
                service.devices.admit_tab_observation(
                    host,
                    &rtab,
                    remote.remote_tab(),
                    &connection,
                    || {
                        remote.remote_tab().admit_observation(
                            generation,
                            &targets.child.path,
                            &omp,
                            &connection,
                            || {
                                service.prefs.with_snapshot(|prefs| {
                                    if prefs["agentControl"] == false
                                        || (targets.recipient.device.is_none()
                                            && prefs["sidebar"]["agentHidden"]
                                                .as_array()
                                                .is_some_and(|hidden| {
                                                    hidden.iter().any(|path| {
                                                        path.as_str()
                                                            == Some(targets.recipient.path.as_str())
                                                    })
                                                }))
                                    {
                                        return Err(Fault::new(
                                            "agent_control_forbidden",
                                            "The recipient does not permit agent observation",
                                        ));
                                    }
                                    service
                                        .authority
                                        .admit_all(
                                            &[
                                                (
                                                    Path::new(&targets.child.path),
                                                    targets.child.device.as_deref(),
                                                ),
                                                (
                                                    Path::new(&targets.recipient.path),
                                                    targets.recipient.device.as_deref(),
                                                ),
                                            ],
                                            || {
                                                effect(&VerifiedCard {
                                                    _admitted: (),
                                                    observer_host: &service.observer_host,
                                                    execution_owner: &targets.child.owner,
                                                    source_incarnation: targets.child.incarnation,
                                                    source_generation: generation,
                                                    recipient_owner: &targets.recipient.owner,
                                                    subject_title: &targets.child_title,
                                                    subject_task: targets.child_task.as_deref(),
                                                    subject_tab: &targets.child.tab,
                                                    subject_host: host,
                                                    subject_path: &targets.child.path,
                                                    omp_epoch: &omp,
                                                    card_id: &targets.card_id,
                                                    request: &targets.request,
                                                    recipient_host: targets
                                                        .recipient
                                                        .device
                                                        .as_deref(),
                                                    recipient_path: &targets.recipient.path,
                                                    recipient_tab: &targets.recipient.tab,
                                                })
                                            },
                                        )
                                        .map_err(|_| changed())?
                                })
                            },
                        )
                    },
                )
            })
            .await
    }
}

#[cfg(all(test, unix))]
#[path = "observed_cards_tests.rs"]
mod tests;
