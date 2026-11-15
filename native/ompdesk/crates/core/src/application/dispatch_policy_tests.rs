#![cfg(unix)]

use std::sync::Arc;
use ompdesk_app_contract::NativeCaller;

use serde_json::{Value, json};
use tokio::sync::Mutex;

use super::*;
use crate::pool::application::native::CapturedEvent;
use crate::pool::application::native::dispatch::tests::Rig;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Disconnected,
    Bridge,
    MailBarrier,
}

struct Fixture {
    rig: Rig,
    scopes: Vec<Scope>,
    pending: Vec<tokio::task::JoinHandle<AnswerResult>>,
    viewers: Vec<(NativeCaller, Admitted)>,
}

impl Fixture {
    async fn new(name: &str, id: u64, mode: Mode) -> Self {
        let mut rig = match mode {
            Mode::Disconnected => Rig::new(name, id).await,
            Mode::Bridge => Rig::new_with_bridge(name, id).await,
            Mode::MailBarrier => Rig::new_with_mail_barrier(name, id).await,
        };
        rig.ready().await;
        if mode != Mode::Disconnected {
            while !rig.source.bridge_connected() {
                crate::application::launch_host::tests::concrete::event(&mut rig.events, "sidecar.bridgeState").await;
            }
        }
        Self { rig, scopes: Vec::new(), pending: Vec::new(), viewers: Vec::new() }
    }

    async fn capture(&mut self, scope: Scope) -> Arc<CommandAdmission<Source>> {
        self.scopes.push(scope.clone());
        self.rig.capture(scope).await
    }

    async fn second_window(&mut self) -> Arc<CommandAdmission<Source>> {
        let page = NativeCaller::Desktop { win_id:18, wc_id:118 };
        let caller = self.rig.world.callers.admit_page(page.clone()).unwrap();
        self.viewers.push((page, caller.clone()));
        self.rig.pool.attach_viewer(&caller.owner, &self.rig.world.spawn.tab).unwrap().await.unwrap();
        let scope = Scope::detached();
        self.scopes.push(scope.clone());
        self.rig.pool.capture_page_command(
            caller, Some(self.rig.world.spawn.tab.clone()), Some(Arc::from("rpc:command")), scope,
        ).await.unwrap()
    }

    fn start_answer(&mut self, answers: &TargetAnswers, admission: Arc<CommandAdmission<Source>>, command: RpcCommand) -> usize {
        let answers = answers.clone();
        let commands = Arc::clone(&self.rig.commands);
        self.pending.push(tokio::spawn(async move {
            answers.run(admission, commands, command, Deadline::None).await
        }));
        self.pending.len() - 1
    }

    async fn answer(&mut self, index: usize) -> AnswerResult {
        let outcome = (&mut self.pending[index]).await;
        drop(self.pending.swap_remove(index));
        outcome.unwrap()
    }

    async fn mail_waiting(&mut self) {
        loop {
            let event = crate::application::launch_host::tests::concrete::event(&mut self.rig.events, "sidecar.frame").await;
            let frame: Value = serde_json::from_slice(event.bin.as_deref().expect("the real sidecar.frame has its payload")).unwrap();
            if frame["type"] == "test_mail_waiting" { break; }
        }
    }

    async fn feed(&mut self, admission: &CommandAdmission<Source>, name: &str, payload: Value) {
        self.rig.pool.feed_captured(&self.rig.world.owner, &self.rig.world.spawn.tab, Arc::clone(&self.rig.source), CapturedEvent {
            generation: admission.selected().generation, name: name.into(), payload, from_link: false,
        }).await.unwrap();
    }
}

async fn scenario<F>(name: &str, id: u64, mode: Mode, run: F)
where
    F: for<'a> FnOnce(&'a mut Fixture) -> EffectFuture<'a, ()> + Send + 'static,
{
    let fixture = Arc::new(Mutex::new(Fixture::new(name, id, mode).await));
    let running = Arc::clone(&fixture);
    let outcome = tokio::spawn(async move {
        let mut fixture = running.lock().await;
        run(&mut fixture).await;
    }).await;
    let mut fixture = Arc::try_unwrap(fixture).ok().expect("scenario released its fixture").into_inner();
    for scope in &fixture.scopes { scope.cancel(); }
    let mut viewers = Vec::with_capacity(fixture.viewers.len());
    for (page, caller) in fixture.viewers.drain(..) {
        let left = match fixture.rig.pool.close_tab(&caller.owner, fixture.rig.world.spawn.tab.clone()) {
            Ok(left) => left.await,
            Err(error) => Err(error),
        };
        let _ = fixture.rig.world.callers.close_page(&page);
        viewers.push(left);
    }
    let retired = fixture.rig.source.retire().wait().await;
    let mut joined = Vec::with_capacity(fixture.pending.len());
    for pending in fixture.pending { joined.push(pending.await); }
    fixture.rig.close().await;
    retired.unwrap();
    // An intentionally cancelled/closed step may reject; executor panics still fail after all cleanup has joined.
    for task in joined { drop(task.unwrap()); }
    for left in viewers { left.unwrap(); }
    outcome.unwrap();
}

fn step(request: &str, target: Value) -> RpcCommand {
    let mut params = target.as_object().unwrap().clone();
    params.insert("requestId".into(), json!(request));
    params.insert("companion".into(), json!({
        "content":"A synthetic attachment note", "details":{"id":request},
        "delivery":{"triggerTurn":false,"deliverAs":"aside"},
    }));
    RpcCommand { kind:"agent_control_answer".into(), id:Some(format!("frame-{request}")), params }
}

#[tokio::test]
async fn a_failed_real_companion_releases_each_claim_without_approving_or_answering() {
    scenario("outer-answer-note-failure", 0x6f75_7465_726e_6f74, Mode::Disconnected, |fixture| Box::pin(async move {
        let admission = fixture.capture(Scope::detached()).await;
        fixture.feed(&admission, "events", json!([{
            "type":"plan_proposal","title":"Synthetic plan","planFilePath":"/isolated/outer-plan.md",
        }])).await;
        let generation = fixture.rig.pool.pending_plan(&fixture.rig.world.spawn.tab).await.unwrap()["generation"].as_u64().unwrap();
        let plan = step("failed-plan-note", json!({"plan":{"type":"plan_approval","approved":true},"planFile":"/isolated/outer-plan.md","planGeneration":generation}));
        let answers = TargetAnswers::default();
        let before = fixture.rig.world.stdin();
        assert!(answers.run(Arc::clone(&admission), Arc::clone(&fixture.rig.commands), plan, Deadline::None).await.is_err());
        let plan_claim = admission.claim_plan("/isolated/outer-plan.md".into(), generation).await.unwrap().expect("failed note released its plan");
        assert!(plan_claim.still_current().await.unwrap());
        drop(plan_claim);
        fixture.feed(&admission, "extensionUi", json!({"request":{"id":"outer-question","method":"input","title":"Synthetic question"},"kinds":{"blocking":true}})).await;
        let question = step("failed-question-note", json!({"askId":"outer-question","response":{"type":"extension_ui_response","id":"outer-question","value":"main"}}));
        assert!(answers.run(Arc::clone(&admission), Arc::clone(&fixture.rig.commands), question, Deadline::Default).await.is_err());
        let question_claim = admission.claim_question("outer-question".into()).await.unwrap().expect("failed note released its question");
        assert!(question_claim.still_current().await.unwrap());
        assert_eq!(fixture.rig.world.stdin(), before, "a failed local note must not become stock or answer input");
    })).await;
}

#[tokio::test]
async fn an_answer_cannot_use_one_question_claim_to_send_a_different_questions_frame() {
    scenario("outer-answer-frame-binding", 0x6f75_7465_7269_6473, Mode::Disconnected, |fixture| Box::pin(async move {
        let admission = fixture.capture(Scope::detached()).await;
        for id in ["claimed-question","other-held-question"] {
            fixture.feed(&admission, "extensionUi", json!({"request":{"id":id,"method":"input","title":"Synthetic question"},"kinds":{"blocking":true}})).await;
        }
        let other = admission.claim_question("other-held-question".into()).await.unwrap().unwrap();
        let before = fixture.rig.world.stdin();
        let forged = step("wrong-question", json!({"askId":"claimed-question","response":{"type":"extension_ui_response","id":"other-held-question","value":"must not reach stock"}}));
        assert!(TargetAnswers::default().run(Arc::clone(&admission), Arc::clone(&fixture.rig.commands), forged, Deadline::Default).await.is_err());
        assert!(other.still_current().await.unwrap());
        let original = admission.claim_question("claimed-question".into()).await.unwrap().expect("rejected frame did not consume the original question");
        assert!(original.still_current().await.unwrap());
        assert_eq!(fixture.rig.world.stdin(), before);
    })).await;
}

#[tokio::test]
async fn real_bridge_companions_precede_one_approval_or_answer_and_completed_retries_deliver_nothing() {
    scenario("outer-answer-real-bridge", 0x6f75_7465_7262_7267, Mode::Bridge, |fixture| Box::pin(async move {
        let admission = fixture.capture(Scope::detached()).await;
        fixture.feed(&admission, "events", json!([{
            "type":"plan_proposal","title":"Synthetic plan","planFilePath":"/isolated/outer-plan.md",
        }])).await;
        let generation = fixture.rig.pool.pending_plan(&fixture.rig.world.spawn.tab).await.unwrap()["generation"].as_u64().unwrap();
        let plan = step("accepted-plan", json!({"plan":{"type":"plan_approval","approved":true},"planFile":"/isolated/outer-plan.md","planGeneration":generation}));
        let answers = TargetAnswers::default();
        let before = fixture.rig.world.stdin();
        answers.run(Arc::clone(&admission), Arc::clone(&fixture.rig.commands), plan.clone(), Deadline::None).await.unwrap();
        let accepted = std::fs::read_to_string(&fixture.rig.world.child_log).unwrap();
        let note = accepted.rfind("bridge agent_control.mail").expect("the real bridge received the companion");
        let approval = accepted.rfind("bridge modes.plan_approval").expect("the canonical local approval reached the bridge");
        assert!(note < approval);
        assert_eq!(accepted.matches("bridge agent_control.mail").count(), 1);
        assert_eq!(accepted.matches("bridge modes.plan_approval").count(), 1);
        assert_eq!(fixture.rig.world.stdin(), before, "a plan local hit must never reach stock");
        answers.run(Arc::clone(&admission), Arc::clone(&fixture.rig.commands), plan, Deadline::Default).await.unwrap();
        assert_eq!(std::fs::read_to_string(&fixture.rig.world.child_log).unwrap(), accepted);

        fixture.feed(&admission, "extensionUi", json!({"request":{"id":"accepted-question","method":"input","title":"Synthetic question"},"kinds":{"blocking":true}})).await;
        let question = step("accepted-question-step", json!({"askId":"accepted-question","response":{"type":"extension_ui_response","id":"accepted-question","value":"main"}}));
        answers.run(Arc::clone(&admission), Arc::clone(&fixture.rig.commands), question.clone(), Deadline::Default).await.unwrap();
        // A following real stock receipt proves the child consumed the preceding extension-UI frame.
        assert_eq!(admission.stock(json!({"type":"get_state"})).await.unwrap()["success"], true);
        let delivered = fixture.rig.world.stdin();
        assert_eq!(delivered.iter().filter(|frame| frame["type"] == "extension_ui_response" && frame["id"] == "accepted-question" && frame["value"] == "main").count(), 1);
        assert!(admission.claim_question("accepted-question".into()).await.unwrap().is_none());
        let after = std::fs::read_to_string(&fixture.rig.world.child_log).unwrap();
        assert_eq!(after.matches("bridge agent_control.mail").count(), 2);
        let companion = after.rfind("bridge agent_control.mail").unwrap();
        let answer = after.rfind("\"extension_ui_response\"").expect("the real Lane delivered its question answer");
        assert!(companion < answer);
        answers.run(Arc::clone(&admission), Arc::clone(&fixture.rig.commands), question, Deadline::Default).await.unwrap();
        assert_eq!(fixture.rig.world.stdin(), delivered);
        assert_eq!(std::fs::read_to_string(&fixture.rig.world.child_log).unwrap(), after);
    })).await;
}

#[tokio::test]
async fn replaced_proposals_cancelled_scopes_and_retired_callers_deliver_no_companion_or_approval() {
    scenario("outer-answer-original-admission", 0x6f75_7465_726f_7267, Mode::Bridge, |fixture| Box::pin(async move {
        let admission = fixture.capture(Scope::detached()).await;
        let proposal = || json!([{"type":"plan_proposal","title":"Synthetic revision","planFilePath":"/isolated/revision.md"}]);
        fixture.feed(&admission, "events", proposal()).await;
        let generation = fixture.rig.pool.pending_plan(&fixture.rig.world.spawn.tab).await.unwrap()["generation"].as_u64().unwrap();
        let original = step("stale-proposal", json!({"plan":{"type":"plan_approval","approved":true},"planFile":"/isolated/revision.md","planGeneration":generation}));
        fixture.feed(&admission, "events", proposal()).await;
        let answers = TargetAnswers::default();
        let before = std::fs::read_to_string(&fixture.rig.world.child_log).unwrap();
        assert!(answers.run(Arc::clone(&admission), Arc::clone(&fixture.rig.commands), original, Deadline::Default).await.is_err());
        assert_eq!(std::fs::read_to_string(&fixture.rig.world.child_log).unwrap(), before);

        let scope = Scope::detached();
        let cancelled = fixture.capture(scope.clone()).await;
        let generation = fixture.rig.pool.pending_plan(&fixture.rig.world.spawn.tab).await.unwrap()["generation"].as_u64().unwrap();
        let current = step("cancelled-proposal", json!({"plan":{"type":"plan_approval","approved":true},"planFile":"/isolated/revision.md","planGeneration":generation}));
        scope.cancel();
        assert!(answers.run(cancelled, Arc::clone(&fixture.rig.commands), current, Deadline::None).await.is_err());
        assert_eq!(std::fs::read_to_string(&fixture.rig.world.child_log).unwrap(), before);
        let current_claim = admission.claim_plan("/isolated/revision.md".into(), generation).await.unwrap().expect("cancelled original scope did not consume the revised plan");
        assert!(current_claim.still_current().await.unwrap());
        drop(current_claim);

        fixture.rig.world.callers.close_page(&ompdesk_app_contract::NativeCaller::Desktop {win_id:17,wc_id:117}).unwrap();
        let retired = step("retired-proposal", json!({"plan":{"type":"plan_approval","approved":true},"planFile":"/isolated/revision.md","planGeneration":generation}));
        assert!(answers.run(admission, Arc::clone(&fixture.rig.commands), retired, Deadline::Default).await.is_err());
        assert_eq!(std::fs::read_to_string(&fixture.rig.world.child_log).unwrap(), before);
    })).await;
}

#[tokio::test]
async fn replacing_a_plan_while_its_real_companion_is_in_flight_never_approves_either_proposal() {
    scenario("outer-answer-inflight-plan", 0x6f75_7465_7270_6c6e, Mode::MailBarrier, |fixture| Box::pin(async move {
        let admission = fixture.capture(Scope::detached()).await;
        let proposal = || json!([{"type":"plan_proposal","title":"Synthetic revision","planFilePath":"/isolated/inflight.md"}]);
        fixture.feed(&admission, "events", proposal()).await;
        let generation = fixture.rig.pool.pending_plan(&fixture.rig.world.spawn.tab).await.unwrap()["generation"].as_u64().unwrap();
        let answer = step("inflight-plan", json!({"plan":{"type":"plan_approval","approved":true},"planFile":"/isolated/inflight.md","planGeneration":generation}));
        let pending = fixture.start_answer(&TargetAnswers::default(), Arc::clone(&admission), answer);
        fixture.mail_waiting().await;
        fixture.feed(&admission, "events", proposal()).await;
        let revised = fixture.rig.pool.pending_plan(&fixture.rig.world.spawn.tab).await.unwrap()["generation"].as_u64().unwrap();
        assert_ne!(generation, revised);
        assert_eq!(admission.stock(json!({"type":"test_release_mail"})).await.unwrap()["success"], true);
        assert!(fixture.answer(pending).await.is_err());
        let log = std::fs::read_to_string(&fixture.rig.world.child_log).unwrap();
        assert_eq!(log.matches("bridge agent_control.mail").count(), 1);
        assert!(!log.contains("bridge modes.plan_approval"));
        assert!(!fixture.rig.world.stdin().iter().any(|frame| frame["type"] == "plan_approval"));
        let claim = admission.claim_plan("/isolated/inflight.md".into(), revised).await.unwrap().expect("the revised proposal remains answerable");
        assert!(claim.still_current().await.unwrap());
    })).await;
}

#[tokio::test]
async fn cancelling_a_question_while_its_real_companion_is_in_flight_keeps_the_note_but_sends_no_answer() {
    scenario("outer-answer-inflight-question", 0x6f75_7465_7271_7565, Mode::MailBarrier, |fixture| Box::pin(async move {
        let admission = fixture.capture(Scope::detached()).await;
        fixture.feed(&admission, "extensionUi", json!({"request":{"id":"inflight-question","method":"input","title":"Synthetic question"},"kinds":{"blocking":true}})).await;
        let answer = step("inflight-question-step", json!({"askId":"inflight-question","response":{"type":"extension_ui_response","id":"inflight-question","value":"main"}}));
        let pending = fixture.start_answer(&TargetAnswers::default(), Arc::clone(&admission), answer);
        fixture.mail_waiting().await;
        fixture.feed(&admission, "extensionUi", json!({"request":{"method":"cancel","targetId":"inflight-question"},"kinds":{"blocking":false}})).await;
        assert_eq!(admission.stock(json!({"type":"test_release_mail"})).await.unwrap()["success"], true);
        assert!(fixture.answer(pending).await.is_err());
        let log = std::fs::read_to_string(&fixture.rig.world.child_log).unwrap();
        assert_eq!(log.matches("bridge agent_control.mail").count(), 1);
        assert!(!fixture.rig.world.stdin().iter().any(|frame| frame["type"] == "extension_ui_response" && frame["id"] == "inflight-question"));
        assert!(admission.claim_question("inflight-question".into()).await.unwrap().is_none());
    })).await;
}

#[test]
fn transcript_origin_labels_match_the_original_window_and_host_consumer_fixture() {
    // src/main/bridge-prompt-origin.test.ts:144-168, with page fields that must survive the transform.
    let original = json!({"version":"kept","cursor":"next","messages":[
        {"role":"user","timestamp":1,"promptFromId":"host"},
        {"role":"assistant","timestamp":2},
        {"role":"user","timestamp":3,"promptFrom":"Laptop A","promptFromId":"dev-a"},
        {"role":"assistant","timestamp":4},
        {"role":"user","timestamp":5,"promptFrom":"Tablet C","promptFromId":"dev-c"}
    ]});
    let mut laptop = original.clone();
    localize_transcript(&mut laptop, "dev-a", "Host B");
    assert_eq!(laptop, json!({"version":"kept","cursor":"next","messages":[
        {"role":"user","timestamp":1,"promptFrom":"Host B"},
        {"role":"assistant","timestamp":2},
        {"role":"user","timestamp":3},
        {"role":"assistant","timestamp":4},
        {"role":"user","timestamp":5,"promptFrom":"Tablet C"}
    ]}));
    let mut host = original;
    localize_transcript(&mut host, "host", "Host B");
    assert_eq!(host["messages"], json!([
        {"role":"user","timestamp":1},
        {"role":"assistant","timestamp":2},
        {"role":"user","timestamp":3,"promptFrom":"Laptop A"},
        {"role":"assistant","timestamp":4},
        {"role":"user","timestamp":5,"promptFrom":"Tablet C"}
    ]));
    let mut unlabelled = json!({"messages":[{"role":"user","timestamp":1,"unknown":{"kept":true}}]});
    let before = unlabelled.clone();
    localize_transcript(&mut unlabelled, "dev-a", "Host B");
    assert_eq!(unlabelled, before);
}

#[tokio::test]
async fn an_old_answer_capture_cannot_send_into_the_same_tabs_restarted_process() {
    scenario("outer-answer-original-run", 0x6f75_7465_7272_756e, Mode::Bridge, |fixture| Box::pin(async move {
        let original = fixture.capture(Scope::detached()).await;
        let proposal = || json!([{"type":"plan_proposal","title":"Synthetic run plan","planFilePath":"/isolated/run-plan.md"}]);
        fixture.feed(&original, "events", proposal()).await;
        let proposal_generation = fixture.rig.pool.pending_plan(&fixture.rig.world.spawn.tab).await.unwrap()["generation"].as_u64().unwrap();
        fixture.rig.source.restart(None);
        crate::sidecar::native::tests::ready_with(&mut fixture.rig.events, |_| None).await;
        while !fixture.rig.source.bridge_connected() {
            crate::application::launch_host::tests::concrete::event(&mut fixture.rig.events, "sidecar.bridgeState").await;
        }
        let current = fixture.capture(Scope::detached()).await;
        assert_ne!(current.selected().generation, original.selected().generation);
        let before = fixture.rig.world.stdin();
        let answers = TargetAnswers::default();
        let stale = step("old-process-plan", json!({"plan":{"type":"plan_approval","approved":true},"planFile":"/isolated/run-plan.md","planGeneration":proposal_generation}));
        assert!(answers.run(original, Arc::clone(&fixture.rig.commands), stale, Deadline::Default).await.is_err());
        assert_eq!(fixture.rig.world.stdin(), before);

        fixture.feed(&current, "events", proposal()).await;
        let generation = fixture.rig.pool.pending_plan(&fixture.rig.world.spawn.tab).await.unwrap()["generation"].as_u64().unwrap();
        let fresh = step("new-process-plan", json!({"plan":{"type":"plan_approval","approved":true},"planFile":"/isolated/run-plan.md","planGeneration":generation}));
        answers.run(current, Arc::clone(&fixture.rig.commands), fresh, Deadline::Default).await.unwrap();
        let log = std::fs::read_to_string(&fixture.rig.world.child_log).unwrap();
        assert_eq!(log.matches("bridge agent_control.mail").count(), 1);
        assert_eq!(log.matches("bridge modes.plan_approval").count(), 1);
        assert_eq!(fixture.rig.world.stdin(), before, "the fresh local handler still never falls through stock");
    })).await;
}

#[test]
fn a_hosted_transcript_uses_the_original_owner_and_viewer_names_without_rewriting_other_messages() {
    // The actual HostedTabView consumer fixture in remote/host-services.test.ts:3007-3030.
    let mut page = json!({"version":"kept","messages":[
        {"role":"user","content":"from the device","timestamp":1},
        {"role":"user","content":"typed here","timestamp":2,"promptFrom":"Host B"},
        {"role":"assistant","content":[],"timestamp":3},
        {"role":"user","content":"third computer","timestamp":4,"promptFrom":"Third device"}
    ]});
    label_for_viewer(&mut page, "device-x", "Host B");
    assert_eq!(page, json!({"version":"kept","messages":[
        {"role":"user","content":"from the device","timestamp":1,"promptFrom":"device-x"},
        {"role":"user","content":"typed here","timestamp":2},
        {"role":"assistant","content":[],"timestamp":3},
        {"role":"user","content":"third computer","timestamp":4,"promptFrom":"Third device"}
    ]}));
    let mut unlabelled = json!({"messages":[{"role":"user","content":"one device only"}]});
    let before = unlabelled.clone();
    label_for_viewer(&mut unlabelled, "device-x", "Host B");
    assert_eq!(unlabelled, before);
}

#[test]
fn session_move_uncertainty_requires_a_real_timeout_not_a_matching_error_message_or_code() {
    for kind in ["new_session", "switch_session", "switch_leaf", "fork", "branch"] {
        assert!(moved_or_unknown(moves_tab(kind), &Ok(json!({"success":true,"data":{"cancelled":false}}))));
        assert!(!moved_or_unknown(moves_tab(kind), &Ok(json!({"success":true,"data":{"cancelled":true}}))));
        assert!(!moved_or_unknown(moves_tab(kind), &Ok(json!({"success":false,"error":"RPC timeout (8ms): switch_session"}))));
        let timeout = crate::local_dispatch::RpcTimeout { timeout_ms:8, command:kind.into() };
        let same_message = timeout.to_string();
        assert!(moved_or_unknown(moves_tab(kind), &Err(RpcError::Timeout(timeout))));
        assert!(!moved_or_unknown(moves_tab(kind), &Err(RpcError::Fault(Fault::new("rpc_delivery_unknown", same_message)))));
    }
    assert!(!moved_or_unknown(moves_tab("get_state"), &Err(RpcError::Timeout(crate::local_dispatch::RpcTimeout {
        timeout_ms:8, command:"get_state".into(),
    }))));
}

#[tokio::test]
async fn real_windows_share_draft_and_subscription_aggregates_without_replacing_the_execution() {
    scenario("outer-aggregate-windows", 0x6f75_7465_7261_6767, Mode::Bridge, |fixture| Box::pin(async move {
        let first = fixture.capture(Scope::detached()).await;
        let second = fixture.second_window().await;
        assert!(Arc::ptr_eq(&first.selected().sidecar, &second.selected().sidecar));
        assert_eq!(first.selected().generation, second.selected().generation);
        let command = "set_idle_compaction_draft".to_owned();
        assert!(!fixture.rig.pool.note_draft_command(Arc::clone(&first), command.clone(), false).await.unwrap());
        assert!(!fixture.rig.pool.note_draft_command(Arc::clone(&second), command.clone(), true).await.unwrap());
        assert!(fixture.rig.pool.note_draft_command(Arc::clone(&first), command, true).await.unwrap());
        assert!(fixture.rig.pool.note_draft_command(Arc::clone(&first), "set_next_prompt_draft".into(), true).await.unwrap());
        assert!(!fixture.rig.pool.note_draft_command(Arc::clone(&second), "set_next_prompt_draft".into(), false).await.unwrap());
        assert_eq!(fixture.rig.pool.note_subagent_level_command(Arc::clone(&first), "events".into()).await.unwrap(), "events");
        assert_eq!(fixture.rig.pool.note_subagent_level_command(second, "progress".into()).await.unwrap(), "events");
        assert_eq!(fixture.rig.pool.note_subagent_level_command(first, "off".into()).await.unwrap(), "progress");
    })).await;
}

#[tokio::test]
async fn successful_state_completion_commits_the_file_and_cwd_without_refreshing_the_old_admission() {
    scenario("outer-state-completion", 0x6f75_7465_7273_7461, Mode::Bridge, |fixture| Box::pin(async move {
        let original = fixture.capture(Scope::detached()).await;
        let folder = fixture.rig.world.fixture.dir.join("adopted-cwd");
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("synthetic-session.jsonl").to_string_lossy().into_owned();
        let cwd = folder.to_string_lossy().into_owned();
        let response = json!({"type":"response","command":"get_state","success":true,"data":{
            "sessionFile":file,"cwd":cwd
        }});
        let command = RpcCommand {kind:"get_state".into(),id:None,params:Map::new()};
        let completion = ResponseTail::for_command(&command).completion(&response).expect("successful state has a metadata tail");
        fixture.rig.pool.complete_command(Arc::clone(&original), completion, fixture.rig.world.config.events.clone()).await.unwrap();
        let current = fixture.capture(Scope::detached()).await;
        assert_eq!(current.selected().session_file.as_deref(), Some(file.as_str()));
        assert_eq!(current.selected().cwd, cwd);
        assert_eq!(current.selected().generation, original.selected().generation);
        assert!(Arc::ptr_eq(&current.selected().sidecar, &original.selected().sidecar));
        let before = fixture.rig.world.stdin();
        assert!(original.stock(json!({"type":"get_state"})).await.is_err(), "committing a new file does not mutate the old admission");
        assert_eq!(fixture.rig.world.stdin(), before);
    })).await;
}

#[tokio::test]
async fn one_real_sign_in_reserves_the_tab_and_its_cleanup_survives_original_caller_retirement() {
    scenario("outer-login-lifetime", 0x6f75_7465_726c_6f67, Mode::Bridge, |fixture| Box::pin(async move {
        let original = fixture.capture(Scope::detached()).await;
        let ticket = fixture.rig.pool.begin_sign_in_command(Arc::clone(&original), Some("synthetic-provider".into())).await.unwrap().unwrap();
        for provider in [None, Some("another-synthetic-provider".into())] {
            let error = fixture.rig.pool.begin_sign_in_command(Arc::clone(&original), provider).await.err().expect("the original login still holds this tab");
            assert_eq!(error.code, "login_in_progress");
        }
        let page = NativeCaller::Desktop { win_id:17, wc_id:117 };
        fixture.rig.world.callers.close_page(&page).unwrap();
        ticket.finish(Some("synthetic provider rejection".into())).await.unwrap();
        fixture.rig.caller = fixture.rig.world.callers.admit_page(page).unwrap();
        let current = fixture.capture(Scope::detached()).await;
        let next = fixture.rig.pool.begin_sign_in_command(Arc::clone(&current), Some("synthetic-provider".into())).await.unwrap().expect("the original login cleanup released its own tab");
        next.finish(None).await.unwrap();
        assert!(original.stock(json!({"type":"get_state"})).await.is_err());
        let before = std::fs::read_to_string(&fixture.rig.world.child_log).unwrap().matches("bridge image_generation_sync").count();
        fixture.rig.pool.sync_image_generation_command(Arc::clone(&current)).await.unwrap();
        current.bridge("ping".into(), None, None).await.unwrap();
        let refreshed = std::fs::read_to_string(&fixture.rig.world.child_log).unwrap();
        assert_eq!(refreshed.matches("bridge image_generation_sync").count(), before + 1);
        assert!(!fixture.rig.world.stdin().iter().any(|frame| matches!(frame["type"].as_str(), Some("login" | "logout"))), "the fixture changes no credentials or accounts");
    })).await;
}

#[test]
fn a_phone_localizes_after_the_hosted_view_so_its_own_prompt_does_not_regain_the_owner_label() {
    let mut page = json!({"messages":[
        {"role":"user","content":"owner"},
        {"role":"user","content":"host","promptFrom":"Execution host","promptFromId":"host"},
        {"role":"user","content":"phone","promptFrom":"This phone","promptFromId":"web-phone"},
        {"role":"assistant","content":"reply"}
    ]});
    label_for_viewer(&mut page, "Owner device", "Execution host");
    localize_transcript(&mut page, "web-phone", "Execution host");
    assert_eq!(page, json!({"messages":[
        {"role":"user","content":"owner","promptFrom":"Owner device"},
        {"role":"user","content":"host","promptFrom":"Execution host"},
        {"role":"user","content":"phone"},
        {"role":"assistant","content":"reply"}
    ]}));
}
