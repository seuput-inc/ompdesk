#[allow(dead_code)]
#[path = "../../../shell/src/shell_args.rs"]
mod shell_args;
#[path = "../../src/js_date.rs"]
mod js_date;
#[path = "../../src/watchdog/marker.rs"]
mod marker;

use serde_json::Value;
use std::io::{self, BufRead, Write};
use std::path::Path;

fn main() -> io::Result<()> {
    let mut out = io::stdout().lock();
    for line in io::stdin().lock().lines() {
        let call: Value = serde_json::from_str(&line?)?;
        let params = &call["params"];
        let answer = match call["method"].as_str().unwrap() {
            "page.allowsExternal" => Value::Bool(params["url"].as_str().is_some_and(shell_args::page_external_url)),
            "hang.consume" => marker::consume_reports(Path::new(params["path"].as_str().unwrap())),
            method => panic!("unknown fixture method {method}"),
        };
        serde_json::to_writer(&mut out, &answer)?;
        out.write_all(b"\n")?;
        out.flush()?;
    }
    Ok(())
}
