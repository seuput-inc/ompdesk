use crate::host::Call;

#[path = "../../shell/src/clipboard.rs"]
pub mod clipboard;
#[path = "diagnostic_logs/mod.rs"]
pub mod diagnostic_logs;
#[path = "../../shell/src/power.rs"]
pub mod power;
#[path = "../../shell/src/screen.rs"]
pub mod screen;
#[path = "../../shell/src/shellops.rs"]
pub mod shellops;
#[path = "../../shell/src/system.rs"]
pub mod system;
#[path = "watchdog/mod.rs"]
pub mod watchdog;

pub fn dispatch(call: Call) -> Option<Call> {
    let handler: fn(Call) = match call.method.split_once('.').map(|(namespace, _)| namespace) {
        _ if matches!(
            call.method.as_str(),
            "system.watchFolderPrompts" | "system.unwatchFolderPrompts"
        ) =>
        {
            crate::folder_prompts::handle
        }
        Some("clipboard") => clipboard::handle,
        Some("power") => power::handle,
        Some("screen") => screen::handle,
        Some("shell") => shellops::handle,
        Some("system") => system::handle,
        Some("theme") => crate::theme::handle,
        _ => return Some(call),
    };
    handler(call);
    None
}
