//! Per-workspace launch profiles (`launchProfiles.<cwd>` in `prefs.json`; was `src/main/launch-profile-store.ts` and
//! `parseLaunchProfile` of `src/shared/launch-profile.ts`): the Settings page reads and patches them, and a tab's spawn
//! appends their flags. The machine that spawns omp keeps them, so a paired host serves its own through these.
//!
//! The page keeps `profileToFlags` for its command preview; `launch-captured.json` holds what the TypeScript answered,
//! read by the tests here and by `src/renderer/lib/launch-profile.test.ts`, so the two copies give the same flags.

use serde_json::{Map, Value};

use crate::control::js;
use crate::server::Fault;

const KEY: &str = "launchProfiles";

/// The fields a profile keeps, in the order `parseLaunchProfile` wrote them.
#[derive(Default)]
struct Profile {
    system_prompt: Option<String>,
    append_system_prompt: Option<String>,
    no_rules: bool,
    add_dirs: Vec<String>,
    tools: Vec<String>,
    no_lsp: bool,
    profile: Option<String>,
    session_dir: Option<String>,
    config: Option<String>,
}

fn kept_text(record: &Map<String, Value>, key: &str) -> Option<String> {
    record
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !js::trim(text).is_empty())
        .map(str::to_owned)
}

fn trimmed_text(record: &Map<String, Value>, key: &str) -> Option<String> {
    kept_text(record, key).map(|text| js::trim(&text).to_owned())
}

fn trimmed_list(record: &Map<String, Value>, key: &str) -> Vec<String> {
    let Some(Value::Array(items)) = record.get(key) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(Value::as_str)
        .map(js::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Untrusted prefs JSON as a profile: unknown keys dropped (a hand-edited `"--session"` never reaches the flags),
/// blank values normalized away, so a profile with no fields means "no profile".
fn parse(raw: Option<&Value>) -> Profile {
    let Some(Value::Object(record)) = raw else {
        return Profile::default();
    };
    Profile {
        system_prompt: kept_text(record, "systemPrompt"),
        append_system_prompt: kept_text(record, "appendSystemPrompt"),
        no_rules: record.get("noRules") == Some(&Value::Bool(true)),
        add_dirs: trimmed_list(record, "addDirs"),
        tools: trimmed_list(record, "tools"),
        no_lsp: record.get("noLsp") == Some(&Value::Bool(true)),
        profile: trimmed_text(record, "profile"),
        session_dir: trimmed_text(record, "sessionDir"),
        config: trimmed_text(record, "config"),
    }
}

impl Profile {
    fn to_value(&self) -> Map<String, Value> {
        let mut out = Map::new();
        let mut text = |key: &str, value: &Option<String>| {
            if let Some(value) = value {
                out.insert(key.into(), Value::String(value.clone()));
            }
        };
        text("systemPrompt", &self.system_prompt);
        text("appendSystemPrompt", &self.append_system_prompt);
        if self.no_rules {
            out.insert("noRules".into(), Value::Bool(true));
        }
        let list =
            |items: &[String]| Value::Array(items.iter().cloned().map(Value::String).collect());
        if !self.add_dirs.is_empty() {
            out.insert("addDirs".into(), list(&self.add_dirs));
        }
        if !self.tools.is_empty() {
            out.insert("tools".into(), list(&self.tools));
        }
        if self.no_lsp {
            out.insert("noLsp".into(), Value::Bool(true));
        }
        let mut text = |key: &str, value: &Option<String>| {
            if let Some(value) = value {
                out.insert(key.into(), Value::String(value.clone()));
            }
        };
        text("profile", &self.profile);
        text("sessionDir", &self.session_dir);
        text("config", &self.config);
        out
    }

    /// The agent CLI flags, in `profileToFlags`' fixed order. The denylist is the spawn's (`omp-launch.ts`), over
    /// every flag the person added: a value here is data, even one that looks like a protected flag.
    fn flags(&self) -> Vec<String> {
        let mut flags = Vec::new();
        let mut pair = |flag: &str, value: &str| {
            flags.push(flag.to_owned());
            flags.push(value.to_owned());
        };
        if let Some(prompt) = &self.system_prompt {
            pair("--system-prompt", prompt);
        }
        if let Some(prompt) = &self.append_system_prompt {
            pair("--append-system-prompt", prompt);
        }
        if self.no_rules {
            flags.push("--no-rules".into());
        }
        for dir in &self.add_dirs {
            flags.push("--add-dir".into());
            flags.push(dir.clone());
        }
        if !self.tools.is_empty() {
            flags.push("--tools".into());
            flags.push(self.tools.join(","));
        }
        if self.no_lsp {
            flags.push("--no-lsp".into());
        }
        let mut pair = |flag: &str, value: &Option<String>| {
            if let Some(value) = value {
                flags.push(flag.to_owned());
                flags.push(value.clone());
            }
        };
        pair("--profile", &self.profile);
        pair("--session-dir", &self.session_dir);
        pair("--config", &self.config);
        flags
    }
}

fn invalid(message: &str) -> Fault {
    Fault::new("invalid_launch_profile", message)
}

/// The stored map's entry for `cwd` (a map that is not an object holds none).
fn stored(profiles: Option<&Value>, cwd: &str) -> Option<Value> {
    profiles?.as_object()?.get(cwd).cloned()
}

/// The workspace's profile, as the Settings page shows it.
pub fn get(file: &str, cwd: &Value) -> Result<Map<String, Value>, Fault> {
    let cwd = cwd
        .as_str()
        .filter(|cwd| js::is_absolute(cwd))
        .ok_or_else(|| invalid("Invalid workspace"))?;
    Ok(parse(stored(super::get(file, KEY)?.as_ref(), cwd).as_ref()).to_value())
}

/// The flags a spawn in `cwd` appends; none when nothing is stored for it.
pub fn flags(file: &str, cwd: &str) -> Result<Vec<String>, Fault> {
    Ok(parse(stored(super::get(file, KEY)?.as_ref(), cwd).as_ref()).flags())
}

/// Merges `patch` into the workspace's profile under the file's one lock and answers the profile now stored; an
/// emptied profile is removed. Two callers changing different fields or workspaces never replace each other.
pub fn update(file: &str, cwd: &Value, patch: &Value) -> Result<Map<String, Value>, Fault> {
    let (Some(cwd), Value::Object(patch)) =
        (cwd.as_str().filter(|cwd| js::is_absolute(cwd)), patch)
    else {
        return Err(invalid("Invalid launch profile update"));
    };
    let mut answer = Map::new();
    super::update(file, KEY, |current| {
        let mut profiles = match current {
            Some(Value::Object(profiles)) => profiles.clone(),
            _ => Map::new(),
        };
        // `{ ...parseLaunchProfile(stored), ...patch }`: the patch's fields over the stored ones.
        let mut merged = parse(profiles.get(cwd)).to_value();
        for (key, value) in patch {
            merged.insert(key.clone(), value.clone());
        }
        answer = parse(Some(&Value::Object(merged))).to_value();
        if answer.is_empty() {
            profiles.shift_remove(cwd);
        } else {
            profiles.insert(cwd.to_owned(), Value::Object(answer.clone()));
        }
        Some(Value::Object(profiles))
    })?;
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::json;

    #[derive(Deserialize)]
    struct Row {
        raw: Value,
        profile: Value,
        flags: Vec<String>,
    }

    /// Rows `parseLaunchProfile` and `profileToFlags` answered before the store moved here.
    #[test]
    fn every_captured_profile_parses_and_maps_as_the_typescript_did() {
        let rows: Vec<Row> = serde_json::from_str(include_str!("launch-captured.json")).unwrap();
        assert!(rows.len() > 30);
        for row in rows {
            let profile = parse(Some(&row.raw));
            assert_eq!(
                Value::Object(profile.to_value()),
                row.profile,
                "{}",
                row.raw
            );
            assert_eq!(profile.flags(), row.flags, "{}", row.raw);
        }
    }

    fn file(dir: &tempfile::TempDir) -> String {
        dir.path().join("prefs.json").to_str().unwrap().to_owned()
    }

    fn work(name: &str) -> Value {
        json!(if cfg!(windows) {
            format!("C:\\work\\{name}")
        } else {
            format!("/work/{name}")
        })
    }

    #[test]
    fn merges_updates_to_different_fields_and_workspaces_and_drops_an_emptied_profile() {
        let dir = tempfile::tempdir().unwrap();
        let file = file(&dir);
        let (app, other) = (work("app"), work("other"));
        update(&file, &app, &json!({ "noRules": true })).unwrap();
        update(&file, &app, &json!({ "noLsp": true })).unwrap();
        let answered = update(&file, &other, &json!({ "profile": " isolated " })).unwrap();
        assert_eq!(Value::Object(answered), json!({ "profile": "isolated" }));
        let mut expected = Map::new();
        expected.insert(
            app.as_str().unwrap().into(),
            json!({ "noRules": true, "noLsp": true }),
        );
        expected.insert(
            other.as_str().unwrap().into(),
            json!({ "profile": "isolated" }),
        );
        assert_eq!(
            super::super::get(&file, KEY).unwrap(),
            Some(Value::Object(expected))
        );
        assert_eq!(
            Value::Object(get(&file, &app).unwrap()),
            json!({ "noRules": true, "noLsp": true })
        );
        assert_eq!(
            flags(&file, app.as_str().unwrap()).unwrap(),
            ["--no-rules", "--no-lsp"]
        );

        update(&file, &app, &json!({ "noRules": false, "noLsp": false })).unwrap();
        let mut expected = Map::new();
        expected.insert(
            other.as_str().unwrap().into(),
            json!({ "profile": "isolated" }),
        );
        assert_eq!(
            super::super::get(&file, KEY).unwrap(),
            Some(Value::Object(expected))
        );
        assert!(flags(&file, app.as_str().unwrap()).unwrap().is_empty());
    }

    #[test]
    fn refuses_a_relative_workspace_and_a_patch_that_is_not_an_object() {
        let dir = tempfile::tempdir().unwrap();
        let file = file(&dir);
        let code = |result: Result<Map<String, Value>, Fault>| result.unwrap_err().message;
        assert_eq!(
            code(update(
                &file,
                &json!("work/app"),
                &json!({ "noRules": true })
            )),
            "Invalid launch profile update"
        );
        assert_eq!(
            code(update(&file, &work("app"), &json!(["noRules"]))),
            "Invalid launch profile update"
        );
        assert_eq!(
            code(update(&file, &json!(7), &json!({}))),
            "Invalid launch profile update"
        );
        assert_eq!(code(get(&file, &json!("relative"))), "Invalid workspace");
        assert_eq!(super::super::get(&file, KEY).unwrap(), None);
    }

    #[test]
    fn a_smuggled_key_never_reaches_the_flags() {
        let dir = tempfile::tempdir().unwrap();
        let file = file(&dir);
        let app = work("app");
        super::super::set(
            &file,
            KEY,
            json!({ app.as_str().unwrap(): { "appendSystemPrompt": "--session", "--session": "x", "session": "x" } }),
        )
        .unwrap();
        assert_eq!(
            flags(&file, app.as_str().unwrap()).unwrap(),
            ["--append-system-prompt", "--session"]
        );
        assert!(flags(&file, "/elsewhere").unwrap().is_empty());
    }
}
