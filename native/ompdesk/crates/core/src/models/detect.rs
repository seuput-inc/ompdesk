//! Local inference engines (was `LocalEngineDetector` of `src/main/local-engines.ts`): the engines main names
//! (FreeToken, colibri) are probed on loopback, and each that answers gets a discovery-only models.yml provider,
//! so its models are listed without the person adding anything. Stock watches models.yml and reloads it live.
//!
//! - `models.localEngines.open {dir, host, prefs, engines: [{id, baseUrl}], intervalMs, start}` stays open while the
//!   detector lives; main learns a core died by its failure and opens again on the next core. With `start` a pass
//!   runs now and then `intervalMs` after each pass ends, while the switch is on. A second open replaces the first,
//!   whose request answers.
//! - `models.localEngines.set {enabled}`: main has stored the switch (pref `localEngineDetect`, never stored = on)
//!   through its prefs client, so its own reads see it at once; the detector waits for a pass already running, then
//!   off removes every entry it wrote and stops the timer, on runs a pass and re-arms it. Answers `{enabled}`;
//!   `no_detector` before an open.
//! - `models.localEngines.close {}` stops the detector; the open request answers.
//! - Events: `models.localEngines.changed {}` once per pass (or switch) that changed models.yml,
//!   `models.localEngines.failed {engine, error}` (`engine` null when models.yml itself could not be read).
//!
//! The rules are one table (`action`). The ledger (pref `localEngines`: what the detector wrote, what the person
//! removed) is changed through `prefs::update`, so main's copies hear of it. Write order keeps a crash harmless: a
//! made entry is written before the ledger claims it (a crash leaves an entry nobody owns), a removed one leaves the
//! ledger first (never a "the person deleted it" tombstone for an engine that merely went away).

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep_until};

use super::{engines, file, locked};
use crate::prefs;
use crate::server::{Answer, Call, Events, Fault, Registry, Reply, at_once};

const DETECT_PREF: &str = "localEngineDetect";
const LEDGER_PREF: &str = "localEngines";

pub(super) fn register(registry: &mut Registry) {
    registry.add("models.localEngines.open", open);
    registry.add("models.localEngines.set", set);
    registry.add("models.localEngines.close", |_| {
        locked(&OPEN).take();
        at_once(Reply::json(&json!({})))
    });
}

/// The detector of this core and the number of the open request that made it.
static OPEN: LazyLock<Mutex<Option<(u64, Handle)>>> = LazyLock::new(Default::default);
static OPENS: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenParams {
    prefs: String,
    engines: Vec<Engine>,
    interval_ms: u64,
    start: bool,
}

/// Registers the detector before it returns, so a `set` main sends after the open finds it.
fn open(call: Call) -> Answer {
    let opened = call.params::<OpenParams>().and_then(|params| {
        let world = Live {
            lane: file::lane(&call)?,
            dir: file::dir(&call)?,
        };
        Ok(spawn(
            world,
            params.prefs,
            params.engines,
            Duration::from_millis(params.interval_ms),
            params.start,
            call.events.clone(),
        ))
    });
    let (handle, actor) = match opened {
        Ok(opened) => opened,
        Err(fault) => return at_once(Err(fault)),
    };
    let number = OPENS.fetch_add(1, Ordering::Relaxed);
    // The detector opened before, if any, loses its handle and ends.
    *locked(&OPEN) = Some((number, handle));
    let scope = call.scope.clone();
    Box::pin(async move {
        tokio::select! {
            _ = actor => {}
            () = scope.on_cancel() => {
                let mut open = locked(&OPEN);
                if open.as_ref().is_some_and(|(mine, _)| *mine == number) {
                    open.take();
                }
            }
        }
        Reply::json(&json!({}))
    })
}

fn set(call: Call) -> Answer {
    #[derive(Deserialize)]
    struct Params {
        enabled: bool,
    }
    let asked = call.params::<Params>().and_then(|Params { enabled }| {
        let open = locked(&OPEN);
        let (_, handle) = open
            .as_ref()
            .ok_or_else(|| Fault::new("no_detector", "The local engine detector is not open"))?;
        Ok((enabled, handle.follow(enabled)))
    });
    match asked {
        Err(fault) => at_once(Err(fault)),
        Ok((enabled, done)) => Box::pin(async move {
            // A detector closed meanwhile drops `done`: the switch is stored all the same.
            let _ = done.await;
            Reply::json(&json!({ "enabled": enabled }))
        }),
    }
}

/// One engine: `id` is the models.yml provider id it is registered under.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Engine {
    id: String,
    /// OpenAI-compatible root; `/models` is read below it.
    base_url: String,
}

/// The provider entry of one engine; its models come from stock's `/models` discovery.
fn provider_input(engine: &Engine) -> Value {
    json!({
        "id": engine.id,
        "api": "openai-completions",
        "baseUrl": engine.base_url,
        "auth": "none",
        "discovery": { "type": "openai-models-list" },
        "models": [],
    })
}

/// What one pass knows of one engine.
struct Facts {
    /// `None` when the probe could not inspect the reply within its bounds.
    up: Option<bool>,
    /// models.yml has a provider with the engine's id.
    present: bool,
    /// The ledger says the detector wrote that entry.
    registered: bool,
    /// The ledger says the person deleted the automatic entry.
    removed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Action {
    Register,
    /// The engine went away; not a tombstone.
    Unregister,
    /// Our entry is gone, so the person deleted it.
    Tombstone,
    Keep,
}

/// The whole policy. An entry the detector did not write (`registered` false) is the person's own, whatever its id:
/// never touched.
fn action(facts: &Facts) -> Action {
    match (facts.up, facts.present, facts.registered, facts.removed) {
        (_, false, true, _) => Action::Tombstone,
        (Some(true), false, false, false) => Action::Register,
        (Some(false), true, true, _) => Action::Unregister,
        _ => Action::Keep,
    }
}

/// `registered`: entries the detector wrote and still owns. `removed`: automatic entries the person deleted.
#[derive(Debug, Default, PartialEq, Serialize)]
struct Ledger {
    registered: Vec<String>,
    removed: Vec<String>,
}

impl Ledger {
    /// A stored ledger read back as `parseLocalEnginesLedger` did: anything unexpected is dropped, never refused.
    fn parse(value: Option<&Value>) -> Ledger {
        let list = |key: &str| {
            let mut ids: Vec<String> = Vec::new();
            let items = value
                .and_then(|value| value.get(key))
                .and_then(Value::as_array);
            for id in items.into_iter().flatten().filter_map(Value::as_str) {
                if !ids.iter().any(|known| known == id) {
                    ids.push(id.to_owned());
                }
            }
            ids
        };
        Ledger {
            registered: list("registered"),
            removed: list("removed"),
        }
    }
}

fn add(ids: &mut Vec<String>, id: &str) {
    if !ids.iter().any(|known| known == id) {
        ids.push(id.to_owned());
    }
}

/// models.yml and the probe; tests stand in for them.
trait World: Send + Sync + 'static {
    fn ids(&self) -> impl Future<Output = Result<HashSet<String>, Fault>> + Send;
    /// Writes the entry only while none has its id, in one turn of models.yml's edit lock; false: one does.
    fn insert(&self, input: &Value) -> impl Future<Output = Result<bool, Fault>> + Send;
    fn delete(&self, id: &str) -> impl Future<Output = Result<(), Fault>> + Send;
    fn probe(&self, base_url: &str) -> impl Future<Output = Option<bool>> + Send;
}

struct Live {
    lane: file::StockLane,
    dir: PathBuf,
}

impl World for Live {
    async fn ids(&self) -> Result<HashSet<String>, Fault> {
        let listed = file::list(&self.lane, &self.dir).await?;
        let providers = listed["providers"].as_array().into_iter().flatten();
        Ok(providers
            .filter_map(|provider| provider["id"].as_str().map(str::to_owned))
            .collect())
    }

    async fn insert(&self, input: &Value) -> Result<bool, Fault> {
        file::upsert(&self.lane, &self.dir, input, true).await
    }

    async fn delete(&self, id: &str) -> Result<(), Fault> {
        file::delete(&self.lane, &self.dir, id).await
    }

    async fn probe(&self, base_url: &str) -> Option<bool> {
        engines::probe(base_url, crate::http::BODY_MAX).await
    }
}

struct SetSwitch {
    enabled: bool,
    done: oneshot::Sender<()>,
}

/// What reaches a running detector. Dropping the last handle stops it: its timer goes, and a pass under way writes
/// nothing more.
struct Handle {
    commands: mpsc::UnboundedSender<SetSwitch>,
}

impl Handle {
    /// Asks the detector to follow the switch main stored (a pass under way re-reads it before each engine, so it
    /// writes nothing more once off); the receiver ends once it did.
    fn follow(&self, enabled: bool) -> oneshot::Receiver<()> {
        let (done, followed) = oneshot::channel();
        let _ = self.commands.send(SetSwitch { enabled, done });
        followed
    }
}

fn spawn<W: World>(
    world: W,
    prefs: String,
    engines: Vec<Engine>,
    interval: Duration,
    start: bool,
    events: Events,
) -> (Handle, JoinHandle<()>) {
    let (commands, inbox) = mpsc::unbounded_channel();
    let detector = Detector {
        world,
        prefs,
        engines,
        interval,
        start,
        events,
        inbox,
    };
    (Handle { commands }, tokio::spawn(detector.run()))
}

/// The detector's task: one pass or switch at a time, so a switch waits for the pass under way.
struct Detector<W> {
    world: W,
    prefs: String,
    engines: Vec<Engine>,
    interval: Duration,
    /// Passes run by themselves (main's `start`); without it only the switch runs them.
    start: bool,
    events: Events,
    inbox: mpsc::UnboundedReceiver<SetSwitch>,
}

impl<W: World> Detector<W> {
    async fn run(mut self) {
        enum Wake {
            Asked(Option<SetSwitch>),
            Due,
        }
        // When the next pass runs by itself; at most one, whoever arms it.
        let mut next = self.start.then(Instant::now);
        loop {
            let wake = match next {
                Some(at) => tokio::select! {
                    biased;
                    asked = self.inbox.recv() => Wake::Asked(asked),
                    () = sleep_until(at) => Wake::Due,
                },
                None => Wake::Asked(self.inbox.recv().await),
            };
            match wake {
                Wake::Due => {
                    self.pass().await;
                    next = self.next();
                }
                Wake::Asked(None) => return,
                Wake::Asked(Some(SetSwitch { enabled, done })) => {
                    next = None;
                    if enabled {
                        self.pass().await;
                        next = self.next();
                    } else {
                        self.unregister_all().await;
                    }
                    let _ = done.send(());
                }
            }
        }
    }

    fn next(&self) -> Option<Instant> {
        (self.start && self.live()).then(|| Instant::now() + self.interval)
    }

    fn enabled(&self) -> bool {
        // An unreadable prefs file decides nothing, so no pass writes under it.
        matches!(prefs::get(&self.prefs, DETECT_PREF), Ok(value) if value != Some(Value::Bool(false)))
    }

    fn live(&self) -> bool {
        !self.inbox.is_closed() && self.enabled()
    }

    async fn pass(&self) {
        if !self.live() {
            return;
        }
        let probes = join_all(
            self.engines
                .iter()
                .map(|engine| self.world.probe(&engine.base_url)),
        );
        // `present` is read before the probes end: an entry the person adds meanwhile stays theirs, and the
        // ledger does not claim it (a later unregister would delete it).
        let (present, up) = tokio::join!(self.world.ids(), probes);
        let present = match present {
            Ok(present) => present,
            Err(fault) => return self.failed(None, &fault),
        };
        let mut wrote = false;
        for (engine, up) in self.engines.iter().zip(up) {
            // Re-read after the awaits: the switch may have turned off, or the detector closed, meanwhile.
            if !self.live() {
                break;
            }
            let decided = match self.ledger() {
                Ok(ledger) => {
                    let facts = Facts {
                        up,
                        present: present.contains(&engine.id),
                        registered: ledger.registered.contains(&engine.id),
                        removed: ledger.removed.contains(&engine.id),
                    };
                    self.apply(action(&facts), engine).await
                }
                Err(fault) => Err(fault),
            };
            match decided {
                Ok(changed) => wrote |= changed,
                Err(fault) => self.failed(Some(&engine.id), &fault),
            }
        }
        if wrote {
            self.changed();
        }
    }

    /// The switch going off: every entry the detector wrote goes, and one already gone was deleted by the person (a
    /// tombstone, as in a pass, so switching on again does not bring it back).
    async fn unregister_all(&self) {
        let present = match self.world.ids().await {
            Ok(present) => present,
            Err(fault) => return self.failed(None, &fault),
        };
        let registered = match self.ledger() {
            Ok(ledger) => ledger.registered,
            Err(fault) => return self.failed(None, &fault),
        };
        let mut wrote = false;
        for id in registered {
            let engine = Engine {
                id,
                base_url: String::new(),
            };
            let action = if present.contains(&engine.id) {
                Action::Unregister
            } else {
                Action::Tombstone
            };
            match self.apply(action, &engine).await {
                Ok(changed) => wrote |= changed,
                Err(fault) => self.failed(Some(&engine.id), &fault),
            }
        }
        if wrote {
            self.changed();
        }
    }

    /// Applies one action; true when models.yml changed.
    async fn apply(&self, action: Action, engine: &Engine) -> Result<bool, Fault> {
        let id = engine.id.as_str();
        match action {
            Action::Register => {
                if !self.world.insert(&provider_input(engine)).await? {
                    return Ok(false);
                }
                self.edit(|ledger| add(&mut ledger.registered, id))?;
                Ok(true)
            }
            Action::Tombstone => {
                self.edit(|ledger| {
                    ledger.registered.retain(|known| known != id);
                    add(&mut ledger.removed, id);
                })?;
                Ok(false)
            }
            Action::Unregister => {
                // The ledger lets go first; a failed delete gives the entry back.
                self.edit(|ledger| ledger.registered.retain(|known| known != id))?;
                if let Err(fault) = self.world.delete(id).await {
                    self.edit(|ledger| add(&mut ledger.registered, id))?;
                    return Err(fault);
                }
                Ok(true)
            }
            Action::Keep => Ok(false),
        }
    }

    fn ledger(&self) -> Result<Ledger, Fault> {
        Ok(Ledger::parse(
            prefs::get(&self.prefs, LEDGER_PREF)?.as_ref(),
        ))
    }

    /// Reads, changes and writes the ledger under the prefs file's one lock.
    fn edit(&self, change: impl FnOnce(&mut Ledger)) -> Result<(), Fault> {
        prefs::update(&self.prefs, LEDGER_PREF, |stored| {
            let mut ledger = Ledger::parse(stored);
            change(&mut ledger);
            Some(json!(ledger))
        })
        .map(drop)
    }

    fn changed(&self) {
        self.events.send("models.localEngines.changed", &json!({}));
    }

    fn failed(&self, engine: Option<&str>, fault: &Fault) {
        self.events.send(
            "models.localEngines.failed",
            &json!({ "engine": engine, "error": fault.message }),
        );
    }
}

#[cfg(test)]
mod tests;
