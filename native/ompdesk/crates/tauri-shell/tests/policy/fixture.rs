#[path = "../../../shell/src/facts/app_icon.rs"]
mod app_icon;
mod clipboard;
#[path = "../../src/diagnostic_bundle_name.rs"]
mod diagnostic_bundle_name;
#[path = "../../src/js_date.rs"]
mod js_date;
#[path = "../../src/launch_protection.rs"]
mod launch_protection;
#[path = "../../src/diagnostic_logs/log_tail.rs"]
mod log_tail;
#[path = "../../src/watchdog/marker.rs"]
mod marker;
#[path = "../../src/notify_triage.rs"]
mod notify_triage;
#[path = "../../src/profile_file.rs"]
mod profile_file;
#[allow(dead_code)]
#[path = "../../../shell/src/shell_args.rs"]
mod shell_args;
#[path = "../../src/update_auth_files.rs"]
mod update_auth_files;
#[path = "../../src/update_files.rs"]
mod update_files;
#[cfg(any(target_os = "macos", all(test, unix)))]
#[path = "../../src/update_stage/mod.rs"]
mod update_stage;

use serde_json::Value;
use std::io::{self, BufRead, Write};
use std::path::Path;

fn main() -> io::Result<()> {
    let mut out = io::stdout().lock();
    let mut launch = None;
    let mut clipboard = clipboard::Clipboard::default();
    let mut notify = notify_triage::NotifyTriage::default();
    for line in io::stdin().lock().lines() {
        let call: Value = serde_json::from_str(&line?)?;
        let params = &call["params"];
        let answer = match call["method"].as_str().unwrap() {
            method if method.starts_with("clipboard.") => clipboard.call(method, params),
            "app.admitNotification" => notify.admit(params).unwrap(),
            method @ ("app.updateDestination" | "app.sweepUpdateFiles") => {
                let mut args = params.clone();
                let directory = args.as_object_mut().unwrap().remove("directory").unwrap();
                let dir = Path::new(directory.as_str().unwrap());
                match update_files::handle(method, &args, dir, dir) {
                    Ok(value) => value,
                    Err(error) => serde_json::json!({ "error": error }),
                }
            }
            method if method.starts_with("updateAuth.") => {
                let profile = Path::new(params["profile"].as_str().unwrap());
                let result = match method {
                    "updateAuth.read" => {
                        update_auth_files::read(profile).map(|bytes| serde_json::json!(bytes))
                    }
                    "updateAuth.status" => Ok(update_auth_files::status(profile)),
                    "updateAuth.save" => {
                        let bytes: Vec<u8> = serde_json::from_value(params["bytes"].clone())?;
                        update_auth_files::save(profile, &bytes).map(|()| Value::Null)
                    }
                    "updateAuth.drop" => {
                        update_auth_files::drop_token(profile).map(|()| Value::Null)
                    }
                    "updateAuth.clear" => update_auth_files::clear(profile).map(|()| Value::Null),
                    _ => panic!("unknown fixture method {method}"),
                };
                result.unwrap_or_else(|error| serde_json::json!({ "error": error.to_string() }))
            }
            #[cfg(target_os = "macos")]
            "app.stageUpdateBundle" => serde_json::json!(update_stage::stage(
                Path::new(params["profile"].as_str().unwrap()),
                Path::new(params["tempRoot"].as_str().unwrap()),
                Path::new(params["dmgPath"].as_str().unwrap()),
                params["version"].as_str().unwrap(),
                Path::new(params["ownBundle"].as_str().unwrap()),
            )),
            "page.allowsExternal" => Value::Bool(
                params["url"]
                    .as_str()
                    .is_some_and(shell_args::page_external_url),
            ),
            "appIcon" => app_icon::fact(
                Path::new(params["resources"].as_str().unwrap()),
                Path::new(params["rendererRoot"].as_str().unwrap()),
                params["packaged"].as_bool().unwrap(),
                params["windows"].as_bool().unwrap(),
                params["headless"].as_str() == Some("1"),
            ),
            "hang.consume" => marker::consume_reports(Path::new(params["path"].as_str().unwrap())),
            "app.diagnosticBundleFileName" => {
                Value::String(diagnostic_bundle_name::file_name(params).unwrap())
            }
            "app.previousRunEnd" => log_tail::previous_run_end(
                std::fs::File::open(params["path"].as_str().unwrap()),
                u32::try_from(params["ownPid"].as_u64().unwrap()).unwrap(),
            ),
            "launch.start" => {
                let (state, result) = launch_protection::LaunchProtection::start(
                    Path::new(params["profile"].as_str().unwrap()),
                    params["now"].as_i64().unwrap(),
                    params["guard"].as_bool().unwrap(),
                    params["enableGpu"].as_bool().unwrap(),
                    params["disableGpu"].as_bool().unwrap(),
                );
                launch = Some(state);
                result
            }
            "launch.event" => launch
                .as_mut()
                .unwrap()
                .apply(params["op"].as_str().unwrap(), &params["args"]),
            method => panic!("unknown fixture method {method}"),
        };
        serde_json::to_writer(&mut out, &answer)?;
        out.write_all(b"\n")?;
        out.flush()?;
    }
    Ok(())
}
