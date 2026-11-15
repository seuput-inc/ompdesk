//! Native-entry tests with an in-memory lane fixture. They exercise the real coordinator, not the legacy Port.
//! Pool/process/artifact integration is a separate Base-owned gate.

use std::collections::HashMap;
use std::sync::Mutex as SyncMutex;

use ompdesk_app_contract::OwnerIssuer;
use tokio::sync::Notify;

use super::*;
use crate::autopilot::coordinator::{Facts, SidecarFacts, Source};
use crate::autopilot::host::{Notice, Relaunch, TurnStop};
use crate::autopilot::land_check::{Prepared, Shell};
use crate::autopilot::run::{Child, ChildRun, RunState, Settings};
use crate::autopilot::ship::PrInput;
use crate::autopilot::start::NewRun;
use crate::run::Runner;

struct Lane {
    owner: Owner,
    status: SyncMutex<Value>,
    events: SyncMutex<Vec<Value>>,
    guard: SyncMutex<Value>,
    guard_gate: SyncMutex<Option<Arc<Notify>>>,
    guard_entered: Notify,
}

impl Lane {
    fn record(&self, event: Value) {
        locked(&self.events).push(event);
    }
    fn count(&self, event: Value) -> usize {
        locked(&self.events)
            .iter()
            .filter(|seen| **seen == event)
            .count()
    }
}

fn unavailable<T: Send + 'static>(operation: &'static str) -> Fut<Result<T, Fault>> {
    Box::pin(async move { Err(Fault::new("fixture_unavailable", operation)) })
}

macro_rules! unused {
    ($($name:ident($($arg:ident:$ty:ty),*) -> $ret:ty;)*) => {$ (
        fn $name(&self,$($arg:$ty),*) -> Fut<Result<$ret,Fault>> {
            $(let _ = $arg;)*
            unavailable(stringify!($name))
        }
    )*};
}

impl Host for Lane {
    fn source(&self, owner: &Owner, tab: &str) -> Result<Source, Fault> {
        if owner != &self.owner || tab != "parent" {
            return Err(Fault::new("invalid_caller", "Not this lane's owner"));
        }
        Ok(Source {
            device: false,
            cwd: "/native-autopilot-fixture".into(),
        })
    }
    fn today(&self) -> String {
        "2026-11-14".into()
    }
    fn stock(&self, tab: String, command: Value) -> Fut<Result<Value, Fault>> {
        self.record(json!(["stock", tab, command]));
        Box::pin(async { Ok(json!({"success":true,"data":{}})) })
    }
    fn bridge(
        &self,
        tab: String,
        method: String,
        params: Value,
        _: Option<u64>,
    ) -> Fut<Result<Value, Fault>> {
        self.record(json!(["bridge", tab, method, params]));
        let (result, gate) = if method == "approval" {
            self.guard_entered.notify_one();
            (locked(&self.guard).clone(), locked(&self.guard_gate).take())
        } else {
            let mut status = locked(&self.status);
            if method == "set_state" {
                status
                    .as_object_mut()
                    .unwrap()
                    .extend(params.as_object().unwrap().clone());
            }
            (json!({"success":true,"data":status.clone()}), None)
        };
        Box::pin(async move {
            if let Some(gate) = gate {
                gate.notified().await;
            }
            Ok(result)
        })
    }
    fn facts(&self, _: String) -> Fut<Result<Option<Facts>, Fault>> {
        Box::pin(async {
            Ok(Some(Facts {
                busy: true,
                ..Facts::default()
            }))
        })
    }
    fn sidecar(&self, _: String) -> Fut<Result<Option<SidecarFacts>, Fault>> {
        Box::pin(async { Ok(None) })
    }
    fn ready_cancel(&self, tab: &str) {
        self.record(json!(["ready_cancel", tab]));
    }
    fn release(&self, tab: String) -> Fut<Result<(), Fault>> {
        self.record(json!(["release", tab]));
        Box::pin(async { Ok(()) })
    }
    fn note_stopped(&self, tab: &str) {
        self.record(json!(["note_stopped", tab]));
    }
    fn turn_stop(&self, stop: TurnStop) {
        self.record(json!(["turn_stop", stop.tab, stop.surface, stop.caller]));
    }
    fn answer(&self, tab: String, id: String, response: Value) -> Fut<Result<bool, Fault>> {
        self.record(json!(["answer", tab, id, response]));
        Box::pin(async { Ok(true) })
    }
    fn text(&self, key: String, _: Value) -> Fut<Result<String, Fault>> {
        Box::pin(async move { Ok(key) })
    }
    fn clear_queue(&self, tab: String) -> Fut<Result<(), Fault>> {
        self.record(json!(["clear_queue", tab]));
        Box::pin(async { Ok(()) })
    }
    fn relaunch(&self, tab: String) -> Fut<Result<Relaunch, Fault>> {
        self.record(json!(["relaunch", tab]));
        Box::pin(async { Ok(Relaunch::Now) })
    }
    fn notify(&self, tab: &str, notice: Notice) {
        self.record(json!(["notify", tab, notice]));
    }
    fn run_ended(&self, root: &str) {
        self.record(json!(["run_ended", root]));
    }
    fn log(&self, message: &str) {
        self.record(json!(["log", message]));
    }
    fn run_log(&self, message: &str, details: Value) {
        self.record(json!(["run_log", message, details]));
    }
    fn mirror(&self, event: Value) {
        self.record(json!(["mirror", event]));
    }
    fn child_run(&self, tab: &str, run: Option<(String, String)>) {
        self.record(json!(["child_run", tab, run]));
    }
    unused! {
        git_runner() -> Runner;
        gh_runner() -> Option<Runner>;
        ready(tab:String) -> ();
        dispatch(owner:Owner,tab:String,command:Value,timeout_ms:u64) -> Value;
        spawn_tab(owner:Owner,payload:Value) -> Value;
        pr_create(cwd:String,input:PrInput) -> (String,i64);
        prepare_worktree(primary:String,tree:String) -> Prepared;
        land_shell(command:String) -> Shell;
    }
}

fn fixture() -> (Arc<Service>, Arc<Lane>, Arc<Run>) {
    fixture_with_status("status")
}

fn fixture_with_status(status_method: &str) -> (Arc<Service>, Arc<Lane>, Arc<Run>) {
    // This issuer stands for Base's authenticated registry only in this isolated fixture.
    let owner = OwnerIssuer::new(17).admit_authenticated().unwrap();
    let settings =
        json!({"ship":{"autoPush":false,"remote":"origin","autoRelease":{"on":false}},"limits":{}});
    let lane = Arc::new(Lane {
        owner,
        status: SyncMutex::new(
            json!({"active":true,"state":"running","role":"parent","settings":settings,"cycles":[]}),
        ),
        events: SyncMutex::default(),
        guard: SyncMutex::new(json!({"success":true,"data":{"reason":null}})),
        guard_gate: SyncMutex::default(),
        guard_entered: Notify::new(),
    });
    let bridge: HashMap<&str, &str> = [
        "arm",
        "approval",
        "status",
        "configure",
        "note",
        "dismiss",
        "setState",
        "shipAction",
        "markReverted",
        "takeShipRequests",
        "cycleAmend",
        "disarm",
        "guide",
    ]
    .into_iter()
    .map(|name| {
        (
            name,
            match name {
                "setState" => "set_state",
                "status" => status_method,
                _ => name,
            },
        )
    })
    .collect();
    let contracts: Contracts = serde_json::from_value(json!({
        "bridge":bridge,"objective":"fixture","guideFile":"AUTOPILOT.md","guideCommitMaxBytes":1000,
        "childTag":"autopilot-child","defaultShipPolicy":settings["ship"],"noLimits":{},"presets":{}
    }))
    .unwrap();
    let service = Service::new(
        lane.clone(),
        Config {
            contracts,
            tuning: Tuning::default(),
            quota_fallback_ms: 60_000.0,
            status_cycles: 30,
        },
    );
    let root = std::env::temp_dir()
        .join("native-autopilot-fixture-no-repository")
        .to_string_lossy()
        .into_owned();
    let run = service.coordinator.new_run(
        "parent",
        RunState::begin(NewRun {
            run: "run-1".into(),
            root: root.clone(),
            branch: "run-branch".into(),
            base_branch: "main".into(),
            checkout_root: root,
            target: None,
            land_to: None,
            settings: Settings(settings),
            release_procedure: None,
            release_blocked: None,
        }),
    );
    run.lock().status = Some(locked(&lane.status).clone());
    (service, lane, run)
}

async fn flush(service: &Service) {
    service
        .before_first_prompt("unrelated", "not-a-run", None, None)
        .await
        .unwrap();
    service.idle().await;
}

fn card() -> Value {
    json!({"type":"extension_ui_request","id":"request-1","method":"select","title":"Allow tool: bash\ngit status","options":["Approve","Deny"]})
}

fn answer(value: &str) -> Value {
    json!(["answer","parent","request-1",{"type":"extension_ui_response","id":"request-1","value":value}])
}

#[tokio::test]
async fn native_admission_uses_the_owner_not_command_json() {
    let (service, lane, _) = fixture();
    let other = OwnerIssuer::new(18).admit_authenticated().unwrap();
    let denied = service
        .command(
            other,
            "parent".into(),
            json!({"type":"get_autopilot","nativeOwner":lane.owner.id(),"source":{"device":false}}),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(denied, crate::local_dispatch::protocol::CommandError::Other(ref message) if message == "Not this lane's owner")
    );
    let status = service
        .command(
            lane.owner.clone(),
            "parent".into(),
            json!({"type":"get_autopilot","source":{"device":true,"cwd":"untrusted"}}),
        )
        .await
        .unwrap();
    assert_eq!(status["state"], "running");
    assert_eq!(status["ship"]["queue"], json!([]));
    service.close().await.unwrap();
}

#[tokio::test]
async fn approvals_require_a_live_guard_decision_and_fail_closed() {
    let (service, lane, _) = fixture();
    for (decision, expected) in [
        (json!({"success":true,"data":{"reason":null}}), "Approve"),
        (
            json!({"success":true,"data":{"reason":"forbidden"}}),
            "Deny",
        ),
        (json!({"success":true,"data":{}}), "Deny"),
        (
            json!({"success":false,"error":"bridge unavailable"}),
            "Deny",
        ),
    ] {
        locked(&lane.events).clear();
        *locked(&lane.guard) = decision;
        assert!(service.extension_ui("parent", card()));
        service.idle().await;
        assert_eq!(lane.count(answer(expected)), 1);
    }
    assert!(!service.extension_ui(
        "parent",
        json!({"id":"signin","method":"input","title":"Sign in"})
    ));
    assert!(!service.extension_ui(
        "parent",
        json!({"id":"control","method":"confirm","title":"[OMPdesk] Keep this tab?"})
    ));
    service.close().await.unwrap();
}

#[tokio::test]
async fn an_approval_guard_returning_after_release_cannot_authorize_the_old_run() {
    let (service, lane, _) = fixture();
    let gate = Arc::new(Notify::new());
    *locked(&lane.guard_gate) = Some(gate.clone());
    assert!(service.extension_ui("parent", card()));
    lane.guard_entered.notified().await;
    service.released("parent").unwrap();
    // The queued callback is an actor barrier, without waiting on the guard we deliberately held.
    service
        .before_first_prompt("unrelated", "not-a-run", None, None)
        .await
        .unwrap();
    gate.notify_one();
    service.idle().await;
    assert_eq!(lane.count(answer("Deny")), 1);
    assert!(!service.holds_limit_wait("parent"));
    service.close().await.unwrap();
}

#[tokio::test]
async fn stop_frames_clear_children_then_settle_and_release_them() {
    let (service, lane, run) = fixture();
    run.lock().children.push(Child {
        tab: "child".into(),
        branch: None,
        worktree: None,
        area: None,
    });
    locked(&service.coordinator.child_runs).insert(
        "child".into(),
        ChildRun {
            parent: "parent".into(),
            root: run.lock().root.clone(),
        },
    );
    service
        .frame(
            "parent",
            json!({"type":"autopilot_stop_requested","end":true,"reason":"user"}),
        )
        .unwrap();
    flush(&service).await;
    assert!(service.is_stopping("parent"));
    assert_eq!(lane.count(json!(["clear_queue", "child"])), 1);
    service
        .frame(
            "parent",
            json!({"type":"autopilot_settled","reason":"user"}),
        )
        .unwrap();
    flush(&service).await;
    assert_eq!(lane.count(json!(["stock","child",{"type":"abort"}])), 1);
    assert_eq!(lane.count(json!(["release", "child"])), 1);
    assert_eq!(
        lane.count(json!(["stock","parent",{"type":"set_goal","action":"drop"}])),
        1
    );
    assert!(locked(&service.coordinator.child_runs).is_empty());
    assert!(run.lock().children.is_empty());
    assert!(!run.ship.has_queued());
    assert!(!service.holds_limit_wait("parent"));
    service.close().await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn replacing_quota_wakes_retries_once_and_release_cancels_the_next_wake() {
    let (service, lane, run) = fixture();
    locked(&lane.status)["state"] = json!("waiting_quota");
    let at = now_ms() + 60_000;
    service.coordinator.arm_quota_wake(&run, at, false);
    service.coordinator.arm_quota_wake(&run, at, false);
    tokio::task::yield_now().await;
    tokio::time::advance(std::time::Duration::from_secs(61)).await;
    tokio::task::yield_now().await;
    service.idle().await;
    assert_eq!(lane.count(json!(["stock","parent",{"type":"retry"}])), 1);
    locked(&lane.status)["state"] = json!("waiting_quota");
    service
        .coordinator
        .arm_quota_wake(&run, now_ms() + 60_000, false);
    service.released("parent").unwrap();
    flush(&service).await;
    tokio::time::advance(std::time::Duration::from_secs(61)).await;
    tokio::task::yield_now().await;
    service.idle().await;
    assert_eq!(lane.count(json!(["stock","parent",{"type":"retry"}])), 1);
    service.close().await.unwrap();
}

#[tokio::test]
async fn readiness_then_restore_resumes_the_goal_only_once() {
    let (service, lane, _) = fixture();
    service.ready("parent").unwrap();
    flush(&service).await;
    service.resume_goal("parent").await.unwrap();
    assert_eq!(
        lane.count(json!(["stock","parent",{"type":"set_goal","action":"resume"}])),
        1
    );
    assert_eq!(lane.count(json!(["relaunch", "parent"])), 1);
    service.close().await.unwrap();
}

#[tokio::test]
async fn native_close_cancels_pending_work_and_rejects_late_admission() {
    let (service, _lane, run) = fixture();
    let (entered, started) = oneshot::channel();
    let work = run.steps.run("held", None, async move {
        let _ = entered.send(());
        std::future::pending::<()>().await;
    });
    started.await.unwrap();
    let ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let observed = ran.clone();
    let queued = run.steps.run("must not start", None, async move {
        observed.store(true, std::sync::atomic::Ordering::SeqCst);
    });
    let (a, b) = tokio::join!(service.close(), service.close());
    a.unwrap();
    b.unwrap();
    assert_eq!(run.steps.pending(), 0);
    assert!(matches!(work.await, super::super::steps::Ended::Failed(_)));
    assert!(matches!(
        queued.await,
        super::super::steps::Ended::Failed(_)
    ));
    assert!(!ran.load(std::sync::atomic::Ordering::SeqCst));
    assert!(!service.holds_limit_wait("parent"));
    assert_eq!(
        service.ready("parent").unwrap_err().code,
        "autopilot_closed"
    );
    assert!(!service.extension_ui("parent", card()));
}

#[tokio::test]
async fn an_unpolled_abort_receipt_cannot_select_a_new_run_of_the_same_tab() {
    let (service, lane, original) = fixture();
    let stopped = service.aborted("parent");
    let replacement = {
        let old = original.lock();
        RunState::begin(NewRun {
            run: "replacement-run".into(),
            root: old.root.clone(),
            branch: old.branch.clone(),
            base_branch: old.base_branch.clone(),
            checkout_root: old.checkout_root.clone(),
            target: old.target.clone(),
            land_to: old.land_to.clone(),
            settings: old.settings.clone(),
            release_procedure: None,
            release_blocked: None,
        })
    };
    let replacement = service.coordinator.new_run("parent", replacement);
    replacement.lock().children.push(Child {
        tab: "replacement-child".into(),
        branch: None,
        worktree: None,
        area: None,
    });
    stopped.await.unwrap();
    service.idle().await;
    assert!(service.coordinator.is_current(&replacement));
    assert_eq!(
        lane.count(json!(["stock","replacement-child",{"type":"abort"}])),
        0
    );
    assert_eq!(locked(&lane.status)["state"], "running");
    assert!(!replacement.lock().stopping);
    service.close().await.unwrap();
}

#[tokio::test]
async fn command_replies_preserve_explicit_domain_codes_but_not_incidental_effect_codes() {
    let (service, lane, _) = fixture();
    locked(&service.coordinator.runs).remove("parent");
    locked(&lane.status)["active"] = json!(false);
    let command: crate::local_dispatch::protocol::RpcCommand =
        serde_json::from_value(json!({"type":"set_autopilot","action":"pause","id":"original"}))
            .unwrap();
    let error = service
        .command(
            lane.owner.clone(),
            "parent".into(),
            serde_json::to_value(&command).unwrap(),
        )
        .await
        .unwrap_err();
    let explicit = serde_json::to_value(crate::local_dispatch::protocol::RpcResponse::local(
        &command,
        Err(error),
    ))
    .unwrap();
    assert_eq!(explicit["code"], "autopilot_no_run");
    assert_eq!(explicit["success"], false);
    service.close().await.unwrap();
    let error = service
        .command(
            lane.owner.clone(),
            "parent".into(),
            serde_json::to_value(&command).unwrap(),
        )
        .await
        .unwrap_err();
    let closed = serde_json::to_value(crate::local_dispatch::protocol::RpcResponse::local(
        &command,
        Err(error),
    ))
    .unwrap();
    assert_eq!(closed["success"], false);
    assert_eq!(closed["error"], "Autopilot is closed");
    assert!(closed.get("code").is_none());
}

#[cfg(unix)]
#[tokio::test]
async fn original_pool_admission_enqueues_without_host_source_reentry_and_binds_parent_bridge() {
    use crate::pool::application::native::dispatch::tests::Rig;
    let rig = Arc::new(tokio::sync::Mutex::new(
        Rig::new_with_bridge("autopilot-command-admission", 0x6175_746f_636d_6401).await,
    ));
    let (service, lane, _) = fixture_with_status("modes.autopilot_status");
    let running = Arc::clone(&rig);
    let actor = Arc::clone(&service);
    let scenario = tokio::spawn(async move {
        let mut rig = running.lock().await;
        rig.ready().await;
        let admission = rig.capture(crate::server::Scope::detached()).await;
        let settings = Settings(json!({"ship":{"autoPush":false,"remote":"origin","autoRelease":{"on":false}},"limits":{}}));
        actor.coordinator.new_run(&rig.world.spawn.tab, RunState::begin(NewRun {
            run:"admitted-run".into(), root:"/isolated/native-command".into(), branch:"run-branch".into(),base_branch:"main".into(),checkout_root:"/isolated/native-command".into(),target:None,land_to:None,settings,release_procedure:None,release_blocked:None,
        }));
        // Lane::source would reject this real World caller. The admitted entry never calls it.
        assert_ne!(admission.caller().owner, lane.owner);
        let status = actor.command_admitted(Arc::clone(&admission), Arc::clone(&rig.commands), json!({"type":"get_autopilot"})).await.unwrap();
        assert_eq!(status["ship"]["queue"], json!([]));
        let log = std::fs::read_to_string(&rig.world.child_log).unwrap();
        assert_eq!(log.lines().filter(|line| *line == "bridge modes.autopilot_status").count(), 1);
        let binding = super::super::native_request::Binding::new(
            Arc::clone(&admission),
            Arc::clone(&rig.commands),
        );
        let before = rig.world.stdin();
        let response = super::super::native_request::within(binding.clone(), actor.coordinator.port.stock(
            &rig.world.spawn.tab,
            json!({"type":"set_goal","tokenBudget":42}),
        )).await.unwrap();
        assert_eq!(response["success"], true);
        let response = super::super::native_request::within(binding, actor.coordinator.port.bridge(
            &rig.world.spawn.tab,
            "modes.autopilot_status",
            json!({}),
            Some(1000),
        )).await.unwrap();
        assert_eq!(response["type"], "response");
        assert_eq!(response["command"], "autopilot_bridge");
        assert_eq!(response["success"], true);
        assert_eq!(rig.world.stdin(), before, "local parent commands must never become stock input");
        let log = std::fs::read_to_string(&rig.world.child_log).unwrap();
        rig.world.callers.close_page(&ompdesk_app_contract::NativeCaller::Desktop {win_id:17,wc_id:117}).unwrap();
        let error = actor.command_admitted(admission, Arc::clone(&rig.commands), json!({"type":"get_autopilot"})).await.unwrap_err();
        assert_eq!(error.to_string(), "The original command admission has ended");
        assert_eq!(std::fs::read_to_string(&rig.world.child_log).unwrap(), log);
    }).await;
    let service_closed = service.close().await;
    let rig = Arc::try_unwrap(rig)
        .ok()
        .expect("scenario released original fixture")
        .into_inner();
    rig.close().await;
    service_closed.unwrap();
    scenario.unwrap();
}
