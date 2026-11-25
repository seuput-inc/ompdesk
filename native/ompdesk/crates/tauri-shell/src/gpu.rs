//! What the app asked of the GPU at `app.init` (`disableHardwareAcceleration`: the crash fallback or `--disable-gpu`),
//! and the `app.getGPUInfo` answer that `softwareCompositing()` (src/main/gpu-fallback.ts) reads. Without an answer
//! main reads an empty feature table as software compositing and holds every cue of the page to a slow clock.

use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, Ordering};

static DISABLED: AtomicBool = AtomicBool::new(false);

pub fn init(params: &Value) {
    DISABLED.store(
        params["disableHardwareAcceleration"].as_bool() == Some(true),
        Ordering::SeqCst,
    );
}

pub fn disabled() -> bool {
    DISABLED.load(Ordering::SeqCst)
}

/// The system WebView does not report its own compositing state: it composites in hardware unless the app turned the
/// GPU off for it.
pub fn info() -> Value {
    #[cfg(windows)]
    let devices = shell_core::sys::system::gpu_adapters();
    #[cfg(not(windows))]
    let devices: Vec<Value> = Vec::new();
    let compositing = if disabled() {
        "disabled_software"
    } else {
        "enabled"
    };
    json!({
        "info": { "gpuDevice": devices },
        "features": { "gpu_compositing": compositing, "webgl": compositing, "rasterization": compositing },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_init_flag_decides_the_compositing_the_answer_reports() {
        init(&json!({}));
        assert_eq!(info()["features"]["gpu_compositing"], "enabled");
        init(&json!({"disableHardwareAcceleration": true}));
        assert_eq!(info()["features"]["gpu_compositing"], "disabled_software");
        init(&json!({"disableHardwareAcceleration": false}));
        assert_eq!(info()["features"]["gpu_compositing"], "enabled");
    }
}
