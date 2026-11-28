use super::*;
use crate::git::{repo_at, sh};
use crate::ports::apply_answer;
use tokio::io::{AsyncBufReadExt, BufReader};

#[tokio::test(start_paused = true)]
async fn settle_expiry_at_the_journal_prevents_a_late_push() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("work");
    let remote = dir.path().join("remote.git");
    repo_at(&root);
    sh(&root, &["init", "--bare", "-q", remote.to_str().unwrap()]);
    sh(
        &root,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    let sha = sh(&root, &["rev-parse", "HEAD"]);
    let root = root.to_str().unwrap().to_owned();

    let (writer, reader) = tokio::io::duplex(65536);
    let (frames, written) = crate::wire::spawn_writer(writer);
    let mut lines = BufReader::new(reader).lines();
    let id = 985_301;
    let bound = Duration::from_millis(300);
    let params = json!({"port":id,"state":null,"tuning":{"stepMaxMs":300},"contracts":{
        "bridge":{"arm":"arm","status":"status","configure":"configure","note":"note",
            "dismiss":"dismiss","setState":"setState","shipAction":"shipAction","markReverted":"markReverted",
            "takeShipRequests":"takeShipRequests","cycleAmend":"cycleAmend","disarm":"disarm","guide":"guide"},
        "objective":"","guideFile":"","guideCommitMaxBytes":0,"childTag":"","defaultShipPolicy":{},"noLimits":{},"presets":{}
    }});
    open(Call {
        params: serde_json::value::to_raw_value(&params).unwrap(),
        events: crate::server::test_events(&frames),
        scope: crate::server::Scope::detached(),
        bin: None,
    })
    .await
    .unwrap();
    let co = instance(id).unwrap();
    let run = co.new_run(
        "ap",
        RunState::begin(crate::autopilot::start::NewRun {
            run: "test".into(),
            root: root.clone(),
            checkout_root: root,
            branch: "main".into(),
            base_branch: "main".into(),
            target: None,
            land_to: None,
            settings: Settings(json!({})),
            release_procedure: None,
            release_blocked: None,
        }),
    );
    run.ship.enqueue(
        &serde_json::from_value(json!({"kind":"push"})).unwrap(),
        "push".into(),
        0,
    );
    let runner = crate::git::run::tests::runner();
    let git = json!({"bin":runner.bin,"args":runner.args,"env":runner.env,
        "timeoutMs":runner.timeout_ms,"maxBytes":runner.max_bytes});

    // A live blocking task inhibits Tokio's idle-time advance while real git is running.
    let (unfreeze, frozen) = oneshot::channel::<()>();
    let clock_guard = tokio::task::spawn_blocking(move || frozen.blocking_recv());
    let start = tokio::time::Instant::now();
    co.frame("ap", &json!({"type":"autopilot_settled","reason":"user"}));
    let journal = loop {
        let line = lines.next_line().await.unwrap().expect("main port closed");
        let frame: Value = serde_json::from_str(&line).unwrap();
        let event = &frame["data"];
        assert!(
            run.lock().stalls.is_empty(),
            "settle expired before journal"
        );
        let item = &run.ship.queue()[0];
        assert_ne!(
            item.state, "failed",
            "pre-journal failure: {:?}",
            item.detail
        );
        let Some(ask) = event["ask"].as_u64() else {
            continue;
        };
        let args = &event["args"];
        match event["method"].as_str() {
            Some("bridge") if args["method"] == "shipAction" => {
                assert_eq!(args["params"]["sha"], sha.trim());
                break ask;
            }
            Some("bridge") => apply_answer(&co.port, ask, Ok(r#"{"success":true}"#)),
            Some("gitRunner") => apply_answer(&co.port, ask, Ok(&git.to_string())),
            other => panic!("unexpected request before journal: {other:?}"),
        }
    };
    assert_eq!(start.elapsed(), Duration::ZERO);
    assert_eq!(run.ship.queue()[0].state, "running");
    tokio::time::advance(bound).await;
    run.steps.idle().await;
    assert_eq!(run.lock().stalls[0].step, "settle");
    assert_eq!(run.ship.queue()[0].state, "failed");

    apply_answer(&co.port, journal, Ok(r#"{"success":true}"#));
    run.ship.wait_for_drain().await;
    assert!(
        sh(&remote, &["for-each-ref", "refs/heads"]).is_empty(),
        "late journal reply pushed to the remote"
    );
    co.port.close();
    drop(frames);
    written.await.unwrap().unwrap();
    drop(unfreeze);
    let _ = clock_guard.await.unwrap();
}
