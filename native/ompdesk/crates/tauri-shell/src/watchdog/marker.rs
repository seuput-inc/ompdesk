use crate::js_date::iso_ms;
use serde_json::{Value, json};
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

pub(super) const STEP_HISTORY: usize = 8;
const MAX_BYTES: u64 = 64 * 1024;
const MACHINE_FACTS: usize = 12;
const JS_DATE_LIMIT_MS: f64 = 8_640_000_000_000_000.0;

pub(super) fn consume(path: &Path) -> Option<Value> {
    let size = fs::metadata(path).ok()?.len();
    let marker = if size <= MAX_BYTES {
        let mut bytes = Vec::with_capacity(size as usize);
        File::open(path)
            .ok()?
            .take(MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() as u64 <= MAX_BYTES {
            parse(&String::from_utf8_lossy(&bytes))
        } else {
            None
        }
    } else {
        None
    };
    // Stat and read failures leave the marker alone; invalid and oversized files are consumed.
    let _ = fs::remove_file(path);
    marker
}

pub(crate) fn consume_reports(path: &Path) -> Value {
    let Some(mut marker) = consume(path) else {
        return Value::Array(Vec::new());
    };
    let ms = marker["unresponsiveMs"].as_f64().unwrap();
    let seconds = (ms / 1000.0).round().abs();
    let outcome = if marker["selfRecovered"] == true {
        "recovered"
    } else {
        "never recovered"
    };
    let duration = if seconds >= 1e21 {
        format!("{seconds:e}").replace('e', "e+")
    } else {
        seconds.to_string()
    };
    let at = iso_ms(marker["detectedAt"].as_f64().unwrap() as i64);
    let steps = marker["steps"].as_array().map(|steps| {
        let mut labels = String::new();
        for (i, step) in steps.iter().enumerate() {
            if i != 0 {
                labels.push_str(" > ");
            }
            labels.push_str(step.as_str().unwrap());
        }
        labels
    });
    let hang = json!({
        "source": "main-thread-hang",
        "message": format!("Main thread stalled for {duration}s and {outcome}"),
        "details": {
            "unresponsiveMs": ms.round(), "selfRecovered": marker["selfRecovered"],
            "detectedAt": at, "previousPid": marker["pid"], "phase": marker["phase"], "steps": steps,
        }
    });
    let mut reports = Vec::with_capacity(if marker["machine"].is_object() { 2 } else { 1 });
    reports.push(hang);
    if let Value::Object(machine) = marker["machine"].take() {
        let mut details = json!({"trigger": "hang", "when": "during", "at": at});
        details.as_object_mut().unwrap().extend(machine);
        reports
            .push(json!({"source": "machine-state", "message": "hang during", "details": details}));
    }
    Value::Array(reports)
}

fn parse(raw: &str) -> Option<Value> {
    let mut input: Value = serde_json::from_str(raw).ok()?;
    let date = input["detectedAt"].as_f64()?;
    let pid = input["pid"].as_f64()?;
    let ms = input["unresponsiveMs"].as_f64()?;
    if date.abs() > JS_DATE_LIMIT_MS || pid <= 0.0 || pid.fract() != 0.0 || ms < 0.0 {
        return None;
    }
    let mut marker = json!({
        "detectedAt": input["detectedAt"], "pid": input["pid"], "unresponsiveMs": input["unresponsiveMs"],
        "selfRecovered": input["selfRecovered"].as_bool() == Some(true),
    });
    if matches!(
        input["phase"].as_str(),
        Some("startup" | "running" | "quit" | "update")
    ) && let Some(steps) = input["steps"].as_array_mut()
        && steps.iter().all(Value::is_string)
    {
        steps.drain(..steps.len().saturating_sub(STEP_HISTORY));
        marker["phase"] = input["phase"].take();
        marker["steps"] = input["steps"].take();
    }
    if let Some(machine) = input
        .get_mut("machine")
        .and_then(|m| machine_facts(m.take()))
    {
        marker["machine"] = machine;
    }
    Some(marker)
}

fn primitive(value: &Value) -> bool {
    matches!(value, Value::String(_) | Value::Number(_) | Value::Bool(_))
}

// Object.entries puts canonical array indices first, then other keys in insertion order.
fn js_key_rank(key: &str) -> u32 {
    match key.as_bytes() {
        b"0" => 0,
        [b'1'..=b'9', ..] => key.parse().unwrap_or(u32::MAX),
        _ => u32::MAX,
    }
}

fn machine_facts(machine: Value) -> Option<Value> {
    let facts = match machine {
        Value::Array(values) => values
            .into_iter()
            .enumerate()
            .filter(|(_, value)| primitive(value))
            .take(MACHINE_FACTS)
            .map(|(index, value)| (index.to_string(), value))
            .collect(),
        Value::Object(values) => {
            let mut first = Vec::with_capacity(MACHINE_FACTS.min(values.len()));
            for (key, value) in values.into_iter().filter(|(_, value)| primitive(value)) {
                let rank = js_key_rank(&key);
                let at = first.partition_point(|(prior, _, _)| *prior <= rank);
                if at < MACHINE_FACTS {
                    if first.len() == MACHINE_FACTS {
                        first.pop();
                    }
                    first.insert(at, (rank, key, value));
                }
            }
            first
                .into_iter()
                .map(|(_, key, value)| (key, value))
                .collect()
        }
        _ => return None,
    };
    Some(Value::Object(facts))
}
