//! Native desktop chrome uses the same OS backends and host protocol as the CEF shell, without its window registry.

use crate::host::Call;

#[path = "../../shell/src/dialog.rs"]
pub mod dialog;
#[path = "../../shell/src/menu.rs"]
pub mod menu;
#[path = "../../shell/src/notification.rs"]
pub mod notification;
#[path = "../../shell/src/tray.rs"]
pub mod tray;

pub fn dispatch(call: Call) -> Option<Call> {
    let handler: fn(Call) = match call.method.split_once('.').map(|(namespace, _)| namespace) {
        Some("menu") => menu::handle,
        Some("tray") => tray::handle,
        Some("notification") => notification::handle,
        Some("dialog") => dialog::handle,
        _ => return Some(call),
    };
    handler(call);
    None
}
