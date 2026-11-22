//! One REA transport per MCP session. Client and child frames share one short protocol turn;
//! neither a pipe write nor a child reply holds that turn open.

mod cache;
mod catalog;
mod process;
#[cfg(test)]
mod tests;

pub(crate) use cache::Store;

use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, watch};

use self::cache::Entry;
use self::catalog::{Catalog, ToolCall};
use self::process::Process;
use crate::remote::events::js;

type Sender = mpsc::UnboundedSender<Value>;

enum Event {
    Frame(Value),
    Ended,
}

pub(crate) struct Session {
    relay: Arc<Mutex<Relay>>,
    ended: watch::Receiver<()>,
}

impl Session {
    pub(crate) fn new(
        store: Arc<Store>,
        command: Arc<Vec<OsString>>,
        cwd: Option<PathBuf>,
        outgoing: Sender,
    ) -> Self {
        let (events, mut frames) = mpsc::unbounded_channel();
        let (end, ended) = watch::channel(());
        let relay = Arc::new(Mutex::new(Relay::new(
            store, command, cwd, outgoing, events,
        )));
        let worker = relay.clone();
        tokio::spawn(async move {
            while let Some(event) = frames.recv().await {
                let mut state = worker.lock().expect("REA session lock");
                match event {
                    Event::Frame(frame) if state.failure.is_none() => state.child_frame(frame),
                    Event::Frame(_) => {}
                    Event::Ended => {
                        state.fail(exited());
                        state.child.take();
                        state.outgoing.take();
                        break;
                    }
                }
            }
            drop(end);
        });
        Self { relay, ended }
    }

    pub(crate) fn receive(&self, message: Value) {
        self.relay
            .lock()
            .expect("REA session lock")
            .client_frame(message);
    }

    pub(crate) fn running(&self) -> bool {
        self.relay.lock().expect("REA session lock").child.is_some()
    }

    pub(crate) async fn close(&self) {
        self.stop();
        let _ = self.ended.clone().changed().await;
    }

    fn stop(&self) {
        let mut relay = self.relay.lock().expect("REA session lock");
        if relay.failure.is_none() {
            relay.stop(exited());
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.stop();
    }
}

enum Startup {
    Cached(Arc<Entry>),
    Replaying,
    Live,
}

struct Request {
    id: Value,
    method: String,
    params: Option<Value>,
}

enum Pending {
    Reply { id: Value, initialize: bool },
    Handshake,
    CatalogPage,
    RememberPrompts,
}

enum LoadReason {
    Demand,
    Compare,
    Changed(Value),
}

struct Load {
    pages: Catalog,
    reason: LoadReason,
}

struct Relay {
    store: Arc<Store>,
    command: Arc<Vec<OsString>>,
    cwd: Option<PathBuf>,
    outgoing: Option<Sender>,
    events: mpsc::UnboundedSender<Event>,
    child: Option<Process>,
    startup: Startup,
    client_init: Option<Value>,
    initialized: Option<Value>,
    notices: Vec<Value>,
    waiting_for_start: Vec<Request>,
    cancelled: HashSet<String>,
    next_id: u64,
    pending: HashMap<String, Pending>,
    server_ids: HashMap<String, Value>,
    catalog: Option<Arc<Catalog>>,
    load: Option<Load>,
    changes: VecDeque<LoadReason>,
    waiting_for_tools: Vec<Request>,
    initialize_result: Option<Arc<Value>>,
    prompts: Option<Arc<Value>>,
    remembered: bool,
    failure: Option<Value>,
}

fn take(map: &mut Value, key: &str) -> Option<Value> {
    map.as_object_mut()?.shift_remove(key)
}

fn field(name: &str, value: Value) -> Value {
    Value::Object(Map::from_iter([(name.to_owned(), value)]))
}

fn error(code: i64, message: impl AsRef<str>) -> Value {
    json!({"code":code, "message":message.as_ref()})
}

fn exited() -> Value {
    error(-32603, "REA child exited")
}

fn response(id: Value, outcome: Result<Option<Value>, Value>) -> Value {
    let mut message = json!({"jsonrpc":"2.0"});
    message["id"] = id;
    match outcome {
        Ok(Some(value)) => message["result"] = value,
        Ok(None) => {}
        Err(err) => message["error"] = err,
    }
    message
}

fn initialized_result(mut value: Value) -> Value {
    if value.is_object() {
        if !value["capabilities"].is_object() {
            value["capabilities"] = json!({});
        }
        value["capabilities"]["tools"] = json!({"listChanged":true});
    }
    value
}

// JSON.parse enumerates array-index keys before ordinary object keys. Retain all other key order:
// a different handshake, even one with just two ordinary fields switched, must miss the cache.
fn handshake_order(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(handshake_order),
        Value::Object(map) => {
            map.values_mut().for_each(handshake_order);
            if map
                .keys()
                .any(|s| s.as_bytes().first().is_some_and(u8::is_ascii_digit))
            {
                for (key, value) in std::mem::take(map) {
                    js::set(map, key, value);
                }
            }
        }
        _ => {}
    }
}

impl Relay {
    fn new(
        store: Arc<Store>,
        command: Arc<Vec<OsString>>,
        cwd: Option<PathBuf>,
        outgoing: Sender,
        events: mpsc::UnboundedSender<Event>,
    ) -> Self {
        let cached = store.get();
        Self {
            store,
            command,
            cwd,
            outgoing: Some(outgoing),
            events,
            child: None,
            catalog: cached.as_ref().map(|entry| entry.catalog.clone()),
            prompts: cached.as_ref().and_then(|entry| entry.prompts.clone()),
            startup: cached.map_or(Startup::Live, Startup::Cached),
            client_init: None,
            initialized: None,
            notices: Vec::new(),
            waiting_for_start: Vec::new(),
            cancelled: HashSet::new(),
            next_id: 0,
            pending: HashMap::new(),
            server_ids: HashMap::new(),
            load: None,
            changes: VecDeque::new(),
            waiting_for_tools: Vec::new(),
            initialize_result: None,
            remembered: false,
            failure: None,
        }
    }

    fn send(&self, message: Value) {
        if let Some(tx) = &self.outgoing {
            let _ = tx.send(message);
        }
    }

    fn pipe(&self, message: Value) {
        if let Some(child) = &self.child {
            let _ = child.input.send(message);
        }
    }

    fn spawn(&mut self) -> bool {
        match Process::start(&self.command, self.cwd.as_deref(), self.events.clone()) {
            Ok(child) => {
                self.child = Some(child);
                true
            }
            Err(_) => {
                self.stop(exited());
                false
            }
        }
    }

    fn request(&mut self, method: &str, params: Option<Value>, waiting: Pending) {
        self.next_id += 1;
        let id = format!("relay:{}", self.next_id);
        let mut msg = json!({"jsonrpc":"2.0", "id":id, "method":method});
        if let Some(params) = params {
            msg["params"] = params;
        }
        self.pending.insert(id, waiting);
        self.pipe(msg);
    }

    fn forward(&mut self, req: Request) {
        match &self.startup {
            Startup::Cached(entry) => {
                let params = self
                    .client_init
                    .as_ref()
                    .filter(|p| !p.is_null())
                    .cloned()
                    .or_else(|| serde_json::from_str(&entry.client).ok())
                    .unwrap_or(Value::Null);
                self.waiting_for_start.push(req);
                self.startup = Startup::Replaying;
                if self.spawn() {
                    self.request("initialize", Some(params), Pending::Handshake);
                }
            }
            Startup::Replaying => self.waiting_for_start.push(req),
            Startup::Live => {
                if !self.cancelled.is_empty() && self.cancelled.remove(&js::stringify(&req.id)) {
                    self.send(response(req.id, Err(error(-32800, "Request cancelled"))));
                } else {
                    self.request(
                        &req.method,
                        req.params,
                        Pending::Reply {
                            id: req.id,
                            initialize: false,
                        },
                    );
                }
            }
        }
    }

    fn stop(&mut self, cause: Value) {
        self.fail(cause);
        if let Some(child) = &mut self.child {
            child.stop();
        } else {
            let _ = self.events.send(Event::Ended);
        }
    }

    fn fail(&mut self, cause: Value) {
        if self.failure.is_some() {
            return;
        }
        if matches!(self.startup, Startup::Replaying) {
            self.store.forget();
        }
        for (_, waiting) in std::mem::take(&mut self.pending) {
            if let Pending::Reply { id, .. } = waiting {
                self.send(response(id, Err(cause.clone())));
            }
        }
        for req in std::mem::take(&mut self.waiting_for_start)
            .into_iter()
            .chain(std::mem::take(&mut self.waiting_for_tools))
        {
            self.send(response(req.id, Err(cause.clone())));
        }
        self.failure = Some(cause);
    }

    fn client_frame(&mut self, mut msg: Value) {
        let notification = msg.get("id").is_none() && msg["method"].is_string();
        if matches!(self.startup, Startup::Live) && self.child.is_none() && self.failure.is_none() {
            self.spawn();
        }
        if let Some(failure) = &self.failure {
            if !notification {
                self.send(response(
                    take(&mut msg, "id").unwrap_or(Value::Null),
                    Err(failure.clone()),
                ));
            }
            return;
        }
        if msg["jsonrpc"].as_str() != Some("2.0")
            || !matches!(
                msg.get("id"),
                None | Some(Value::String(_) | Value::Number(_) | Value::Null)
            )
        {
            if !notification {
                self.send(response(
                    take(&mut msg, "id").unwrap_or(Value::Null),
                    Err(error(-32600, "Invalid JSON-RPC request")),
                ));
            }
            return;
        }
        if !msg["method"].is_string() {
            if let Some(original) = msg["id"]
                .as_str()
                .and_then(|key| self.server_ids.remove(key))
            {
                msg["id"] = original;
                self.pipe(msg);
            } else {
                self.send(response(
                    take(&mut msg, "id").unwrap_or(Value::Null),
                    Err(error(-32600, "Unknown server request")),
                ));
            }
            return;
        }
        let Some(id) = take(&mut msg, "id") else {
            self.notice(msg);
            return;
        };
        let Some(Value::String(method)) = take(&mut msg, "method") else {
            unreachable!()
        };
        let mut req = Request {
            id,
            method,
            params: take(&mut msg, "params"),
        };
        match req.method.as_str() {
            "initialize" => {
                if let Some(params) = &mut req.params {
                    handshake_order(params);
                }
                self.client_init = req.params.clone();
                if let Startup::Cached(entry) = &self.startup {
                    if js::stringify(req.params.as_ref().unwrap_or(&Value::Null)) == entry.client {
                        let result = initialized_result((*entry.initialize).clone());
                        self.send(response(req.id, Ok(Some(result))));
                        return;
                    }
                    self.startup = Startup::Live;
                    self.catalog = None;
                    self.prompts = None;
                    if !self.spawn() {
                        self.send(response(req.id, Err(exited())));
                        return;
                    }
                }
                self.request(
                    &req.method,
                    req.params,
                    Pending::Reply {
                        id: req.id,
                        initialize: true,
                    },
                );
            }
            "ping" if self.child.is_none() => self.send(response(req.id, Ok(Some(json!({}))))),
            "prompts/list"
                if self.child.is_none()
                    && self.prompts.is_some()
                    && first_page(req.params.as_ref()) =>
            {
                self.send(response(req.id, Ok(self.prompts.as_deref().cloned())));
            }
            "tools/list" if !first_page(req.params.as_ref()) => {
                self.send(response(
                    req.id,
                    Err(error(-32602, "The relay tool list is not paginated")),
                ));
            }
            "tools/call"
                if !req.params.as_ref().is_some_and(|p| {
                    p["name"].is_string() && p.get("arguments").is_none_or(Value::is_object)
                }) =>
            {
                self.send(response(
                    req.id,
                    Err(error(-32602, "Expected tool name and object arguments")),
                ));
            }
            "tools/list" | "tools/call" => {
                if self.load.is_none() && self.catalog.is_some() {
                    self.serve_catalog(req);
                } else {
                    self.waiting_for_tools.push(req);
                    if self.load.is_none() {
                        self.start_load(LoadReason::Demand);
                    }
                }
            }
            _ => self.forward(req),
        }
    }

    fn notice(&mut self, mut message: Value) {
        let cancel =
            message["method"] == "notifications/cancelled" && message["params"].is_object();
        if !matches!(self.startup, Startup::Live) {
            if message["method"] == "notifications/initialized" {
                self.initialized = Some(message);
            } else if cancel {
                if let Some(id) = message["params"].get("requestId") {
                    self.cancelled.insert(js::stringify(id));
                }
            } else if message["method"] != "notifications/cancelled" {
                self.notices.push(message);
            }
        } else if cancel {
            let target = message["params"].get("requestId");
            if let Some((key, _)) = self.pending.iter().find(|(_, call)| matches!(call, Pending::Reply {id, ..} if js::strict_equal(target, Some(id)))) {
                message["params"]["requestId"] = Value::String(key.clone());
                self.pipe(message);
            }
        } else {
            self.pipe(message);
        }
    }

    fn serve_catalog(&mut self, mut req: Request) {
        let all = self.catalog.as_ref().expect("catalog loaded");
        if req.method == "tools/list" {
            self.send(response(req.id, Ok(Some(all.list()))));
            return;
        }
        match all.call(req.params.take().unwrap_or(Value::Null)) {
            Ok(ToolCall::Answer(result)) => self.send(response(req.id, Ok(Some(result)))),
            Ok(ToolCall::Relay(params)) => {
                req.params = Some(params);
                self.forward(req);
            }
            Err(err) => self.send(response(req.id, Err(err))),
        }
    }

    fn start_load(&mut self, reason: LoadReason) {
        if self.load.is_some() {
            self.changes.push_back(reason);
        } else {
            self.load = Some(Load {
                pages: Catalog::default(),
                reason,
            });
            self.request("tools/list", Some(json!({})), Pending::CatalogPage);
        }
    }

    fn catalog_page(&mut self, result: Result<Option<Value>, Value>) {
        let Some(mut load) = self.load.take() else {
            return;
        };
        let page = result.and_then(|page| {
            let mut page = page.unwrap_or(Value::Null);
            load.pages
                .append(take(&mut page, "tools").unwrap_or(Value::Null))?;
            Ok(take(&mut page, "nextCursor").filter(|v| v.as_str().is_some_and(|s| !s.is_empty())))
        });
        match page {
            Err(err) => {
                for req in std::mem::take(&mut self.waiting_for_tools) {
                    self.send(response(req.id, Err(err.clone())));
                }
                if !matches!(load.reason, LoadReason::Demand) || !self.changes.is_empty() {
                    self.stop(exited());
                }
                return;
            }
            Ok(Some(cursor)) => {
                self.load = Some(load);
                self.request(
                    "tools/list",
                    Some(field("cursor", cursor)),
                    Pending::CatalogPage,
                );
                return;
            }
            Ok(None) => {}
        }
        let fresh = Arc::new(load.pages);
        let previous = self.catalog.replace(fresh);
        if !self.remembered {
            self.remembered = true;
            if self.store.enabled()
                && let Some(init) = &self.initialize_result
            {
                if js::truthy(init["capabilities"].get("prompts")) {
                    self.request("prompts/list", Some(json!({})), Pending::RememberPrompts);
                } else {
                    self.save();
                }
            }
        }
        match load.reason {
            LoadReason::Changed(notice) => self.send(notice),
            LoadReason::Compare
                if !previous
                    .as_ref()
                    .zip(self.catalog.as_ref())
                    .is_some_and(|(a, b)| a.same(b)) =>
            {
                self.send(json!({"jsonrpc":"2.0", "method":"notifications/tools/list_changed"}));
            }
            _ => {}
        }
        if let Some(change) = self.changes.pop_front() {
            self.start_load(change);
        } else {
            for req in std::mem::take(&mut self.waiting_for_tools) {
                self.serve_catalog(req);
            }
        }
    }

    fn save(&self) {
        if let (Some(initialize), Some(catalog)) = (&self.initialize_result, &self.catalog) {
            self.store.write(Entry {
                client: js::stringify(self.client_init.as_ref().unwrap_or(&Value::Null)),
                initialize: initialize.clone(),
                catalog: catalog.clone(),
                prompts: self.prompts.clone(),
            });
        }
    }

    fn child_frame(&mut self, mut message: Value) {
        if message["method"].is_string() {
            if message.get("id").is_some() {
                self.next_id += 1;
                let key = format!("rea-server:{}", self.next_id);
                let original = std::mem::replace(&mut message["id"], Value::String(key.clone()));
                self.server_ids.insert(key, original);
                self.send(message);
            } else if message["method"] == "notifications/tools/list_changed" {
                self.start_load(LoadReason::Changed(message));
            } else {
                self.send(message);
            }
            return;
        }
        let Some(call) = message["id"]
            .as_str()
            .and_then(|id| self.pending.remove(id))
        else {
            return;
        };
        let result = match take(&mut message, "error").filter(Value::is_object) {
            Some(mut err) => {
                let mut failure = json!({"code": error_code(err.get("code")), "message":js::string_of(err.get("message"))});
                if let Some(data) = take(&mut err, "data") {
                    failure["data"] = data;
                }
                Err(failure)
            }
            None => Ok(take(&mut message, "result")),
        };
        match call {
            Pending::Reply {
                id,
                initialize: false,
            } => self.send(response(id, result)),
            Pending::Reply {
                id,
                initialize: true,
            } => {
                let result = result.map(|answer| {
                    answer.map(|value| {
                        self.initialize_result = value.is_object().then(|| Arc::new(value.clone()));
                        initialized_result(value)
                    })
                });
                self.send(response(id, result));
            }
            Pending::Handshake => match result {
                Err(err) => self.stop(err),
                Ok(answer) => {
                    self.initialize_result = answer.filter(Value::is_object).map(Arc::new);
                    if let Some(initialized) = self.initialized.take() {
                        self.pipe(initialized);
                    }
                    for notice in std::mem::take(&mut self.notices) {
                        self.pipe(notice);
                    }
                    self.startup = Startup::Live;
                    for req in std::mem::take(&mut self.waiting_for_start) {
                        self.forward(req);
                    }
                    self.start_load(LoadReason::Compare);
                }
            },
            Pending::CatalogPage => self.catalog_page(result),
            Pending::RememberPrompts => {
                if let Ok(answer) = result {
                    if let Some(before) = self.prompts.as_deref()
                        && !answer
                            .as_ref()
                            .is_some_and(|fresh| js::same_json(fresh, before))
                    {
                        self.send(
                            json!({"jsonrpc":"2.0", "method":"notifications/prompts/list_changed"}),
                        );
                    }
                    self.prompts = answer.map(Arc::new);
                    self.save();
                }
            }
        }
    }
}

fn first_page(params: Option<&Value>) -> bool {
    params.is_none_or(|params| params.is_object() && params.get("cursor").is_none())
}

fn error_code(code: Option<&Value>) -> Value {
    match code {
        Some(Value::Number(code)) => Value::Number(code.clone()),
        Some(Value::Null | Value::Bool(false)) => 0.into(),
        Some(Value::Bool(true)) => 1.into(),
        code => {
            let text = js::string_of(code);
            let text = crate::control::js::trim(&text);
            if text.is_empty() {
                0.into()
            } else {
                text.parse::<f64>().ok().map_or(Value::Null, Value::from)
            }
        }
    }
}
