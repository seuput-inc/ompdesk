use crate::host::Call;

#[path = "../../shell/src/clipboard.rs"]
pub mod clipboard;
#[path = "../../shell/src/power.rs"]
pub mod power;
#[path = "../../shell/src/screen.rs"]
pub mod screen;
#[path = "../../shell/src/shellops.rs"]
pub mod shellops;
#[path = "../../shell/src/shortcut.rs"]
pub mod shortcut;
#[path = "../../shell/src/system.rs"]
pub mod system;

pub fn dispatch(call: Call) -> Option<Call> {
    let handler: fn(Call) = match call.method.split_once('.').map(|(namespace, _)| namespace) {
        Some("clipboard") => clipboard::handle,
        Some("power") => power::handle,
        Some("screen") => screen::handle,
        Some("shell") => shellops::handle,
        Some("shortcut") => shortcut::handle,
        Some("system") => system::handle,
        Some("theme") => crate::theme::handle,
        _ => return Some(call),
    };
    handler(call);
    None
}
