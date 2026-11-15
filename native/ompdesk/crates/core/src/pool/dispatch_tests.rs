//! Shared real services/Source/pool fixture. It never constructs a CommandAdmission or Owner by hand.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use ompdesk_app_contract::NativeCaller;
use serde_json::json;
use tokio::sync::mpsc;

use super::*;
use crate::agentctl::runtime::{RuntimeConfig, start};
use crate::agentctl::service::host::Caps;
use crate::agentctl::service::tuning::Tuning;
use crate::agentctl::service::{AgentControl, Files};
use crate::application::launch_host::tests::concrete::World;
use crate::application::local_sources::LocalSources;
use crate::application::source::Source;
use crate::pool::application::native::tests::{TestHost, set_test_source, test_host_for};
use crate::pool::application::native::{CapturedEvent, Config};
use crate::sidecar::native::tests::{Recorder, ready_with};
use crate::worktree_lifecycle::RemovalClaims;

pub(crate) struct Rig {
    pub world: World,
    pub factory: LocalSources,
    pub source: Arc<Source>,
    pub pool: Arc<Service<TestHost<Source>>>,
    pub caller: Admitted,
    pub events: mpsc::UnboundedReceiver<crate::sidecar::LaneEvent>,
    pub commands: Arc<crate::local_dispatch::Commands<crate::sidecar::native::Service>>,
}

impl Rig {
    pub async fn new(name: &str, id: u64) -> Self {
        Self::build(name, id, false, false).await
    }

    pub async fn new_with_bridge(name: &str, id: u64) -> Self {
        Self::build(name, id, true, false).await
    }

    pub async fn new_with_mail_barrier(name: &str, id: u64) -> Self {
        Self::build(name, id, true, true).await
    }

    async fn build(name: &str, id: u64, bridge: bool, mail_barrier: bool) -> Self {
        let mut world = World::new(name).await;
        world.config.bridge = bridge;
        let caller = world
            .callers
            .page(&NativeCaller::Desktop {
                win_id: 17,
                wc_id: 117,
            })
            .unwrap();
        let factory = LocalSources::new(world.config.clone());
        let (events, received) = mpsc::unbounded_channel();
        let created = factory
            .create(
                &world.spawn,
                format!("dispatch-fixture-{id}"),
                Arc::new(Recorder {
                    events,
                    flushes: AtomicUsize::new(0),
                }),
                None,
                if mail_barrier {
                    crate::machine::Environment::from([("OMPDESK_FAKE_MAIL_BARRIER".into(), "1".into())])
                } else {
                    Default::default()
                },
            )
            .unwrap();
        let source = Arc::new(Source::from_local(created));
        let app = Arc::new(Application::new(test_host_for(
            Arc::clone(&world.callers),
            |source: &Source| source.local().map(Arc::as_ref),
        )));
        let pool = Service::new(
            Config {
                id,
                view_epoch: format!("dispatch-fixture-{id}"),
                layout_version: 1,
                max_former_tab_ids: 8,
                stop_session_wait_ms: 60_000,
                window_tabs_hook: false,
                now_ms: || 100,
                callers: Arc::clone(&world.callers),
                removal_claims: RemovalClaims::new(),
            },
            Arc::clone(&app),
        )
        .await
        .unwrap();
        pool.call("seed",json!({"tabs":[{"tab":world.spawn.tab,"win":17,"status":"asleep","sessionFile":world.unwritten}]}),false).await.unwrap();
        set_test_source(&app, &world.spawn.tab, Arc::clone(&source));
        let commands = Arc::clone(source.local_commands().unwrap());
        Self {
            world,
            factory,
            source,
            pool,
            caller,
            events: received,
            commands,
        }
    }

    pub async fn ready(&mut self) {
        self.source.start();
        ready_with(&mut self.events, |_| None).await;
    }

    pub async fn capture(&self, scope: Scope) -> Arc<CommandAdmission<Source>> {
        self.pool
            .capture_page_command(
                self.caller.clone(),
                Some(self.world.spawn.tab.clone()),
                Some(Arc::from("rpc:command")),
                scope,
            )
            .await
            .unwrap()
    }

    pub async fn close(self) {
        let retired = self.source.retire().wait().await;
        let factory = self.factory.close().await;
        self.world.begin_close();
        let world = self.world.finish_close().await;
        retired.unwrap();
        factory.unwrap();
        world.unwrap();
    }
}

#[tokio::test]
async fn one_original_request_controls_its_stop_prompt_metadata_and_no_effect_after_cancellation() {
    let rig = Rig::new("dispatch-request-admission", 0x6469_7370_6174_6368).await;
    let native_caller = NativeCaller::Desktop {
        win_id: 17,
        wc_id: 117,
    };
    let (port, lines, tx) = crate::agentctl::runtime::tests::native_port(
        0x6469_7370_706f_7274,
        json!({"deviceId":"dispatch-host","enabled":true,"tabs":[],"windowOf":{},"parents":{
            (rig.world.spawn.tab.clone()):{"callerTabId":"original-parent"}
        }}),
    );
    let control = AgentControl::new(
        Arc::clone(&port),
        Caps::default(),
        &Files::default(),
        Tuning::default(),
        crate::agentctl::journal::system_clock(),
    );
    let runtime = start(
        control,
        port.id(),
        RuntimeConfig {
            sweep_ms: 0,
            ..RuntimeConfig::default()
        },
    );
    let rig = Arc::new(tokio::sync::Mutex::new(rig));
    let running = Arc::clone(&rig);
    let scenario = tokio::spawn(async move {
        let rig = running.lock().await;
        let scope = Scope::detached();
        let admitted = rig.capture(scope.clone()).await;
        assert_eq!(admitted.caller().owner, rig.caller.owner);
        assert_eq!(admitted.execution_owner(), &rig.world.owner);
        assert!(Arc::ptr_eq(&admitted.selected().sidecar, &rig.source));
        assert_eq!(admitted.channel(), Some("rpc:command"));
        rig.pool
            .note_person_prompt(Arc::clone(&admitted), Arc::clone(&runtime))
            .await
            .unwrap();
        rig.pool
            .note_stopped_command(Arc::clone(&admitted))
            .await
            .unwrap();
        assert_eq!(
            rig.pool.facts(&rig.world.spawn.tab).await.unwrap()["userTouched"],
            true
        );
        let facts = rig
            .pool
            .call("resumeFacts", json!({}), false)
            .await
            .unwrap();
        assert_eq!(facts[0]["prompted"], 1);
        assert_eq!(facts[0]["stopped"], true);
        scope.cancel();
        assert_eq!(
            rig.pool
                .note_person_prompt(Arc::clone(&admitted), runtime)
                .await
                .unwrap_err()
                .code,
            "cancelled"
        );
        let reached = Arc::new(AtomicUsize::new(0));
        let changed = Arc::clone(&reached);
        assert_eq!(
            rig.pool
                .command_effect(Arc::clone(&admitted), move |_| {
                    changed.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
                .await
                .unwrap_err()
                .code,
            "cancelled"
        );
        assert_eq!(reached.load(Ordering::SeqCst), 0);
        assert_eq!(
            rig.pool
                .call("resumeFacts", json!({}), false)
                .await
                .unwrap()[0]["prompted"],
            1
        );
        rig.world.callers.close_page(&native_caller).unwrap();
        assert!(
            rig.pool
                .capture_page_command(
                    rig.caller.clone(),
                    Some(rig.world.spawn.tab.clone()),
                    None,
                    Scope::detached()
                )
                .await
                .is_err()
        );
    })
    .await;
    port.close();
    drop((lines, tx));
    let rig = Arc::try_unwrap(rig)
        .ok()
        .expect("scenario released original fixture")
        .into_inner();
    rig.close().await;
    scenario.unwrap();
}

#[tokio::test]
async fn private_claims_and_bound_sessions_never_promote_a_revision_or_retired_caller() {
    let rig = Arc::new(tokio::sync::Mutex::new(
        Rig::new_with_bridge("dispatch-private-claims", 0x636c_6169_6d73_6170).await,
    ));
    let running = Arc::clone(&rig);
    let scenario = tokio::spawn(async move {
        let mut rig = running.lock().await;
        rig.ready().await;
        let admission = rig.capture(Scope::detached()).await;
        let session = crate::local_dispatch::session::Session::from_captured(Arc::clone(&rig.source), Arc::from("fixture"), admission.selected().generation)
            .with_admission(Arc::clone(&admission)).unwrap();
        assert_eq!(session.raw_stock(json!({"type":"get_state"})).await.unwrap()["success"], true);
        let event = |name: &str, payload| CapturedEvent {
            generation: admission.selected().generation, name:name.into(), payload, from_link:false,
        };
        let proposal = || json!([{"type":"plan_proposal","title":"Original plan","planFilePath":"/isolated/plan.md"}]);
        rig.pool.feed_captured(&rig.world.owner, &rig.world.spawn.tab, Arc::clone(&rig.source), event("events", proposal())).await.unwrap();
        let generation = rig.pool.pending_plan(&rig.world.spawn.tab).await.unwrap()["generation"].as_u64().unwrap();
        let claim = admission.claim_plan("/isolated/plan.md".into(), generation).await.unwrap().unwrap();
        assert!(claim.still_current().await.unwrap());
        assert!(admission.claim_plan("/isolated/plan.md".into(), generation).await.unwrap().is_none());
        let before = rig.world.stdin().len();
        let held = session.bridge(crate::local_dispatch::modes::PLAN_APPROVAL_METHOD, json!({"approved":true})).await.unwrap_err();
        assert!(matches!(held, crate::local_dispatch::protocol::CommandError::Local { code, .. } if code == "being_answered"));
        rig.pool.feed_captured(&rig.world.owner, &rig.world.spawn.tab, Arc::clone(&rig.source), event("events", proposal())).await.unwrap();
        assert!(!claim.still_current().await.unwrap());
        assert_eq!(claim.approve(serde_json::from_value(json!({"type":"plan_approval","approved":true})).unwrap()).await.unwrap_err().code, "tab_stale");
        assert_eq!(rig.world.stdin().len(), before);
        drop(claim);
        let generation = rig.pool.pending_plan(&rig.world.spawn.tab).await.unwrap()["generation"].as_u64().unwrap();
        let current = admission.claim_plan("/isolated/plan.md".into(), generation).await.unwrap().unwrap();
        assert_eq!(current.approve(serde_json::from_value(json!({"type":"plan_approval","approved":true})).unwrap()).await.unwrap(), serde_json::Value::Null);
        assert_eq!(rig.world.stdin().len(), before);
        drop(current);
        let question = json!({"request":{"id":"original-question","method":"input","title":"Pick a branch"},"kinds":{"blocking":true}});
        rig.pool.feed_captured(&rig.world.owner, &rig.world.spawn.tab, Arc::clone(&rig.source), event("extensionUi", question)).await.unwrap();
        let question = admission.claim_question("original-question".into()).await.unwrap().unwrap();
        assert!(question.still_current().await.unwrap());
        let before = rig.world.stdin().len();
        assert_eq!(question.answer(json!({"type":"extension_ui_response","id":"another-question","value":"wrong"}), "wrong".into()).await.unwrap_err().code, "invalid_response");
        assert_eq!(rig.world.stdin().len(), before);
        assert!(question.still_current().await.unwrap());
        assert!(question.answer(json!({"type":"extension_ui_response","id":"original-question","value":"main"}), "main".into()).await.unwrap());
        assert!(!question.still_current().await.unwrap());
        let native_caller = NativeCaller::Desktop {win_id:17,wc_id:117};
        rig.world.callers.close_page(&native_caller).unwrap();
        let before = rig.world.stdin().len();
        assert_eq!(session.raw_stock(json!({"type":"get_state"})).await.unwrap_err().code, "caller_closed");
        assert_eq!(session.bridge("composer_state", json!({})).await.unwrap_err().to_string(), "The original command admission has ended");
        assert_eq!(rig.world.stdin().len(), before);
    }).await;
    let rig = Arc::try_unwrap(rig)
        .ok()
        .expect("scenario released original fixture")
        .into_inner();
    rig.close().await;
    scenario.unwrap();
}

#[tokio::test]
async fn local_and_stock_deadlines_end_only_the_waiter_and_keep_original_effect_responsibility() {
    use crate::agentctl::service::host::Deadline;
    use crate::local_dispatch::{RpcError, RpcTimeout, protocol::RpcCommand};
    let rig = Arc::new(tokio::sync::Mutex::new(
        Rig::new_with_mail_barrier("dispatch-deadline", 0x6465_6164_6c69_6e65).await,
    ));
    let running = Arc::clone(&rig);
    let scenario = tokio::spawn(async move {
        let mut rig = running.lock().await;
        rig.ready().await;
        let request = ompdesk_app_contract::RequestId { generation: 1, id: 90 };
        let (scope, gone) = rig.world.callers.begin(&rig.caller.owner, request).unwrap();
        let admission = rig.capture(scope.clone()).await;
        let command: RpcCommand = serde_json::from_value(json!({
            "type":"agent_control_mail","content":"sample","details":{},"triggerTurn":false
        })).unwrap();
        let response = rig.commands.command_with_admission(admission, command, Deadline::Ms(0));
        let cancelled = scope.cancellation();
        drop(scope);
        assert!(matches!(response.await, Err(RpcError::Timeout(RpcTimeout { timeout_ms: 0, .. }))));
        loop {
            let event = rig.events.recv().await.unwrap();
            if event.name == "sidecar.frame"
                && event.bin.as_deref()
                    .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(bytes).ok())
                    .is_some_and(|frame| frame["type"] == "test_mail_waiting")
            {
                break;
            }
        }
        let settled = gone.wait();
        tokio::pin!(settled);
        assert!(std::future::poll_fn(|cx| std::task::Poll::Ready(settled.as_mut().poll(cx).is_pending())).await);
        assert!(!cancelled.cancelled());
        let source = Arc::clone(rig.source.local().unwrap());
        let generation = source.generation();
        source.stock_for_generation(generation, json!({"type":"test_release_mail"}), None).await.unwrap();
        settled.await;
        rig.world.callers.finish(&rig.caller.owner, request);
        assert!(!cancelled.cancelled());
        assert_eq!(std::fs::read_to_string(&rig.world.child_log).unwrap().lines().filter(|line| *line == "bridge agent_control.mail").count(), 1);
        assert!(rig.world.stdin().iter().all(|command| command["type"] != "agent_control_mail"));

        let admission = rig.capture(Scope::detached()).await;
        assert!(matches!(
            admission.stock_call(json!({"type":"test_no_reply"}), Deadline::Ms(0)).await,
            Err(RpcError::Timeout(_))
        ));
        let failure = source.stock_for_generation(generation, json!({"type":"test_no_reply"}), Some(std::time::Duration::ZERO)).await.unwrap_err();
        assert_eq!(failure.code, "rpc_timeout");
        assert_eq!(failure.message, "RPC timeout (0ms): test_no_reply");
        assert!(source.admit_observation(generation, || Ok(())).is_ok());
    }).await;
    let rig = Arc::try_unwrap(rig).ok().expect("scenario released original fixture").into_inner();
    rig.close().await;
    scenario.unwrap();
}
