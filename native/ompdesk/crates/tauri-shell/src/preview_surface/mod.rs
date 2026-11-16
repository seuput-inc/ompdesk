//! Native child compositor for an existing Preview view and the same retained BrowserPage frames.
//! The caller owns UI dispatch, the view registry, document epochs and browser effects.
//! Bounds, input coordinates and supplied caret/AX rectangles use surface-local DIP.
//! `FramePublisher::submit` retains only the newest PNG; `schedule_present` must enqueue
//! a UI-thread `Surface::drain_frame`, not call it reentrantly. Accepted frames release
//! their original Page receipt exactly once, including hide, supersede and disposal.
//! Only `Surface::set_document` advances the caller's captured view/wc generation.

mod model;
mod shared;

#[cfg(target_os = "macos")]
mod mac;
#[cfg(windows)]
mod windows;

pub use model::*;
pub use shared::FramePublisher;
#[cfg(target_os = "macos")]
pub use mac::{NativeParent, Surface};
#[cfg(windows)]
pub use windows::{NativeParent, Surface};

#[cfg(all(test, target_os = "macos"))]
pub(crate) use mac::run_native_input_fixture;
