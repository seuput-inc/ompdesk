//! One generation per live source. Editing, pausing or deleting its schedule retires the generation
//! under the same engine lock that accepts a mark, a failure or a fire.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Weak};

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use super::{Engine, Service, locked, marks::Marks, system_now};
use crate::remote::events::js;
use crate::routines::runtime::{
    Source, Timing,
    sessions::{Activity, Tab},
};
use crate::server::{Call, Fault, Registry, Reply};

#[derive(Clone, Deserialize, Serialize)]
struct Token {
    id: String,
    generation: u64,
}

type Answer = oneshot::Sender<Result<Value, Fault>>;

struct Live {
    generation: u64,
    event: Arc<Value>,
    wake: Option<String>,
    key: String,
    name: String,
    source: Source,
    warnings: HashMap<String, String>,
    ask: u64,
    answer: Option<Answer>,
}

pub(super) struct Triggers {
    service: Weak<Service>,
    live: HashMap<String, Live>,
    marks: Marks,
    running: HashSet<String>,
    ended: HashMap<String, i64>,
    sequence: u64,
    timing: Timing,
    draining: mpsc::Sender<()>,
    drained: mpsc::Receiver<()>,
}

impl Triggers {
    fn new(service: &Arc<Service>, file: PathBuf, timing: Timing) -> Self {
        let (draining, drained) = mpsc::channel(1);
        Self {
            service: Arc::downgrade(service),
            live: HashMap::new(),
            marks: Marks::open(file),
            running: HashSet::new(),
            ended: HashMap::new(),
            sequence: 0,
            timing,
            draining,
            drained,
        }
    }

    pub fn sync(&mut self, service: &Service, engine: &mut Engine, state: &Value, now: i64) {
        let running = state["runs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|run| run["status"] == "running")
            .filter_map(|run| run["scheduleId"].as_str().map(str::to_owned))
            .collect();
        let ended: Vec<_> = self.running.difference(&running).cloned().collect();
        self.running = running;
        for id in &ended {
            self.ended.insert(id.clone(), now);
        }
        self.ended
            .retain(|_, at| now.saturating_sub(*at) < self.timing.quiet_ms);

        let mut wanted = HashSet::new();
        let mut dirty = false;
        for schedule in state["schedules"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|schedule| {
                state["paused"] != true
                    && super::rules::truthy(schedule.get("enabled"))
                    && schedule["frequency"]["kind"] == "event"
                    && schedule["frequency"]["event"]["source"] != "webhook"
            })
        {
            let Some(id) = schedule["id"].as_str() else {
                continue;
            };
            wanted.insert(id);
            let event = &schedule["frequency"]["event"];
            let wake = schedule["wakeSession"].as_str();
            if let Some(live) = self.live.get(id) {
                if live.wake.as_deref() == wake && js::same_json(&live.event, event) {
                    continue;
                }
                unobserve(service, id, live);
                engine.retire_trigger(id);
                self.live.remove(id);
                dirty |= self.marks.entries().shift_remove(id).is_some();
            }
            self.sequence += 1;
            let token = Token {
                id: id.to_owned(),
                generation: self.sequence,
            };
            let key = serde_json::to_string(&(event, wake)).expect("event key");
            let mark = self.marks.get(id, &key).cloned();
            let context = Context {
                service: self.service.clone(),
                token: token.clone(),
            };
            let event = Arc::new(event.clone());
            let source = Source::start(
                Arc::clone(&event),
                mark,
                context,
                self.timing,
                self.draining.clone(),
            );
            if matches!(source, Source::Session(_)) {
                service.tell(
                    "schedules.routineSession",
                    json!({"token":token,"on":true,"wake":wake}),
                );
            }
            self.live.insert(
                token.id,
                Live {
                    generation: token.generation,
                    event,
                    wake: wake.map(str::to_owned),
                    key,
                    name: schedule["name"].as_str().unwrap_or_default().to_owned(),
                    source,
                    warnings: HashMap::new(),
                    ask: 0,
                    answer: None,
                },
            );
        }
        self.live.retain(|id, live| {
            if wanted.contains(id.as_str()) {
                return true;
            }
            unobserve(service, id, live);
            engine.retire_trigger(id);
            false
        });
        let entries = self.marks.entries();
        let before = entries.len();
        entries.retain(|id, _| wanted.contains(id.as_str()));
        if dirty || entries.len() != before {
            self.marks.changed();
        }
        for id in ended {
            if let Some(Live {
                source: Source::Poll(poll),
                ..
            }) = self.live.get(&id)
            {
                poll.run_ended();
            }
        }
    }

    fn current(&self, token: &Token) -> bool {
        self.live
            .get(&token.id)
            .is_some_and(|live| live.generation == token.generation)
    }

    fn quiet(&self, id: &str, now: i64) -> bool {
        self.running.contains(id)
            || self
                .ended
                .get(id)
                .is_some_and(|at| now < at.saturating_add(self.timing.quiet_ms))
    }

    pub fn close(mut self, service: &Service) -> mpsc::Receiver<()> {
        for (id, live) in self.live.drain() {
            unobserve(service, &id, &live);
        }
        self.marks.close();
        self.drained
    }
}

fn unobserve(service: &Service, id: &str, live: &Live) {
    if matches!(live.source, Source::Session(_)) {
        service.tell(
            "schedules.routineSession",
            json!({"token":{"id":id,"generation":live.generation},"on":false}),
        );
    }
}

pub(crate) struct Context {
    service: Weak<Service>,
    token: Token,
}

impl Context {
    pub fn current(&self) -> bool {
        self.service.upgrade().is_some_and(|s| {
            locked(&s.triggers)
                .as_ref()
                .is_some_and(|t| t.current(&self.token))
        })
    }

    pub fn running(&self) -> bool {
        self.service.upgrade().is_some_and(|s| {
            locked(&s.triggers)
                .as_ref()
                .is_some_and(|t| t.running.contains(&self.token.id))
        })
    }

    pub fn quiet(&self) -> bool {
        self.service.upgrade().is_none_or(|s| {
            let now = s.at(None);
            locked(&s.triggers)
                .as_ref()
                .is_none_or(|t| !t.current(&self.token) || t.quiet(&self.token.id, now))
        })
    }

    fn enter<T>(
        &self,
        entry: impl FnOnce(&mut Triggers, &mut Engine, &Service, i64) -> T,
    ) -> Option<T> {
        let service = self.service.upgrade()?;
        service.with(|engine| {
            let mut triggers = locked(&service.triggers);
            let triggers = triggers.as_mut().filter(|t| t.current(&self.token))?;
            let now = if service.manual {
                engine.now()
            } else {
                system_now()
            };
            Some(entry(triggers, engine, &service, now))
        })
    }

    pub fn publish(&self, mark: Value, lines: &[String]) -> bool {
        self.enter(|triggers, engine, _, now| {
            let id = &self.token.id;
            triggers.marks.set(id, &triggers.live[id].key, mark);
            for line in lines {
                engine.fire(id, line, now);
            }
        })
        .is_some()
    }

    /// Who asked this bot's connector without being in its `from` (`Engine::access_asked`).
    pub fn access_asked(&self, asks: &[crate::routines::connectors::AccessAsk]) {
        if asks.is_empty() {
            return;
        }
        self.enter(|_, engine, _, now| engine.asked_access(&self.token.id, asks, now));
    }

    pub fn file_changed(&self, line: &str) {
        self.enter(|triggers, engine, _, now| {
            if !triggers.quiet(&self.token.id, now) {
                engine.fire(&self.token.id, line, now);
            }
        });
    }

    pub fn git_changed(&self, line: &str, revision: u64) {
        self.enter(|triggers, engine, _, now| {
            let id = &self.token.id;
            if !triggers.running.contains(id) && matches!(&triggers.live[id].source, Source::Poll(p) if p.git_revision() == Some(revision)) { engine.fire(id, line, now); }
        });
    }

    pub fn failure(&self, key: &str, error: Option<&str>) {
        self.enter(|triggers, engine, service, now| {
            let live = triggers
                .live
                .get_mut(&self.token.id)
                .expect("current generation");
            let Some(error) = error else {
                live.warnings.remove(key);
                return;
            };
            if live.warnings.get(key).is_some_and(|old| old == error) {
                return;
            }
            live.warnings.insert(key.into(), error.into());
            let message = format!("{key}: {error}");
            service.tell(
                "schedules.routineLog",
                json!({"message":format!("{}: {message}", live.name)}),
            );
            engine.trigger_failed(&self.token.id, &message, now);
        });
    }

    /// Only the lookup is in main. The answer is a private request, never a credential-bearing event.
    pub async fn ask<T: DeserializeOwned>(
        &self,
        kind: &str,
        account: Option<&str>,
    ) -> Result<T, Fault> {
        let answered = {
            let service = self.service.upgrade().ok_or_else(Fault::cancelled)?;
            let mut triggers = locked(&service.triggers);
            let live = triggers
                .as_mut()
                .and_then(|t| t.live.get_mut(&self.token.id))
                .filter(|l| l.generation == self.token.generation)
                .ok_or_else(Fault::cancelled)?;
            let (answer, answered) = oneshot::channel();
            live.ask += 1;
            live.answer = Some(answer);
            service.tell(
                "schedules.routineAsk",
                json!({"token":self.token,"ask":live.ask,"kind":kind,"account":account}),
            );
            answered
        };
        let value = answered.await.map_err(|_| Fault::cancelled())??;
        serde_json::from_value(value).map_err(|_| {
            Fault::new(
                "routine_host",
                "The routine host returned invalid launch parameters",
            )
        })
    }
}

#[derive(Deserialize)]
struct Ready {
    file: PathBuf,
    #[serde(default)]
    timing: Timing,
}
#[derive(Deserialize)]
struct Answered {
    token: Token,
    ask: u64,
    value: Option<Value>,
    error: Option<String>,
}
#[derive(Deserialize)]
struct Notice {
    token: Token,
    activity: Activity,
    tab: Option<Tab>,
}

pub(super) fn register(registry: &mut Registry) {
    registry.add("schedules.routinesReady", |call: Call| {
        Box::pin(async move {
            let (service, now, ready): (_, _, Ready) = super::asked(&call)?;
            service.with(|engine| {
                let mut slot = locked(&service.triggers);
                if slot.is_none() && !engine.closed() {
                    let mut triggers = Triggers::new(&service, ready.file, ready.timing);
                    let state = engine.state();
                    triggers.sync(&service, engine, &state, now);
                    *slot = Some(triggers);
                }
            });
            Reply::json(&())
        })
    });
    registry.add("schedules.routineAnswer", |call| {
        Box::pin(async move {
            let (service, _, reply): (_, _, Answered) = super::asked(&call)?;
            let mut triggers = locked(&service.triggers);
            if let Some(live) = triggers
                .as_mut()
                .and_then(|t| t.live.get_mut(&reply.token.id))
                && live.generation == reply.token.generation
                && live.ask == reply.ask
                && let Some(tx) = live.answer.take()
            {
                let _ = tx.send(match reply.error {
                    Some(error) => Err(Fault::new("routine_host", error)),
                    None => Ok(reply.value.unwrap_or(Value::Null)),
                });
            }
            Reply::json(&())
        })
    });
    registry.add("schedules.routineActivity", |call| {
        Box::pin(async move {
            let (service, now, notice): (_, _, Notice) = super::asked(&call)?;
            service.with(|engine| {
                let mut triggers = locked(&service.triggers);
                if let Some(live) = triggers
                    .as_mut()
                    .and_then(|t| t.live.get_mut(&notice.token.id))
                    && live.generation == notice.token.generation
                    && let Source::Session(session) = &mut live.source
                    && let Some(line) =
                        session.notice(notice.activity, notice.tab, live.wake.as_deref())
                {
                    engine.fire(&notice.token.id, &line, now);
                }
            });
            Reply::json(&())
        })
    });
}
