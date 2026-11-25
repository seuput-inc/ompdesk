use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use tokio::sync::watch;
use tokio::time::sleep;

use super::*;
use crate::server::Events;
use crate::wire::Frame;

const INTERVAL: Duration = Duration::from_secs(60);

fn engine(id: &str, port: u16) -> Engine {
    Engine {
        id: id.into(),
        base_url: format!("http://127.0.0.1:{port}/v1"),
    }
}

#[derive(Default)]
struct State {
    up: HashSet<String>,
    uninspected: HashSet<String>,
    file: HashSet<String>,
    probes: usize,
    inserts: Vec<Value>,
    deletes: Vec<String>,
    delete_fails: usize,
    ids_fail: bool,
    /// Probes wait until it opens.
    hold: Option<watch::Receiver<bool>>,
}

#[derive(Default)]
struct Fake(Mutex<State>);

impl Fake {
    fn with<T>(&self, look: impl FnOnce(&mut State) -> T) -> T {
        look(&mut self.0.lock().unwrap())
    }
}

impl World for Arc<Fake> {
    async fn ids(&self) -> Result<HashSet<String>, Fault> {
        self.with(|world| {
            if world.ids_fail {
                return Err(Fault::new("models_config", "invalid YAML"));
            }
            Ok(world.file.clone())
        })
    }

    async fn insert(&self, input: &Value) -> Result<bool, Fault> {
        self.with(|world| {
            let id = input["id"].as_str().unwrap().to_owned();
            if world.file.contains(&id) {
                return Ok(false);
            }
            world.inserts.push(input.clone());
            world.file.insert(id);
            Ok(true)
        })
    }

    async fn delete(&self, id: &str) -> Result<(), Fault> {
        self.with(|world| {
            if world.delete_fails > 0 {
                world.delete_fails -= 1;
                return Err(Fault::new("models_io", "disk full"));
            }
            world.deletes.push(id.to_owned());
            world.file.remove(id);
            Ok(())
        })
    }

    async fn probe(&self, base_url: &str) -> Option<bool> {
        let (answer, hold) = self.with(|world| {
            world.probes += 1;
            let id = if base_url.contains(":1919/") {
                "freetoken"
            } else {
                "colibri"
            };
            let answer = (!world.uninspected.contains(id)).then(|| world.up.contains(id));
            (answer, world.hold.clone())
        });
        if let Some(mut hold) = hold {
            let _ = hold.wait_for(|open| *open).await;
        }
        answer
    }
}

struct Rig {
    world: Arc<Fake>,
    handle: Option<Handle>,
    actor: JoinHandle<()>,
    prefs: String,
    frames: mpsc::UnboundedReceiver<Frame>,
    _keep: mpsc::UnboundedSender<Frame>,
    _dir: tempfile::TempDir,
    changed: usize,
    failed: usize,
}

fn rig(start: bool) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let prefs = dir.path().join("prefs.json").to_str().unwrap().to_owned();
    let world = Arc::new(Fake::default());
    let (events, keep, frames) = Events::capture();
    let (handle, actor) = spawn(
        Arc::clone(&world),
        prefs.clone(),
        vec![engine("freetoken", 1919), engine("colibri", 8000)],
        INTERVAL,
        start,
        events,
    );
    Rig {
        world,
        handle: Some(handle),
        actor,
        prefs,
        frames,
        _keep: keep,
        _dir: dir,
        changed: 0,
        failed: 0,
    }
}

/// Lets the detector's task run what is ready; the fake world never waits but on `hold`.
async fn settle() {
    for _ in 0..16 {
        tokio::task::yield_now().await;
    }
}

/// Lets `time` pass on the paused clock, then what it woke run.
async fn pass_time(time: Duration) {
    sleep(time).await;
    settle().await;
}

impl Rig {
    /// Stores the switch as main does, then asks the detector to follow it; the receiver ends once it did.
    fn ask(&self, enabled: bool) -> oneshot::Receiver<()> {
        prefs::set(&self.prefs, DETECT_PREF, Value::Bool(enabled)).unwrap();
        self.handle.as_ref().unwrap().follow(enabled)
    }

    async fn set(&self, enabled: bool) {
        self.ask(enabled).await.unwrap();
    }

    /// A pass now: the switch turned on again runs one.
    async fn tick(&self) {
        self.set(true).await;
    }

    fn ledger(&self) -> Ledger {
        Ledger::parse(prefs::get(&self.prefs, LEDGER_PREF).unwrap().as_ref())
    }

    fn file(&self) -> HashSet<String> {
        self.world.with(|world| world.file.clone())
    }

    fn probes(&self) -> usize {
        self.world.with(|world| world.probes)
    }

    fn hold(&self) -> watch::Sender<bool> {
        let (open, hold) = watch::channel(false);
        self.world.with(|world| world.hold = Some(hold));
        open
    }

    /// Counts the events sent so far.
    fn read_events(&mut self) {
        while let Ok(frame) = self.frames.try_recv() {
            let head: Value = serde_json::from_slice(frame.parts().0).unwrap();
            match head["event"].as_str() {
                Some("models.localEngines.changed") => self.changed += 1,
                Some("models.localEngines.failed") => self.failed += 1,
                other => panic!("unexpected event {other:?}"),
            }
        }
    }

    fn changed(&mut self) -> usize {
        self.read_events();
        self.changed
    }

    fn failed(&mut self) -> usize {
        self.read_events();
        self.failed
    }
}

fn ledger(registered: &[&str], removed: &[&str]) -> Ledger {
    Ledger {
        registered: registered.iter().map(|id| (*id).to_owned()).collect(),
        removed: removed.iter().map(|id| (*id).to_owned()).collect(),
    }
}

fn ids(list: &[&str]) -> HashSet<String> {
    list.iter().map(|id| (*id).to_owned()).collect()
}

fn facts(up: Option<bool>, present: bool, registered: bool, removed: bool) -> Facts {
    Facts {
        up,
        present,
        registered,
        removed,
    }
}

#[test]
fn the_table_registers_an_answering_engine_only_when_nothing_of_its_id_exists_and_it_was_never_removed()
 {
    assert_eq!(
        action(&facts(Some(true), false, false, false)),
        Action::Register
    );
    assert_eq!(action(&facts(Some(true), false, false, true)), Action::Keep);
}

#[test]
fn the_table_reads_a_vanished_entry_of_ours_as_the_person_deleting_it_up_down_or_unknown() {
    for up in [Some(true), Some(false), None] {
        assert_eq!(action(&facts(up, false, true, false)), Action::Tombstone);
    }
}

#[test]
fn the_table_unregisters_our_entry_once_its_engine_stops_answering_and_keeps_it_while_it_answers() {
    assert_eq!(
        action(&facts(Some(false), true, true, false)),
        Action::Unregister
    );
    assert_eq!(action(&facts(Some(true), true, true, false)), Action::Keep);
    assert_eq!(action(&facts(None, true, true, false)), Action::Keep);
}

#[test]
fn the_table_never_touches_an_entry_the_person_made_and_does_nothing_for_an_absent_engine() {
    for up in [Some(true), Some(false), None] {
        for removed in [true, false] {
            assert_eq!(action(&facts(up, true, false, removed)), Action::Keep);
        }
    }
    assert_eq!(
        action(&facts(Some(false), false, false, false)),
        Action::Keep
    );
    assert_eq!(
        action(&facts(Some(false), false, false, true)),
        Action::Keep
    );
    assert_eq!(action(&facts(None, false, false, false)), Action::Keep);
}

#[test]
fn a_stored_ledger_drops_what_is_not_a_list_of_strings_and_repeats() {
    let parsed = Ledger::parse(Some(
        &json!({ "registered": ["a", 1, "a", "b"], "removed": "x" }),
    ));
    assert_eq!(parsed, ledger(&["a", "b"], &[]));
    assert_eq!(Ledger::parse(Some(&json!("nope"))), Ledger::default());
    assert_eq!(Ledger::parse(None), Ledger::default());
}

#[tokio::test(start_paused = true)]
async fn registers_an_answering_engine_as_a_discovery_only_provider_and_tells_once() {
    let mut rig = rig(false);
    rig.world.with(|world| world.up.insert("freetoken".into()));
    rig.tick().await;
    assert_eq!(
        rig.world.with(|world| world.inserts.clone()),
        vec![json!({
            "id": "freetoken",
            "api": "openai-completions",
            "baseUrl": "http://127.0.0.1:1919/v1",
            "auth": "none",
            "discovery": { "type": "openai-models-list" },
            "models": [],
        })]
    );
    assert_eq!(rig.ledger(), ledger(&["freetoken"], &[]));
    assert_eq!(rig.changed(), 1);
    // Nothing changed in the next pass: no second write, no second event.
    rig.tick().await;
    assert_eq!(rig.world.with(|world| world.inserts.len()), 1);
    assert_eq!(rig.changed(), 1);
}

#[tokio::test(start_paused = true)]
async fn unregisters_an_entry_whose_engine_stops_answering_and_registers_it_again_when_it_returns()
{
    let mut rig = rig(false);
    rig.world.with(|world| world.up.insert("colibri".into()));
    rig.tick().await;
    rig.world.with(|world| world.up.remove("colibri"));
    rig.tick().await;
    assert!(!rig.file().contains("colibri"));
    assert_eq!(rig.ledger(), Ledger::default());
    assert_eq!(rig.changed(), 2);
    rig.world.with(|world| world.up.insert("colibri".into()));
    rig.tick().await;
    assert!(rig.file().contains("colibri"));
    assert_eq!(rig.changed(), 3);
}

#[tokio::test(start_paused = true)]
async fn never_makes_an_entry_again_that_the_person_deleted_while_the_engine_keeps_answering() {
    let mut rig = rig(false);
    rig.world.with(|world| world.up.insert("freetoken".into()));
    rig.tick().await;
    rig.world.with(|world| world.file.remove("freetoken"));
    rig.tick().await;
    assert_eq!(rig.ledger(), ledger(&[], &["freetoken"]));
    rig.tick().await;
    rig.tick().await;
    assert_eq!(rig.world.with(|world| world.inserts.len()), 1);
    // The tombstone changed nothing in models.yml, so it told nothing.
    assert_eq!(rig.changed(), 1);
}

#[tokio::test(start_paused = true)]
async fn leaves_an_entry_of_the_same_id_the_person_made_alone_up_or_down() {
    let mut rig = rig(false);
    rig.world.with(|world| {
        world.file.insert("freetoken".into());
        world.up.insert("freetoken".into());
    });
    rig.tick().await;
    rig.world.with(|world| world.up.clear());
    rig.tick().await;
    assert!(rig.file().contains("freetoken"));
    assert!(
        rig.world
            .with(|world| world.inserts.is_empty() && world.deletes.is_empty())
    );
    assert_eq!(rig.ledger(), Ledger::default());
    assert_eq!(rig.changed(), 0);
}

#[tokio::test(start_paused = true)]
async fn turning_the_switch_off_removes_every_entry_it_wrote_and_none_of_the_persons() {
    let rig = rig(true);
    rig.world.with(|world| {
        world.up.insert("freetoken".into());
        world.up.insert("colibri".into());
    });
    rig.tick().await;
    assert_eq!(rig.file(), ids(&["freetoken", "colibri"]));
    rig.world.with(|world| world.file.remove("colibri"));
    rig.tick().await;
    rig.set(false).await;
    assert!(rig.file().is_empty());
    assert_eq!(rig.ledger(), ledger(&[], &["colibri"]));
    assert_eq!(
        prefs::get(&rig.prefs, DETECT_PREF).unwrap(),
        Some(json!(false))
    );
    // The tombstone survives while off; no pass runs while off.
    let before = rig.probes();
    pass_time(INTERVAL * 3).await;
    assert_eq!(rig.probes(), before);
}

#[tokio::test(start_paused = true)]
async fn turning_the_switch_on_again_registers_at_once_and_keeps_what_the_person_deleted() {
    let rig = rig(false);
    rig.world.with(|world| {
        world.up.insert("freetoken".into());
        world.up.insert("colibri".into());
    });
    rig.tick().await;
    rig.world.with(|world| world.file.remove("freetoken"));
    rig.tick().await;
    assert_eq!(rig.ledger().removed, vec!["freetoken".to_owned()]);
    rig.set(false).await;
    assert!(rig.file().is_empty());
    rig.set(true).await;
    assert_eq!(rig.ledger(), ledger(&["colibri"], &["freetoken"]));
    assert_eq!(rig.file(), ids(&["colibri"]));
}

#[tokio::test(start_paused = true)]
async fn a_deletion_right_before_the_switch_goes_off_is_a_tombstone_too() {
    let rig = rig(false);
    rig.world.with(|world| world.up.insert("freetoken".into()));
    rig.tick().await;
    rig.world.with(|world| world.file.remove("freetoken"));
    rig.set(false).await;
    assert_eq!(rig.ledger(), ledger(&[], &["freetoken"]));
    assert!(rig.world.with(|world| world.deletes.is_empty()));
    rig.set(true).await;
    assert!(!rig.file().contains("freetoken"));
    assert_eq!(rig.ledger(), ledger(&[], &["freetoken"]));
}

#[tokio::test(start_paused = true)]
async fn a_pass_that_began_before_the_switch_went_off_writes_nothing() {
    let rig = rig(false);
    rig.world.with(|world| world.up.insert("freetoken".into()));
    let open = rig.hold();
    let pass = rig.ask(true);
    settle().await;
    let off = rig.ask(false);
    open.send_replace(true);
    pass.await.unwrap();
    off.await.unwrap();
    assert!(rig.world.with(|world| world.inserts.is_empty()));
    assert!(rig.file().is_empty());
    assert_eq!(rig.ledger(), Ledger::default());
}

#[tokio::test(start_paused = true)]
async fn a_provider_the_person_adds_while_the_probe_runs_is_theirs() {
    let mut rig = rig(false);
    rig.world.with(|world| world.up.insert("freetoken".into()));
    let open = rig.hold();
    let pass = rig.ask(true);
    settle().await;
    rig.world
        .with(|world| world.file.insert("freetoken".into()));
    open.send_replace(true);
    pass.await.unwrap();
    assert!(rig.world.with(|world| world.inserts.is_empty()));
    assert_eq!(rig.ledger(), Ledger::default());
    assert_eq!(rig.changed(), 0);
    // Engine down later: the person's entry is not the detector's to delete.
    rig.world.with(|world| world.up.clear());
    rig.tick().await;
    assert!(rig.world.with(|world| world.deletes.is_empty()));
    assert!(rig.file().contains("freetoken"));
}

#[tokio::test(start_paused = true)]
async fn a_switch_asked_during_a_pass_waits_for_it_instead_of_running_alongside() {
    let rig = rig(false);
    rig.world.with(|world| world.up.insert("freetoken".into()));
    let open = rig.hold();
    let calls = [rig.ask(true), rig.ask(true), rig.ask(true)];
    settle().await;
    assert_eq!(rig.probes(), 2);
    open.send_replace(true);
    for call in calls {
        call.await.unwrap();
    }
    assert_eq!(rig.probes(), 6);
    assert_eq!(rig.world.with(|world| world.inserts.len()), 1);
}

#[tokio::test(start_paused = true)]
async fn starts_with_a_pass_then_waits_the_interval_after_each_pass_ends() {
    let rig = rig(true);
    rig.world.with(|world| world.up.insert("freetoken".into()));
    settle().await;
    assert_eq!(rig.probes(), 2);
    pass_time(INTERVAL - Duration::from_millis(1)).await;
    assert_eq!(rig.probes(), 2);
    pass_time(Duration::from_millis(1)).await;
    assert_eq!(rig.probes(), 4);
    rig.world.with(|world| world.up.clear());
    pass_time(INTERVAL).await;
    assert!(rig.file().is_empty());
}

#[tokio::test(start_paused = true)]
async fn does_not_stack_a_pass_on_one_still_running_when_the_interval_elapses() {
    let rig = rig(true);
    let open = rig.hold();
    pass_time(INTERVAL * 3).await;
    assert_eq!(rig.probes(), 2);
    open.send_replace(true);
    settle().await;
    rig.world.with(|world| world.hold = None);
    pass_time(INTERVAL).await;
    assert_eq!(rig.probes(), 4);
}

#[tokio::test(start_paused = true)]
async fn stops_the_timer_while_off_and_restarts_it_when_turned_on() {
    let rig = rig(true);
    settle().await;
    rig.set(false).await;
    let before = rig.probes();
    pass_time(INTERVAL * 3).await;
    assert_eq!(rig.probes(), before);
    rig.set(true).await;
    assert_eq!(rig.probes(), before + 2);
    pass_time(INTERVAL).await;
    assert_eq!(rig.probes(), before + 4);
}

#[tokio::test(start_paused = true)]
async fn a_detector_without_start_runs_passes_only_for_the_switch() {
    let rig = rig(false);
    pass_time(INTERVAL * 3).await;
    assert_eq!(rig.probes(), 0);
    rig.tick().await;
    pass_time(INTERVAL * 3).await;
    assert_eq!(rig.probes(), 2);
}

#[tokio::test(start_paused = true)]
async fn does_nothing_after_close_not_even_a_timer_already_waiting() {
    let mut rig = rig(true);
    rig.world.with(|world| world.up.insert("freetoken".into()));
    settle().await;
    let probes = rig.probes();
    rig.handle = None;
    (&mut rig.actor).await.unwrap();
    pass_time(INTERVAL * 3).await;
    assert_eq!(rig.probes(), probes);
}

#[tokio::test(start_paused = true)]
async fn a_pass_under_way_when_the_detector_closes_writes_nothing() {
    let mut rig = rig(true);
    rig.world.with(|world| world.up.insert("freetoken".into()));
    let open = rig.hold();
    settle().await;
    rig.handle = None;
    open.send_replace(true);
    (&mut rig.actor).await.unwrap();
    assert!(rig.file().is_empty());
    assert_eq!(rig.ledger(), Ledger::default());
}

#[tokio::test(start_paused = true)]
async fn keeps_an_entry_whose_removal_failed_owned_and_removes_it_on_the_next_pass() {
    let mut rig = rig(false);
    rig.world.with(|world| world.up.insert("freetoken".into()));
    rig.tick().await;
    rig.world.with(|world| {
        world.up.clear();
        world.delete_fails = 1;
    });
    rig.tick().await;
    assert_eq!(rig.failed(), 1);
    assert!(rig.file().contains("freetoken"));
    assert_eq!(rig.ledger(), ledger(&["freetoken"], &[]));
    rig.tick().await;
    assert!(!rig.file().contains("freetoken"));
    assert_eq!(rig.ledger(), Ledger::default());
}

#[tokio::test(start_paused = true)]
async fn an_uninspectable_reply_keeps_the_provider_but_not_another_engine_that_went_offline() {
    let mut rig = rig(false);
    rig.world.with(|world| {
        world.up.insert("freetoken".into());
        world.up.insert("colibri".into());
    });
    rig.tick().await;
    rig.world.with(|world| {
        world.up.clear();
        world.uninspected.insert("freetoken".into());
    });
    rig.tick().await;
    assert_eq!(rig.file(), ids(&["freetoken"]));
    assert_eq!(rig.ledger(), ledger(&["freetoken"], &[]));
    // Not knowing is not a failure.
    assert_eq!(rig.failed(), 0);
    rig.world.with(|world| world.file.remove("freetoken"));
    rig.tick().await;
    assert_eq!(rig.ledger(), ledger(&[], &["freetoken"]));
}

#[tokio::test(start_paused = true)]
async fn reads_an_unreadable_models_yml_as_no_decision_not_as_every_entry_gone() {
    let mut rig = rig(false);
    rig.world.with(|world| world.up.insert("freetoken".into()));
    rig.tick().await;
    rig.world.with(|world| world.ids_fail = true);
    rig.tick().await;
    assert_eq!(rig.ledger(), ledger(&["freetoken"], &[]));
    assert_eq!(rig.failed(), 1);
    rig.set(false).await;
    assert_eq!(rig.ledger(), ledger(&["freetoken"], &[]));
    assert_eq!(rig.failed(), 2);
}

mod wire {
    use serde_json::{Value, json};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    use crate::server::Registry;

    #[tokio::test]
    async fn set_is_refused_without_an_open_detector_and_close_answers_the_open_request() {
        let (client, server) = tokio::io::duplex(1 << 16);
        let (server_read, server_write) = tokio::io::split(server);
        let mut registry = Registry::default();
        super::super::register(&mut registry);
        tokio::spawn(crate::serve(server_read, server_write, registry));
        let (client_read, mut write) = tokio::io::split(client);
        let mut lines = BufReader::new(client_read);
        let mut next = async || {
            let mut line = String::new();
            lines.read_line(&mut line).await.unwrap();
            serde_json::from_str::<Value>(&line).unwrap()
        };
        assert_eq!(next().await["event"], "ready");
        let dir = tempfile::tempdir().unwrap();
        let prefs = dir.path().join("prefs.json");
        let requests = [
            json!({ "id": 1, "method": "models.localEngines.set", "params": { "enabled": false } }),
            json!({ "id": 2, "method": "models.localEngines.open", "params": {
                "dir": dir.path(), "host": "none", "prefs": prefs, "engines": [], "intervalMs": 60_000, "start": false,
            } }),
            json!({ "id": 3, "method": "models.localEngines.close", "params": {} }),
        ];
        for request in requests {
            write
                .write_all(format!("{request}\n").as_bytes())
                .await
                .unwrap();
        }
        let mut answers = [next().await, next().await, next().await];
        answers.sort_by_key(|answer| answer["id"].as_u64());
        assert_eq!(answers[0]["error"]["code"], "no_detector");
        assert_eq!(answers[1]["result"], json!({}));
        assert_eq!(answers[2]["result"], json!({}));
    }
}
