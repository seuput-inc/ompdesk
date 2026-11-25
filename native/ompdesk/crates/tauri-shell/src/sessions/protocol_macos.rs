#![allow(unsafe_code)]

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::panic::AssertUnwindSafe;

use objc2::rc::Retained;
use objc2::runtime::{NSObject, ProtocolObject};
use objc2::{AnyThread, DefinedClass, MainThreadOnly, Message, define_class, msg_send};
use objc2_foundation::{
    MainThreadMarker, NSData, NSError, NSHTTPURLResponse, NSMutableDictionary, NSObjectProtocol,
    NSString, NSURL, NSUUID,
};
use objc2_web_kit::{
    WKURLSchemeHandler, WKURLSchemeTask, WKWebView, WKWebViewConfiguration, WKWebsiteDataStore,
};
use tokio::sync::oneshot;

use super::protocol::{self, Chunk, Request};
thread_local! {
    static NEXT_ID: Cell<u64> = const { Cell::new(1) };
    static TASKS: RefCell<HashMap<u64, Task>> = RefCell::new(HashMap::new());
}

fn next_id() -> u64 {
    NEXT_ID.with(|next| {
        let id = next.get();
        next.set(id.checked_add(1).expect("scheme task identifier exhausted"));
        id
    })
}

enum Phase {
    PendingHead,
    Streaming,
}

struct Task {
    handler: u64,
    key: usize,
    native: Retained<ProtocolObject<dyn WKURLSchemeTask>>,
    url: Retained<NSURL>,
    phase: Phase,
    worker: tauri::async_runtime::JoinHandle<()>,
}

struct HandlerIvars {
    partition: String,
    id: u64,
}

impl Drop for HandlerIvars {
    fn drop(&mut self) {
        let _ = TASKS.try_with(|tasks| {
            let removed = {
                let mut tasks = tasks.borrow_mut();
                let ids: Vec<_> = tasks
                    .iter()
                    .filter_map(|(id, task)| (task.handler == self.id).then_some(*id))
                    .collect();
                ids.into_iter()
                    .filter_map(|id| tasks.remove(&id))
                    .collect::<Vec<_>>()
            };
            for task in removed {
                task.worker.abort();
            }
        });
    }
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = HandlerIvars]
    struct OmpdeskURLSchemeHandler;

    unsafe impl NSObjectProtocol for OmpdeskURLSchemeHandler {}

    unsafe impl WKURLSchemeHandler for OmpdeskURLSchemeHandler {
        #[unsafe(method(webView:startURLSchemeTask:))]
        unsafe fn start(&self, _view: &WKWebView, task: &ProtocolObject<dyn WKURLSchemeTask>) {
            start(self, task);
        }

        #[unsafe(method(webView:stopURLSchemeTask:))]
        unsafe fn stop(&self, _view: &WKWebView, task: &ProtocolObject<dyn WKURLSchemeTask>) {
            let key = task_key(task);
            let active = TASKS.with(|tasks| {
                let mut tasks = tasks.borrow_mut();
                let id = tasks.iter().find_map(|(id, active)| {
                    (active.handler == self.ivars().id && active.key == key).then_some(*id)
                });
                id.and_then(|id| tasks.remove(&id))
            });
            if let Some(active) = active {
                active.worker.abort();
            }
        }
    }
);

fn task_key(task: &ProtocolObject<dyn WKURLSchemeTask>) -> usize {
    std::ptr::from_ref(task).cast::<()>() as usize
}

fn fail(task: &ProtocolObject<dyn WKURLSchemeTask>, message: &str) {
    let domain = NSString::from_str(&format!("OMPdesk protocol: {message}"));
    // SAFETY: Both objects are live on the main thread, and the task is active.
    unsafe {
        let error = NSError::errorWithDomain_code_userInfo(&domain, 1, None);
        task.didFailWithError(&error);
    }
}

fn start(handler: &OmpdeskURLSchemeHandler, task: &ProtocolObject<dyn WKURLSchemeTask>) {
    // SAFETY: WebKit invokes the handler on its owning main thread with a live task.
    let request = unsafe { task.request() };
    let Some(url) = request.URL() else {
        fail(task, "request has no URL");
        return;
    };
    let Some(absolute) = url.absoluteString() else {
        fail(task, "request URL has no absolute string");
        return;
    };
    let Some(scheme) = url.scheme() else {
        fail(task, "request URL has no scheme");
        return;
    };
    let body = if let Some(body) = request.HTTPBody() {
        body.to_vec()
    } else if request.HTTPBodyStream().is_some() {
        fail(task, "streamed request bodies are not supported");
        return;
    } else {
        Vec::new()
    };
    let mut headers = Vec::new();
    if let Some(fields) = request.allHTTPHeaderFields() {
        for key in fields.allKeys().iter() {
            if let Some(value) = fields.objectForKey(&key) {
                headers.push((key.to_string(), value.to_string()));
            }
        }
    }
    let request = Request {
        partition: handler.ivars().partition.clone(),
        scheme: scheme.to_string(),
        url: absolute.to_string(),
        method: request
            .HTTPMethod()
            .map_or_else(|| "GET".to_string(), |v| v.to_string()),
        headers,
        body,
    };
    let id = next_id();
    let worker = tauri::async_runtime::spawn(async move {
        let response = match protocol::open(request).await {
            Ok(response) => response,
            Err(error) => {
                deliver(id, Frame::Fail(error)).await;
                return;
            }
        };
        let protocol::Response {
            status,
            status_text: _,
            headers,
            mut body,
        } = response;
        if !deliver(id, Frame::Head { status, headers }).await {
            return;
        }
        while let Some(chunk) = body.next().await {
            match chunk {
                Ok(bytes) => {
                    if !deliver(id, Frame::Data(bytes)).await {
                        return;
                    }
                }
                Err(error) => {
                    deliver(id, Frame::Fail(error)).await;
                    return;
                }
            }
        }
        deliver(id, Frame::Finish).await;
    });
    TASKS.with(|tasks| {
        tasks.borrow_mut().insert(
            id,
            Task {
                handler: handler.ivars().id,
                key: task_key(task),
                native: task.retain(),
                url,
                phase: Phase::PendingHead,
                worker,
            },
        );
    });
}

enum Frame {
    Head {
        status: u16,
        headers: Vec<(String, String)>,
    },
    Data(Chunk),
    Finish,
    Fail(String),
}

async fn deliver(id: u64, frame: Frame) -> bool {
    let (tx, rx) = oneshot::channel();
    crate::ui::post(move || {
        let active = apply(id, frame);
        let _ = tx.send(active);
    });
    rx.await.unwrap_or(false)
}

fn apply(id: u64, frame: Frame) -> bool {
    match frame {
        Frame::Head { status, headers } => {
            let target = TASKS.with(|tasks| {
                let mut tasks = tasks.borrow_mut();
                let task = tasks.get_mut(&id)?;
                if !matches!(task.phase, Phase::PendingHead) {
                    return None;
                }
                task.phase = Phase::Streaming;
                Some((task.native.clone(), task.url.clone()))
            });
            let Some((task, url)) = target else {
                return false;
            };
            let fields = NSMutableDictionary::new();
            let mut seen = std::collections::HashSet::new();
            for (name, value) in headers {
                if !seen.insert(name.to_ascii_lowercase()) {
                    let _removed = TASKS.with(|tasks| tasks.borrow_mut().remove(&id));
                    fail(
                        &task,
                        &format!("WebKit cannot preserve repeated response header {name}"),
                    );
                    return false;
                }
                fields.insert(&*NSString::from_str(&name), &*NSString::from_str(&value));
            }
            let response = NSHTTPURLResponse::initWithURL_statusCode_HTTPVersion_headerFields(
                NSHTTPURLResponse::alloc(),
                &url,
                status as isize,
                Some(&NSString::from_str("HTTP/1.1")),
                Some(&fields),
            );
            let Some(response) = response else {
                let _removed = TASKS.with(|tasks| tasks.borrow_mut().remove(&id));
                fail(&task, "could not construct HTTP response");
                return false;
            };
            // SAFETY: The task was active at the last main-thread check; no callback ran since it.
            unsafe { task.didReceiveResponse(&response) };
            true
        }
        Frame::Data(bytes) => {
            let task = TASKS.with(|tasks| {
                let tasks = tasks.borrow();
                let task = tasks.get(&id)?;
                matches!(task.phase, Phase::Streaming).then(|| task.native.clone())
            });
            let Some(task) = task else { return false };
            let data = NSData::with_bytes(bytes.as_slice());
            // SAFETY: The task is active and its response was delivered on this thread.
            unsafe { task.didReceiveData(&data) };
            // Return relay credit after WebKit accepted the bytes, not while the UI callback is queued.
            // WebKit exposes no consumption credit; it can buffer after this callback returns.
            drop(bytes);
            true
        }
        Frame::Finish | Frame::Fail(_) => {
            let task = TASKS.with(|tasks| tasks.borrow_mut().remove(&id));
            let Some(task) = task else { return false };
            match frame {
                Frame::Finish if matches!(task.phase, Phase::Streaming) => {
                    // SAFETY: Removing the active task makes this its only terminal callback.
                    unsafe { task.native.didFinish() };
                }
                Frame::Fail(error) => fail(&task.native, &error),
                _ => fail(&task.native, "protocol ended before its response"),
            }
            false
        }
    }
}

pub fn configuration(
    partition: &str,
    identifier: [u8; 16],
    schemes: &[String],
) -> Result<Retained<WKWebViewConfiguration>, String> {
    let mtm = MainThreadMarker::new().ok_or("WebKit configuration requires the main thread")?;
    if !objc2::available!(macos = 14.0) {
        return Err("persistent WebKit partition stores require macOS 14 or newer".into());
    }
    if identifier == [0; 16] {
        return Err("WebKit data store identifier cannot be zero".into());
    }
    // SAFETY: Construction and registration are confined to the main thread. Exceptions are
    // converted to errors because WebKit rejects built-in and duplicate scheme registrations.
    objc2::exception::catch(AssertUnwindSafe(|| unsafe {
        let config = WKWebViewConfiguration::new(mtm);
        let uuid = NSUUID::from_bytes(identifier);
        let store = WKWebsiteDataStore::dataStoreForIdentifier(&uuid, mtm);
        config.setWebsiteDataStore(&store);
        let handler = mtm
            .alloc::<OmpdeskURLSchemeHandler>()
            .set_ivars(HandlerIvars {
                partition: partition.to_string(),
                id: next_id(),
            });
        let handler: Retained<OmpdeskURLSchemeHandler> = msg_send![super(handler), init];
        let handler = ProtocolObject::from_ref(&*handler);
        for scheme in schemes {
            if scheme.eq_ignore_ascii_case("app") {
                continue;
            }
            config.setURLSchemeHandler_forURLScheme(Some(handler), &NSString::from_str(scheme));
        }
        config
    }))
    .map_err(|_| "WebKit rejected the data store or custom scheme configuration".into())
}
