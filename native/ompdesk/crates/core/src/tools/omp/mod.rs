//! The omp updater's part (was `src/main/omp-updater.ts`): `OmpUpdateState` and the calls `omp.now`, `omp.repair`,
//! `omp.prefChanged`. While OMPdesk runs it asks stock `omp update --check` for the newest omp at launch (setup's first
//! pass ended) and on the timer, backing off after failures, and installs a newer one through setup on its own: no
//! click, never waiting for a turn to end. What reads omp's files from disk (the stats server, the stock helper) is
//! stopped before the installer and brought back after it (asks `releaseHelpers`, `resume`).
//!
//! **Nothing here installs an untested omp unasked** (the owner's rule, 19 Nov 2026). A pass nobody asked for (`launch`,
//! `scheduled`, `repair`) runs only under `toolsAutoUpdate`, installs only by name, and picks its target one of two
//! ways (the hidden pref `ompFollowVerified`, default off): off, the registry's newest while its major is at most the
//! tested omp's, else held `untested-major` and the newest release of the tested major instead; on, only the tested
//! omp or one runners verified for this release (`compat.rs`), a newer one held `verifying` or `failed`. A person's
//! "Update now" installs the newest whatever is held.
//!
//! A pass is one step of kind `OmpPass` on the one queue, so a second one asked meanwhile joins it (one pass, one
//! answer); a click before the pass chose its version makes the pass the person's (`asked`). The step is bound like
//! every other (30 min): a stopped pass is a failed one, and the helpers it released come back.

mod compat;
mod hold;
mod takeover;
#[cfg(test)]
mod tests;

use std::cell::Cell;
use std::rc::Rc;

use serde_json::value::RawValue;
use serde_json::{Map, Value, json};

use super::queue::{Answer, Ctx, StepKind};
use super::setup::{BeforeInstall, OmpRun, OmpUpdateOutcome};
use super::{Tools, Updater, queued};
use crate::hub::{LocalFuture, Outcome};
use crate::server::Fault;
use compat::{Entry, Fetched, follow_target, is_newer, major_of};
use hold::Hold;

/// What the part reads of setup and the network; the real ones go to setup's part (`tools/setup.rs`) and `compat.rs`,
/// a test hands in its own.
pub trait Deps {
    /// `SetupService.latestOmp`.
    fn latest(&self, tools: &Rc<Tools>) -> LocalFuture<Result<String, String>>;
    /// `SetupService.newestOmpIn`.
    fn newest_within(
        &self,
        tools: &Rc<Tools>,
        major: u64,
    ) -> LocalFuture<Result<Option<String>, String>>;
    /// `SetupService.updateOmp`, inline in the pass's step.
    fn update(
        &self,
        tools: &Rc<Tools>,
        ctx: &Ctx,
        target: String,
        before: BeforeInstall,
        exact_only: bool,
    ) -> LocalFuture<OmpUpdateOutcome>;
    /// The omp that runs now, from setup's detection; none while omp is missing.
    fn installed(&self, tools: &Tools) -> Option<String>;
    /// One read of the verified list's address.
    fn fetch_compat(&self, tools: &Rc<Tools>) -> LocalFuture<Fetched>;
    /// `omp <args>` on the omp OMPdesk runs, 30 s (`runOmpCli`).
    fn run_omp(
        &self,
        tools: &Rc<Tools>,
        args: Vec<&'static str>,
    ) -> LocalFuture<Result<OmpRun, String>>;
}

struct Real;

impl Deps for Real {
    fn latest(&self, tools: &Rc<Tools>) -> LocalFuture<Result<String, String>> {
        let tools = Rc::clone(tools);
        Box::pin(async move { super::setup::latest_omp(&tools).await })
    }

    fn newest_within(
        &self,
        tools: &Rc<Tools>,
        major: u64,
    ) -> LocalFuture<Result<Option<String>, String>> {
        let tools = Rc::clone(tools);
        Box::pin(async move { super::setup::newest_omp_in(&tools, major).await })
    }

    fn update(
        &self,
        tools: &Rc<Tools>,
        ctx: &Ctx,
        target: String,
        before: BeforeInstall,
        exact_only: bool,
    ) -> LocalFuture<OmpUpdateOutcome> {
        let (tools, ctx) = (Rc::clone(tools), ctx.clone());
        Box::pin(async move {
            super::setup::update_omp(&tools, &ctx, &target, before, exact_only).await
        })
    }

    fn installed(&self, tools: &Tools) -> Option<String> {
        let presence = omp_presence(tools)?;
        (presence["kind"] == "present")
            .then(|| presence["version"].as_str().map(str::to_owned))
            .flatten()
    }

    fn fetch_compat(&self, tools: &Rc<Tools>) -> LocalFuture<Fetched> {
        let tools = Rc::clone(tools);
        Box::pin(async move { compat::fetch(&tools).await })
    }

    fn run_omp(
        &self,
        tools: &Rc<Tools>,
        args: Vec<&'static str>,
    ) -> LocalFuture<Result<OmpRun, String>> {
        let tools = Rc::clone(tools);
        Box::pin(async move { super::setup::run_omp(&tools, &args, takeover::RUN_TIMEOUT).await })
    }
}

/// Setup's `presence` of omp; none before detection.
fn omp_presence(tools: &Tools) -> Option<Value> {
    let setup = tools.setup.borrow();
    let item = setup.items.iter().find(|item| item["id"] == "omp")?;
    (!item["presence"].is_null()).then(|| item["presence"].clone())
}

pub struct Part {
    pub deps: Rc<dyn Deps>,
    /// Failed checks in a row: the timer's back-off.
    pub failures: u32,
    pub phase: &'static str,
    pub latest: Option<String>,
    pub checked_at: Option<u64>,
    pub updated_to: Option<String>,
    /// `OmpUpdateFailure`.
    pub failure: Option<Value>,
    pub held: Option<Hold>,
    /// What the last check read of the verified list; none while the list is off.
    pub verified: Option<Vec<String>>,
    /// A pass is queued or runs.
    running: bool,
    /// A person asked for the pass that runs now ("Update now"), whoever started it.
    asked: bool,
    /// The timer's first tick is the launch check.
    ticked: bool,
    compat: compat::Source,
    takeover: takeover::Takeover,
}

impl Default for Part {
    fn default() -> Part {
        Part {
            deps: Rc::new(Real),
            failures: 0,
            phase: "idle",
            latest: None,
            checked_at: None,
            updated_to: None,
            failure: None,
            held: None,
            verified: None,
            running: false,
            asked: false,
            ticked: false,
            compat: compat::Source::default(),
            takeover: takeover::Takeover::default(),
        }
    }
}

/// `ompFollowVerified`: only a stored `true` turns it on.
fn follow(tools: &Tools) -> bool {
    tools.pref("ompFollowVerified") == Some(Value::Bool(true))
}

/// `OmpUpdateState`.
pub fn state(tools: &Tools) -> Value {
    let installed = Rc::clone(&tools.omp.borrow().deps).installed(tools);
    let stock_auto_taken = takeover::taken(tools);
    let part = tools.omp.borrow();
    let mut state = json!({
        "enabled": tools.auto_update(),
        "scheduled": tools.opts.scheduled.omp,
        "phase": part.phase,
        "installed": installed,
        "latest": part.latest,
        "checkedAt": part.checked_at,
        "updatedTo": part.updated_to,
        "failure": part.failure,
        "tested": tools.opts.tested_omp,
        "held": part.held,
    });
    if let Some(verified) = &part.verified {
        state["verified"] = json!(verified);
    }
    state["stockAutoTaken"] = json!(stock_auto_taken);
    state
}

/// One `omp-update` line of `gui-runtime.jsonl` (`logOmpUpdate`): `level` first, `warn` for a failure.
fn log(tools: &Tools, step: &str, details: Value) {
    let mut line = Map::new();
    line.insert(
        "level".into(),
        json!(if step == "failed" { "warn" } else { "info" }),
    );
    if let Value::Object(details) = details {
        line.extend(details);
    }
    tools.log("omp-update", step, Value::Object(line));
}

/// The state went to main (the windows, paired devices); a held omp under the verified list is told.
fn emit(tools: &Tools) {
    if tools.is_closed() {
        return;
    }
    let state = state(tools);
    tools
        .main
        .push(json!({"k": "state", "part": "omp", "state": state.clone()}));
    tell_hold(tools, &state);
}

fn hold_of(value: &Value) -> Option<Hold> {
    let reason = match value["reason"].as_str()? {
        "verifying" => "verifying",
        "failed" => "failed",
        "untested-major" => "untested-major",
        _ => return None,
    };
    Some(Hold {
        version: value["version"].as_str()?.to_owned(),
        reason,
        since: value["since"].as_str().map(str::to_owned),
    })
}

/// `holdNotice` on every state main is sent: one failed once and again after a day, one still waiting for runners
/// after 6 hours and then every 24 hours. The pref is written before the notice is asked for.
fn tell_hold(tools: &Tools, state: &Value) {
    let told = hold::parse_told(tools.pref(hold::TOLD_PREF).as_ref());
    let held = hold_of(&state["held"]);
    let now = tools.clock.now_ms() as f64;
    let (Some(notice), told) = hold::notice(held.as_ref(), told, now) else {
        return;
    };
    let prefs = std::path::Path::new(&tools.opts.user_data).join("prefs.json");
    if let Some(told) = &told {
        let value = told.to_value();
        let _ = crate::prefs::update(&prefs.to_string_lossy(), hold::TOLD_PREF, |_| Some(value));
    }
    log(
        tools,
        "told",
        json!({
            "version": notice.version,
            "reason": notice.reason,
            "since": state["held"]["since"],
            "hours": hold::number(notice.hours),
            "installed": state["installed"],
            "count": told.as_ref().map_or(Value::Null, |told| hold::number(told.count)),
        }),
    );
    let params = json!({
        "version": notice.version,
        "reason": notice.reason,
        "hours": hold::number(notice.hours),
        "days": hold::number(notice.days),
        "installed": state["installed"].as_str().unwrap_or(""),
    });
    let ask = tools.ask("notify", json!({"kind": "ompHold", "params": params}));
    tools.spawn_task(async move {
        let _ = ask.await;
    });
}

/// `#set`: a change of the part, then the state goes out.
fn set(tools: &Tools, change: impl FnOnce(&mut Part)) {
    change(&mut tools.omp.borrow_mut());
    emit(tools);
}

/// `#fail`: a failure in a row, its line, its reason in the state.
fn fail(tools: &Tools, path: &str, failure: Value, target: Option<&str>) {
    let mut details = json!({"path": path});
    if let Some(target) = target {
        details["target"] = json!(target);
    }
    if let (Value::Object(details), Value::Object(failure)) = (&mut details, &failure) {
        details.extend(failure.clone());
    }
    log(tools, "failed", details);
    set(tools, |part| {
        part.failures += 1;
        part.failure = Some(failure);
    });
}

/// When this computer first saw `version` held for verification (`firstSeen`, the pref `ompHeldSeen`).
fn first_seen(tools: &Tools, version: &str) -> String {
    let (since, store) = hold::held_since(
        tools.pref(hold::SEEN_PREF).as_ref(),
        version,
        tools.clock.now_ms(),
    );
    if let Some(store) = store {
        let prefs = std::path::Path::new(&tools.opts.user_data).join("prefs.json");
        let _ = crate::prefs::update(&prefs.to_string_lossy(), hold::SEEN_PREF, |_| Some(store));
    }
    since
}

/// `#withinTested`: `version`'s major is known and at most the tested omp's.
fn within_tested(tools: &Tools, version: &str) -> bool {
    let tested = major_of(&tools.opts.tested_omp);
    matches!((major_of(version), tested), (Some(major), Some(tested)) if major <= tested)
}

/// Who started a pass (`OmpUpdateTrigger`).
#[derive(Clone, Copy, Debug, PartialEq)]
enum Trigger {
    Launch,
    Scheduled,
    Repair,
    Manual,
}

impl Trigger {
    fn name(self) -> &'static str {
        match self {
            Trigger::Launch => "launch",
            Trigger::Scheduled => "scheduled",
            Trigger::Repair => "repair",
            Trigger::Manual => "manual",
        }
    }
}

/// The pass's path now: a click before the version is chosen makes it the person's.
fn path(tools: &Tools, trigger: Trigger) -> &'static str {
    if tools.omp.borrow().asked {
        "manual"
    } else {
        trigger.name()
    }
}

/// Ends a pass however it ends (`#run`'s `finally`). A pass dropped by its bound fails and brings back the helpers it
/// released; one dropped by the quit starts nothing (helpers, tabs, toast).
struct PassEnd {
    tools: Rc<Tools>,
    trigger: Trigger,
    released: Rc<Cell<bool>>,
    ended: bool,
}

impl Drop for PassEnd {
    fn drop(&mut self) {
        let tools = &self.tools;
        if tools.is_closed() {
            return;
        }
        if !self.ended {
            if self.released.get() {
                let resume = tools.ask("resume", json!({"updated": false}));
                tools.spawn_task(async move {
                    let _ = resume.await;
                });
            }
            let updating = tools.omp.borrow().phase == "updating";
            fail(
                tools,
                path(tools, self.trigger),
                json!({
                    "reason": if updating { "install" } else { "check" },
                    "detail": "The omp update did not finish in its time and was stopped.",
                }),
                None,
            );
        }
        set(tools, |part| {
            part.running = false;
            part.asked = false;
            part.phase = "idle";
        });
    }
}

/// `#check`: one pass.
async fn check(tools: &Rc<Tools>, ctx: &Ctx, trigger: Trigger, released: &Rc<Cell<bool>>) {
    let deps = Rc::clone(&tools.omp.borrow().deps);
    // Missing, outdated or broken omp is machine setup's to install; there is nothing to check or update yet.
    if deps.installed(tools).is_none() {
        return;
    }
    if tools.omp.borrow().phase != "checking" {
        set(tools, |part| part.phase = "checking");
    }
    let latest = match deps.latest(tools).await {
        Ok(latest) => latest,
        Err(detail) => {
            let path = path(tools, trigger);
            return fail(
                tools,
                path,
                json!({"reason": "check", "detail": detail}),
                None,
            );
        }
    };
    let entry: Option<Entry> = if follow(tools) {
        let list = compat::read(tools).await.unwrap_or_default();
        Some(compat::entry_of(&list, &tools.opts.app_version))
    } else {
        None
    };
    let checked_at = tools.clock.now_ms();
    let verified = entry.as_ref().map(|entry| entry.verified.clone());
    let Some(installed) = deps.installed(tools) else {
        return set(tools, |part| {
            part.latest = Some(latest);
            part.checked_at = Some(checked_at);
            part.verified = verified;
        });
    };
    let tested = tools.opts.tested_omp.clone();
    let followed = entry
        .as_ref()
        .and_then(|entry| follow_target(&installed, &latest, &tested, &entry.verified));
    let held = match &entry {
        // `#verifiedHold`: a newer omp the list does not let a pass install, as failed or as waiting for runners.
        Some(entry) if is_newer(&latest, &installed) && followed.as_deref() != Some(&latest) => {
            Some(match &entry.holding {
                Some(holding) if holding.version == latest => Hold {
                    version: latest.clone(),
                    reason: "failed",
                    since: Some(holding.since.clone()),
                },
                _ => Hold {
                    version: latest.clone(),
                    reason: "verifying",
                    since: Some(first_seen(tools, &latest)),
                },
            })
        }
        Some(_) => None,
        // `#guardHold`: a newer omp whose major is above the tested omp's (or cannot be read).
        None => (is_newer(&latest, &installed) && !within_tested(tools, &latest)).then(|| Hold {
            version: latest.clone(),
            reason: "untested-major",
            since: None,
        }),
    };
    set(tools, |part| {
        part.latest = Some(latest.clone());
        part.checked_at = Some(checked_at);
        part.verified = verified;
        part.held = held.clone();
    });
    let mut checked = json!({
        "path": path(tools, trigger),
        "installed": installed,
        "latest": latest,
        "tested": tested,
    });
    if let Some(entry) = &entry {
        checked["verified"] = json!(entry.verified.last());
    }
    log(tools, "checked", checked);
    let asked = || tools.omp.borrow().asked;
    if let Some(held) = held.as_ref().filter(|_| !asked()) {
        let mut line = json!({"path": path(tools, trigger), "installed": installed});
        line.as_object_mut().unwrap().extend(
            serde_json::to_value(held)
                .unwrap()
                .as_object()
                .unwrap()
                .clone(),
        );
        if entry.is_none() {
            line["tested"] = json!(tested);
        }
        log(tools, "held", line);
    }
    let mut target = if entry.is_some() && !asked() {
        followed.unwrap_or_else(|| installed.clone())
    } else {
        latest.clone()
    };
    if entry.is_none() && held.is_some() && !asked() {
        let within = match deps
            .newest_within(tools, major_of(&tested).unwrap_or(0))
            .await
        {
            Ok(within) => within,
            Err(detail) => {
                let path = path(tools, trigger);
                return fail(
                    tools,
                    path,
                    json!({"reason": "check", "detail": detail}),
                    None,
                );
            }
        };
        // The lookup is asked for one major; an answer outside it is never installed.
        if !asked() {
            target = within
                .filter(|within| within_tested(tools, within))
                .unwrap_or_else(|| installed.clone());
        }
    }
    if !is_newer(&target, &installed) {
        return set(tools, |part| {
            part.failures = 0;
            part.failure = None;
        });
    }
    // The version is chosen: from here the install is this path's, whatever is clicked meanwhile.
    let by = path(tools, trigger);
    log(
        tools,
        "started",
        json!({"path": by, "from": installed, "target": target}),
    );
    set(tools, |part| part.phase = "updating");
    let before: BeforeInstall = {
        let (tools, released) = (Rc::clone(tools), Rc::clone(released));
        Box::new(move || {
            Box::pin(async move {
                released.set(true);
                tools.ask("releaseHelpers", json!({})).await.map(|_| ())
            })
        })
    };
    let outcome = deps
        .update(tools, ctx, target.clone(), before, by != "manual")
        .await;
    // Quit while the installer ran: teardown is under way, so nothing starts again (helpers, tabs, toast).
    if tools.is_closed() {
        return;
    }
    match outcome {
        OmpUpdateOutcome::Updated(version) => {
            log(
                tools,
                "finished",
                json!({"path": by, "from": installed, "target": target, "version": version}),
            );
            set(tools, |part| {
                part.failures = 0;
                part.failure = None;
                part.updated_to = Some(version.clone());
                part.held = held.filter(|held| is_newer(&held.version, &version));
            });
            let _ = tools.ask("resume", json!({"updated": true})).await;
            tools
                .main
                .push(json!({"k": "ompUpdated", "version": version}));
        }
        outcome => {
            if released.get() {
                let _ = tools.ask("resume", json!({"updated": false})).await;
            }
            match outcome {
                OmpUpdateOutcome::Failed(failure) => fail(tools, by, failure, Some(&target)),
                _ => log(
                    tools,
                    "skipped",
                    json!({"path": by, "target": target, "reason": "no-install"}),
                ),
            }
        }
    }
}

/// `#run`: queues a pass started by `trigger`, or joins the one queued or running.
fn request(tools: &Rc<Tools>, trigger: Trigger) -> Result<LocalFuture<Answer>, Fault> {
    if trigger == Trigger::Manual && !tools.is_closed() {
        tools.omp.borrow_mut().asked = true;
    }
    let weak = Rc::downgrade(tools);
    let pass = tools.enqueue("omp update", StepKind::OmpPass, move |ctx: Ctx| {
        Box::pin(async move {
            let Some(tools) = weak.upgrade() else {
                return Ok(Value::Null);
            };
            let released = Rc::new(Cell::new(false));
            let mut end = PassEnd {
                tools: Rc::clone(&tools),
                trigger,
                released: Rc::clone(&released),
                ended: false,
            };
            check(&tools, &ctx, trigger, &released).await;
            end.ended = true;
            drop(end);
            Ok(state(&tools))
        })
    })?;
    let first = !std::mem::replace(&mut tools.omp.borrow_mut().running, true);
    // Update now starts its check within the call: the state says so before anything is awaited.
    let deps = Rc::clone(&tools.omp.borrow().deps);
    if first && deps.installed(tools).is_some() {
        set(tools, |part| part.phase = "checking");
    }
    Ok(pass)
}

/// The timer's check: the launch's, then the scheduled ones; none while "Keep tools up to date" is off.
pub fn tick(tools: &Rc<Tools>) -> Result<LocalFuture<Answer>, Fault> {
    let trigger = if std::mem::replace(&mut tools.omp.borrow_mut().ticked, true) {
        Trigger::Scheduled
    } else {
        Trigger::Launch
    };
    if !tools.auto_update() {
        return Ok(Box::pin(async { Ok(Value::Null) }));
    }
    request(tools, trigger)
}

/// Setup's first pass ended: stock's `update.auto` is settled in a launch that updates omp on its own.
pub fn started(tools: &Rc<Tools>) {
    if tools.opts.scheduled.omp {
        takeover::sync(tools);
    }
}

/// `repair`: a tab's omp lacks what the bridge needs, or the bridge never reached it (BridgeHealth). An omp setup holds
/// missing or broken is setup's to put back; a usable one gets the timer's pass early: in a launch that schedules,
/// under the pref, only to an omp such a pass may install.
fn repair(tools: &Rc<Tools>) -> Outcome {
    if omp_presence(tools).is_some_and(|presence| presence["kind"] != "present") {
        let item: &RawValue = serde_json::from_str(r#"{"item":"omp"}"#).expect("a JSON object");
        return super::setup::call(tools, "retry", item)
            .unwrap_or_else(|| Outcome::fault("no_method", "setup.retry"));
    }
    if tools.is_closed() {
        return Outcome::done();
    }
    let enabled = tools.auto_update();
    if !tools.opts.scheduled.omp || !enabled {
        let reason = if enabled {
            "not-scheduled"
        } else {
            "auto-update-off"
        };
        log(
            tools,
            "skipped",
            json!({"path": "repair", "reason": reason}),
        );
        return Outcome::done();
    }
    queued(request(tools, Trigger::Repair))
}

/// `toolsAutoUpdate` or `ompFollowVerified` changed: the state goes out again; turning it on checks now and the timer
/// counts from there (not during a pass, nor before the start); stock's `update.auto` is settled again.
fn pref_changed(tools: &Rc<Tools>) {
    emit(tools);
    let idle = !tools.omp.borrow().running;
    if tools.started.get() && tools.opts.scheduled.omp && tools.auto_update() && idle {
        tools.rearm(Updater::Omp);
    }
    if tools.opts.scheduled.omp {
        takeover::sync(tools);
    }
}

pub fn call(tools: &Rc<Tools>, method: &str, _: &RawValue) -> Option<Outcome> {
    Some(match method {
        "now" => queued(request(tools, Trigger::Manual)),
        "repair" => repair(tools),
        "prefChanged" => {
            pref_changed(tools);
            Outcome::done()
        }
        _ => return None,
    })
}
