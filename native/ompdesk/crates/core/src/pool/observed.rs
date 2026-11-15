//! Host-observed cards retain the original two pool entries and source Arcs. No wire fields issue this handle.

use std::sync::Arc;

use ompdesk_app_contract::Owner;
use serde::Deserialize;
use serde_json::Value;

use super::{Application, EffectFuture, Host, Service, Sidecar};
use crate::agentctl::service::text::is_agent_card;
use crate::agentctl::service::types::{ControlAsk, UiRequest};
use crate::pool::state::Ctx;
use crate::server::Fault;

pub(crate) struct ObservedSession<S: Sidecar + ?Sized> {
    pub owner: Owner,
    pub tab: String,
    pub source: Arc<S>,
    pub incarnation: u64,
    pub path: String,
    pub device: Option<String>,
}

pub(crate) struct ObservedTargets<S: Sidecar + ?Sized> {
    pub child: ObservedSession<S>,
    pub recipient: ObservedSession<S>,
    pub card_id: String,
    pub source_generation: u64,
    pub request: Value,
    pub child_title: String,
    pub child_task: Option<String>,
}

fn stale() -> Fault {
    Fault::new(
        "observed_card_changed",
        "The original question, execution or recipient has changed",
    )
}

fn capture_session<H: Host>(
    ctx: &Ctx,
    app: &Application<H>,
    owner: Owner,
    tab: &str,
) -> Result<ObservedSession<H::Sidecar>, Fault> {
    let source = app.sidecar(tab).ok_or_else(stale)?;
    ctx.with(|pool| {
        let entry = pool.entry(tab).ok_or_else(stale)?;
        Ok(ObservedSession {
            owner,
            tab: tab.to_owned(),
            source,
            incarnation: entry.seq,
            path: entry
                .session_file
                .clone()
                .filter(|path| !path.is_empty())
                .ok_or_else(stale)?,
            device: entry.device.clone(),
        })
    })
}

fn current<H: Host>(ctx: &Ctx, app: &Application<H>, target: &ObservedSession<H::Sidecar>) -> bool {
    app.sidecar(&target.tab)
        .is_some_and(|source| Arc::ptr_eq(&source, &target.source))
        && ctx.with(|pool| {
            pool.entry(&target.tab).is_some_and(|entry| {
                entry.seq == target.incarnation
                    && entry.session_file.as_deref() == Some(target.path.as_str())
                    && entry.device == target.device
            })
        })
}

fn card<'a>(
    pool: &'a crate::pool::state::Pool,
    targets: &ObservedTargets<impl Sidecar + ?Sized>,
) -> Result<&'a Value, Fault> {
    if pool.request_owners.get(&targets.card_id) != Some(&targets.child.incarnation)
        || pool.answering.contains(&targets.card_id)
        || pool.sign_in_requests.contains(&targets.card_id)
    {
        return Err(stale());
    }
    let held = pool
        .request_bodies
        .get(&targets.card_id)
        .ok_or_else(stale)?;
    if !held.kinds.blocking
        || held.kinds.sign_in
        || held.source_generation != Some(targets.source_generation)
    {
        return Err(stale());
    }
    Ok(&held.request)
}

fn family(ctx: &Ctx, child: &str, recipient: &str, recipient_path: &str) -> bool {
    child != recipient
        && ctx.with(|pool| {
            pool.entry(child).is_some_and(|entry| {
                entry.opened_by.as_deref() == Some(recipient)
                    || entry.opened_by_session.as_deref() == Some(recipient_path)
            })
        })
}

impl<H: Host> Service<H> {
    pub(crate) fn capture_observed_targets(
        &self,
        child_owner: &Owner,
        child_tab: &str,
        card_id: &str,
        recipient_tab: &str,
    ) -> Result<EffectFuture<'static, Result<Arc<ObservedTargets<H::Sidecar>>, Fault>>, Fault> {
        let child_owner = child_owner.clone();
        let recipient_owner = self.callers.execution_owner(recipient_tab)?;
        let child_tab = child_tab.to_owned();
        let recipient_tab = recipient_tab.to_owned();
        let card_id = card_id.to_owned();
        let callers = Arc::clone(&self.callers);
        let app = Arc::clone(&self.app);
        Ok(self.execute_typed(move |ctx| {
            Box::pin(async move {
                callers.admit_execution_pair(
                    (&child_owner, &child_tab),
                    (&recipient_owner, &recipient_tab),
                    || {
                        let child = capture_session(&ctx, &app, child_owner.clone(), &child_tab)?;
                        let recipient =
                            capture_session(&ctx, &app, recipient_owner.clone(), &recipient_tab)?;
                        if child.device.is_none()
                            || !family(&ctx, &child_tab, &recipient_tab, &recipient.path)
                        {
                            return Err(stale());
                        }
                        let mut targets = ObservedTargets {
                            child,
                            recipient,
                            source_generation: ctx
                                .with(|pool| {
                                    pool.request_bodies
                                        .get(&card_id)
                                        .and_then(|held| held.source_generation)
                                })
                                .ok_or_else(stale)?,
                            card_id,
                            request: Value::Null,
                            child_title: String::new(),
                            child_task: None,
                        };
                        let (title, task) = ctx.with(|pool| {
                            let entry = pool
                                .entry(&targets.child.tab)
                                .expect("captured child remains in this hub step");
                            let title = entry
                                .title
                                .as_ref()
                                .and_then(Option::as_deref)
                                .filter(|title| !title.is_empty())
                                .or(entry.task.as_deref())
                                .unwrap_or("");
                            (title.to_owned(), entry.task.clone())
                        });
                        targets.child_title = title;
                        targets.child_task = task;
                        targets.request = ctx.with(|pool| {
                            let request = card(pool, &targets)?;
                            let typed = UiRequest::deserialize(request).map_err(|_| stale())?;
                            if is_agent_card(&ControlAsk {
                                id: targets.card_id.clone(),
                                request: typed,
                            }) {
                                return Err(stale());
                            }
                            Ok(request.clone())
                        })?;
                        Ok(Arc::new(targets))
                    },
                )
            })
        }))
    }

    /// The outer native observation gate also holds the original RemoteTab snapshot while this effect runs.
    /// Do not read that child's generation again here: it would reenter the same actor snapshot mutex.
    pub(crate) fn admit_observed_targets<T: Send + 'static>(
        &self,
        targets: Arc<ObservedTargets<H::Sidecar>>,
        effect: impl FnOnce(&ObservedTargets<H::Sidecar>) -> Result<T, Fault> + Send + 'static,
    ) -> EffectFuture<'static, Result<T, Fault>> {
        let callers = Arc::clone(&self.callers);
        let app = Arc::clone(&self.app);
        self.execute_typed(move |ctx| {
            Box::pin(async move {
                callers.admit_execution_pair(
                    (&targets.child.owner, &targets.child.tab),
                    (&targets.recipient.owner, &targets.recipient.tab),
                    || {
                        if !current(&ctx, &app, &targets.child)
                            || !current(&ctx, &app, &targets.recipient)
                            || !family(
                                &ctx,
                                &targets.child.tab,
                                &targets.recipient.tab,
                                &targets.recipient.path,
                            )
                            || !ctx.with(|pool| {
                                card(pool, &targets)
                                    .is_ok_and(|request| *request == targets.request)
                            })
                        {
                            return Err(stale());
                        }
                        effect(&targets)
                    },
                )
            })
        })
    }
}

impl<H: Host> Service<H> {
    /// Rendering an epoch is not admission; effects still recheck this target and the captured run.
    pub fn omp_epoch(
        &self,
        target: &super::ExecutionTarget<H::Sidecar>,
        generation: u64,
    ) -> String {
        run_token(&self.run_namespace, target.incarnation(), generation)
    }

    /// The hosted wire epoch is derived from the existing native pool incarnation and actual run.
    pub fn execution_omp(
        &self,
        target: &super::ExecutionTarget<H::Sidecar>,
    ) -> EffectFuture<'static, Result<String, Fault>> {
        let namespace = self.run_namespace.clone();
        let target = target.clone();
        let app = Arc::clone(&self.app);
        let callers = Arc::clone(&self.callers);
        self.execute_typed(move |ctx| {
            Box::pin(async move {
                callers.admit_execution(target.owner(), target.tab(), None, || {
                    let selected = super::peer_admission::selected(&ctx, &app, &target)?;
                    Ok(run_token(
                        &namespace,
                        target.incarnation(),
                        selected.generation,
                    ))
                })
            })
        })
    }
}

pub(super) fn run_token(namespace: &str, incarnation: u64, generation: u64) -> String {
    format!("run.{namespace}.{incarnation:x}.{generation:x}")
}

impl<H: Host> Service<H> {
    /// The execution host issues only its actual current question. Wire fields cannot bypass its policy.
    pub(crate) fn peer_observe_card(
        &self,
        owner: &Owner,
        connection: &crate::remote::requests::RemoteRequests,
        target: &super::ExecutionTarget<H::Sidecar>,
        expected_omp: String,
        card_id: String,
        prefs: Arc<crate::application::prefs::Prefs>,
        authority: Arc<crate::application::session_authority::SessionAuthority>,
    ) -> EffectFuture<'static, Result<crate::remote::application_host::CardObservation, Fault>>
    {
        let owner = owner.clone();
        let connection = connection.clone();
        let target = target.clone();
        let namespace = self.run_namespace.clone();
        let callers = Arc::clone(&self.callers);
        let app = Arc::clone(&self.app);
        self.execute_typed(move |ctx| {
            Box::pin(async move {
                callers.admit_peer_execution(&owner, &connection, target.owner(), || {
                    let selected = super::peer_admission::selected(&ctx, &app, &target)?;
                    let path = selected
                        .session_file
                        .as_deref()
                        .filter(|path| !path.is_empty())
                        .ok_or_else(stale)?;
                    if selected.device.is_some()
                        || run_token(&namespace, target.incarnation(), selected.generation)
                            != expected_omp
                    {
                        return Err(stale());
                    }
                    let local = app
                        .host
                        .local_source(selected.sidecar.as_ref())
                        .ok_or_else(stale)?;
                    local.admit_observation(selected.generation, || {
                        prefs.with_snapshot(|values| {
                            if values["agentControl"] == false
                                || values["sidebar"]["agentHidden"].as_array().is_some_and(
                                    |paths| {
                                        paths.iter().any(|hidden| hidden.as_str() == Some(path))
                                    },
                                )
                            {
                                return Err(Fault::new(
                                    "agent_control_forbidden",
                                    "This session does not permit agent observation",
                                ));
                            }
                            authority
                                .admit(std::path::Path::new(path), None, || {
                                    ctx.with(|pool| {
                                        if pool.request_owners.get(&card_id)
                                            != Some(&target.incarnation())
                                            || pool.answering.contains(&card_id)
                                            || pool.sign_in_requests.contains(&card_id)
                                        {
                                            return Err(stale());
                                        }
                                        let held =
                                            pool.request_bodies.get(&card_id).ok_or_else(stale)?;
                                        if !held.kinds.blocking
                                            || held.kinds.sign_in
                                            || held.source_generation != Some(selected.generation)
                                        {
                                            return Err(stale());
                                        }
                                        let request = UiRequest::deserialize(&held.request)
                                            .map_err(|_| stale())?;
                                        if is_agent_card(&ControlAsk {
                                            id: card_id.clone(),
                                            request,
                                        }) {
                                            return Err(stale());
                                        }
                                        Ok(crate::remote::application_host::CardObservation {
                                            session_path: path.to_owned(),
                                            omp_epoch: expected_omp,
                                            card_id,
                                            request: held.request.clone(),
                                        })
                                    })
                                })
                                .map_err(|_| stale())?
                        })
                    })
                })
            })
        })
    }
}
