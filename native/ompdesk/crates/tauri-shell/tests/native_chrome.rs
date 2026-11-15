#![allow(dead_code)]

#[path = "../../shell/src/host.rs"]
mod host;
#[path = "../../shell/src/log.rs"]
mod log;
#[path = "../src/native_chrome.rs"]
mod native_chrome;
use native_chrome::menu;

use std::io::{BufReader, Write};
use std::sync::{LazyLock, Mutex, OnceLock, mpsc};
use std::time::Duration;

use serde_json::{Value, json};
use shell_core::conn::{self, Listener};
use shell_core::wire::{self, Incoming};

mod ui {
    use super::*;
    type Job = Box<dyn FnOnce() + Send>;
    static QUEUE: LazyLock<(mpsc::Sender<Job>, Mutex<mpsc::Receiver<Job>>)> = LazyLock::new(|| {
        let (tx, rx) = mpsc::channel();
        (tx, Mutex::new(rx))
    });
    pub fn post(work: impl FnOnce() + Send + 'static) {
        QUEUE.0.send(Box::new(work)).unwrap();
    }
    pub fn run(work: impl FnOnce() + Send + 'static) {
        post(work);
    }
    pub fn next() {
        let job = QUEUE
            .1
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(5))
            .unwrap();
        job();
    }
    pub fn window_handle(id: u64) -> Option<isize> {
        (id == 1).then_some(0)
    }
}

fn request(call: host::Call) {
    if let Some(call) = native_chrome::dispatch(call) {
        call.unsupported();
    }
}

fn answer(reader: &mut BufReader<conn::Conn>, expected: u64) -> Result<Value, wire::WireError> {
    match wire::read_frame(reader).unwrap().unwrap() {
        Incoming::Answer { id, result, bin } => {
            assert_eq!(id, expected);
            assert!(bin.is_none());
            result
        }
        other => panic!("expected answer, got {other:?}"),
    }
}

#[test]
fn native_requests_preserve_validation_gone_and_precancelled_answers() {
    // A deterministic scheduler lets cancellation reach the real backend before its UI work starts.
    #[cfg(windows)]
    let name = format!(r"\\.\pipe\ompdesk-chrome-test-{}", std::process::id());
    #[cfg(unix)]
    let name = std::env::temp_dir()
        .join(format!("c{}", std::process::id()))
        .to_string_lossy()
        .into_owned();
    let listener = Listener::bind(&name).unwrap();
    let (closed_tx, closed_rx) = mpsc::channel();
    static CLOSED: OnceLock<mpsc::Sender<()>> = OnceLock::new();
    CLOSED.set(closed_tx).unwrap();
    host::serve(
        listener,
        "test-token".into(),
        json!({}),
        host::Handlers {
            request,
            event: |_, _, _| {},
            closed: || CLOSED.get().unwrap().send(()).unwrap(),
        },
    );
    let mut client = conn::connect(&name).unwrap();
    let mut reader = BufReader::new(client.try_clone().unwrap());
    client
        .write_all(&wire::request(
            1,
            "hello",
            json!({"token":"test-token"}),
            None,
        ))
        .unwrap();
    assert_eq!(answer(&mut reader, 1).unwrap()["protocol"], 1);

    for (id, method, params, code, queued) in [
        (2, "menu.popup", json!({}), "invalid", false),
        (
            3,
            "menu.popup",
            json!({"menuId":1,"template":[],"winId":2}),
            "gone",
            true,
        ),
        (
            4,
            "tray.op",
            json!({"trayId":99,"op":"destroy"}),
            "gone",
            true,
        ),
        (5, "notification.close", json!({}), "invalid", false),
        (6, "dialog.unknown", json!({}), "unsupported", false),
    ] {
        client
            .write_all(&wire::request(id, method, params, None))
            .unwrap();
        if queued {
            ui::next();
        }
        assert_eq!(answer(&mut reader, id).unwrap_err().code, code);
    }

    client
        .write_all(&wire::request(
            7,
            "menu.popup",
            json!({
                "menuId":1,"template":[],"winId":1
            }),
            None,
        ))
        .unwrap();
    ui::next();
    assert_eq!(answer(&mut reader, 7).unwrap(), json!({"itemId":null}));

    client.write_all(&wire::request(8, "dialog.messageBox", json!({
        "winId":2,"options":{"buttons":["Continue","Back"],"cancelId":1,"checkboxChecked":true}
    }), None)).unwrap();
    client.write_all(&wire::cancel(8)).unwrap();
    // The reader answers this only after it has processed the preceding cancellation.
    client
        .write_all(&wire::request(9, "test.barrier", json!({}), None))
        .unwrap();
    assert_eq!(answer(&mut reader, 9).unwrap_err().code, "unsupported");
    ui::next();
    assert_eq!(
        answer(&mut reader, 8).unwrap(),
        json!({"response":1,"checkboxChecked":true})
    );

    drop(client);
    drop(reader);
    closed_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    #[cfg(unix)]
    std::fs::remove_file(name).unwrap();
}
