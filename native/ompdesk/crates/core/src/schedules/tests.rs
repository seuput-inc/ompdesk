//! The engine held to what the TypeScript `ScheduleService` did: `captured.json`'s scenarios are scripts of what the
//! page, the clock, the triggers and the runs did, with the state the service answered after each step and the
//! journal it left; its loads are journals as a launch finds them. Each is replayed here on the engine alone, with
//! this file standing in for main (the charge, the run, its stop) and for the host (the run's files).

use std::collections::HashMap;

use serde_json::Value;

use super::captured;
use super::engine::{Commanded, Engine, Limits, Out};
use super::rules::Fixed;
use crate::server::Fault;

/// The clock's check, as `SCHEDULE_TICK_MS` set it.
const TICK_MS: i64 = 30_000;
const DIR: &str = "/work/ompdesk-replay";
const KEY: &str = "KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK";

const FIRED: &str = "\n\nWhat fired this run:\n";

/// A launch the TypeScript recorded, as the core tells it now: the TypeScript pasted what fired a run raw into its
/// prompt, the core quotes it fenced as other people's words (`fence_untrusted`).
fn as_fenced(launch: &Value) -> Value {
    let mut launch = launch.clone();
    if let Some((head, detail)) = launch["prompt"]
        .as_str()
        .and_then(|prompt| prompt.split_once(FIRED))
    {
        let fenced = format!("{head}{FIRED}{}", super::engine::fence_untrusted(detail));
        launch["prompt"] = fenced.into();
    }
    launch
}

/// Run fields the core added after the TypeScript: left out of what is held to the capture, and pinned by the
/// hand-written tests below.
const CORE_RUN_FIELDS: [&str; 4] = ["notStarted", "repeats", "resentAs", "usage"];

/// A state or a journal (`pretty`) as the TypeScript would have had it: without `CORE_RUN_FIELDS`.
fn ts_view(text: &str, pretty: bool) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(text) else {
        return text.to_owned();
    };
    let mut stripped = false;
    if let Some(runs) = value.get_mut("runs").and_then(Value::as_array_mut) {
        for run in runs.iter_mut().filter_map(Value::as_object_mut) {
            for field in CORE_RUN_FIELDS {
                stripped |= run.shift_remove(field).is_some();
            }
        }
    }
    match (stripped, pretty) {
        (false, _) => text.to_owned(),
        (true, true) => serde_json::to_string_pretty(&value).unwrap(),
        (true, false) => value.to_string(),
    }
}

fn limits() -> Limits {
    Limits {
        runs_kept: 200,
        runs_per_schedule: 20,
        once_done_kept: 20,
        chain_limit: 10,
        agent_prefix: "[agent] ".into(),
    }
}

fn engine(ids: std::sync::Arc<std::sync::atomic::AtomicU64>) -> Engine {
    let next = move || {
        let number = ids.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        format!("u~{number}~")
    };
    Engine::new(
        limits(),
        60_000,
        true,
        true,
        Box::new(Fixed(0)),
        Box::new(next),
        Box::new(|| KEY.to_owned()),
    )
}

/// Main and the host, as the capture's fakes were: a device's budget, runs that end when the script says, a folder
/// named `gone` that is not there.
struct Play {
    engine: Engine,
    ids: std::sync::Arc<std::sync::atomic::AtomicU64>,
    now: i64,
    next_tick: i64,
    /// A device's requests left; none: no limit.
    left: Option<u64>,
    launches: Vec<(String, String, bool)>,
    refunds: u64,
    journals: Vec<String>,
    /// What a run now answered once main had said whether it may be charged.
    answered: Option<Result<(), Fault>>,
    schedules: Vec<String>,
    runs: Vec<String>,
    /// The engine's ids by the names the capture gave them: in the order they first showed.
    names: HashMap<String, String>,
    /// The first schedule's webhook key as it last was, which the capture wrote as `<key>`.
    key: String,
    /// Prechecks the fake shell was asked to run (it says yes to `true` only), and quiet notes main was asked to send.
    prechecks: Vec<String>,
    notes: Vec<(String, String)>,
    /// Runs whose result the host was asked to send, and where.
    results: Vec<(String, Value)>,
}

impl Play {
    fn new(start: i64) -> Play {
        let ids = std::sync::Arc::default();
        let mut play = Play {
            engine: engine(std::sync::Arc::clone(&ids)),
            ids,
            now: start,
            next_tick: start + TICK_MS,
            left: None,
            launches: Vec::new(),
            refunds: 0,
            journals: Vec::new(),
            answered: None,
            schedules: Vec::new(),
            runs: Vec::new(),
            names: HashMap::new(),
            key: String::new(),
            prechecks: Vec::new(),
            notes: Vec::new(),
            results: Vec::new(),
        };
        play.engine.load(None, start);
        play.settle();
        play
    }

    fn settle(&mut self) {
        loop {
            let outs = std::mem::take(&mut self.engine.outs);
            if outs.is_empty() {
                break;
            }
            for out in outs {
                match out {
                    Out::Reserve { ask, device } => {
                        let refused = match &mut self.left {
                            Some(0) => Some(format!("{device}'s daily model limit is used up")),
                            Some(left) => {
                                *left -= 1;
                                None
                            }
                            None => None,
                        };
                        let answered = self.engine.reserved(ask, refused.as_deref(), self.now);
                        self.answered = self.answered.take().or(answered);
                    }
                    Out::Refund { .. } => self.refunds += 1,
                    Out::Prepare { run, cwd, .. } => {
                        let failed = cwd
                            .filter(|cwd| cwd.ends_with("/gone"))
                            .map(|cwd| format!("Project folder not found: {cwd}"));
                        self.engine.prepared(&run, failed, self.now);
                    }
                    Out::Start {
                        run,
                        schedule,
                        wake,
                        ..
                    } => {
                        let prompt = schedule["prompt"].as_str().unwrap().to_owned();
                        self.launches.push((run.clone(), prompt, wake));
                        self.engine.started(&run, self.now);
                    }
                    // The fake run ends as a stopped supervisor does.
                    Out::Stop { run } => self.engine.ended(&run, Some(130), None, self.now),
                    Out::Closed { journal } => self.journals.push(journal),
                    Out::Precheck { ask, command, .. } => {
                        let ok = command == "true";
                        self.prechecks.push(command);
                        self.engine.prechecked(ask, ok, "not today\nno", self.now);
                    }
                    Out::Note { session, text } => self.notes.push((session, text)),
                    Out::Result { run, to, .. } => self.results.push((run, to)),
                    Out::Changed { .. }
                    | Out::WakeLog { .. }
                    | Out::RemovePrompt { .. }
                    | Out::RemoveLogs { .. } => {}
                }
            }
        }
    }

    /// `@n`: the nth schedule that showed; `#n`: the nth run.
    fn named(&self, written: &Value) -> String {
        let text = written.as_str().unwrap_or_default();
        let at = |list: &[String]| {
            let index: usize = text[1..].parse().unwrap();
            list.get(index).cloned().unwrap_or_else(|| "missing".into())
        };
        match text.as_bytes().first() {
            Some(b'@') => at(&self.schedules),
            Some(b'#') => at(&self.runs),
            _ => text.to_owned(),
        }
    }

    fn track(&mut self) {
        let state = self.engine.state();
        let ids = |list: &Value| -> Vec<String> {
            let items = list.as_array().unwrap();
            items
                .iter()
                .map(|item| item["id"].as_str().unwrap().to_owned())
                .collect()
        };
        for id in ids(&state["schedules"]) {
            if !self.schedules.contains(&id) {
                self.schedules.push(id);
            }
        }
        // Oldest first among the ones not seen yet: the list is newest first.
        for id in ids(&state["runs"]).into_iter().rev() {
            if !self.runs.contains(&id) {
                self.runs.push(id);
            }
        }
    }

    /// `text` as the capture wrote it: each id by the order it first showed, the key and the folder by their marks.
    fn normal(&mut self, text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        let mut rest = text;
        while let Some(at) = rest.find("u~") {
            let end = at + 2 + rest[at + 2..].find('~').unwrap() + 1;
            out.push_str(&rest[..at]);
            let count = self.names.len();
            let name = self
                .names
                .entry(rest[at..end].to_owned())
                .or_insert_with(|| format!("id-{count}"));
            out.push_str(name);
            rest = &rest[end..];
        }
        out.push_str(rest);
        if !self.key.is_empty() {
            out = out.replace(&self.key, "<key>");
        }
        out.replace(DIR, "<dir>")
    }

    fn rekey(&mut self) {
        let event = &self.engine.state()["schedules"][0]["frequency"]["event"];
        if let (Some("webhook"), Some(key)) = (event["source"].as_str(), event["key"].as_str()) {
            self.key = key.to_owned();
        }
    }

    /// `told`: the prompts the TypeScript's runs were started with, in its order. Runs that came due in one check
    /// it started in whatever order their files were made, so a script's `launch` names a run by its prompt.
    fn step(&mut self, step: &Value, told: &[Value]) -> (Option<Value>, Option<String>) {
        let own = |fault: Fault| match fault.code.as_ref() {
            "remote_limit_reached" => format!("[remote_limit_reached] {}", fault.message),
            _ => fault.message,
        };
        let origin = step["origin"].as_str();
        let now = self.now;
        let mut result = None;
        let mut error = None;
        let command = |play: &mut Play, request: Value| {
            let commanded = play.engine.command(&request, origin, now);
            play.settle();
            match commanded {
                Ok(Commanded::Done) => None,
                Ok(Commanded::Asked(_)) => play.answered.take().and_then(Result::err).map(own),
                Err(fault) => Some(own(fault)),
            }
        };
        let id = self.named(&step["id"]);
        match step["op"].as_str().unwrap() {
            "advance" => {
                let until = now + step["ms"].as_i64().unwrap();
                while self.next_tick <= until {
                    self.now = self.next_tick;
                    self.engine.tick(self.now);
                    self.settle();
                    self.next_tick += TICK_MS;
                }
                self.now = until;
            }
            "reserve" => self.left = step["left"].as_u64(),
            "create" => match self.engine.create(&step["draft"], origin, now) {
                Ok(id) => {
                    self.settle();
                    self.track();
                    let at = self.schedules.iter().position(|known| *known == id);
                    result = Some(Value::String(format!("@{}", at.unwrap())));
                }
                Err(fault) => error = Some(own(fault)),
            },
            "save" => {
                let mut request = serde_json::json!({ "action": "save", "draft": step["draft"] });
                if !step["id"].is_null() {
                    request["id"] = id.into();
                }
                error = command(self, request);
            }
            "delete" => error = command(self, serde_json::json!({ "action": "delete", "id": id })),
            "setEnabled" => {
                let request = serde_json::json!({ "action": "setEnabled", "id": id, "enabled": step["enabled"] });
                error = command(self, request);
            }
            "setPaused" => {
                let request =
                    serde_json::json!({ "action": "setPaused", "paused": step["paused"] });
                error = command(self, request);
            }
            "runNow" => error = command(self, serde_json::json!({ "action": "runNow", "id": id })),
            "stop" => {
                let run = self.named(&step["run"]);
                error = command(self, serde_json::json!({ "action": "stop", "runId": run }));
            }
            "get" => error = command(self, serde_json::json!({ "action": "get" })),
            "command" => error = command(self, step["request"].clone()),
            "fire" => {
                let detail = step["detail"].as_str().unwrap();
                result = Some(self.engine.fire(&id, detail, now).into());
            }
            "webhook" => {
                let bearer = step["bearer"].as_str().unwrap();
                let bearer = bearer.replace("$key", KEY).replace("+x", "x");
                let detail = step["detail"].as_str().unwrap();
                result = Some(self.engine.webhook(&id, &bearer, detail, now).into());
            }
            "triggerFailed" => {
                let reason = step["reason"].as_str().unwrap();
                result = Some(self.engine.trigger_failed(&id, reason, now).into());
            }
            "prune" => self.engine.prune(now + step["plus"].as_i64().unwrap(), now),
            "finish" => {
                let launch = step["launch"].as_u64().unwrap() as usize;
                let prompt = told.get(launch).map(|told| &told["prompt"]);
                let earlier = told.iter().take(launch);
                let nth = earlier
                    .filter(|told| Some(&told["prompt"]) == prompt)
                    .count();
                let ours = self.launches.iter();
                let mut ours = ours
                    .filter(|(_, ours, _)| Some(ours.as_str()) == prompt.and_then(Value::as_str));
                match ours.nth(nth) {
                    Some((run, ..)) => {
                        let run = run.clone();
                        let error = step["error"].as_str().map(str::to_owned);
                        self.engine.ended(&run, step["code"].as_i64(), error, now);
                    }
                    None => error = Some(format!("no launch {launch}")),
                }
            }
            "dispose" => self.engine.close(now),
            "reload" => {
                self.engine.close(now);
                self.settle();
                let journal = self.journals.last().unwrap().clone();
                self.engine = engine(std::sync::Arc::clone(&self.ids));
                self.engine.load(Some(&journal), now);
                self.next_tick = now + TICK_MS;
            }
            other => panic!("unknown step {other}"),
        }
        self.settle();
        (result, error)
    }
}

/// Two long texts are the same; a failure shows where they part.
#[track_caller]
fn same(ours: &str, theirs: &str, at: &str) {
    if ours == theirs {
        return;
    }
    let parted = ours
        .bytes()
        .zip(theirs.bytes())
        .position(|(ours, theirs)| ours != theirs)
        .unwrap_or(ours.len().min(theirs.len()));
    let near = |text: &str| {
        let from = (0..=parted.saturating_sub(300))
            .rev()
            .find(|at| text.is_char_boundary(*at));
        let to = (parted + 200).min(text.len());
        let to = (to..=text.len()).find(|at| text.is_char_boundary(*at));
        text[from.unwrap_or(0)..to.unwrap_or(text.len())].to_owned()
    };
    panic!("{at}\n  ours: …{}\ntheirs: …{}", near(ours), near(theirs));
}

#[test]
fn does_what_the_typescript_service_did() {
    let scenarios = captured("scenarios");
    assert_eq!(scenarios.len(), 26);
    for scenario in scenarios {
        let name = scenario["name"].as_str().unwrap();
        let mut play = Play::new(scenario["start"].as_i64().unwrap());
        let steps = serde_json::to_string(&scenario["steps"]).unwrap();
        let steps: Value = serde_json::from_str(&steps.replace("<dir>", DIR)).unwrap();
        let mut journals = 0;
        for (index, step) in steps.as_array().unwrap().iter().enumerate() {
            let at = format!("{name}, step {index} {step}");
            let told: Vec<Value> = scenario["launches"]
                .as_array()
                .unwrap()
                .iter()
                .map(as_fenced)
                .collect();
            let (result, error) = play.step(step, &told);
            play.track();
            // In the order the capture named things: a journal a step wrote, then its error, then its state.
            for journal in play.journals.clone().iter().skip(journals) {
                let journal = play.normal(&ts_view(journal, true));
                same(
                    &journal,
                    scenario["journals"][journals].as_str().unwrap(),
                    &at,
                );
                journals += 1;
            }
            play.rekey();
            let record = &scenario["records"][index];
            if record.is_null() {
                continue;
            }
            let error = error.map(|error| play.normal(&error));
            assert_eq!(error.as_deref(), record["error"].as_str(), "{at}");
            assert_eq!(result.as_ref(), record.get("result"), "{at}");
            let state = play.engine.state().to_string();
            same(
                &play.normal(&ts_view(&state, false)),
                &record["state"].to_string(),
                &at,
            );
            assert_eq!(
                play.launches.len() as u64,
                record["launched"].as_u64().unwrap(),
                "{at}"
            );
            assert_eq!(play.refunds, record["refunds"].as_u64().unwrap(), "{at}");
        }
        let mut ours: Vec<String> = play
            .launches
            .iter()
            .map(|(_, prompt, wake)| {
                serde_json::json!({ "prompt": prompt, "wake": wake }).to_string()
            })
            .collect();
        let theirs = scenario["launches"].as_array().unwrap();
        let mut theirs: Vec<String> = theirs
            .iter()
            .map(|launch| as_fenced(launch).to_string())
            .collect();
        ours.sort();
        theirs.sort();
        assert_eq!(ours, theirs, "{name}");
        assert_eq!(
            journals,
            scenario["journals"].as_array().unwrap().len(),
            "{name}"
        );
    }
}

#[test]
fn reads_a_journal_as_the_typescript_service_did() {
    let loads = captured("loads");
    assert_eq!(loads.len(), 10);
    for load in loads {
        let name = load["name"].as_str().unwrap();
        let mut engine = engine(std::sync::Arc::default());
        let now = load["now"].as_i64().unwrap();
        engine.load(load["text"].as_str(), now);
        same(
            &engine.state().to_string(),
            &load["state"].to_string(),
            name,
        );
        engine.outs.clear();
        engine.close(now);
        let Some(Out::Closed { journal }) = engine.outs.pop() else {
            panic!("{name}: no journal at the close");
        };
        same(&journal, load["journal"].as_str().unwrap(), name);
    }
}

#[test]
fn a_stop_asked_before_main_started_the_run_goes_out_once_it_did() {
    let mut engine = engine(std::sync::Arc::default());
    engine.load(None, 0);
    let draft = serde_json::json!({
        "name": "Tidy", "prompt": "Tidy", "cwd": "/work", "frequency": { "kind": "interval", "minutes": 60 },
        "model": null, "autoApprove": false, "enabled": true,
    });
    let id = engine.create(&draft, None, 0).unwrap();
    let run_now = serde_json::json!({ "action": "runNow", "id": id });
    assert!(matches!(
        engine.command(&run_now, None, 0),
        Ok(Commanded::Done)
    ));
    let run = engine
        .outs
        .iter()
        .find_map(|out| match out {
            Out::Prepare { run, .. } => Some(run.clone()),
            _ => None,
        })
        .unwrap();
    engine.outs.clear();
    engine.prepared(&run, None, 0);
    assert!(matches!(
        engine.outs.as_slice(),
        [Out::Start { wake: false, .. }]
    ));
    engine.outs.clear();
    let stop = serde_json::json!({ "action": "stop", "runId": run });
    assert!(matches!(
        engine.command(&stop, None, 0),
        Ok(Commanded::Done)
    ));
    assert!(
        !engine
            .outs
            .iter()
            .any(|out| matches!(out, Out::Stop { .. }))
    );
    engine.started(&run, 0);
    assert!(
        engine
            .outs
            .iter()
            .any(|out| matches!(out, Out::Stop { .. }))
    );
    // Whatever the run answers, it reads stopped.
    engine.ended(&run, Some(0), None, 5);
    let state = engine.state();
    assert_eq!(state["runs"][0]["status"], "stopped");
    assert_eq!(state["runs"][0]["error"], Value::Null);
}

#[test]
fn a_charge_asked_while_the_schedule_goes_is_given_back() {
    let mut engine = engine(std::sync::Arc::default());
    engine.load(None, 0);
    let draft = serde_json::json!({
        "name": "Tidy", "prompt": "Tidy", "cwd": "/work", "frequency": { "kind": "interval", "minutes": 60 },
        "model": null, "autoApprove": false, "enabled": true,
    });
    let id = engine.create(&draft, Some("dev-a"), 0).unwrap();
    engine.tick(3_600_000);
    let ask = engine
        .outs
        .iter()
        .find_map(|out| match out {
            Out::Reserve { ask, .. } => Some(*ask),
            _ => None,
        })
        .unwrap();
    // The check after it finds the start waiting, and neither asks again nor calls it skipped.
    engine.outs.clear();
    engine.tick(3_630_000);
    assert!(engine.outs.is_empty());
    let delete = serde_json::json!({ "action": "delete", "id": id });
    assert!(matches!(
        engine.command(&delete, None, 3_630_000),
        Ok(Commanded::Done)
    ));
    engine.outs.clear();
    assert!(engine.reserved(ask, None, 3_630_001).is_none());
    assert!(matches!(engine.outs.as_slice(), [Out::Refund { charge }] if *charge == ask));
    assert_eq!(engine.state()["runs"], serde_json::json!([]));
}

#[test]
fn an_old_routine_quota_answer_cannot_start_or_release_the_new_generations_run() {
    let mut engine = engine(std::sync::Arc::default());
    engine.load(None, 0);
    let draft = serde_json::json!({"name":"Watch", "prompt":"Look", "cwd":"/work", "model":null, "autoApprove":false, "enabled":true,
        "frequency":{"kind":"event","event":{"source":"session","events":["done"]}}});
    let id = engine.create(&draft, Some("peer"), 0).unwrap();
    let ask = |engine: &Engine| {
        engine
            .outs
            .iter()
            .rev()
            .find_map(|out| match out {
                Out::Reserve { ask, .. } => Some(*ask),
                _ => None,
            })
            .unwrap()
    };
    assert!(engine.fire(&id, "old", 1));
    let old = ask(&engine);
    assert!(engine.fire(&id, "old pending", 2));
    engine.retire_trigger(&id);
    assert!(matches!(engine.outs.last(), Some(Out::Refund { charge }) if *charge == old));
    assert!(engine.fire(&id, "new", 3));
    let new = ask(&engine);
    assert_ne!(old, new);
    engine.outs.clear();
    assert!(engine.reserved(old, None, 4).is_none());
    assert!(engine.outs.is_empty());
    assert!(engine.reserved(new, None, 5).is_none());
    assert_eq!(engine.state()["runs"][0]["detail"], "new");
}

/// The journal's writer thread can be holding an older state when the quit's close writes the last one; nothing of
/// it may land after the close, not even its temp file, or the folder cannot be removed (`ENOTEMPTY` on Windows).
#[test]
fn nothing_of_the_journal_lands_after_its_close() {
    for round in 0..200 {
        let dir = crate::fs::disk::make_temp_dir("ompdesk-core-journal-").unwrap();
        let file = dir.join("schedules.json");
        let journal = super::Journal::open(file.clone(), None, "schedules");
        journal.keep("older".into());
        journal.close("last");
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "last",
            "round {round}"
        );
        std::fs::remove_dir_all(&dir).unwrap_or_else(|error| panic!("round {round}: {error}"));
    }
}

const HOUR: i64 = 3_600_000;

fn draft(frequency: Value) -> Value {
    serde_json::json!({
        "name": "Tidy", "prompt": "Look", "cwd": "/work", "frequency": frequency,
        "model": null, "autoApprove": false, "enabled": true,
    })
}

impl Play {
    /// OMPdesk closed now and opened again `away` later, as a launch opens the schedules: load, then catch up.
    fn relaunch(&mut self, away: i64) {
        self.engine.close(self.now);
        self.settle();
        let journal = self.journals.last().unwrap().clone();
        self.now += away;
        self.next_tick = self.now + TICK_MS;
        self.engine = engine(std::sync::Arc::clone(&self.ids));
        self.engine.load(Some(&journal), self.now);
        self.engine.catch_up(self.now);
        self.settle();
    }

    fn run(&mut self, request: Value) -> Result<Commanded, Fault> {
        let commanded = self.engine.command(&request, None, self.now);
        self.settle();
        commanded
    }

    fn end_last(&mut self, code: Option<i64>, error: Option<&str>) {
        let run = self.launches.last().unwrap().0.clone();
        self.engine
            .ended(&run, code, error.map(str::to_owned), self.now);
        self.settle();
    }

    fn runs(&self) -> Vec<Value> {
        self.engine.state()["runs"].as_array().unwrap().clone()
    }
}

#[test]
fn a_start_missed_while_closed_runs_once_within_the_grace_and_is_recorded_past_it() {
    let mut play = Play::new(0);
    play.engine
        .create(
            &draft(serde_json::json!({"kind": "interval", "minutes": 60})),
            None,
            0,
        )
        .unwrap();
    play.settle();
    // Due at one hour, closed until half an hour after: it starts at the first check after the launch.
    play.relaunch(HOUR + HOUR / 2);
    assert!(play.launches.is_empty());
    play.step(&serde_json::json!({"op": "advance", "ms": TICK_MS}), &[]);
    assert_eq!(play.launches.len(), 1);
    play.end_last(Some(0), None);
    // Closed for a day now: recorded once as missed, nothing runs at once, and a launch after it records nothing more.
    play.relaunch(24 * HOUR);
    let runs = play.runs();
    assert_eq!(runs[0]["status"], "skipped");
    assert!(
        runs[0]["error"]
            .as_str()
            .unwrap()
            .starts_with("Missed while OMPdesk was closed (due ")
    );
    play.step(&serde_json::json!({"op": "advance", "ms": TICK_MS}), &[]);
    assert_eq!(play.launches.len(), 1);
    play.relaunch(60_000);
    assert_eq!(play.runs().len(), runs.len());
}

#[test]
fn a_one_time_start_missed_past_the_grace_is_spent() {
    let mut play = Play::new(0);
    let at = rules_iso(HOUR);
    play.engine
        .create(
            &draft(serde_json::json!({"kind": "once", "at": at})),
            None,
            0,
        )
        .unwrap();
    play.settle();
    play.relaunch(3 * HOUR);
    let state = play.engine.state();
    assert_eq!(state["schedules"][0]["enabled"], false);
    assert_eq!(state["runs"][0]["status"], "skipped");
    play.step(&serde_json::json!({"op": "advance", "ms": HOUR}), &[]);
    assert!(play.launches.is_empty());
}

fn rules_iso(ms: i64) -> String {
    super::rules::iso(ms)
}

#[test]
fn just_woken_timed_starts_wait_for_the_settle_then_start() {
    let mut play = Play::new(0);
    play.engine
        .create(
            &draft(serde_json::json!({"kind": "interval", "minutes": 60})),
            None,
            0,
        )
        .unwrap();
    play.settle();
    play.now = HOUR;
    play.engine.resumed(HOUR);
    play.engine.tick(HOUR + TICK_MS);
    play.settle();
    assert!(play.launches.is_empty(), "held while the computer settles");
    assert!(play.runs().is_empty(), "never recorded as skipped");
    play.engine.tick(HOUR + 2 * 60_000);
    play.settle();
    assert_eq!(play.launches.len(), 1);
}

#[test]
fn a_precheck_decides_the_start_and_a_repeated_no_folds_into_one_row() {
    let mut play = Play::new(0);
    let mut routine =
        draft(serde_json::json!({"kind": "event", "event": {"source": "files", "path": "/work"}}));
    routine["precheck"] = "test -f /work/ready".into();
    let id = play.engine.create(&routine, None, 0).unwrap();
    play.settle();
    assert!(play.engine.fire(&id, "a.ts changed", 0));
    play.settle();
    assert!(play.engine.fire(&id, "b.ts changed", 0));
    play.settle();
    assert_eq!(
        play.prechecks,
        ["test -f /work/ready", "test -f /work/ready"]
    );
    assert!(play.launches.is_empty());
    let runs = play.runs();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["error"], "Its precheck said no: not today no");
    assert_eq!(runs[0]["repeats"], 2);
    routine["precheck"] = "true".into();
    let save = serde_json::json!({"action": "save", "id": id, "draft": routine});
    assert!(play.run(save).is_ok());
    assert!(play.engine.fire(&id, "c.ts changed", 0));
    play.settle();
    assert_eq!(play.launches.len(), 1);
    // A paired device never sets a shell command that runs on this computer.
    assert!(play.engine.create(&routine, Some("dev-a"), 0).is_err());
}

#[test]
fn a_routines_test_replays_its_last_event_fenced() {
    let mut play = Play::new(0);
    let id = play
        .engine
        .create(
            &draft(
                serde_json::json!({"kind": "event", "event": {"source": "files", "path": "/work"}}),
            ),
            None,
            0,
        )
        .unwrap();
    play.settle();
    assert!(
        play.run(serde_json::json!({"action": "runNow", "id": id}))
            .is_ok()
    );
    assert!(
        play.launches[0]
            .1
            .ends_with("Test run:\nA test run: no event fired")
    );
    play.end_last(Some(0), None);
    assert!(play.engine.fire(&id, "Ann pushed `main`", 0));
    play.settle();
    play.end_last(Some(0), None);
    assert!(
        play.run(serde_json::json!({"action": "runNow", "id": id}))
            .is_ok()
    );
    let prompt = &play.launches[2].1;
    assert!(prompt.contains("A test run, replaying its last event:\n"));
    assert!(prompt.contains("```text\nAnn pushed `main`\n```"));
    assert_eq!(play.runs()[0]["trigger"], "manual");
}

#[test]
fn a_run_that_could_not_start_is_sent_again_once_whoever_asks() {
    let mut play = Play::new(0);
    let mut gone = draft(serde_json::json!({"kind": "interval", "minutes": 60}));
    gone["cwd"] = "/work/gone".into();
    let id = play.engine.create(&gone, None, 0).unwrap();
    play.settle();
    assert!(
        play.run(serde_json::json!({"action": "runNow", "id": id}))
            .is_ok()
    );
    let failed = play.runs()[0].clone();
    assert_eq!(failed["status"], "failed");
    assert_eq!(failed["notStarted"], true);
    let run = failed["id"].as_str().unwrap().to_owned();
    let resend = serde_json::json!({"action": "resend", "runId": run});
    // Another computer cannot spend it; this one can, once.
    assert!(play.engine.command(&resend, Some("dev-a"), 0).is_err());
    assert!(play.run(resend.clone()).is_ok());
    assert_eq!(play.runs().len(), 2);
    let original = play
        .runs()
        .into_iter()
        .find(|r| r["id"] == run.as_str())
        .unwrap();
    let sent = original["resentAs"].as_str().unwrap().to_owned();
    assert_ne!(sent, run);
    assert!(play.run(resend.clone()).is_ok());
    play.relaunch(60_000);
    assert!(play.run(resend).is_ok());
    assert_eq!(
        play.runs()
            .iter()
            .filter(|r| r["scheduleId"] == id.as_str())
            .count(),
        2
    );
    // A run that started is never sent again.
    play.engine
        .create(
            &draft(serde_json::json!({"kind": "interval", "minutes": 60})),
            None,
            0,
        )
        .unwrap();
    let ok = play.engine.state()["schedules"][1]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        play.run(serde_json::json!({"action": "runNow", "id": ok}))
            .is_ok()
    );
    play.end_last(Some(1), None);
    let started = play.runs()[0]["id"].as_str().unwrap().to_owned();
    assert!(
        play.run(serde_json::json!({"action": "resend", "runId": started}))
            .is_err()
    );
}

#[test]
fn a_wake_up_that_fails_three_times_in_a_row_turns_itself_off_and_tells_its_session() {
    let mut play = Play::new(0);
    let mut wake = draft(serde_json::json!({"kind": "interval", "minutes": 60}));
    wake["wakeSession"] = "/sessions/a.jsonl".into();
    let id = play.engine.create(&wake, None, 0).unwrap();
    play.settle();
    for round in 0..3 {
        assert!(
            play.run(serde_json::json!({"action": "runNow", "id": id}))
                .is_ok(),
            "{round}"
        );
        play.end_last(None, Some("The turn ended with an error"));
    }
    let state = play.engine.state();
    assert_eq!(state["schedules"][0]["enabled"], false);
    assert_eq!(
        state["runs"][0]["error"],
        "Turned off after 3 failed runs in a row"
    );
    assert_eq!(play.notes.len(), 1);
    assert_eq!(play.notes[0].0, "/sessions/a.jsonl");
    assert!(play.notes[0].1.contains("The turn ended with an error"));
}

fn wait(by: i64) -> Value {
    let mut wait = draft(serde_json::json!({
        "kind": "event", "event": {"source": "files", "path": "/work"}, "by": rules_iso(by),
    }));
    wait["wakeSession"] = "/sessions/a.jsonl".into();
    wait
}

#[test]
fn a_wait_runs_once_on_its_event_or_at_its_deadline() {
    // The event first: one run with it, then the wait is spent and a later event starts nothing.
    let mut play = Play::new(0);
    let id = play.engine.create(&wait(HOUR), None, 0).unwrap();
    play.settle();
    assert_eq!(
        play.engine.state()["nextRuns"][&id],
        Value::String(rules_iso(HOUR))
    );
    assert!(play.engine.fire(&id, "ready.txt created", 0));
    play.settle();
    assert_eq!(play.launches.len(), 1);
    play.end_last(Some(0), None);
    assert!(!play.engine.fire(&id, "again", 0));
    play.step(&serde_json::json!({"op": "advance", "ms": 2 * HOUR}), &[]);
    assert_eq!(play.launches.len(), 1);
    // The deadline first: one run that says so, then spent.
    let mut play = Play::new(0);
    let id = play.engine.create(&wait(HOUR), None, 0).unwrap();
    play.settle();
    play.step(&serde_json::json!({"op": "advance", "ms": HOUR}), &[]);
    assert_eq!(play.launches.len(), 1);
    assert!(
        play.launches[0]
            .1
            .ends_with("Its deadline passed and the event did not come.")
    );
    assert_eq!(play.engine.state()["schedules"][0]["enabled"], false);
    assert!(!play.engine.fire(&id, "late", HOUR));
    // A deadline already past is refused.
    assert!(play.engine.create(&wait(HOUR / 2), None, HOUR).is_err());
}

#[test]
fn a_wait_whose_deadline_passed_while_closed_is_spent_unrun_and_its_session_told() {
    let mut play = Play::new(0);
    play.engine.create(&wait(HOUR), None, 0).unwrap();
    play.settle();
    play.relaunch(2 * HOUR);
    let state = play.engine.state();
    assert_eq!(state["schedules"][0]["enabled"], false);
    assert_eq!(
        state["runs"][0]["error"],
        "Its deadline passed while OMPdesk was closed"
    );
    assert_eq!(play.notes.len(), 1);
    assert_eq!(play.notes[0].0, "/sessions/a.jsonl");
    play.step(&serde_json::json!({"op": "advance", "ms": HOUR}), &[]);
    assert!(play.launches.is_empty());
}

#[test]
fn a_fresh_runs_result_goes_where_its_schedule_says_unless_it_is_quiet() {
    let mut play = Play::new(0);
    let mut report = draft(serde_json::json!({"kind": "interval", "minutes": 60}));
    report["resultsTo"] = serde_json::json!({"kind": "notify", "forged": true});
    let id = play.engine.create(&report, None, 0).unwrap();
    assert_eq!(
        play.engine.state()["schedules"][0]["resultsTo"],
        serde_json::json!({"kind": "notify"})
    );
    play.settle();
    assert!(
        play.run(serde_json::json!({"action": "runNow", "id": id}))
            .is_ok()
    );
    assert!(
        play.launches[0]
            .1
            .ends_with("end your answer with the line NO_REPLY.")
    );
    play.end_last(Some(1), None);
    assert!(play.results.is_empty(), "a failed run sends nothing");
    assert!(
        play.run(serde_json::json!({"action": "runNow", "id": id}))
            .is_ok()
    );
    play.end_last(Some(0), None);
    assert_eq!(play.results.len(), 1);
    assert_eq!(play.results[0].1, serde_json::json!({"kind": "notify"}));
}

#[test]
fn keeps_what_a_fresh_run_used_on_its_row() {
    let mut play = Play::new(0);
    let id = play
        .engine
        .create(
            &draft(serde_json::json!({"kind": "interval", "minutes": 60})),
            None,
            0,
        )
        .unwrap();
    play.settle();
    assert!(
        play.run(serde_json::json!({"action": "runNow", "id": id}))
            .is_ok()
    );
    let run = play.launches[0].0.clone();
    let used = serde_json::json!({"input": 1200, "output": 300, "cacheRead": 0, "cacheWrite": 0, "cost": 0.012});
    play.engine.usage(&run, used.clone());
    play.engine.usage(&run, serde_json::json!("not usage"));
    play.end_last(Some(0), None);
    assert_eq!(play.runs()[0]["usage"], used);
    assert_eq!(play.runs()[0]["status"], "succeeded");
}

#[test]
fn reads_a_runs_answer_and_tells_a_quiet_one() {
    use super::engine::{quiet_result, run_answer};
    let log = "$ omp -p --model x\n# /work\n\nChecked the feed.\nTwo new releases.";
    assert_eq!(run_answer(log), "Checked the feed.\nTwo new releases.");
    assert_eq!(run_answer(&"x".repeat(2500)).len(), 2000);
    for quiet in [
        "NO_REPLY",
        "Nothing new.\n\n**NO_REPLY**\n",
        "- `NO_REPLY`.",
        "## NO_REPLY",
    ] {
        assert!(quiet_result(quiet), "{quiet}");
    }
    for loud in [
        "",
        "NO_REPLY\nBut the build broke.",
        "I would say NO_REPLY",
        "NO_REPLY_X",
    ] {
        assert!(!quiet_result(loud), "{loud}");
    }
}

#[test]
fn a_dark_wake_is_told_by_the_missing_graphics_capability() {
    let full =
        "Current System Capabilities are: CPU Graphics Audio Network \nCurrent Power State: 4\n";
    let dark = "Current System Capabilities are: CPU Network \nCurrent Power State: 4\n";
    assert!(!super::is_dark_wake(full));
    assert!(super::is_dark_wake(dark));
    // An output without the line is read as awake: a run is never held on a guess.
    assert!(!super::is_dark_wake("pmset: unknown\n"));
}
