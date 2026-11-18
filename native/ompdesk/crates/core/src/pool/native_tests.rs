use super::*;
use crate::pool::application::{Released, Spawn, asks::Collaborators};

pub(crate) struct TestHost<S: Sidecar<Error = Fault> + 'static = crate::sidecar::native::Service> {
    callers: Option<Arc<Callers>>,
    listening: Mutex<Vec<i64>>,
    announcements: Mutex<Vec<(Value, Value, Option<u64>)>>,
    notifications: Mutex<Vec<effects::Notification>>,
    running_changes: std::sync::atomic::AtomicUsize,
    releases: Mutex<Vec<Released<S>>>,
    local: for<'a> fn(&'a S) -> Option<&'a crate::sidecar::native::Service>,
    fail_running: std::sync::atomic::AtomicBool,
    fail_window_tabs: std::sync::atomic::AtomicBool,
    retire_on_running: Mutex<Option<(Arc<Callers>, Owner)>>,
    command_seen: Mutex<Option<oneshot::Sender<()>>>,
    receipt_gate: Mutex<Option<oneshot::Receiver<Result<(), Fault>>>>,
    receipt_entered: Mutex<Option<oneshot::Sender<()>>>,
    on_gone: Mutex<Option<(Weak<Application<TestHost<S>>>, Arc<S>)>>,
    constructed: Mutex<Option<(Owner, String, Arc<S>)>>,
    spawned: Mutex<Vec<Spawn>>,
    attached: Mutex<Vec<&'static str>>,
}

impl<S: Sidecar<Error = Fault> + 'static> Default for TestHost<S> {
    fn default() -> Self {
        Self {
            callers: None,
            listening: Mutex::default(),
            announcements: Mutex::default(),
            notifications: Mutex::default(),
            running_changes: Default::default(),
            releases: Mutex::default(),
            local: |_| None,
            fail_running: Default::default(),
            fail_window_tabs: Default::default(),
            retire_on_running: Mutex::default(),
            command_seen: Mutex::default(),
            receipt_gate: Mutex::default(),
            receipt_entered: Mutex::default(),
            on_gone: Mutex::default(),
            constructed: Mutex::default(),
            spawned: Mutex::default(),
            attached: Mutex::default(),
        }
    }
}

pub(crate) fn test_host_for<S: Sidecar<Error = Fault> + 'static>(
    callers: Arc<Callers>,
    local: for<'a> fn(&'a S) -> Option<&'a crate::sidecar::native::Service>,
) -> Arc<TestHost<S>> {
    Arc::new(TestHost {
        callers: Some(callers),
        local,
        ..Default::default()
    })
}

pub(crate) fn test_host(callers: Arc<Callers>) -> Arc<TestHost> {
    test_host_for(callers, |source| Some(source))
}

pub(crate) fn take_notifications<S: Sidecar<Error = Fault> + 'static>(host: &TestHost<S>) -> Vec<effects::Notification> {
    std::mem::take(&mut *locked(&host.notifications))
}

#[test]
fn original_full_stream_metadata_is_required_before_notifying_the_host() {
    let host = Arc::new(TestHost::<crate::sidecar::native::Service>::default());
    let app = Arc::new(Application::new(Arc::clone(&host)));
    for view in [None, Some("")] {
        let mut item = json!({"k": "wireFull", "tab": "tab", "win": 17});
        if let Some(view) = view {
            item["viewId"] = json!(view);
        }
        drop(app.effect(&item));
        let notices = take_notifications(&host);
        assert!(
            matches!(notices.as_slice(), [effects::Notification::ProtocolFault(error)] if error.code == "unsupported_protocol")
        );
    }
    drop(app.effect(&json!({"k": "wireFull", "tab": "tab", "win": 17, "viewId": "original.1.0"})));
    let notices = take_notifications(&host);
    assert!(
        matches!(notices.as_slice(), [effects::Notification::WireFull { tab, window: 17, view_id }] if tab == "tab" && view_id.as_ref() == "original.1.0")
    );
}

pub(crate) fn set_test_source<S: Sidecar<Error = Fault> + 'static>(
    app: &Application<TestHost<S>>,
    tab: &str,
    source: Arc<S>,
) {
    app.handles().insert(
        super::super::HandleKey::Tab(tab.into()),
        super::super::Handle {
            sidecar: source,
            device: None,
        },
    );
}

fn page_owner(pool: &Service<TestHost>) -> Owner {
    pool.callers
        .admit_page(ompdesk_app_contract::NativeCaller::Desktop {
            win_id: 17,
            wc_id: 17,
        })
        .unwrap()
        .owner
}

impl<S: Sidecar<Error = Fault> + 'static> super::super::Host for TestHost<S> {
    type Sidecar = S;
    fn window(&self, _: i64) -> (bool, bool) {
        (false, false)
    }
    fn unknown_window(&self) -> Fault {
        Fault::new("window_unknown", "closed")
    }
    fn canonical_cwd(&self, cwd: &str) -> String {
        std::fs::canonicalize(cwd).expect("the fixture's real checkout").to_string_lossy().into_owned()
    }
    fn create(&self, spawn: &Spawn, _: bool) -> Result<Arc<Self::Sidecar>, Fault> {
        let (owner, tab, source) = locked(&self.constructed).take().expect("the actual LocalSources result");
        assert_eq!(owner, spawn.owner);
        assert_eq!(tab, spawn.tab);
        assert_eq!(self.callers.as_ref().unwrap().execution_facts(&owner).unwrap().window, spawn.window);
        locked(&self.spawned).push(Spawn {
            owner: spawn.owner.clone(), tab: spawn.tab.clone(), window: spawn.window,
            cwd: spawn.cwd.clone(), kind: spawn.kind.clone(), fresh: spawn.fresh,
            device: spawn.device.clone(), session_path: spawn.session_path.clone(),
            worktree: spawn.worktree.clone(), placeholder: spawn.placeholder, defer_start: spawn.defer_start,
        });
        Ok(source)
    }
    fn prepare_gate(&self, _: &Spawn, _: &Arc<Self::Sidecar>) {
        locked(&self.attached).push("prepare_gate");
    }
    fn wire_light(&self, _: &str, _: &Arc<Self::Sidecar>) {
        locked(&self.attached).push("wire_light");
    }
    fn track_summary(&self, _: &Arc<Self::Sidecar>) {
        locked(&self.attached).push("track_summary");
    }
    fn released(&self, release: Released<Self::Sidecar>) {
        locked(&self.releases).push(release);
    }
}

impl<S: Sidecar<Error = Fault> + 'static> Collaborators for TestHost<S> {
    fn error(&self, message: String) -> Fault {
        Fault::new("main_error", message)
    }
    fn spawn_owner(&self, tab: &str) -> Result<Owner, Fault> {
        self.callers.as_ref().ok_or_else(closed)?.execution_owner(tab)
    }
    fn blocked(&self, _: Option<&str>, _: Option<&str>, _: &str, _: bool) -> bool {
        false
    }
    fn acquired(&self, _: &str, _: Arc<Self::Sidecar>) {
        locked(&self.attached).push("acquired");
    }
    fn end_views(&self, _: &str, _: &[i64]) {
        unreachable!()
    }
    fn deleted_add(&self, _: &str, _: Option<&str>) {
        unreachable!()
    }
    fn self_device(&self) -> Option<String> {
        unreachable!()
    }
    fn snowflake(&self) -> String {
        unreachable!()
    }
    fn running_changed(&self) -> Result<(), Fault> {
        self.running_changes.fetch_add(1, Ordering::SeqCst);
        if let Some((callers, owner)) = locked(&self.retire_on_running).take() {
            callers.retire_execution(&owner);
        }
        if self.fail_running.load(Ordering::SeqCst) {
            return Err(Fault::new("observer_failed", "Running observer failed"));
        }
        Ok(())
    }
    fn session_files_changed(&self) {}
    fn window_tabs_changed(&self, _: i64, _: Value) -> Result<(), Fault> {
        if self.fail_window_tabs.load(Ordering::SeqCst) {
            return Err(Fault::new(
                "window_observer_failed",
                "Window observer failed",
            ));
        }
        Ok(())
    }
    fn exiting(&self, _: String) -> EffectFuture<'_, Result<(), Fault>> {
        unreachable!()
    }
    fn command(
        &self,
        sidecar: Arc<Self::Sidecar>,
        command: Value,
    ) -> EffectFuture<'static, Result<Value, Fault>> {
        let generation = sidecar.generation();
        self.command_for_generation(sidecar, generation, command)
    }
    fn command_for_generation(
        &self,
        sidecar: Arc<Self::Sidecar>,
        generation: u64,
        command: Value,
    ) -> EffectFuture<'static, Result<Value, Fault>> {
        if let Some(seen) = locked(&self.command_seen).take() {
            let _ = seen.send(());
        }
        crate::pool::application::Sidecar::stock_for_generation(
            sidecar.as_ref(),
            generation,
            command,
            crate::agentctl::service::host::Deadline::Default,
        )
    }
}

impl<S: Sidecar<Error = Fault> + 'static> effects::Host for TestHost<S> {
    fn notify(&self, notification: effects::Notification) {
        match notification {
            effects::Notification::ListenClosed { window } => locked(&self.listening).push(window),
            effects::Notification::Gone { tab } => {
                if let Some((app, replacement)) = locked(&self.on_gone).take()
                    && let Some(app) = app.upgrade()
                {
                    app.handles().insert(
                        super::super::HandleKey::Tab(tab),
                        super::super::Handle {
                            sidecar: replacement,
                            device: None,
                        },
                    );
                }
            }
            effects::Notification::Send { .. }
            | effects::Notification::SettleWatch { .. }
            | effects::Notification::ModelWaitForget { .. }
            | effects::Notification::SessionFile { .. } => {}
            notification => locked(&self.notifications).push(notification),
        }
    }
}

impl<S: Sidecar<Error = Fault> + 'static> Host for TestHost<S> {
    type Reservation = crate::application::callers::Reservation;
    fn local_source<'a>(
        &self,
        source: &'a Self::Sidecar,
    ) -> Option<&'a crate::sidecar::native::Service> {
        (self.local)(source)
    }
    fn presentation_for(&self, owner: &Owner) -> Result<Option<i64>, Fault> {
        match self.callers.as_ref().ok_or_else(closed)?.principal(owner)? {
            crate::application::callers::Principal::Page(
                ompdesk_app_contract::NativeCaller::Desktop { win_id, .. },
            ) => i64::try_from(win_id).map(Some).map_err(|_| closed()),
            crate::application::callers::Principal::Page(
                ompdesk_app_contract::NativeCaller::Web { window_id, .. },
            ) => Ok(Some(window_id)),
            crate::application::callers::Principal::Peer { .. } => Ok(None),
        }
    }
    fn window_for(&self, owner: &Owner) -> Result<i64, Fault> {
        self.presentation_for(owner)?.ok_or_else(closed)
    }
    fn reserve_owner(&self, owner: &Owner, tab: &str) -> Result<Self::Reservation, Fault> {
        self.callers.as_ref().ok_or_else(closed)?.reserve_execution(
            owner,
            tab,
            self.presentation_for(owner)?,
        )
    }
    fn finish_reservation(&self, reservation: Self::Reservation, acquired: bool) {
        self.callers
            .as_ref()
            .expect("reserved caller")
            .finish_execution_reservation(reservation, acquired);
    }
    fn authorize_tab(&self, _: &Owner, _: &str) -> Result<(), Fault> {
        Ok(())
    }
    fn when_released(
        &self,
        _: String,
        source: Arc<Self::Sidecar>,
    ) -> EffectFuture<'static, Result<(), Fault>> {
        let release = locked(&self.releases).pop();
        let gate = locked(&self.receipt_gate).take();
        let entered = locked(&self.receipt_entered).take();
        Box::pin(async move {
            let release =
                release.ok_or_else(|| Fault::new("missing_receipt", "No release receipt"))?;
            if !Arc::ptr_eq(&source, &release.source) {
                return Err(Fault::new(
                    "wrong_receipt",
                    "Release receipt names another sidecar",
                ));
            }
            release.exited.await?;
            if let Some(entered) = entered {
                let _ = entered.send(());
            }
            if let Some(gate) = gate {
                gate.await
                    .map_err(|_| Fault::new("receipt_lost", "Receipt gate dropped"))??;
            }
            Ok(())
        })
    }
    fn announce(&self, activity: Value, tabs: Value, outcome_id: Option<u64>) {
        locked(&self.announcements).push((activity, tabs, outcome_id));
    }
}

#[tokio::test]
async fn native_pool_finishes_effects_before_answer_and_keeps_seeded_host_identity() {
    let host = Arc::new(TestHost::<crate::sidecar::native::Service>::default());
    let service = Service::new(
        Config {
            id: 0x706f_6f6c_6170_7001,
            view_epoch: "native-test-1".into(),
            layout_version: 1,
            max_former_tab_ids: 8,
            stop_session_wait_ms: 60_000,
            window_tabs_hook: false,
            now_ms: || 1234,
            callers: Arc::new(Callers::new(1)),
            removal_claims: RemovalClaims::new(),
        },
        Arc::new(Application::new(Arc::clone(&host))),
    )
    .await
    .unwrap();
    service.call("seed", json!({"tabs": [
        {"tab": "local", "win": 17, "sessionFile": "/local/session.jsonl", "status": "asleep"},
        {"tab": "remote", "win": 17, "device": "peer", "sessionFile": "/host/session.jsonl", "status": "ready"}
    ]}), false).await.unwrap();
    assert_eq!(*locked(&host.listening), [17]);
    let rows = service.snapshot().await.unwrap();
    assert_eq!(rows[0]["tab"], "local");
    assert_eq!(rows[0]["device"], Value::Null);
    assert_eq!(rows[0]["sessionFile"], "/local/session.jsonl");
    assert_eq!(rows[1]["device"], "peer");
    assert_eq!(rows[1]["sessionFile"], "/host/session.jsonl");
    assert_eq!(rows[0]["facts"]["busy"], false);
    assert!(rows[0]["pendingPlan"].is_null());
    assert!(
        service
            .session_owner("/local/session.jsonl", None)
            .await
            .unwrap()["tabId"]
            == "local"
    );
    assert!(
        !service
            .session_running("/local/session.jsonl", None)
            .await
            .unwrap()
    );
    service.guard_plan("local", false).await.unwrap();
    assert!(
        !service
            .note_draft("local", 17, "set_next_prompt_draft", false)
            .await
            .unwrap()
    );
    assert!(
        !service
            .note_draft("local", 18, "set_next_prompt_draft", true)
            .await
            .unwrap()
    );
    assert!(
        service
            .note_draft("local", 17, "set_next_prompt_draft", true)
            .await
            .unwrap()
    );
    service
        .feed("local", "events", json!([{"type": "agent_start"}]), false)
        .await
        .unwrap();
    service.feed("local", "events", json!([{"type": "agent_end", "messages": [
        {"role": "assistant", "stopReason": "stop", "content": [{"type": "text", "text": "done"}]}
    ]}]), false).await.unwrap();
    service
        .execute(false, |ctx, _| {
            Outcome::Later(Box::pin(async move {
                ctx.announce_run("local").await?;
                Ok(Value::Null)
            }))
        })
        .await
        .unwrap();
    service
        .feed("local", "events", json!([{"type": "agent_start"}]), false)
        .await
        .unwrap();
    service.feed("local", "events", json!([{"type": "agent_end", "messages": [
        {"role": "assistant", "stopReason": "stop", "content": [{"type": "text", "text": "done"}]}
    ]}]), false).await.unwrap();
    {
        let announcements = locked(&host.announcements);
        assert_eq!(announcements[0].0["type"], "busy");
        assert_eq!(announcements[0].1[0]["facts"]["busy"], true);
        assert_eq!(announcements[0].1[0]["sessionFile"], "/local/session.jsonl");
        assert_eq!(announcements[1].0["type"], "idle");
        assert_eq!(announcements[1].1[0]["facts"]["busy"], false);
        assert_eq!(announcements[1].0["outcome"]["reply"], "done");
        assert_eq!(announcements[0].2, None);
        assert!(announcements[1].2.is_some());
        assert_eq!(announcements[1].2, announcements[2].2);
        assert_ne!(announcements[1].2, announcements[4].2);
        assert_eq!(host.running_changes.load(Ordering::SeqCst), 4);
    }
    let out = service.out;
    drop(service);
    let (send, recv) = oneshot::channel();
    hub::post(move || {
        let _ = send.send(out.open());
    });
    assert!(!recv.await.unwrap());
}

#[cfg(unix)]
pub(crate) struct SidecarSink;

#[cfg(unix)]
impl crate::sidecar::native::Sink for SidecarSink {
    fn event(&self, _: crate::sidecar::LaneEvent) {}
    fn before_response(&self) {}
    fn reply_barrier(&self) -> crate::sidecar::native::Held {
        Box::pin(async { Ok(()) })
    }
    fn remove_listeners(&self) {}
    fn sync_settings(&self) -> EffectFuture<'_, ()> {
        Box::pin(async {})
    }
}

#[cfg(unix)]
#[tokio::test]
async fn binding_checks_the_actual_source_before_mutating_the_pool_entry() {
    use crate::sidecar::native::{Config as SidecarConfig, DirectSpawn, Service as SidecarService};
    let host = Arc::new(TestHost::<crate::sidecar::native::Service>::default());
    let app = Arc::new(Application::new(host));
    let pool = Service::new(
        Config {
            id: 0x706f_6f6c_6170_7002,
            view_epoch: "native-test-2".into(),
            layout_version: 1,
            max_former_tab_ids: 8,
            stop_session_wait_ms: 60_000,
            window_tabs_hook: false,
            now_ms: || 1234,
            callers: Arc::new(Callers::new(1)),
            removal_claims: RemovalClaims::new(),
        },
        Arc::clone(&app),
    )
    .await
    .unwrap();
    pool.call("seed", json!({"tabs": [{"tab": "binding", "win": 17, "status": "asleep", "sessionFile": "/session.jsonl"}]}), false).await.unwrap();
    let (events_a, _output_a, _frames_a) = crate::server::Events::capture();
    let (events_b, _output_b, _frames_b) = crate::server::Events::capture();
    let config = |tab: &str| SidecarConfig {
        tab: tab.into(),
        seq: 0,
        cwd: ".".into(),
        fresh: true,
        event_filter: Vec::new(),
        bridge: false,
        ledger_file: None,
        start_slow_ms: None,
        entry_id_timeout_ms: None,
        tuning: None,
        session_path: None,
        is_new: Some(true),
    };
    let (old, old_held) = SidecarService::new(
        config("bind-old"),
        events_a,
        Arc::new(SidecarSink),
        Arc::new(DirectSpawn),
    )
    .unwrap();
    let (current, current_held) = SidecarService::new(
        config("bind-current"),
        events_b,
        Arc::new(SidecarSink),
        Arc::new(DirectSpawn),
    )
    .unwrap();
    app.handles().insert(
        super::super::HandleKey::Tab("binding".into()),
        super::super::Handle {
            sidecar: Arc::clone(&current),
            device: None,
        },
    );
    let owner = page_owner(&pool);
    let target = pool
        .session_target(&owner, "/session.jsonl", None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(target.tab, "binding");
    assert!(Arc::ptr_eq(&target.sidecar, &current));
    let mut stale_generation = target.clone();
    stale_generation.generation = stale_generation.generation.wrapping_add(1);
    assert!(
        pool.note_name_for_session(&owner, &stale_generation, "not current")
            .await
            .is_err()
    );
    let mut stale_incarnation = target.clone();
    stale_incarnation.incarnation = stale_incarnation.incarnation.wrapping_add(1);
    assert!(
        pool.note_name_for_session(&owner, &stale_incarnation, "not current")
            .await
            .is_err()
    );
    pool.note_name_for_session(&owner, &target, "captured name")
        .await
        .unwrap();
    assert_eq!(
        pool.facts("binding").await.unwrap()["title"],
        "captured name"
    );
    app.handles().insert(
        super::super::HandleKey::Tab("binding".into()),
        super::super::Handle {
            sidecar: Arc::clone(&old),
            device: None,
        },
    );
    assert!(
        pool.command_for_session(&owner, &target, json!({"type": "abort"}))
            .await
            .is_err()
    );
    assert!(pool.stop_session(&owner, &target).await.is_err());
    assert!(pool.close_session_tab(&owner, &target).await.is_err());
    assert!(
        pool.note_name_for_session(&owner, &target, "wrong source")
            .await
            .is_err()
    );
    assert!(
        pool.bridge_if_live(
            &owner,
            "binding",
            Arc::clone(&current),
            0,
            "worktree.create".into(),
            None,
            None
        )
        .await
        .is_err()
    );
    app.handles().insert(
        super::super::HandleKey::Tab("binding".into()),
        super::super::Handle {
            sidecar: Arc::clone(&current),
            device: None,
        },
    );
    assert!(
        pool.stock_if_live(
            &owner,
            "binding",
            Arc::clone(&current),
            u64::MAX,
            json!({"type": "get_state"})
        )
        .await
        .is_err()
    );
    assert!(
        !pool
            .bind_if_live(
                &owner,
                "binding",
                Arc::clone(&old),
                json!({"branch": "old"})
            )
            .await
            .unwrap()
    );
    let unchanged = pool
        .execute(false, |ctx, _| {
            Outcome::Now(Ok(ctx.with(|state| {
                state
                    .entry("binding")
                    .and_then(|entry| entry.worktree.clone())
                    .unwrap_or(Value::Null)
            })))
        })
        .await
        .unwrap();
    assert_eq!(unchanged, Value::Null);
    assert!(
        pool.bind_if_live(
            &owner,
            "binding",
            Arc::clone(&current),
            json!({"branch": "new"})
        )
        .await
        .unwrap()
    );
    let value = pool
        .execute(false, |ctx, _| {
            Outcome::Now(Ok(ctx.with(|state| {
                state
                    .entry("binding")
                    .and_then(|entry| entry.worktree.clone())
                    .unwrap_or(Value::Null)
            })))
        })
        .await
        .unwrap();
    assert_eq!(value, json!({"branch": "new"}));
    let admitted = pool
        .callers
        .admit_page(ompdesk_app_contract::NativeCaller::Desktop {
            win_id: 17,
            wc_id: 117,
        })
        .unwrap();
    let reservation = pool
        .callers
        .reserve_execution(&admitted.owner, "binding", Some(17))
        .unwrap();
    let execution = pool.callers.execution_owner("binding").unwrap();
    pool.callers.finish_execution_reservation(reservation, true);
    let generation = current.generation();
    assert!(
        pool.execution_note_stopped(
            &execution,
            "binding",
            Arc::clone(&current),
            generation.wrapping_add(1),
        )
        .await
        .is_err()
    );
    assert!(
        pool.execution_note_stopped(&execution, "binding", Arc::clone(&old), generation)
            .await
            .is_err()
    );
    let stopped = pool
        .execute(false, |ctx, _| {
            Outcome::Now(Ok(Value::Bool(
                ctx.with(|pool| pool.entry("binding").unwrap().tracking.stopped),
            )))
        })
        .await
        .unwrap();
    assert_eq!(stopped, Value::Bool(false));
    pool.execution_note_stopped(&execution, "binding", Arc::clone(&current), generation)
        .await
        .unwrap();
    let stopped = pool
        .execute(false, |ctx, _| {
            Outcome::Now(Ok(Value::Bool(
                ctx.with(|pool| pool.entry("binding").unwrap().tracking.stopped),
            )))
        })
        .await
        .unwrap();
    assert_eq!(stopped, Value::Bool(true));
    assert!(pool.callers.retire_execution(&execution));
    assert!(
        pool.execution_note_stopped(&execution, "binding", Arc::clone(&current), generation)
            .await
            .is_err()
    );
    old.dispose(std::time::Duration::ZERO);
    current.dispose(std::time::Duration::ZERO);
    old_held.await.unwrap();
    current_held.await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn detached_release_disposes_the_captured_lane_not_its_replacement() {
    use crate::sidecar::native::{Config as SidecarConfig, DirectSpawn, Service as SidecarService};
    let host = Arc::new(TestHost::<crate::sidecar::native::Service>::default());
    let app = Arc::new(Application::new(Arc::clone(&host)));
    let config = |tab: &str| SidecarConfig {
        tab: tab.into(),
        seq: 0,
        cwd: ".".into(),
        fresh: true,
        event_filter: Vec::new(),
        bridge: false,
        ledger_file: None,
        start_slow_ms: None,
        entry_id_timeout_ms: None,
        tuning: None,
        session_path: None,
        is_new: Some(true),
    };
    let (events_a, _output_a, _frames_a) = crate::server::Events::capture();
    let (events_b, _output_b, _frames_b) = crate::server::Events::capture();
    let (old, old_held) = SidecarService::new(
        config("release-old"),
        events_a,
        Arc::new(SidecarSink),
        Arc::new(DirectSpawn),
    )
    .unwrap();
    let (replacement, replacement_held) = SidecarService::new(
        config("release-new"),
        events_b,
        Arc::new(SidecarSink),
        Arc::new(DirectSpawn),
    )
    .unwrap();
    app.handles().insert(
        super::super::HandleKey::Tab("shared".into()),
        super::super::Handle {
            sidecar: Arc::clone(&old),
            device: None,
        },
    );
    assert!(
        app.effect(&json!({"k": "gone", "tab": "shared", "incarnation": 17}))
            .is_none()
    );
    app.handles().insert(
        super::super::HandleKey::Tab("shared".into()),
        super::super::Handle {
            sidecar: Arc::clone(&replacement),
            device: None,
        },
    );
    app.ask("dispose", &json!({"tab": "shared", "incarnation": 17}))
        .await
        .unwrap();
    let release = locked(&host.releases).pop().unwrap();
    assert!(Arc::ptr_eq(&release.source, &old));
    release.exited.await.unwrap();
    old_held.await.unwrap();
    app.handles().insert(
        super::super::HandleKey::Tab("already-closed".into()),
        super::super::Handle {
            sidecar: Arc::clone(&old),
            device: None,
        },
    );
    assert!(
        app.effect(&json!({"k": "gone", "tab": "already-closed", "incarnation": 18}))
            .is_none()
    );
    app.ask(
        "dispose",
        &json!({"tab": "already-closed", "incarnation": 18}),
    )
    .await
    .unwrap();
    let failed = locked(&host.releases).pop().unwrap();
    assert!(failed.exited.await.is_err());
    assert!(Arc::ptr_eq(&app.sidecar("shared").unwrap(), &replacement));
    replacement.barrier().await.unwrap();
    replacement.dispose(std::time::Duration::ZERO);
    replacement_held.await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn session_close_keeps_the_detached_source_when_the_tab_is_replaced() {
    use crate::sidecar::native::{Config as SidecarConfig, DirectSpawn, Service as SidecarService};
    let host = Arc::new(TestHost::<crate::sidecar::native::Service>::default());
    let app = Arc::new(Application::new(Arc::clone(&host)));
    let pool = Service::new(
        Config {
            id: 0x706f_6f6c_6170_7003,
            view_epoch: "native-test-3".into(),
            layout_version: 1,
            max_former_tab_ids: 8,
            stop_session_wait_ms: 60_000,
            window_tabs_hook: false,
            now_ms: || 1234,
            callers: Arc::new(Callers::new(1)),
            removal_claims: RemovalClaims::new(),
        },
        Arc::clone(&app),
    )
    .await
    .unwrap();
    pool.call("seed", json!({"tabs": [{"tab": "closing", "win": 17, "status": "asleep", "sessionFile": "/closing.jsonl"}]}), false).await.unwrap();
    let config = |tab: &str| SidecarConfig {
        tab: tab.into(),
        seq: 0,
        cwd: ".".into(),
        fresh: true,
        event_filter: Vec::new(),
        bridge: false,
        ledger_file: None,
        start_slow_ms: None,
        entry_id_timeout_ms: None,
        tuning: None,
        session_path: None,
        is_new: Some(true),
    };
    let (events_a, _output_a, _frames_a) = crate::server::Events::capture();
    let (events_b, _output_b, _frames_b) = crate::server::Events::capture();
    let (old, old_held) = SidecarService::new(
        config("close-engine-old"),
        events_a,
        Arc::new(SidecarSink),
        Arc::new(DirectSpawn),
    )
    .unwrap();
    let (replacement, replacement_held) = SidecarService::new(
        config("close-engine-new"),
        events_b,
        Arc::new(SidecarSink),
        Arc::new(DirectSpawn),
    )
    .unwrap();
    app.handles().insert(
        super::super::HandleKey::Tab("closing".into()),
        super::super::Handle {
            sidecar: Arc::clone(&old),
            device: None,
        },
    );
    *locked(&host.on_gone) = Some((Arc::downgrade(&app), Arc::clone(&replacement)));
    let owner = page_owner(&pool);
    let target = pool
        .session_target(&owner, "/closing.jsonl", None)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        pool.close_session_tab(&owner, &target).await.unwrap(),
        SessionRelease::Released(Ok(()))
    ));
    old_held.await.unwrap();
    assert!(Arc::ptr_eq(&app.sidecar("closing").unwrap(), &replacement));
    replacement.barrier().await.unwrap();
    replacement.dispose(std::time::Duration::ZERO);
    replacement_held.await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn observer_failure_still_disposes_and_waits_for_the_exact_receipt() {
    use crate::sidecar::native::{Config as SidecarConfig, DirectSpawn, Service as SidecarService};
    let host = Arc::new(TestHost::<crate::sidecar::native::Service>::default());
    let app = Arc::new(Application::new(Arc::clone(&host)));
    let pool = Service::new(
        Config {
            id: 0x706f_6f6c_6170_7004,
            view_epoch: "native-test-4".into(),
            layout_version: 1,
            max_former_tab_ids: 8,
            stop_session_wait_ms: 60_000,
            window_tabs_hook: false,
            now_ms: || 1234,
            callers: Arc::new(Callers::new(1)),
            removal_claims: RemovalClaims::new(),
        },
        Arc::clone(&app),
    )
    .await
    .unwrap();
    pool.call("seed", json!({"tabs": [{"tab": "fault-close", "win": 17, "status": "asleep", "sessionFile": "/fault.jsonl"}]}), false).await.unwrap();
    let (events, _output, _frames) = crate::server::Events::capture();
    let (source, held) = SidecarService::new(
        SidecarConfig {
            tab: "fault-close-lane".into(),
            seq: 0,
            cwd: ".".into(),
            fresh: true,
            event_filter: Vec::new(),
            bridge: false,
            ledger_file: None,
            start_slow_ms: None,
            entry_id_timeout_ms: None,
            tuning: None,
            session_path: None,
            is_new: Some(true),
        },
        events,
        Arc::new(SidecarSink),
        Arc::new(DirectSpawn),
    )
    .unwrap();
    app.handles().insert(
        super::super::HandleKey::Tab("fault-close".into()),
        super::super::Handle {
            sidecar: Arc::clone(&source),
            device: None,
        },
    );
    let (gate, gated) = oneshot::channel();
    let (entered, seen) = oneshot::channel();
    *locked(&host.receipt_gate) = Some(gated);
    *locked(&host.receipt_entered) = Some(entered);
    host.fail_running.store(true, Ordering::SeqCst);
    let owner = page_owner(&pool);
    let target = pool
        .session_target(&owner, "/fault.jsonl", None)
        .await
        .unwrap()
        .unwrap();
    let closing = tokio::spawn(pool.close_session_tab(&owner, &target));
    seen.await.unwrap();
    assert!(!closing.is_finished());
    gate.send(Err(Fault::new("exit_failed", "Exit proof failed")))
        .unwrap();
    let SessionRelease::Released(Err(error)) = closing.await.unwrap().unwrap() else {
        panic!("the committed release must retain its observer failure");
    };
    assert_eq!(error.code, "observer_failed");
    held.await.unwrap();
    assert!(app.sidecar("fault-close").is_none());
}

#[cfg(unix)]
#[tokio::test]
async fn window_observer_failure_after_disposal_still_waits_for_exit_result() {
    use crate::sidecar::native::{Config as SidecarConfig, DirectSpawn, Service as SidecarService};
    let host = Arc::new(TestHost::<crate::sidecar::native::Service>::default());
    let app = Arc::new(Application::new(Arc::clone(&host)));
    let pool = Service::new(
        Config {
            id: 0x706f_6f6c_6170_7005,
            view_epoch: "native-test-5".into(),
            layout_version: 1,
            max_former_tab_ids: 8,
            stop_session_wait_ms: 60_000,
            window_tabs_hook: true,
            now_ms: || 1234,
            callers: Arc::new(Callers::new(1)),
            removal_claims: RemovalClaims::new(),
        },
        Arc::clone(&app),
    )
    .await
    .unwrap();
    pool.call("seed", json!({"tabs": [{"tab": "window-fault", "win": 17, "status": "asleep", "sessionFile": "/window-fault.jsonl"}]}), false).await.unwrap();
    let (events, _output, _frames) = crate::server::Events::capture();
    let (source, held) = SidecarService::new(
        SidecarConfig {
            tab: "window-fault-lane".into(),
            seq: 0,
            cwd: ".".into(),
            fresh: true,
            event_filter: Vec::new(),
            bridge: false,
            ledger_file: None,
            start_slow_ms: None,
            entry_id_timeout_ms: None,
            tuning: None,
            session_path: None,
            is_new: Some(true),
        },
        events,
        Arc::new(SidecarSink),
        Arc::new(DirectSpawn),
    )
    .unwrap();
    app.handles().insert(
        super::super::HandleKey::Tab("window-fault".into()),
        super::super::Handle {
            sidecar: source,
            device: None,
        },
    );
    let (gate, gated) = oneshot::channel();
    let (entered, seen) = oneshot::channel();
    *locked(&host.receipt_gate) = Some(gated);
    *locked(&host.receipt_entered) = Some(entered);
    host.fail_window_tabs.store(true, Ordering::SeqCst);
    let owner = page_owner(&pool);
    let target = pool
        .session_target(&owner, "/window-fault.jsonl", None)
        .await
        .unwrap()
        .unwrap();
    let closing = tokio::spawn(pool.close_session_tab(&owner, &target));
    seen.await.unwrap();
    assert!(!closing.is_finished());
    gate.send(Err(Fault::new("exit_failed", "Exit proof failed")))
        .unwrap();
    let SessionRelease::Released(Err(error)) = closing.await.unwrap().unwrap() else {
        panic!("the committed release must retain its window observer failure");
    };
    assert_eq!(error.code, "window_observer_failed");
    held.await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn removal_claims_and_real_pool_acquire_share_one_atomic_admission() {
    let callers = Arc::new(Callers::new(91));
    let admitted = callers
        .admit_page(ompdesk_app_contract::NativeCaller::Desktop {
            win_id: 17,
            wc_id: 17,
        })
        .unwrap();
    let claims = RemovalClaims::new();
    let host = Arc::new(TestHost::<crate::sidecar::native::Service> {
        callers: Some(Arc::clone(&callers)),
        ..Default::default()
    });
    let pool = Service::new(
        Config {
            id: 0x706f_6f6c_6170_7006,
            view_epoch: "native-test-6".into(),
            layout_version: 1,
            max_former_tab_ids: 8,
            stop_session_wait_ms: 60_000,
            window_tabs_hook: false,
            now_ms: || 1234,
            callers: Arc::clone(&callers),
            removal_claims: Arc::clone(&claims),
        },
        Arc::new(Application::new(host)),
    )
    .await
    .unwrap();
    let cwd = std::env::current_dir()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let folder = Folder::resolve(cwd.clone()).await.unwrap();
    let guard = pool
        .claim_worktree(&admitted.owner, folder.clone(), Arc::clone(&claims))
        .await
        .unwrap();
    assert!(claims.holds(&folder));
    assert!(
        pool.claim_worktree(&admitted.owner, folder.clone(), RemovalClaims::new())
            .await
            .is_err()
    );
    let result = pool
        .acquire(
            &admitted.owner,
            Acquire {
                tab: "claim-blocked".into(),
                cwd,
                session_path: None,
                kind: "agent".into(),
                worktree: None,
                fresh: true,
                placeholder: false,
                defer_start: false,
                title: None,
                device: None,
                task: None,
                former_ids: None,
            },
        )
        .unwrap()
        .await
        .unwrap();
    assert_eq!(result, json!({"ok":false, "added":false}));
    assert!(callers.execution_owner("claim-blocked").is_err());
    drop(guard);
    assert!(!claims.holds(&folder));
    let guard = pool
        .claim_worktree(&admitted.owner, folder.clone(), Arc::clone(&claims))
        .await
        .unwrap();
    drop(guard);
    callers.revoke(&admitted.owner);
    assert!(pool.worktree_folders(&admitted.owner).await.is_err());
}

#[cfg(unix)]
#[path = "peer_admission_tests.rs"]
mod peer_admission;

#[cfg(unix)]
#[tokio::test]
async fn a_bound_peer_acquires_and_releases_a_real_local_source_without_a_page_window() {
    use futures_util::FutureExt;
    use std::panic::AssertUnwindSafe;
    use crate::application::launch_host::tests::concrete::World;
    use crate::application::local_sources::LocalSources;
    use crate::application::source::Source;
    use crate::sidecar::native::tests::{Recorder, ready_with};

    let mut world = World::new("headless-peer-pool-acquire").await;
    let (link, remote, _io) = crate::remote::requests::tests::pair().await;
    let peer = world.callers.admit_peer("headless-peer".into(), link.link_id().unwrap()).unwrap();
    world.callers.bind_peer_connection(&peer.owner, link.clone()).unwrap();
    assert!(world.callers.retire_execution(&world.owner));
    assert!(world.callers.finish_execution_retirement(&world.owner));
    let reservation = world.callers.reserve_execution(&peer.owner, &world.spawn.tab, None).unwrap();
    world.owner = world.callers.execution_owner(&world.spawn.tab).unwrap();
    world.callers.keep_execution(&world.owner).unwrap();
    world.callers.finish_execution_reservation(reservation, true);
    world.spawn.owner = world.owner.clone();
    world.spawn.window = None;
    world.spawn.defer_start = true;
    let factory = LocalSources::new(world.config.clone());
    let (events, mut received) = tokio::sync::mpsc::unbounded_channel();
    let created = factory.create(
        &world.spawn, "headless-peer-pool-source".into(),
        Arc::new(Recorder { events, flushes: Default::default() }), None, Default::default(),
    ).unwrap();
    let source = Arc::new(Source::from_local(created));
    let host = test_host_for(Arc::clone(&world.callers), |source: &Source| source.local().map(Arc::as_ref));
    *locked(&host.constructed) = Some((world.owner.clone(), world.spawn.tab.clone(), Arc::clone(&source)));
    let pool = Service::new(Config {
        id: 0x686561646c657373, view_epoch: "headless-peer-acquire".into(),
        layout_version: 1, max_former_tab_ids: 8, stop_session_wait_ms: 60_000,
        window_tabs_hook: true, now_ms: || 100, callers: Arc::clone(&world.callers),
        removal_claims: RemovalClaims::new(),
    }, Arc::new(Application::new(Arc::clone(&host)))).await.unwrap();
    let result = AssertUnwindSafe(async {
        let acquired = pool.acquire(&peer.owner, Acquire {
            tab: world.spawn.tab.clone(), cwd: world.spawn.cwd.clone(),
            session_path: world.spawn.session_path.clone(), kind: "agent".into(),
            worktree: None, fresh: false, placeholder: false, defer_start: true,
            title: None, device: None, task: None, former_ids: None,
        }).unwrap().await.unwrap();
        assert_eq!(acquired, json!({"ok":true,"added":true}));
        assert_eq!(locked(&host.spawned)[0].window, None);
        assert!(locked(&host.listening).is_empty());
        assert_eq!(pool.call("windowOfTab", json!({"tab":world.spawn.tab}), false).await.unwrap(), Value::Null);
        assert_eq!(pool.call("windowsShowingTab", json!({"tab":world.spawn.tab}), false).await.unwrap(), json!([]));
        assert_eq!(pool.session_owner(world.spawn.session_path.as_deref().unwrap(), None).await.unwrap()["winId"], Value::Null);
        assert_eq!(
            pool.call("foreignSessionOwner", json!({"path":world.spawn.session_path}), false).await.unwrap(),
            json!({"tabId":world.spawn.tab,"hosted":true}),
            "the canonical claim blocks another tab before HostServices publishes its hosted map",
        );
        pool.start(&world.owner, &world.spawn.tab).unwrap();
        ready_with(&mut received, |_| None).await;
        let target = pool.peer_execution_target(&peer.owner, &link, &world.spawn.tab).await.unwrap();
        assert_eq!(target.owner(), &world.owner);
        let generation = source.generation();
        assert_eq!(pool.execution_command(
            Arc::clone(&world.callers), &world.owner, &world.spawn.tab, Arc::clone(&source),
            None, ExecutionRun::Captured(generation), ExecutionCommand::Stock(json!({"type":"get_state"})),
        ).await.unwrap()["success"], true);
        assert_eq!(source.generation(), generation);
        pool.release_execution(Arc::clone(&world.callers), &world.owner, &world.spawn.tab, Arc::clone(&source)).await.unwrap();
        assert!(pool.snapshot().await.unwrap().as_array().unwrap().is_empty());
        assert_eq!(source.facts()["processAlive"], false);
        assert!(locked(&host.listening).is_empty());
    }).catch_unwind().await;
    let retired = source.retire().wait().await;
    let factory = factory.close().await;
    link.disconnect_for_test();
    remote.disconnect_for_test();
    world.begin_close();
    let closed = world.finish_close().await;
    if let Err(error) = result { std::panic::resume_unwind(error); }
    retired.unwrap();
    factory.unwrap();
    closed.unwrap();
}
