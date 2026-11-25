//! OMPdesk is the one owner of omp updates (was `src/main/omp-auto-takeover.ts`; `docs/design/follow-omp.md`):
//! stock omp's own background update (`update.auto`, default off) installs the registry's newest on any interactive
//! launch and takes no version, so the verified list cannot steer it. While OMPdesk follows that list
//! (`ompFollowVerified`) and "Keep tools up to date" is on, a launch that updates omp on its own turns a stock
//! `update.auto` that is on off, once, through `omp config set`, and records it in `<userData>/omp-auto-takeover.json`.
//! Either switch going off gives the value back, but only while stock still holds what OMPdesk wrote; a person who
//! changed it in between keeps their choice.

use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value, json};

use super::super::Tools;
use super::super::setup::OmpRun;
use crate::care::iso_of;

pub const KEY: &str = "update.auto";
const FILE: &str = "omp-auto-takeover.json";
/// `runOmpCli`'s bound.
pub(super) const RUN_TIMEOUT: Duration = Duration::from_secs(30);

/// `TakeoverRecord`: what OMPdesk did to stock's value, when, and which OMPdesk release.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Record {
    /// Stock had it on and OMPdesk wrote off.
    Taken {
        before: bool,
        wrote: bool,
        at: String,
        by: String,
    },
    /// A person changed it while OMPdesk held it: hands off while the switch stays on.
    Left {
        current: bool,
        at: String,
        by: String,
    },
}

/// `TakeoverStep`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Step {
    Take,
    GiveBack,
    /// Stock no longer holds what OMPdesk wrote: remember that, write nothing.
    LetGo(bool),
    /// The switch went off after OMPdesk let go: forget it, write nothing.
    Forget,
    None,
}

impl Step {
    fn kind(self) -> &'static str {
        match self {
            Step::Take => "take",
            Step::GiveBack => "give-back",
            Step::LetGo(_) => "let-go",
            Step::Forget => "forget",
            Step::None => "none",
        }
    }
}

/// `takeoverStep`: what to do, from the switch, stock's value (none: it could not be read) and the record.
pub fn step(enabled: bool, current: Option<bool>, record: Option<&Record>) -> Step {
    let Some(current) = current else {
        return Step::None;
    };
    match record {
        Some(Record::Taken { wrote, .. }) if current != *wrote => Step::LetGo(current),
        Some(Record::Taken { .. }) if enabled => Step::None,
        Some(Record::Taken { .. }) => Step::GiveBack,
        Some(Record::Left { .. }) if enabled => Step::None,
        Some(Record::Left { .. }) => Step::Forget,
        None if enabled && current => Step::Take,
        None => Step::None,
    }
}

/// The takeover's memory: its record (read from the file at first use) and its one sync at a time.
#[derive(Default)]
pub struct Takeover {
    record: Option<Option<Record>>,
    syncing: bool,
    again: bool,
}

fn file(tools: &Tools) -> PathBuf {
    Path::new(&tools.opts.user_data).join(FILE)
}

/// `readRecord`: the record of its own shape, else none.
pub fn read_record(file: &Path) -> Option<Record> {
    let data: Value = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    let record = data.get("record")?.as_object()?;
    let at = record.get("at")?.as_str()?.to_owned();
    let by = record.get("by")?.as_str()?.to_owned();
    match record.get("state")?.as_str()? {
        "taken"
            if record.get("before") == Some(&Value::Bool(true))
                && record.get("wrote") == Some(&Value::Bool(false)) =>
        {
            Some(Record::Taken {
                before: true,
                wrote: false,
                at,
                by,
            })
        }
        "left" => Some(Record::Left {
            current: record.get("current")?.as_bool()?,
            at,
            by,
        }),
        _ => None,
    }
}

fn record(tools: &Tools) -> Option<Record> {
    let mut part = tools.omp.borrow_mut();
    part.takeover
        .record
        .get_or_insert_with(|| read_record(&file(tools)))
        .clone()
}

/// OMPdesk holds stock `update.auto` turned off now.
pub fn taken(tools: &Tools) -> bool {
    matches!(record(tools), Some(Record::Taken { .. }))
}

fn set(tools: &Tools, record: Option<Record>) {
    let text = {
        let mut out = Vec::new();
        let mut serializer = serde_json::Serializer::with_formatter(
            &mut out,
            serde_json::ser::PrettyFormatter::with_indent(b"\t"),
        );
        let _ = json!({ "record": record }).serialize(&mut serializer);
        out.push(b'\n');
        out
    };
    tools.omp.borrow_mut().takeover.record = Some(record);
    // The core alone backs off on a full disk; the record in memory stands meanwhile.
    let _ = crate::disk::saves::write_kept(&file(tools), &text, None, 0o777);
    super::emit(tools);
}

/// `omp config <args> --json`'s object, or why there is none.
async fn stock_config(
    tools: &Rc<Tools>,
    args: &[&'static str],
) -> Result<Map<String, Value>, String> {
    let mut all = vec!["config"];
    all.extend_from_slice(args);
    all.push("--json");
    let deps = Rc::clone(&tools.omp.borrow().deps);
    let run: OmpRun = deps.run_omp(tools, all).await?;
    if run.code != 0 {
        let text = if run.stderr.is_empty() {
            &run.stdout
        } else {
            &run.stderr
        };
        let text = crate::fs::order::js_trim(text);
        let tail: String = text
            .chars()
            .rev()
            .take(400)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        return Err(if tail.is_empty() {
            format!("exit {}", run.code)
        } else {
            tail
        });
    }
    match serde_json::from_str(&run.stdout) {
        Ok(Value::Object(reply)) => Ok(reply),
        Ok(_) => Err(format!("omp config {}: no JSON object", args[0])),
        Err(error) => Err(error.to_string()),
    }
}

/// Stock's effective `update.auto`; none when it is no boolean or cannot be read.
async fn read_stock(tools: &Rc<Tools>) -> Option<bool> {
    stock_config(tools, &["get", KEY])
        .await
        .ok()?
        .get("value")?
        .as_bool()
}

/// `omp config set update.auto <value>`: `overriddenBy` means the write did not take.
async fn write_stock(tools: &Rc<Tools>, value: bool) -> Result<(), String> {
    let reply = stock_config(tools, &["set", KEY, if value { "true" } else { "false" }]).await?;
    match reply.get("overriddenBy").and_then(Value::as_str) {
        Some(by) => Err(format!("written, but {by} overrides it")),
        None => Ok(()),
    }
}

/// Settles stock's setting against the switch (setup's first pass ended, either switch changed), one at a time.
pub fn sync(tools: &Rc<Tools>) {
    {
        let mut part = tools.omp.borrow_mut();
        if part.takeover.syncing {
            part.takeover.again = true;
            return;
        }
        part.takeover.syncing = true;
    }
    let weak = Rc::downgrade(tools);
    tools.spawn_task(async move {
        loop {
            let Some(tools) = weak.upgrade() else { return };
            sync_once(&tools).await;
            let mut part = tools.omp.borrow_mut();
            if !std::mem::take(&mut part.takeover.again) {
                part.takeover.syncing = false;
                return;
            }
        }
    });
}

async fn sync_once(tools: &Rc<Tools>) {
    let enabled = super::follow(tools) && tools.auto_update();
    let held = record(tools);
    // Nothing taken and nothing to take: stock's config is not even read.
    if !enabled && held.is_none() {
        return;
    }
    let current = read_stock(tools).await;
    let step = step(enabled, current, held.as_ref());
    let at = iso_of(tools.clock.now_ms() as f64);
    let by = format!("OMPdesk {}", tools.opts.app_version);
    let taken = match &held {
        Some(Record::Taken { at, .. } | Record::Left { at, .. }) => json!(at),
        None => Value::Null,
    };
    let done = match step {
        Step::None => return,
        Step::Take => write_stock(tools, false).await.map(|()| {
            set(
                tools,
                Some(Record::Taken {
                    before: true,
                    wrote: false,
                    at,
                    by,
                }),
            );
            (
                "stock-auto-taken",
                json!({"key": KEY, "before": true, "wrote": false}),
            )
        }),
        Step::GiveBack => write_stock(tools, true).await.map(|()| {
            set(tools, None);
            (
                "stock-auto-given-back",
                json!({"key": KEY, "value": true, "taken": taken}),
            )
        }),
        Step::LetGo(current) => {
            set(tools, Some(Record::Left { current, at, by }));
            Ok((
                "stock-auto-let-go",
                json!({"key": KEY, "current": current, "taken": taken}),
            ))
        }
        Step::Forget => {
            set(tools, None);
            return;
        }
    };
    match done {
        Ok((message, details)) => super::log(tools, message, details),
        Err(detail) => super::log(
            tools,
            "stock-auto-failed",
            json!({"key": KEY, "step": step.kind(), "detail": detail}),
        ),
    }
}
