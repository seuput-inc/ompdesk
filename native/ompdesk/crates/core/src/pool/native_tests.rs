use super::*;
use crate::pool::application::{Released, Spawn, asks::Collaborators};

struct TestHost {
pub(crate) struct TestHost<S: Sidecar<Error = Fault> + 'static = crate::sidecar::native::Service> {
    listening: Mutex<Vec<i64>>,
    announcements: Mutex<Vec<(Value, Value, Option<u64>)>>,
    running_changes: std::sync::atomic::AtomicUsize,
}

impl super::super::Host for TestHost {
    type Sidecar = crate::sidecar::native::Service;
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
    fn released(&self, _: Released) {
        unreachable!()
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
    fn running_changed(&self) {
        self.running_changes.fetch_add(1, Ordering::SeqCst);
    }
    fn session_files_changed(&self) {
        unreachable!()
    }
    fn window_tabs_changed(&self, _: i64, _: Value) {
        unreachable!()
    }
    fn exiting(&self, _: String) -> EffectFuture<'_, ()> {
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
            crate::agentctl::service::host::Deadline::Default,
}

impl<S: Sidecar<Error = Fault> + 'static> effects::Host for TestHost<S> {
    fn notify(&self, notification: effects::Notification) {
        match notification {
            effects::Notification::ListenClosed { window } => locked(&self.listening).push(window),
            effects::Notification::Send { .. } | effects::Notification::SettleWatch { .. } => {}
            _ => unreachable!(),
        }
    }
}

impl Host for TestHost {
    type Reservation = ();
    fn window_for(&self, _: &Owner) -> Result<i64, Fault> {
        unreachable!()
    }
    fn reserve_owner(&self, _: &Owner, _: &str) -> Result<(), Fault> {
        unreachable!()
    fn window_for(&self, owner: &Owner) -> Result<i64, Fault> {
        self.presentation_for(owner)?.ok_or_else(closed)
    }
            self.presentation_for(owner)?,
    }
    fn finish_reservation(&self, _: Self::Reservation, _: bool) {
        unreachable!()
    }
    fn authorize_tab(&self, _: &Owner, _: &str) -> Result<(), Fault> {
        unreachable!()
    }
    fn when_released(&self, _: String) -> EffectFuture<'static, ()> {
        unreachable!()
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
