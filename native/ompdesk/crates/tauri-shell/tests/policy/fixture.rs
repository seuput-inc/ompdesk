#[path = "../../../shell/src/facts/app_icon.rs"]
mod app_icon;
#[path = "../../src/js_date.rs"]
mod js_date;
#[path = "../../src/launch_protection.rs"]
mod launch_protection;
#[path = "../../src/diagnostic_logs/log_tail.rs"]
mod log_tail;
#[path = "../../src/watchdog/marker.rs"]
mod marker;
#[allow(dead_code)]
#[path = "../../../shell/src/shell_args.rs"]
mod shell_args;

use serde_json::Value;
use std::io::{self, BufRead, Write};
use std::path::Path;

fn main() -> io::Result<()> {
    let mut out = io::stdout().lock();
    let mut launch = None;
    for line in io::stdin().lock().lines() {
        let call: Value = serde_json::from_str(&line?)?;
        let params = &call["params"];
        let answer = match call["method"].as_str().unwrap() {
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
                params["headless"].as_str().map(std::ffi::OsStr::new),
            ),
            "hang.consume" => marker::consume_reports(Path::new(params["path"].as_str().unwrap())),
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
