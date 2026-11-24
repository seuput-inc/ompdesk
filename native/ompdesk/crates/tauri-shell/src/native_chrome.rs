//! Native desktop chrome uses the same OS backends and host protocol as the CEF shell, without its window registry.
//! The application menu and the tray are the shell's own (app_menu.rs, tray.rs); Node asks only for popups.

use crate::host::Call;

#[path = "../../shell/src/dialog.rs"]
pub mod dialog;
#[path = "../../shell/src/menu.rs"]
pub mod menu;
#[path = "../../shell/src/notification.rs"]
pub mod notification;

pub fn dispatch(call: Call) -> Option<Call> {
    let handler: fn(Call) = match call.method.as_str() {
        "menu.popup" => menu::handle,
        method => match method.split_once('.').map(|(namespace, _)| namespace) {
            Some("notification") => notification::handle,
            Some("dialog") => dialog::handle,
            _ => return Some(call),
        },
    };
    handler(call);
    None
}
