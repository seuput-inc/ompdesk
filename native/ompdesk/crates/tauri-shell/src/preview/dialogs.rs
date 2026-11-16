//! Actual CDP dialogs use Node's existing streamed-page question/answer channel.
//! Replies bypass the mutation/input FIFO; close, replacement and page shutdown withdraw the pending question.

use serde_json::{Value, json};
use shell_preview::Browser;
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::oneshot;

use crate::host;

/// The channel Node's `ipcMain.on` handler for a streamed page answers (`DIALOG_CHANNEL` in `web/preview-dialog.ts`).
pub(super) const CHANNEL: &str = "preview-web:dialog";
/// Longest text Node accepts for a message or a default, in UTF-16 code units (`MESSAGE_MAX` in `preview-dialog.ts`).
const TEXT_MAX_UNITS: usize = 2000;
/// Node dismisses an unanswered dialog after 60 s; a Node that answers nothing at all must not leave the page blocked.
const ANSWER_DEADLINE: Duration = Duration::from_secs(75);

pub(super) type Task = Pin<Box<dyn Future<Output = ()> + Send>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Alert,
    Confirm,
    Prompt,
    BeforeUnload,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Opening {
    kind: Kind,
    message: String,
    default_prompt: Option<String>,
    /// The URL of the frame that opened it (already mapped back from the gateway by the observer).
    url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Event {
    Opening(Opening),
    /// The dialog ended, by an answer or because something else closed it (navigation, the page's end).
    Closed,
}

pub(super) fn decode(event: &shell_preview::Event) -> Option<Event> {
    let params = &event.params;
    match event.method.as_str() {
        "Page.javascriptDialogOpening" => {
            let kind = match params.get("type")?.as_str()? {
                "alert" => Kind::Alert,
                "confirm" => Kind::Confirm,
                "prompt" => Kind::Prompt,
                "beforeunload" => Kind::BeforeUnload,
                _ => return None,
            };
            Some(Event::Opening(Opening {
                kind,
                message: params.get("message")?.as_str()?.to_owned(),
                default_prompt: params
                    .get("defaultPrompt")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                url: params
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            }))
        }
        "Page.javascriptDialogClosed" => Some(Event::Closed),
        _ => None,
    }
}

fn clip(text: &str) -> String {
    let mut units = 0;
    let mut clipped = String::new();
    for character in text.chars() {
        units += character.len_utf16();
        if units > TEXT_MAX_UNITS {
            break;
        }
        clipped.push(character);
    }
    clipped
}

/// What the page's function gets back, as Chromium takes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Verdict {
    accept: bool,
    prompt_text: Option<String>,
}

impl Verdict {
    fn params(&self) -> Value {
        let mut params = json!({"accept":self.accept});
        if let Some(text) = &self.prompt_text {
            params["promptText"] = json!(text);
        }
        params
    }
}

impl Opening {
    /// The request Node's `dialogRequestSchema` takes; `None` for `beforeunload`, which is never a question: leaving
    /// a page is not something a viewer is asked about (the streamed page's `will-prevent-unload` lets it go).
    fn question(&self) -> Option<Value> {
        let kind = match self.kind {
            Kind::Alert => "alert",
            Kind::Confirm => "confirm",
            Kind::Prompt => "prompt",
            Kind::BeforeUnload => return None,
        };
        let initial = (self.kind == Kind::Prompt)
            .then(|| clip(self.default_prompt.as_deref().unwrap_or_default()));
        Some(json!({"kind":kind,"message":clip(&self.message),"initial":initial}))
    }

    /// Node's `{value}` as the page's function sees it: `null` for an alert, a boolean for a confirm, a string or
    /// `null` for a prompt. `None` is no answer at all (Node failed, did not answer, or the viewer left): the dialog
    /// is dismissed, as Node dismisses one nobody answers.
    fn verdict(&self, answer: Option<&Value>) -> Verdict {
        match self.kind {
            Kind::Alert | Kind::BeforeUnload => Verdict {
                accept: true,
                prompt_text: None,
            },
            Kind::Confirm => Verdict {
                accept: answer.and_then(Value::as_bool) == Some(true),
                prompt_text: None,
            },
            Kind::Prompt => match answer.and_then(Value::as_str) {
                Some(text) => Verdict {
                    accept: true,
                    prompt_text: Some(text.to_owned()),
                },
                None => Verdict {
                    accept: false,
                    prompt_text: None,
                },
            },
        }
    }
}

/// The two peers a dialog talks to; the live ones are Node's host wire and the Preview browser's transport.
pub(super) trait Backend: Send + Sync + 'static {
    /// Asks Node the question about page `wc`. The receiver yields Node's `value`, or `None` when the request failed;
    /// it is closed without a value when `cancel` withdraws the request.
    fn ask(
        &self,
        wc: u64,
        frame_url: &str,
        question: Value,
    ) -> (u64, oneshot::Receiver<Option<Value>>);
    /// Stops waiting for request `id` and tells Node (its handler's abort signal fires).
    fn cancel(&self, id: u64);
    /// `Page.handleJavaScriptDialog` on the session that reported the dialog.
    fn handle(
        &self,
        session: String,
        params: Value,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
}

pub(super) struct Live(Arc<Browser>);

impl Live {
    pub(super) fn new(browser: Arc<Browser>) -> Self {
        Self(browser)
    }
}

impl Backend for Live {
    fn ask(
        &self,
        wc: u64,
        frame_url: &str,
        question: Value,
    ) -> (u64, oneshot::Receiver<Option<Value>>) {
        let (send, receive) = oneshot::channel();
        let id = host::request(
            "ipc.sendSync",
            json!({"wcId":wc,"frameUrl":frame_url,"channel":CHANNEL,"args":[question]}),
            None,
            move |answer, _| {
                let _ = send.send(answer.ok().map(|answer| answer["value"].clone()));
            },
        );
        (id, receive)
    }

    fn cancel(&self, id: u64) {
        host::cancel_request(id);
    }

    fn handle(
        &self,
        session: String,
        params: Value,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>> {
        let browser = Arc::clone(&self.0);
        Box::pin(async move {
            browser
                .command("Page.handleJavaScriptDialog", params, Some(&session))
                .await
                .map(|_| ())
                .map_err(|error| error.to_string())
        })
    }
}

struct Open {
    ticket: u64,
    session: String,
    request: u64,
}

/// The dialogs open now, at most one per page (Chromium shows one at a time and the page is blocked in it).
pub(super) struct Dialogs {
    open: Arc<Mutex<HashMap<u64, Open>>>,
    next: AtomicU64,
    deadline: Duration,
    backend: OnceLock<Arc<dyn Backend>>,
}

impl Default for Dialogs {
    fn default() -> Self {
        Self::with_deadline(ANSWER_DEADLINE)
    }
}

impl Dialogs {
    fn with_deadline(deadline: Duration) -> Self {
        Self {
            open: Arc::default(),
            next: AtomicU64::new(1),
            deadline,
            backend: OnceLock::new(),
        }
    }

    /// The peers to talk to, set once when the Preview browser has launched. A dialog event cannot precede it.
    pub(super) fn install(&self, backend: Arc<dyn Backend>) {
        let _ = self.backend.set(backend);
    }

    /// Registers the dialog `session` reported for page `wc` and returns the task that waits for its answer; the
    /// caller spawns it off the Preview queue. A dialog still registered for `wc` is gone from Chromium's view (it
    /// shows one at a time): its request is withdrawn, so Node drops its viewer sheet, and it is never answered.
    pub(super) fn opened(&self, wc: u64, session: &str, opening: &Opening) -> Task {
        let backend = self
            .backend
            .get()
            .expect("Preview dialog backend installed before observation")
            .clone();
        let session = session.to_owned();
        let Some(question) = opening.question() else {
            let verdict = opening.verdict(None);
            return Box::pin(async move { respond(backend.as_ref(), &session, &verdict).await });
        };
        let ticket = self.next.fetch_add(1, Ordering::Relaxed);
        let (request, answer) = backend.ask(wc, &opening.url, question);
        let previous = self.open.lock().expect("Preview dialogs").insert(
            wc,
            Open {
                ticket,
                session: session.clone(),
                request,
            },
        );
        if let Some(previous) = previous {
            backend.cancel(previous.request);
        }
        let open = Arc::clone(&self.open);
        let deadline = self.deadline;
        let opening = opening.clone();
        Box::pin(async move {
            let answered = tokio::time::timeout(deadline, answer).await;
            let owner = {
                let mut open = open.lock().expect("Preview dialogs");
                let owned = open.get(&wc).is_some_and(|open| open.ticket == ticket);
                if owned {
                    open.remove(&wc);
                }
                owned
            };
            // Closed or replaced meanwhile: its request is already withdrawn and Chromium has no dialog to answer.
            if !owner {
                return;
            }
            let value = match answered {
                Ok(Ok(value)) => value,
                Ok(Err(_)) => None,
                Err(_) => {
                    backend.cancel(request);
                    None
                }
            };
            respond(backend.as_ref(), &session, &opening.verdict(value.as_ref())).await;
        })
    }

    /// `Page.javascriptDialogClosed` from `session`: Chromium ended the dialog without an answer from here.
    pub(super) fn closed(&self, wc: u64, session: &str) {
        let ended = {
            let mut open = self.open.lock().expect("Preview dialogs");
            if open.get(&wc).is_some_and(|open| open.session == session) {
                open.remove(&wc)
            } else {
                None
            }
        };
        self.withdraw(ended);
    }

    /// The page ended while it held a dialog.
    pub(super) fn end(&self, wc: u64) {
        let ended = self.open.lock().expect("Preview dialogs").remove(&wc);
        self.withdraw(ended);
    }

    fn withdraw(&self, ended: Option<Open>) {
        if let (Some(ended), Some(backend)) = (ended, self.backend.get()) {
            backend.cancel(ended.request);
        }
    }
}

async fn respond(backend: &dyn Backend, session: &str, verdict: &Verdict) {
    if let Err(error) = backend.handle(session.to_owned(), verdict.params()).await {
        crate::log::log("preview.dialog.handle", json!({"error":error}));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn event(method: &str, params: Value) -> shell_preview::Event {
        shell_preview::Event {
            method: method.into(),
            params: Arc::new(params),
            session_id: Some("page".into()),
        }
    }

    fn opening(kind: &str, message: &str, default: Option<&str>) -> Opening {
        let mut params =
            json!({"url":"http://a.test/","message":message,"type":kind,"hasBrowserHandler":false});
        if let Some(default) = default {
            params["defaultPrompt"] = json!(default);
        }
        match decode(&event("Page.javascriptDialogOpening", params)) {
            Some(Event::Opening(opening)) => opening,
            other => panic!("not an opening: {other:?}"),
        }
    }

    #[derive(Default)]
    struct Fake {
        asked: Mutex<Vec<(u64, String, Value)>>,
        waiting: Mutex<HashMap<u64, oneshot::Sender<Option<Value>>>>,
        cancelled: Mutex<Vec<u64>>,
        handled: Mutex<Vec<(String, Value)>>,
        next: AtomicU64,
    }

    impl Fake {
        fn answer(&self, id: u64, value: Option<Value>) {
            let _ = self
                .waiting
                .lock()
                .unwrap()
                .remove(&id)
                .expect("a waiting request")
                .send(value);
        }
        fn handled(&self) -> Vec<(String, Value)> {
            self.handled.lock().unwrap().clone()
        }
        fn cancelled(&self) -> Vec<u64> {
            self.cancelled.lock().unwrap().clone()
        }
    }

    impl Backend for Fake {
        fn ask(
            &self,
            wc: u64,
            frame_url: &str,
            question: Value,
        ) -> (u64, oneshot::Receiver<Option<Value>>) {
            let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
            let (send, receive) = oneshot::channel();
            self.waiting.lock().unwrap().insert(id, send);
            self.asked
                .lock()
                .unwrap()
                .push((wc, frame_url.to_owned(), question));
            (id, receive)
        }
        fn cancel(&self, id: u64) {
            self.cancelled.lock().unwrap().push(id);
            self.waiting.lock().unwrap().remove(&id);
        }
        fn handle(
            &self,
            session: String,
            params: Value,
        ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>> {
            self.handled.lock().unwrap().push((session, params));
            Box::pin(async { Ok(()) })
        }
    }

    fn rig(deadline: Duration) -> (Dialogs, Arc<Fake>) {
        let (dialogs, fake) = (Dialogs::with_deadline(deadline), Arc::new(Fake::default()));
        dialogs.install(fake.clone());
        (dialogs, fake)
    }

    fn start(
        dialogs: &Dialogs,
        wc: u64,
        session: &str,
        opening: &Opening,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(dialogs.opened(wc, session, opening))
    }

    #[test]
    fn decodes_only_the_dialog_events() {
        assert_eq!(
            opening("prompt", "Name?", Some("dflt")),
            Opening {
                kind: Kind::Prompt,
                message: "Name?".into(),
                default_prompt: Some("dflt".into()),
                url: "http://a.test/".into(),
            }
        );
        assert_eq!(
            decode(&event(
                "Page.javascriptDialogClosed",
                json!({"result":true,"userInput":""})
            )),
            Some(Event::Closed)
        );
        assert_eq!(decode(&event("Page.frameNavigated", json!({}))), None);
        assert_eq!(
            decode(&event(
                "Page.javascriptDialogOpening",
                json!({"url":"","message":"m","type":"unknown"})
            )),
            None
        );
    }

    #[test]
    fn the_question_is_the_request_nodes_schema_takes() {
        assert_eq!(
            opening("alert", "Hi", None).question(),
            Some(json!({"kind":"alert","message":"Hi","initial":null}))
        );
        assert_eq!(
            opening("confirm", "Sure?", Some("ignored")).question(),
            Some(json!({"kind":"confirm","message":"Sure?","initial":null}))
        );
        assert_eq!(
            opening("prompt", "Name?", None).question(),
            Some(json!({"kind":"prompt","message":"Name?","initial":""}))
        );
        assert_eq!(opening("beforeunload", "", None).question(), None);
    }

    #[test]
    fn text_is_cut_to_nodes_limit_in_utf16_units_without_splitting_a_character() {
        let long = format!("{}😀", "a".repeat(TEXT_MAX_UNITS - 1));
        let clipped = clip(&long);
        assert_eq!(clipped, "a".repeat(TEXT_MAX_UNITS - 1));
        assert_eq!(clip(&"é".repeat(3000)).chars().count(), TEXT_MAX_UNITS);
        assert_eq!(clip("short"), "short");
    }

    #[test]
    fn the_verdict_is_what_the_page_function_returns() {
        let alert = opening("alert", "m", None);
        assert!(alert.verdict(Some(&Value::Null)).accept);
        assert!(alert.verdict(None).accept);
        let confirm = opening("confirm", "m", None);
        assert!(confirm.verdict(Some(&json!(true))).accept);
        assert!(!confirm.verdict(Some(&json!(false))).accept);
        assert!(!confirm.verdict(Some(&Value::Null)).accept);
        assert!(!confirm.verdict(None).accept);
        let prompt = opening("prompt", "m", None);
        assert_eq!(
            prompt.verdict(Some(&json!("Ada"))).params(),
            json!({"accept":true,"promptText":"Ada"})
        );
        assert_eq!(
            prompt.verdict(Some(&json!(""))).params(),
            json!({"accept":true,"promptText":""})
        );
        assert_eq!(
            prompt.verdict(Some(&Value::Null)).params(),
            json!({"accept":false})
        );
        assert_eq!(prompt.verdict(None).params(), json!({"accept":false}));
        assert!(opening("beforeunload", "", None).verdict(None).accept);
    }

    #[tokio::test]
    async fn an_answer_becomes_the_handle_call_on_the_reporting_session() {
        let (dialogs, fake) = rig(ANSWER_DEADLINE);
        let waiting = start(
            &dialogs,
            7,
            "iframe-session",
            &opening("prompt", "Name?", Some("dflt")),
        );
        tokio::task::yield_now().await;
        assert_eq!(
            fake.asked.lock().unwrap().clone(),
            vec![(
                7,
                "http://a.test/".to_owned(),
                json!({"kind":"prompt","message":"Name?","initial":"dflt"})
            )]
        );
        assert_eq!(
            fake.handled(),
            vec![],
            "the page stays blocked until the viewer answers"
        );
        fake.answer(1, Some(json!("Ada")));
        waiting.await.unwrap();
        assert_eq!(
            fake.handled(),
            vec![(
                "iframe-session".into(),
                json!({"accept":true,"promptText":"Ada"})
            )]
        );
        assert!(dialogs.open.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_failed_or_lost_request_dismisses_instead_of_blocking_the_page() {
        let (dialogs, fake) = rig(ANSWER_DEADLINE);
        let waiting = start(&dialogs, 1, "page", &opening("confirm", "Sure?", None));
        tokio::task::yield_now().await;
        fake.answer(1, None);
        waiting.await.unwrap();
        assert_eq!(
            fake.handled(),
            vec![("page".into(), json!({"accept":false}))]
        );

        let waiting = start(&dialogs, 1, "page", &opening("confirm", "Again?", None));
        tokio::task::yield_now().await;
        fake.waiting.lock().unwrap().clear();
        waiting.await.unwrap();
        assert_eq!(fake.handled().len(), 2);
        assert_eq!(fake.handled()[1].1, json!({"accept":false}));
    }

    #[tokio::test]
    async fn a_node_that_never_answers_is_dismissed_at_the_deadline_and_its_request_withdrawn() {
        let (dialogs, fake) = rig(Duration::ZERO);
        start(&dialogs, 1, "page", &opening("confirm", "Sure?", None))
            .await
            .unwrap();
        assert_eq!(fake.cancelled(), vec![1]);
        assert_eq!(
            fake.handled(),
            vec![("page".into(), json!({"accept":false}))]
        );
    }

    #[tokio::test]
    async fn closing_withdraws_the_request_and_answers_nothing() {
        let (dialogs, fake) = rig(ANSWER_DEADLINE);
        let waiting = start(&dialogs, 3, "page", &opening("confirm", "Sure?", None));
        tokio::task::yield_now().await;
        dialogs.closed(3, "another-session");
        assert_eq!(
            fake.cancelled(),
            Vec::<u64>::new(),
            "a session that did not report it cannot close it"
        );
        dialogs.closed(3, "page");
        waiting.await.unwrap();
        assert_eq!(fake.cancelled(), vec![1]);
        assert_eq!(fake.handled(), vec![]);
    }

    #[tokio::test]
    async fn a_new_opening_replaces_the_old_one_and_only_the_new_one_is_answered() {
        let (dialogs, fake) = rig(ANSWER_DEADLINE);
        let old = start(&dialogs, 3, "page", &opening("confirm", "Old?", None));
        tokio::task::yield_now().await;
        let new = start(&dialogs, 3, "page", &opening("alert", "New", None));
        old.await.unwrap();
        assert_eq!(fake.cancelled(), vec![1]);
        assert_eq!(fake.handled(), vec![]);
        fake.answer(2, Some(Value::Null));
        new.await.unwrap();
        assert_eq!(
            fake.handled(),
            vec![("page".into(), json!({"accept":true}))]
        );
    }

    #[tokio::test]
    async fn the_page_ending_withdraws_its_dialog_and_other_pages_keep_theirs() {
        let (dialogs, fake) = rig(ANSWER_DEADLINE);
        let ended = start(&dialogs, 1, "a", &opening("confirm", "A?", None));
        let kept = start(&dialogs, 2, "b", &opening("confirm", "B?", None));
        tokio::task::yield_now().await;
        dialogs.end(1);
        ended.await.unwrap();
        assert_eq!(fake.cancelled(), vec![1]);
        fake.answer(2, Some(json!(true)));
        kept.await.unwrap();
        assert_eq!(fake.handled(), vec![("b".into(), json!({"accept":true}))]);
    }

    #[tokio::test]
    async fn leaving_a_page_is_never_a_question() {
        let (dialogs, fake) = rig(ANSWER_DEADLINE);
        start(&dialogs, 1, "page", &opening("beforeunload", "", None))
            .await
            .unwrap();
        assert_eq!(fake.asked.lock().unwrap().len(), 0);
        assert_eq!(
            fake.handled(),
            vec![("page".into(), json!({"accept":true}))]
        );
    }
}
