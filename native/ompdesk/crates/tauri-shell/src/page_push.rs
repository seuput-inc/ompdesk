use crate::registry::{Identity, Registry};
use crate::{WireError, failed, log, runtime, window_for_wc};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::VecDeque;
use tokio::sync::oneshot;

const PRE_READY_LIMIT: usize = 4096;
const DISK_FULL: &str = "disk-full:state";
type Submitted = oneshot::Sender<Result<(), WireError>>;

#[derive(Serialize)]
struct Message<'a> {
    channel: &'a str,
    args: &'a [Value],
}

struct Push {
    script: String,
    submitted: Option<Submitted>,
}

impl Push {
    fn new(id: Identity, channel: &str, args: &[Value], submitted: Option<Submitted>) -> Self {
        let mut script = format!("window.__ompTauriPush({}, ", id.generation).into_bytes();
        serde_json::to_writer(&mut script, &Message { channel, args }).expect("JSON into Vec");
        script.extend_from_slice(b");");
        Self {
            script: String::from_utf8(script).expect("JSON is UTF-8"),
            submitted,
        }
    }

    fn submit(self, eval: impl FnOnce(String) -> Result<(), WireError>) -> Result<(), WireError> {
        let result = eval(self.script);
        if let Some(receipt) = self.submitted {
            let _ = receipt.send(result.clone());
        }
        result
    }
}

#[derive(Default)]
pub(super) struct Outbox {
    ready: bool,
    pending: VecDeque<Push>,
}

fn gone() -> WireError {
    WireError::new("gone", "original app document ended")
}

fn admit(registry: &mut Registry, id: Identity, push: Push) -> Result<bool, WireError> {
    let outbox = registry.outbox(id).ok_or_else(gone)?;
    if !outbox.ready && outbox.pending.len() >= PRE_READY_LIMIT {
        outbox.pending.clear();
        outbox.pending.push_back(Push {
            script: format!(
                "window.__ompTauriPush({}, {{\"stream\":\"reset\"}});",
                id.generation
            ),
            submitted: None,
        });
    }
    outbox.pending.push_back(push);
    Ok(outbox.ready)
}

fn ready(registry: &mut Registry, id: Identity) -> Result<Option<VecDeque<Push>>, WireError> {
    let outbox = registry.outbox(id).ok_or_else(gone)?;
    Ok((!std::mem::replace(&mut outbox.ready, true)).then(|| std::mem::take(&mut outbox.pending)))
}

fn next(registry: &mut Registry, id: Identity) -> Option<Push> {
    registry.outbox(id)?.pending.pop_front()
}

/// A native invoke passes a oneshot sender and awaits its receiver before replying. The UI never waits.
/// A closed receiver means its document or buffered event ended before submission to the WebView.
/// Node's socket reader passes None so it stays free to answer requests from the UI thread.
pub(super) fn enqueue(
    id: Identity,
    channel: &str,
    args: &[Value],
    submitted: Option<Submitted>,
) -> Result<(), WireError> {
    let push = Push::new(id, channel, args, submitted);
    let live = admit(&mut runtime().registry.lock().expect("registry"), id, push)?;
    if live {
        // Workers may post their UI turns in reverse. Each turn submits the FIFO head, not its own event.
        runtime()
            .app
            .run_on_main_thread(move || {
                let push = next(&mut runtime().registry.lock().expect("registry"), id);
                if let Some(push) = push
                    && let Err(error) =
                        push.submit(|script| window_for_wc(id.wc)?.eval(script).map_err(failed))
                {
                    log_failure(id, error);
                }
            })
            .map_err(|error| {
                // The event loop closed. Release receipts that no UI turn can now complete.
                if let Some(outbox) = runtime().registry.lock().expect("registry").outbox(id) {
                    outbox.pending.clear();
                }
                failed(error)
            })?;
    }
    Ok(())
}

pub(super) fn document_ready(id: Identity, webview: &tauri::Webview) -> Result<bool, WireError> {
    let Some(queued) = ready(&mut runtime().registry.lock().expect("registry"), id)? else {
        return Ok(false);
    };
    for push in queued {
        push.submit(|script| webview.eval(script).map_err(failed))?;
    }
    Ok(true)
}

fn log_failure(id: Identity, error: WireError) {
    if error.code != "gone" {
        log::log("push.failed", json!({"wcId":id.wc,"error":error.message}));
    }
}

pub(super) fn detached(id: Identity, channel: &str, args: &[Value]) {
    if let Err(error) = enqueue(id, channel, args, None) {
        log_failure(id, error);
    }
}

pub(super) fn wc_send(data: &Value) {
    let (Some(wc), Some(channel), Some(args)) = (
        data["wcId"].as_u64(),
        data["channel"].as_str(),
        data["args"].as_array(),
    ) else {
        return;
    };
    let id = runtime()
        .registry
        .lock()
        .expect("registry")
        .app_document(wc);
    if let Some(id) = id {
        detached(id, channel, args);
    }
}

fn disk_state_args(data: Value) -> Option<[Value; 1]> {
    fn file_name(value: &Value) -> bool {
        value.as_str().is_some_and(|name| {
            !name.contains(['/', '\\'])
                && !matches!(name.as_bytes(), [b'a'..=b'z' | b'A'..=b'Z', b':', ..])
        })
    }
    if data.as_object()?.len() != 1 || !data["files"].as_array()?.iter().all(file_name) {
        return None;
    }
    Some([data])
}

pub(super) fn disk_full_state(data: Value) {
    let Some(args) = disk_state_args(data) else {
        log::log("diskFull.invalid", json!({}));
        return;
    };
    let ids: Vec<_> = runtime()
        .registry
        .lock()
        .expect("registry")
        .app_documents()
        .collect();
    for id in ids {
        detached(id, DISK_FULL, &args);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oneshot::error::TryRecvError;

    fn document() -> (Registry, Identity) {
        let mut registry = Registry::default();
        registry.create(1, 1).unwrap();
        let id = registry
            .navigate(1, "app://ompdesk/index.html".into())
            .unwrap();
        (registry, id)
    }

    fn frame(script: &str) -> (u64, Value) {
        let args = script
            .strip_prefix("window.__ompTauriPush(")
            .unwrap()
            .strip_suffix(");")
            .unwrap();
        serde_json::from_str(&format!("[{args}]")).unwrap()
    }

    fn delivered(push: Push) -> (u64, Value) {
        let mut sent = None;
        push.submit(|script| {
            sent = Some(frame(&script));
            Ok(())
        })
        .unwrap();
        sent.unwrap()
    }

    #[test]
    fn node_and_native_pushes_keep_admission_order_across_ready_and_before_invoke_reply() {
        let (mut registry, id) = document();
        let node = Push::new(id, "node", &[json!(1)], None);
        assert!(!admit(&mut registry, id, node).unwrap());
        let buffered = ready(&mut registry, id).unwrap().unwrap();
        let (ack, mut receipt) = oneshot::channel();
        let native = Push::new(id, "native", &[json!(2)], Some(ack));
        assert!(admit(&mut registry, id, native).unwrap());
        let args = disk_state_args(json!({"files":["settings.json"]})).unwrap();
        assert!(admit(&mut registry, id, Push::new(id, DISK_FULL, &args, None)).unwrap());
        assert!(ready(&mut registry, id).unwrap().is_none());
        assert_eq!(receipt.try_recv(), Err(TryRecvError::Empty));
        assert_eq!(
            buffered.into_iter().map(delivered).collect::<Vec<_>>(),
            [(1, json!({"channel":"node","args":[1]}))]
        );

        // The disk-full producer's UI turn may run before the native producer's turn.
        next(&mut registry, id)
            .unwrap()
            .submit(|script| {
                assert_eq!(frame(&script), (1, json!({"channel":"native","args":[2]})));
                assert_eq!(receipt.try_recv(), Err(TryRecvError::Empty));
                Ok(())
            })
            .unwrap();
        assert_eq!(receipt.try_recv(), Ok(Ok(())));
        assert_eq!(
            delivered(next(&mut registry, id).unwrap()),
            (
                1,
                json!({"channel":"disk-full:state","args":[{"files":["settings.json"]}]})
            )
        );
        assert!(next(&mut registry, id).is_none());
    }

    #[test]
    fn stale_ui_turn_and_captured_sender_cannot_reach_the_next_document() {
        let (mut registry, id) = document();
        ready(&mut registry, id).unwrap();
        let (ack, mut receipt) = oneshot::channel();
        admit(&mut registry, id, Push::new(id, "old", &[], Some(ack))).unwrap();
        let (new, _) = registry.process_gone(id.wc).unwrap();
        assert_eq!(receipt.try_recv(), Err(TryRecvError::Closed));
        assert!(admit(&mut registry, id, Push::new(id, "late", &[], None)).is_err());
        assert!(!admit(&mut registry, new, Push::new(new, "new", &[], None)).unwrap());
        assert!(next(&mut registry, id).is_none());
        assert!(ready(&mut registry, id).is_err());
        let sent = ready(&mut registry, new).unwrap().unwrap();
        assert_eq!(
            sent.into_iter().map(delivered).collect::<Vec<_>>(),
            [(new.generation, json!({"channel":"new","args":[]}))]
        );
    }

    #[test]
    fn preview_and_closing_pages_are_neither_broadcast_nor_direct_targets() {
        let (mut registry, id) = document();
        registry.create_view(1, 2).unwrap();
        registry.create_offscreen(2, 3).unwrap();
        registry.create(3, 4).unwrap();
        let (ack, mut receipt) = oneshot::channel();
        admit(&mut registry, id, Push::new(id, "pending", &[], Some(ack))).unwrap();
        registry.begin_close(id.wc);
        assert_eq!(receipt.try_recv(), Err(TryRecvError::Closed));
        assert_eq!(
            registry.app_documents().collect::<Vec<_>>(),
            [registry.app_document(4).unwrap()]
        );
        for wc in [1, 2, 3] {
            let target = registry.page(wc).unwrap().identity;
            assert!(registry.app_document(wc).is_none());
            assert!(
                admit(
                    &mut registry,
                    target,
                    Push::new(target, "denied", &[], None)
                )
                .is_err()
            );
            assert!(ready(&mut registry, target).is_err());
            assert!(next(&mut registry, target).is_none());
        }
    }

    #[test]
    fn pre_ready_overflow_cancels_displaced_receipts_and_resets_before_the_retained_suffix() {
        let (mut registry, id) = document();
        let (ack, mut receipt) = oneshot::channel();
        admit(&mut registry, id, Push::new(id, "first", &[], Some(ack))).unwrap();
        for _ in 1..4096 {
            admit(&mut registry, id, Push::new(id, "old", &[], None)).unwrap();
        }
        assert_eq!(receipt.try_recv(), Err(TryRecvError::Empty));
        for channel in ["after loss", "last"] {
            admit(&mut registry, id, Push::new(id, channel, &[], None)).unwrap();
        }
        assert_eq!(receipt.try_recv(), Err(TryRecvError::Closed));
        let sent = ready(&mut registry, id).unwrap().unwrap();
        assert_eq!(
            sent.into_iter().map(delivered).collect::<Vec<_>>(),
            [
                (1, json!({"stream":"reset"})),
                (1, json!({"channel":"after loss","args":[]})),
                (1, json!({"channel":"last","args":[]})),
            ]
        );
    }

    #[test]
    fn failed_webview_submission_does_not_acknowledge_a_successful_push() {
        let (_, id) = document();
        let (ack, mut receipt) = oneshot::channel();
        let push = Push::new(id, "native", &[], Some(ack));
        let failure = failed("webview ended");
        assert_eq!(push.submit(|_| Err(failure.clone())), Err(failure.clone()));
        assert_eq!(receipt.try_recv(), Ok(Err(failure)));
    }

    #[test]
    fn disk_state_accepts_ordered_names_or_clear_but_never_forwards_paths_or_extra_fields() {
        for files in [json!([]), json!(["z.json", "a.json", "z.json"])] {
            let state = json!({"files":files});
            assert_eq!(disk_state_args(state.clone()), Some([state]));
        }
        for state in [
            json!(null),
            json!({}),
            json!({"files":"a"}),
            json!({"files":[1]}),
            json!({"files":[],"path":"/private/a"}),
            json!({"files":["dir/a"]}),
            json!({"files":["dir\\a"]}),
            json!({"files":["C:secret"]}),
        ] {
            assert!(disk_state_args(state).is_none());
        }
    }
}
