mod sys;

use std::{marker::PhantomData, rc::Rc, sync::Arc};

use super::{
    model::{
        AxSnapshot, Bounds, Consumer, FrameDisposition, SurfaceError, SurfaceKey, TextInputState,
    },
    shared::{FramePublisher, Shared},
};
use objc2::{MainThreadMarker, rc::Retained};

pub struct NativeParent(sys::Parent);

impl NativeParent {
    pub fn from_tauri_window(window: &tauri::WebviewWindow) -> Result<Self, SurfaceError> {
        sys::Parent::from_tauri_window(window).map(Self)
    }
}

pub struct Surface {
    parent: NativeParent,
    view: Retained<sys::PreviewView>,
    shared: Arc<Shared>,
    _main_thread: PhantomData<Rc<()>>,
}

impl Surface {
    pub fn new(
        parent: NativeParent,
        key: SurfaceKey,
        bounds: Bounds,
        consumer: Arc<dyn Consumer>,
    ) -> Result<Self, SurfaceError> {
        MainThreadMarker::new().ok_or(SurfaceError::WrongThread)?;
        let shared = Shared::new(key, bounds, consumer)?;
        let view = parent.0.attach(bounds, Arc::clone(&shared))?;
        Ok(Self {
            parent,
            view,
            shared,
            _main_thread: PhantomData,
        })
    }

    pub fn key(&self) -> SurfaceKey {
        self.shared.key()
    }
    pub fn publisher(&self) -> FramePublisher {
        self.shared.publisher()
    }

    pub fn set_document(&mut self, key: SurfaceKey) -> Result<(), SurfaceError> {
        MainThreadMarker::new().ok_or(SurfaceError::WrongThread)?;
        let result = self.shared.set_document(key);
        if self.shared.key() == key {
            self.view.clear_document();
        }
        result
    }

    pub fn set_bounds(&mut self, bounds: Bounds) -> Result<(), SurfaceError> {
        MainThreadMarker::new().ok_or(SurfaceError::WrongThread)?;
        self.shared.set_bounds(bounds)?;
        self.parent.0.set_bounds(&self.view, bounds)
    }

    pub fn set_visible(&mut self, visible: bool) -> Result<(), SurfaceError> {
        MainThreadMarker::new().ok_or(SurfaceError::WrongThread)?;
        self.shared.set_visible(visible)?;
        self.view.set_visible(visible)?;
        if visible {
            self.drain_frame()?;
        }
        Ok(())
    }

    pub fn focus(&mut self) -> Result<(), SurfaceError> {
        self.shared.check()?;
        self.parent.0.focus(&self.view)
    }

    pub fn set_text_input_state(&mut self, state: TextInputState) -> Result<(), SurfaceError> {
        MainThreadMarker::new().ok_or(SurfaceError::WrongThread)?;
        self.shared.set_text_input_state(state)?;
        self.view.update_text_input();
        Ok(())
    }

    pub fn set_accessibility(&mut self, snapshot: Arc<AxSnapshot>) -> Result<(), SurfaceError> {
        MainThreadMarker::new().ok_or(SurfaceError::WrongThread)?;
        self.shared.set_accessibility(snapshot)?;
        self.view.update_accessibility();
        Ok(())
    }

    pub fn drain_frame(&mut self) -> Result<(), SurfaceError> {
        MainThreadMarker::new().ok_or(SurfaceError::WrongThread)?;
        let Some(pending) = self.shared.take_frame()? else {
            return Ok(());
        };
        if !self.shared.is_visible() {
            return self.shared.finish_frame(pending, FrameDisposition::Hidden);
        }
        let decoded = sys::decode_frame(&pending.frame)
            .and_then(|image| self.view.install_image(&image, &pending.frame));
        match decoded {
            Ok(()) => self
                .shared
                .finish_frame(pending, FrameDisposition::Presented),
            Err(error) => {
                self.shared
                    .finish_frame(pending, FrameDisposition::DecodeFailed)?;
                Err(error)
            }
        }
    }

    pub fn dispose(&mut self) -> Result<(), SurfaceError> {
        MainThreadMarker::new().ok_or(SurfaceError::WrongThread)?;
        let closed = self.shared.close();
        let detached = self.view.detach();
        closed.and(detached)
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        if let Err(error) = self.dispose() {
            self.shared.report_error(error);
        }
    }
}
