use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Hello<'a> {
    pub name: &'a str,
    app_version: &'a str,
    pub slim: Slim,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Slim {
    events: bool,
    progress: bool,
    autopilot: bool,
    ends: bool,
    read_groups: bool,
    tool_results: bool,
    end_fields: bool,
    autopilot_reads: bool,
    list_reads: bool,
    shifted_reads: bool,
    settings_reads: bool,
    roster_reads: bool,
    jobs_reads: bool,
    tool_outputs: bool,
    tool_args: bool,
    pub deflate: bool,
    pub deflate_context: bool,
    session_lists: bool,
}

pub(super) fn parse(value: &Value) -> Option<Hello<'_>> {
    let fields = value.as_object()?;
    let text = |key: &str, max| {
        fields
            .get(key)?
            .as_str()
            .filter(|s| s.encode_utf16().count() <= max)
    };
    if fields.get("t")?.as_str()? != "hello" || !fields.get("protocol")?.is_number() {
        return None;
    }
    let name = text("name", 256)?;
    let app_version = text("appVersion", 64)?;
    let bit = |key: &str| fields.get(key).map_or(Some(false), Value::as_bool);
    let events = bit("slimEvents")?;
    let progress = bit("slimProgress")? && events;
    let autopilot = bit("slimAutopilot")? && events;
    let ends = bit("slimEnds")? && events;
    let read_groups = bit("slimReadGroups")? && ends;
    let tool_results = bit("slimToolResults")? && ends;
    let end_fields = bit("slimEndFields")? && ends;
    let autopilot_reads = bit("slimAutopilotReads")? && autopilot;
    let list_reads = bit("slimListReads")? && autopilot_reads;
    let shifted_reads = bit("slimShiftedReads")? && list_reads;
    let settings_reads = bit("slimSettingsReads")? && list_reads;
    let roster_reads = bit("slimRosterReads")? && list_reads;
    let jobs_reads = bit("slimJobsReads")? && list_reads;
    let tool_outputs = bit("slimToolOutputs")? && events;
    let tool_args = bit("slimToolArgs")? && events;
    let deflate = bit("deflate")?;
    let deflate_context = bit("deflateContext")? && deflate;
    let session_lists = bit("slimSessionLists")?;
    Some(Hello {
        name,
        app_version,
        slim: Slim {
            events,
            progress,
            autopilot,
            ends,
            read_groups,
            tool_results,
            end_fields,
            autopilot_reads,
            list_reads,
            shifted_reads,
            settings_reads,
            roster_reads,
            jobs_reads,
            tool_outputs,
            tool_args,
            deflate,
            deflate_context,
            session_lists,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn hello() -> Value {
        json!({"t":"hello", "protocol":2, "name":"", "appVersion":"", "future":null})
    }

    #[test]
    fn negotiates_and_type_checks_every_capability() {
        let events: &[&str] = &["slimEvents"];
        let ends: &[&str] = &["slimEvents", "slimEnds"];
        let autopilot: &[&str] = &["slimEvents", "slimAutopilot"];
        let reads: &[&str] = &["slimEvents", "slimAutopilot", "slimAutopilotReads"];
        let lists: &[&str] = &[
            "slimEvents",
            "slimAutopilot",
            "slimAutopilotReads",
            "slimListReads",
        ];
        let cases = [
            ("slimEvents", "events", &[] as &[&str]),
            ("slimProgress", "progress", events),
            ("slimAutopilot", "autopilot", events),
            ("slimEnds", "ends", events),
            ("slimReadGroups", "readGroups", ends),
            ("slimToolResults", "toolResults", ends),
            ("slimEndFields", "endFields", ends),
            ("slimAutopilotReads", "autopilotReads", autopilot),
            ("slimListReads", "listReads", reads),
            ("slimShiftedReads", "shiftedReads", lists),
            ("slimSettingsReads", "settingsReads", lists),
            ("slimRosterReads", "rosterReads", lists),
            ("slimJobsReads", "jobsReads", lists),
            ("slimToolOutputs", "toolOutputs", events),
            ("slimToolArgs", "toolArgs", events),
            ("deflate", "deflate", &[]),
            ("deflateContext", "deflateContext", &["deflate"]),
            ("slimSessionLists", "sessionLists", &[]),
        ];
        for (wire, key, parents) in cases {
            let negotiated = |v: &Value| {
                serde_json::to_value(parse(v).unwrap().slim).unwrap()[key]
                    .as_bool()
                    .unwrap()
            };
            let mut v = hello();
            assert!(!negotiated(&v), "{wire}");
            for bad in [Value::Null, json!(1), json!("true")] {
                v[wire] = bad;
                assert!(parse(&v).is_none(), "{wire}");
            }
            for &parent in parents {
                v[parent] = json!(true);
            }
            v[wire] = json!(false);
            assert!(!negotiated(&v), "{wire}");
            v[wire] = json!(true);
            assert!(negotiated(&v), "{wire}");
            for &parent in parents {
                v[parent] = json!(false);
                assert!(!negotiated(&v), "{wire} without {parent}");
                v[parent] = json!(true);
            }
        }
    }

    #[test]
    fn validates_required_fields_and_utf16_limits() {
        for key in ["name", "appVersion", "protocol", "t"] {
            let mut v = hello();
            v.as_object_mut().unwrap().remove(key);
            assert!(parse(&v).is_none());
            v[key] = Value::Null;
            assert!(parse(&v).is_none());
        }
        for (key, limit) in [("name", 256), ("appVersion", 64)] {
            let mut v = hello();
            let boundary = "😀".repeat(limit / 2);
            v[key] = json!(boundary);
            assert!(parse(&v).is_some());
            v[key] = json!(boundary + "!");
            assert!(parse(&v).is_none());
        }
    }
}
