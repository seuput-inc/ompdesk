use crate::{host::Call, runtime, update_auth_files};
use serde_json::Value;
use std::io;

pub(super) fn dispatch(call: Call) -> Option<Call> {
    match call.method.as_str() {
        "updateAuth.read" | "updateAuth.status" | "updateAuth.save" | "updateAuth.drop"
        | "updateAuth.clear" => {
            tauri::async_runtime::spawn_blocking(move || auth(call));
        }
        #[cfg(target_os = "macos")]
        "app.stageUpdateBundle" => {
            tauri::async_runtime::spawn_blocking(move || stage(call));
        }
        #[cfg(target_os = "macos")]
        "app.updateDestination" | "app.sweepUpdateFiles" => {
            tauri::async_runtime::spawn_blocking(move || {
                let host = runtime();
                match crate::update_files::handle(
                    &call.method,
                    &call.params,
                    &host.downloads,
                    &host.user_data.join("updates"),
                ) {
                    Ok(value) => call.ok(value),
                    Err(error) => call.err("failed", error),
                }
            });
        }
        _ => return Some(call),
    }
    None
}

fn auth(call: Call) {
    let profile = &runtime().user_data;
    let result = match call.method.as_str() {
        "updateAuth.read" => match update_auth_files::read(profile) {
            Ok(Some(bytes)) => return call.ok_bin(Value::Bool(true), &bytes),
            Ok(None) => return call.ok(Value::Bool(false)),
            Err(error) => Err(error),
        },
        "updateAuth.status" => return call.ok(update_auth_files::status(profile)),
        "updateAuth.save" => match call.bin.as_deref() {
            Some(bytes) if !bytes.is_empty() => update_auth_files::save(profile, bytes),
            _ => return call.err("invalid", "missing encrypted update token"),
        },
        "updateAuth.drop" => update_auth_files::drop_token(profile),
        "updateAuth.clear" => update_auth_files::clear(profile),
        _ => return call.unsupported(),
    };
    match result {
        Ok(()) => call.ok(Value::Null),
        Err(error) => {
            let code = match error.kind() {
                io::ErrorKind::PermissionDenied => "EACCES",
                io::ErrorKind::NotFound => "ENOENT",
                io::ErrorKind::IsADirectory => "EISDIR",
                io::ErrorKind::NotADirectory => "ENOTDIR",
                io::ErrorKind::StorageFull => "ENOSPC",
                _ => "EIO",
            };
            call.err(code, error.to_string());
        }
    }
}

#[cfg(target_os = "macos")]
fn stage(call: Call) {
    use std::path::{Path, PathBuf};
    let host = runtime();
    let bundle = if host.packaged {
        std::env::current_exe()
            .ok()
            .and_then(|exe| shell_core::startup::mac_bundle_paths(&exe).map(|(bundle, _)| bundle))
    } else {
        std::env::var_os("OMP_DEV_UPDATE_BUNDLE").map(PathBuf::from)
    };
    let (Some(bundle), Some(version), Some(dmg)) = (
        bundle,
        call.params["version"].as_str(),
        call.params["dmgPath"].as_str(),
    ) else {
        return call.err("invalid", "missing update bundle, version or image");
    };
    if call.params["ownBundle"].as_str().map(Path::new) != Some(bundle.as_path()) {
        return call.err("invalid", "not the running update bundle");
    }
    let reply = crate::update_stage::stage(
        &host.user_data,
        &std::env::temp_dir(),
        Path::new(dmg),
        version,
        &bundle,
    );
    call.ok(serde_json::json!(reply));
}
