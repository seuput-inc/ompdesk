mod sys;

use std::sync::Arc;

use super::model::{
    AxSnapshot, Bounds, Consumer, FrameDisposition, SurfaceError, SurfaceKey, TextInputState,
};
use super::shared::{FramePublisher, Shared};

pub struct NativeParent(sys::Parent);

impl NativeParent {
    pub fn from_tauri_window(window: &tauri::WebviewWindow) -> Result<Self, SurfaceError> {
        let hwnd = window
            .hwnd()
            .map_err(|error| SurfaceError::Native(error.to_string()))?;
        sys::Parent::from_raw(hwnd.0).map(Self)
    }

    #[cfg(test)]
    pub fn from_hwnd(hwnd: isize) -> Result<Self, SurfaceError> {
        sys::Parent::from_raw(hwnd as *mut std::ffi::c_void).map(Self)
    }
}

pub struct Surface {
    shared: Arc<Shared>,
    child: sys::Child,
}

impl Surface {
    pub fn new(
        parent: NativeParent,
        key: SurfaceKey,
        bounds: Bounds,
        consumer: Arc<dyn Consumer>,
    ) -> Result<Self, SurfaceError> {
        let shared = Shared::new(key, bounds, consumer)?;
        let child = sys::Child::new(&parent.0, bounds, shared.clone())?;
        child.set_visible(true)?;
        Ok(Self { shared, child })
    }

    pub fn key(&self) -> SurfaceKey {
        self.shared.key()
    }
    pub fn publisher(&self) -> FramePublisher {
        self.shared.publisher()
    }

    pub fn set_document(&mut self, key: SurfaceKey) -> Result<(), SurfaceError> {
        self.child.check()?;
        self.shared.check()?;
        let current = self.shared.key();
        if key.view != current.view || key.wc != current.wc || key.generation <= current.generation
        {
            return Err(SurfaceError::StaleGeneration);
        }
        self.child.cancel_ime()?;
        self.shared.set_document(key)
    }

    pub fn set_bounds(&mut self, bounds: Bounds) -> Result<(), SurfaceError> {
        self.shared.check()?;
        self.child.set_bounds(bounds)?;
        self.shared.set_bounds(bounds)
    }

    pub fn set_visible(&mut self, visible: bool) -> Result<(), SurfaceError> {
        self.shared.check()?;
        if !visible {
            self.child.cancel_ime()?;
        }
        self.child.set_visible(visible)?;
        self.shared.set_visible(visible)?;
        if visible {
            self.drain_frame()?;
        }
        Ok(())
    }

    pub fn focus(&mut self) -> Result<(), SurfaceError> {
        self.shared.check()?;
        self.child.focus()
    }

    pub fn set_text_input_state(&mut self, state: TextInputState) -> Result<(), SurfaceError> {
        self.child.check()?;
        self.shared.set_text_input_state(state.clone())?;
        self.child.set_text_input_state(&state)
    }

    pub fn set_accessibility(&mut self, snapshot: Arc<AxSnapshot>) -> Result<(), SurfaceError> {
        self.child.check()?;
        self.shared.set_accessibility(snapshot)
    }

    pub fn drain_frame(&mut self) -> Result<(), SurfaceError> {
        self.child.check()?;
        if let Some(pending) = self.shared.take_frame()? {
            let result = self.child.present(&pending.frame);
            let disposition = match &result {
                Ok(()) => FrameDisposition::Presented,
                Err(SurfaceError::Disposed | SurfaceError::StaleGeneration) => {
                    FrameDisposition::Disposed
                }
                Err(_) => FrameDisposition::DecodeFailed,
            };
            self.shared.finish_frame(pending, disposition)?;
            result?;
        }
        Ok(())
    }

    pub fn dispose(&mut self) -> Result<(), SurfaceError> {
        self.child.cancel_ime()?;
        self.child.destroy()?;
        self.shared.close()
    }
}
