//! The Settings page's view of a provider entry, and an entry written back from it (was `models-config.ts`). The
//! view surfaces every field the page renders and tolerates any file content (an unknown shape reads as absent,
//! never an error). A write merges over the entry: rendered fields are set or deleted from the input, every other
//! key (compat beyond extraBody, remoteCompaction, modelOverrides, effortMap, contextPromotionTarget,
//! compactionModel…) stays as written.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Characters of a stored key the list shows.
const MASK_PREVIEW_LEN: usize = 4;

/// Stock's built-in providers and option vocabularies (`catalog.roster`); never a checked-in copy. The page's form
/// gets them as its options.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::models) struct Roster {
    pub builtin_providers: Vec<String>,
    #[serde(default)]
    pub anthropic_models: Vec<Value>,
    pub apis: Vec<String>,
    pub auth: Vec<String>,
    pub discovery: Vec<String>,
    pub thinking_modes: Vec<String>,
    pub efforts: Vec<String>,
}

impl Roster {
    pub fn builtin(&self, id: &str) -> bool {
        self.builtin_providers.iter().any(|known| known == id)
    }
}

fn listed(options: &[String], value: &str) -> bool {
    options.iter().any(|option| option == value)
}

fn text(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

fn number(value: Option<&Value>) -> Option<Value> {
    value.filter(|value| value.is_number()).cloned()
}

fn boolean(value: Option<&Value>) -> Option<Value> {
    value.filter(|value| value.is_boolean()).cloned()
}

fn string_record(value: Option<&Value>) -> Option<Value> {
    let kept: Map<String, Value> = value?
        .as_object()?
        .iter()
        .filter(|(_, value)| value.is_string())
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    (!kept.is_empty()).then_some(Value::Object(kept))
}

fn api(value: Option<&Value>, roster: &Roster) -> Option<Value> {
    text(value)
        .filter(|api| listed(&roster.apis, api))
        .map(Value::from)
}

fn cost(value: Option<&Value>) -> Option<Value> {
    let rec = value?.as_object()?;
    let mut cost = Map::new();
    for key in ["input", "output", "cacheRead", "cacheWrite"] {
        if let Some(value) = number(rec.get(key)) {
            cost.insert(key.into(), value);
        }
    }
    (!cost.is_empty()).then_some(Value::Object(cost))
}

fn thinking(value: Option<&Value>, roster: &Roster) -> Option<Map<String, Value>> {
    let rec = value?.as_object()?;
    let mode = rec.get("mode")?.as_str()?;
    if !listed(&roster.thinking_modes, mode) {
        return None;
    }
    let efforts = rec
        .get("efforts")
        .and_then(Value::as_array)
        .filter(|efforts| !efforts.is_empty())?;
    let mut view = Map::new();
    view.insert("mode".into(), mode.into());
    view.insert("efforts".into(), Value::Array(efforts.clone()));
    if let Some(level) =
        text(rec.get("defaultLevel")).filter(|level| listed(&roster.efforts, level))
    {
        view.insert("defaultLevel".into(), level.into());
    }
    if let Some(display) = boolean(rec.get("supportsDisplay")) {
        view.insert("supportsDisplay".into(), display);
    }
    Some(view)
}

fn input(value: Option<&Value>) -> Option<Value> {
    let kept: Vec<Value> = value?
        .as_array()?
        .iter()
        .filter(|item| matches!(item.as_str(), Some("text" | "image")))
        .cloned()
        .collect();
    (!kept.is_empty()).then_some(Value::Array(kept))
}

fn discovery(value: Option<&Value>, roster: &Roster) -> Option<Value> {
    let rec = value?.as_object()?;
    let kind = rec.get("type")?.as_str()?;
    if !listed(&roster.discovery, kind) {
        return None;
    }
    let mut view = Map::new();
    view.insert("type".into(), kind.into());
    if let Some(timeout) = number(rec.get("timeoutMs")) {
        view.insert("timeoutMs".into(), timeout);
    }
    Some(Value::Object(view))
}

fn put(view: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        view.insert(key.into(), value);
    }
}

fn model(raw: &Value, roster: &Roster) -> Option<Value> {
    let rec = raw.as_object()?;
    let id = text(rec.get("id"))?;
    let mut view = Map::new();
    view.insert("id".into(), id.into());
    put(&mut view, "name", text(rec.get("name")).map(Value::from));
    put(&mut view, "api", api(rec.get("api"), roster));
    put(
        &mut view,
        "baseUrl",
        text(rec.get("baseUrl")).map(Value::from),
    );
    put(
        &mut view,
        "reasoning",
        (rec.get("reasoning") == Some(&Value::Bool(true))).then_some(Value::Bool(true)),
    );
    put(
        &mut view,
        "thinking",
        thinking(rec.get("thinking"), roster).map(Value::Object),
    );
    put(&mut view, "input", input(rec.get("input")));
    put(
        &mut view,
        "supportsTools",
        boolean(rec.get("supportsTools")),
    );
    put(&mut view, "cost", cost(rec.get("cost")));
    put(
        &mut view,
        "premiumMultiplier",
        number(rec.get("premiumMultiplier")),
    );
    put(&mut view, "contextWindow", number(rec.get("contextWindow")));
    put(&mut view, "maxTokens", number(rec.get("maxTokens")));
    put(
        &mut view,
        "omitMaxOutputTokens",
        boolean(rec.get("omitMaxOutputTokens")),
    );
    put(&mut view, "headers", string_record(rec.get("headers")));
    Some(Value::Object(view))
}

/// A `modelOverrides` entry's rendered fields; anything else in it stays in the file only.
fn model_override(raw: &Value, roster: &Roster) -> Option<Value> {
    let rec = raw.as_object()?;
    let mut view = Map::new();
    put(&mut view, "name", text(rec.get("name")).map(Value::from));
    put(&mut view, "api", api(rec.get("api"), roster));
    put(&mut view, "reasoning", boolean(rec.get("reasoning")));
    if let Some(shown) = thinking(rec.get("thinking"), roster) {
        let mut thinking = Map::new();
        thinking.insert("mode".into(), shown["mode"].clone());
        thinking.insert("efforts".into(), shown["efforts"].clone());
        let effort_map: Map<String, Value> = rec["thinking"]
            .get("effortMap")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .filter(|(effort, wire)| listed(&roster.efforts, effort) && text(Some(wire)).is_some())
            .map(|(effort, wire)| (effort.clone(), wire.clone()))
            .collect();
        if !effort_map.is_empty() {
            thinking.insert("effortMap".into(), Value::Object(effort_map));
        }
        view.insert("thinking".into(), Value::Object(thinking));
    }
    put(&mut view, "contextWindow", number(rec.get("contextWindow")));
    put(&mut view, "maxTokens", number(rec.get("maxTokens")));
    put(
        &mut view,
        "replayReasoning",
        boolean(
            rec.get("compat")
                .and_then(|compat| compat.get("requiresReasoningContentForToolCalls")),
        ),
    );
    Some(Value::Object(view))
}

/// The list's view of one provider entry; the key only as a masked preview.
pub(super) fn provider(id: &str, raw: &Value, roster: &Roster) -> Value {
    let empty = Map::new();
    let rec = raw.as_object().unwrap_or(&empty);
    let models: Vec<Value> = rec
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|raw| model(raw, roster))
        .collect();
    let mut view = Map::new();
    view.insert("id".into(), id.into());
    view.insert(
        "api".into(),
        api(rec.get("api"), roster).unwrap_or_else(|| "openai-completions".into()),
    );
    view.insert(
        "baseUrl".into(),
        text(rec.get("baseUrl")).unwrap_or_default().into(),
    );
    let key = text(rec.get("apiKey"));
    view.insert("hasApiKey".into(), key.is_some().into());
    if let Some(key) = key.filter(|_| !super::claude_key_id(id)) {
        let start = key
            .char_indices()
            .rev()
            .nth(MASK_PREVIEW_LEN - 1)
            .map_or(0, |(start, _)| start);
        view.insert(
            "apiKeyPreview".into(),
            format!("•••{}", &key[start..]).into(),
        );
    }
    put(
        &mut view,
        "auth",
        text(rec.get("auth"))
            .filter(|auth| listed(&roster.auth, auth))
            .map(Value::from),
    );
    put(&mut view, "authHeader", boolean(rec.get("authHeader")));
    put(&mut view, "headers", string_record(rec.get("headers")));
    put(
        &mut view,
        "discovery",
        discovery(rec.get("discovery"), roster),
    );
    put(
        &mut view,
        "disableStrictTools",
        boolean(rec.get("disableStrictTools")),
    );
    put(
        &mut view,
        "transport",
        (rec.get("transport").and_then(Value::as_str) == Some("pi-native"))
            .then(|| "pi-native".into()),
    );
    put(
        &mut view,
        "extraBody",
        rec.get("compat")
            .and_then(|compat| compat.get("extraBody"))
            .and_then(Value::as_object)
            .filter(|body| !body.is_empty())
            .map(|body| Value::Object(body.clone())),
    );
    view.insert("models".into(), Value::Array(models));
    view.insert("builtin".into(), roster.builtin(id).into());
    let overrides: Map<String, Value> = rec
        .get("modelOverrides")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(model, raw)| Some((model.clone(), model_override(raw, roster)?)))
        .collect();
    if !overrides.is_empty() {
        view.insert("modelOverrides".into(), Value::Object(overrides));
    }
    Value::Object(view)
}

/// `setOrDelete`: an absent, null or empty-string value removes the key, keeping the others' order.
fn set_or_delete(entry: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    match value {
        None | Some(Value::Null) => {
            entry.shift_remove(key);
        }
        Some(Value::String(text)) if text.is_empty() => {
            entry.shift_remove(key);
        }
        Some(value) => {
            entry.insert(key.into(), value.clone());
        }
    }
}

/// A list or record value only while it holds something.
fn filled(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| match value {
        Value::Array(list) => !list.is_empty(),
        Value::Object(map) => !map.is_empty(),
        _ => true,
    })
}

fn object(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// The legacy range keys restate the ladder `efforts` holds: kept, a later edit that shortens the ladder would leave
/// a stale `levels`/`minLevel`+`maxLevel` claiming the old range.
fn drop_ranges(thinking: &mut Map<String, Value>) {
    for key in ["levels", "minLevel", "maxLevel"] {
        thinking.shift_remove(key);
    }
}

/// One model of the form merged over the entry's model with its id.
fn merge_model(existing: Option<&Value>, input: &Value) -> Value {
    let id = input.get("id").cloned().unwrap_or(Value::Null);
    let found = existing.and_then(Value::as_array).and_then(|models| {
        models
            .iter()
            .find(|model| model.is_object() && model.get("id") == Some(&id))
    });
    let mut merged = object(found);
    set_or_delete(&mut merged, "name", input.get("name"));
    set_or_delete(&mut merged, "api", input.get("api"));
    set_or_delete(&mut merged, "baseUrl", input.get("baseUrl"));
    set_or_delete(&mut merged, "reasoning", input.get("reasoning"));
    match input.get("thinking").and_then(Value::as_object) {
        Some(given) => {
            let mut thinking = object(merged.get("thinking"));
            drop_ranges(&mut thinking);
            thinking.extend(given.clone());
            merged.insert("thinking".into(), Value::Object(thinking));
        }
        None => {
            merged.shift_remove("thinking");
        }
    }
    set_or_delete(&mut merged, "input", filled(input.get("input")));
    set_or_delete(&mut merged, "supportsTools", input.get("supportsTools"));
    set_or_delete(&mut merged, "cost", filled(input.get("cost")));
    set_or_delete(
        &mut merged,
        "premiumMultiplier",
        input.get("premiumMultiplier"),
    );
    set_or_delete(&mut merged, "contextWindow", input.get("contextWindow"));
    set_or_delete(&mut merged, "maxTokens", input.get("maxTokens"));
    set_or_delete(
        &mut merged,
        "omitMaxOutputTokens",
        input.get("omitMaxOutputTokens"),
    );
    set_or_delete(&mut merged, "headers", filled(input.get("headers")));
    let mut model = Map::new();
    model.insert("id".into(), id);
    model.extend(merged.into_iter().filter(|(key, _)| key != "id"));
    Value::Object(model)
}

/// The provider entry the form writes over `existing` (the normalized entry). The stored key stays unless the form
/// gives a new one or clears it.
pub(super) fn provider_entry(existing: Option<&Value>, input: &Value) -> Value {
    let mut entry = object(existing);
    let stored_key = existing
        .and_then(|entry| entry.get("apiKey"))
        .filter(|key| key.is_string());
    let given_key = input
        .get("apiKey")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|key| !key.is_empty());
    let api_key = if input.get("clearApiKey") == Some(&Value::Bool(true)) {
        None
    } else {
        given_key.map(Value::from).or_else(|| stored_key.cloned())
    };
    entry.insert(
        "baseUrl".into(),
        input.get("baseUrl").cloned().unwrap_or(Value::Null),
    );
    entry.insert(
        "api".into(),
        input.get("api").cloned().unwrap_or(Value::Null),
    );
    set_or_delete(&mut entry, "apiKey", api_key.as_ref());
    set_or_delete(&mut entry, "auth", input.get("auth"));
    set_or_delete(&mut entry, "authHeader", input.get("authHeader"));
    set_or_delete(&mut entry, "headers", filled(input.get("headers")));
    set_or_delete(&mut entry, "discovery", input.get("discovery"));
    set_or_delete(
        &mut entry,
        "disableStrictTools",
        input.get("disableStrictTools"),
    );
    set_or_delete(&mut entry, "transport", input.get("transport"));
    // extraBody is merged into the existing compat object: its other flags survive.
    let mut compat = object(entry.get("compat"));
    set_or_delete(&mut compat, "extraBody", filled(input.get("extraBody")));
    if compat.is_empty() {
        entry.shift_remove("compat");
    } else {
        entry.insert("compat".into(), Value::Object(compat));
    }
    let models: Vec<Value> = input
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|model| merge_model(entry.get("models"), model))
        .collect();
    entry.insert("models".into(), Value::Array(models));
    Value::Object(entry)
}

/// The provider entry with one model's `modelOverrides` entry written from `input`, or removed for `None`. Rendered
/// fields are set or deleted; the override's other keys survive. `None` back: the entry is left with nothing.
pub(super) fn override_entry(
    before: Option<&Value>,
    model: &str,
    input: Option<&Value>,
) -> Option<Value> {
    let mut entry = object(before);
    let mut overrides = object(entry.get("modelOverrides"));
    match input {
        None => {
            overrides.shift_remove(model);
        }
        Some(input) => {
            let mut merged = object(overrides.get(model));
            set_or_delete(&mut merged, "name", input.get("name"));
            set_or_delete(&mut merged, "api", input.get("api"));
            set_or_delete(&mut merged, "reasoning", input.get("reasoning"));
            set_or_delete(&mut merged, "contextWindow", input.get("contextWindow"));
            set_or_delete(&mut merged, "maxTokens", input.get("maxTokens"));
            match input.get("thinking").and_then(Value::as_object) {
                Some(given) => {
                    let mut thinking = object(merged.get("thinking"));
                    drop_ranges(&mut thinking);
                    thinking.insert(
                        "mode".into(),
                        given.get("mode").cloned().unwrap_or(Value::Null),
                    );
                    thinking.insert(
                        "efforts".into(),
                        given.get("efforts").cloned().unwrap_or(Value::Null),
                    );
                    set_or_delete(&mut thinking, "effortMap", filled(given.get("effortMap")));
                    merged.insert("thinking".into(), Value::Object(thinking));
                }
                None => {
                    merged.shift_remove("thinking");
                }
            }
            let mut compat = object(merged.get("compat"));
            set_or_delete(
                &mut compat,
                "requiresReasoningContentForToolCalls",
                input.get("replayReasoning"),
            );
            if compat.is_empty() {
                merged.shift_remove("compat");
            } else {
                merged.insert("compat".into(), Value::Object(compat));
            }
            if merged.is_empty() {
                overrides.shift_remove(model);
            } else {
                overrides.insert(model.into(), Value::Object(merged));
            }
        }
    }
    if overrides.is_empty() {
        entry.shift_remove("modelOverrides");
    } else {
        entry.insert("modelOverrides".into(), Value::Object(overrides));
    }
    (!entry.is_empty()).then(|| Value::Object(entry))
}

#[cfg(test)]
pub(super) fn roster_for_tests() -> Roster {
    serde_json::from_value(serde_json::json!({
        "builtinProviders": ["anthropic"],
        "apis": ["openai-completions", "anthropic-messages"],
        "auth": ["apiKey", "none"],
        "discovery": ["openai-models-list"],
        "thinkingModes": ["effort", "budget"],
        "efforts": ["minimal", "low", "medium", "high", "max"],
    }))
    .unwrap()
}
