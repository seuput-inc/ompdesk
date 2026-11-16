use super::{Entry, NativeTask, Pages};
use crate::{preview_surface as native, registry::Kind, runtime};
use native::{
    Bounds, Consumer, FrameDisposition, FramePublisher, Surface, SurfaceError, SurfaceKey,
};
use shell_core::wire::WireError;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{Arc, Weak};
use tauri::Manager;
use tokio::sync::oneshot;

thread_local! {
    static VIEWS: RefCell<HashMap<u64,Surface>>=RefCell::new(HashMap::new());
}
pub(super) fn key(wc: u64) -> Result<SurfaceKey, SurfaceError> {
    let registry = runtime().registry.lock().expect("registry");
    let page = registry
        .page(wc)
        .filter(|page| page.state == crate::registry::PageState::Live)
        .ok_or(SurfaceError::Disposed)?;
    let Kind::PreviewView { view, .. } = page.kind else {
        return Err(SurfaceError::Invalid("page is not a native view".into()));
    };
    Ok(SurfaceKey {
        view,
        wc,
        generation: page.identity.generation,
    })
}
fn current(key: SurfaceKey) -> Result<(), SurfaceError> {
    if self::key(key.wc)? == key {
        Ok(())
    } else {
        Err(SurfaceError::StaleGeneration)
    }
}
fn wire(error: SurfaceError) -> WireError {
    WireError::new("native-surface", error.to_string())
}
async fn ui<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, SurfaceError> + Send + 'static,
) -> Result<T, WireError> {
    let (send, receive) = oneshot::channel();
    runtime()
        .app
        .run_on_main_thread(move || {
            let _ = send.send(work());
        })
        .map_err(crate::failed)?;
    receive.await.map_err(crate::failed)?.map_err(wire)
}
struct Effects {
    pages: Weak<Pages>,
    entry: Weak<Entry>,
}
impl Consumer for Effects {
    fn schedule_present(&self, key: SurfaceKey) -> Result<(), SurfaceError> {
        current(key)?;
        runtime()
            .app
            .run_on_main_thread(move || {
                let result = current(key).and_then(|()| {
                    VIEWS.with(|views| {
                        let mut views = views.borrow_mut();
                        let surface = views.get_mut(&key.view).ok_or(SurfaceError::Disposed)?;
                        if surface.key() != key {
                            return Err(SurfaceError::StaleGeneration);
                        }
                        surface.drain_frame()
                    })
                });
                if let Err(error) = result {
                    failed(key, error);
                }
            })
            .map_err(|error| SurfaceError::Native(error.to_string()))
    }
    fn presented(
        &self,
        key: SurfaceKey,
        ack: i64,
        disposition: FrameDisposition,
    ) -> Result<(), SurfaceError> {
        let entry = self.entry.upgrade().ok_or(SurfaceError::Disposed)?;
        let owned = entry
            .surface_acks
            .lock()
            .expect("native frame acknowledgements")
            .remove(&(key.generation, ack));
        if !owned {
            return Err(SurfaceError::StaleGeneration);
        }
        if disposition == FrameDisposition::DecodeFailed {
            failed(
                key,
                SurfaceError::Native("native Preview PNG decode failed".into()),
            );
        }
        let page = Arc::clone(&entry.page);
        let (done, finished) = oneshot::channel();
        {
            let mut tasks = entry
                .surface_ack_tasks
                .lock()
                .expect("native frame ACK tasks");
            tasks.retain_mut(|task| {
                matches!(task.try_recv(), Err(oneshot::error::TryRecvError::Empty))
            });
            tasks.push(finished);
        }
        tauri::async_runtime::spawn(async move {
            if let Err(error) = page.ack_frame(ack).await {
                crate::log::log(
                    "preview.frame.ack",
                    serde_json::json!({"error":error.to_string()}),
                );
            }
            let _ = done.send(());
        });
        Ok(())
    }
    fn input(&self, key: SurfaceKey, input: native::Input) -> Result<(), SurfaceError> {
        current(key)?;
        runtime().preview.native(NativeTask::Input { key, input })
    }
    fn accessibility(
        &self,
        key: SurfaceKey,
        generation: u64,
        target: native::AxTarget,
        action: native::AxAction,
    ) -> Result<(), SurfaceError> {
        current(key)?;
        if generation != key.generation {
            return Err(SurfaceError::StaleGeneration);
        }
        runtime().preview.native(NativeTask::Accessibility {
            key,
            generation,
            target,
            action,
        })
    }
    fn text_query(
        &self,
        key: SurfaceKey,
        generation: u64,
        node: native::AxTarget,
        query: native::TextQuery,
    ) -> Result<native::TextReply, SurfaceError> {
        current(key)?;
        if generation != key.generation {
            return Err(SurfaceError::StaleGeneration);
        }
        let pages = self.pages.upgrade().ok_or(SurfaceError::Disposed)?;
        let entry = self.entry.upgrade().ok_or(SurfaceError::Disposed)?;
        let snapshot = entry
            .ax_snapshot
            .lock()
            .expect("native AX snapshot")
            .clone()
            .filter(|snapshot| snapshot.key == key && snapshot.generation == generation)
            .ok_or(SurfaceError::StaleGeneration)?;
        let browser = pages.browser.get().cloned().ok_or(SurfaceError::Disposed)?;
        let sessions = super::iframe_sessions(&pages, key.wc);
        let zoom = runtime()
            .registry
            .lock()
            .expect("registry")
            .page(key.wc)
            .map(|page| page.zoom)
            .ok_or(SurfaceError::Disposed)?;
        let mutating = matches!(&query, native::TextQuery::ScrollIntoView { .. });
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let job = tauri::async_runtime::spawn(async move {
            let result = async {
                current(key)?;
                let reply = super::frame_scope::text_query(
                    &browser,
                    &entry.page.session_id,
                    &sessions,
                    &snapshot,
                    node,
                    query,
                    zoom,
                )
                .await
                .map_err(|error| SurfaceError::Consumer(error.to_string()))?;
                current(key)?;
                Ok(reply)
            }
            .await;
            let _ = send.send(result);
        });
        if mutating {
            receive.recv().map_err(|error| {
                SurfaceError::Consumer(format!("native text query did not complete: {error}"))
            })?
        } else {
            match receive.recv_timeout(std::time::Duration::from_secs(2)) {
                Ok(result) => result,
                Err(error) => {
                    job.abort();
                    Err(SurfaceError::Consumer(format!(
                        "native text query did not complete: {error}"
                    )))
                }
            }
        }
    }
    fn failed(&self, key: SurfaceKey, error: SurfaceError) {
        failed(key, error);
    }
}
fn failed(key: SurfaceKey, error: SurfaceError) {
    if current(key).is_ok() {
        let _ = runtime().preview.native(NativeTask::Failure {
            key,
            message: error.to_string(),
        });
    }
}
pub(super) async fn attach(
    pages: Arc<Pages>,
    entry: Arc<Entry>,
    key: SurfaceKey,
    win: u64,
    bounds: Bounds,
    visible: bool,
) -> Result<FramePublisher, WireError> {
    ui(move || {
        current(key)?;
        let label = runtime()
            .registry
            .lock()
            .expect("registry")
            .by_window(win)
            .filter(|page| page.kind == Kind::App && page.state == crate::registry::PageState::Live)
            .map(|page| page.label.clone())
            .ok_or(SurfaceError::Disposed)?;
        let window = runtime()
            .app
            .get_webview_window(&label)
            .ok_or(SurfaceError::Disposed)?;
        let parent = native::NativeParent::from_tauri_window(&window)?;
        VIEWS.with(|views| {
            let mut views = views.borrow_mut();
            if views.get(&key.view).is_some_and(|old| old.key() != key) {
                return Err(SurfaceError::StaleGeneration);
            }
            if let Some(mut old) = views.remove(&key.view) {
                old.dispose()?;
            }
            let mut surface = Surface::new(
                parent,
                key,
                bounds,
                Arc::new(Effects {
                    pages: Arc::downgrade(&pages),
                    entry: Arc::downgrade(&entry),
                }),
            )?;
            surface.set_visible(visible)?;
            let result = {
                let mut registry = runtime().registry.lock().expect("registry");
                if !registry.page(key.wc).is_some_and(|page| {
                    page.state == crate::registry::PageState::Live
                        && page.identity.generation == key.generation
                        && matches!(page.kind,Kind::PreviewView{view,..} if view==key.view)
                }) {
                    Err(SurfaceError::StaleGeneration)
                } else {
                    registry
                        .set_parent(key.wc, Some(win))
                        .map_err(|error| SurfaceError::Invalid(error.into()))
                }
            };
            if let Err(error) = result {
                surface.dispose()?;
                return Err(error);
            }
            let publisher = surface.publisher();
            views.insert(key.view, surface);
            Ok(publisher)
        })
    })
    .await
}
pub(super) async fn synchronize(key: SurfaceKey) -> Result<Option<FramePublisher>, WireError> {
    ui(move || {
        current(key)?;
        VIEWS.with(|views| {
            let mut views = views.borrow_mut();
            let Some(surface) = views.get_mut(&key.view) else {
                return Ok(None);
            };
            if surface.key() != key {
                surface.set_document(key)?;
            }
            Ok(Some(surface.publisher()))
        })
    })
    .await
}
pub(super) async fn bounds(key: SurfaceKey, bounds: Bounds) -> Result<(), WireError> {
    ui(move || {
        current(key)?;
        VIEWS.with(|views| {
            let mut views = views.borrow_mut();
            let surface = views.get_mut(&key.view).ok_or(SurfaceError::Disposed)?;
            if surface.key() != key {
                return Err(SurfaceError::StaleGeneration);
            }
            surface.set_bounds(bounds)?;
            Ok(())
        })
    })
    .await
}
pub(super) async fn visible(key: SurfaceKey, visible: bool) -> Result<(), WireError> {
    ui(move || {
        current(key)?;
        VIEWS.with(|views| {
            let mut views = views.borrow_mut();
            let surface = views.get_mut(&key.view).ok_or(SurfaceError::Disposed)?;
            if surface.key() != key {
                return Err(SurfaceError::StaleGeneration);
            }
            surface.set_visible(visible)?;
            Ok(())
        })
    })
    .await
}
pub(super) async fn focus(key: SurfaceKey) -> Result<(), WireError> {
    ui(move || {
        current(key)?;
        VIEWS.with(|views| {
            let mut views = views.borrow_mut();
            let surface = views.get_mut(&key.view).ok_or(SurfaceError::Disposed)?;
            if surface.key() != key {
                return Err(SurfaceError::StaleGeneration);
            }
            surface.focus()
        })
    })
    .await
}
pub(super) async fn text(state: native::TextInputState) -> Result<(), WireError> {
    ui(move || {
        let key = state.key;
        current(key)?;
        VIEWS.with(|views| {
            let mut views = views.borrow_mut();
            let surface = views.get_mut(&key.view).ok_or(SurfaceError::Disposed)?;
            if surface.key() != key {
                return Err(SurfaceError::StaleGeneration);
            }
            surface.set_text_input_state(state)
        })
    })
    .await
}
pub(super) async fn accessibility(snapshot: Arc<native::AxSnapshot>) -> Result<(), WireError> {
    ui(move || {
        let key = snapshot.key;
        current(key)?;
        VIEWS.with(|views| {
            let mut views = views.borrow_mut();
            let surface = views.get_mut(&key.view).ok_or(SurfaceError::Disposed)?;
            if surface.key() != key {
                return Err(SurfaceError::StaleGeneration);
            }
            surface.set_accessibility(snapshot)
        })
    })
    .await
}
pub(super) async fn dispose(key: SurfaceKey) -> Result<(), WireError> {
    ui(move || {
        let result = VIEWS.with(|views| {
            let mut views = views.borrow_mut();
            if views
                .get(&key.view)
                .is_some_and(|surface| surface.key() != key)
            {
                return Err(SurfaceError::StaleGeneration);
            }
            Ok(views.remove(&key.view))
        })?;
        let disposed = if let Some(mut surface) = result {
            surface.dispose()
        } else {
            Ok(())
        };
        {
            let mut registry = runtime().registry.lock().expect("registry");
            if registry.page(key.wc).is_some_and(|page| {
                page.state == crate::registry::PageState::Live
                    && matches!(page.kind,Kind::PreviewView{view,..} if view==key.view)
            }) {
                registry
                    .set_parent(key.wc, None)
                    .map_err(|error| SurfaceError::Invalid(error.into()))?;
            }
        }
        disposed
    })
    .await
}
