use std::fs;
use std::str::FromStr;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{Map, Value, json};
use yaml_edit::{Document, YamlNode};

use super::*;

/// YAML as JSON, standing in for Bun.YAML (the real reader is stock's, exercised by `models-config.test.ts`).
fn to_json(node: &YamlNode) -> Value {
    match node {
        YamlNode::Scalar(scalar) => {
            if scalar.is_quoted() {
                return Value::String(scalar.as_string());
            }
            match scalar.as_string().trim() {
                "" | "~" | "null" => Value::Null,
                "true" => Value::Bool(true),
                "false" => Value::Bool(false),
                text => text
                    .parse::<i64>()
                    .map(Value::from)
                    .or_else(|_| text.parse::<f64>().map(Value::from))
                    .unwrap_or_else(|_| Value::String(text.to_owned())),
            }
        }
        YamlNode::Mapping(mapping) => Value::Object(
            mapping
                .iter()
                .map(|(key, value)| {
                    (
                        to_json(&key)
                            .as_str()
                            .map_or_else(|| to_json(&key).to_string(), str::to_owned),
                        to_json(&value),
                    )
                })
                .collect(),
        ),
        YamlNode::Sequence(sequence) => {
            Value::Array(sequence.values().map(|item| to_json(&item)).collect())
        }
        _ => Value::Null,
    }
}

fn read_json(text: &str) -> Value {
    let doc = Document::from_str(text).unwrap();
    doc.as_mapping()
        .map_or(json!({}), |root| to_json(&YamlNode::Mapping(root)))
}

type Normalize = fn(Value) -> Value;

struct Fake {
    roster_fails: bool,
    normalize: Normalize,
    checks: AtomicUsize,
    /// Runs before the check of this number (1-based).
    on_check: Mutex<Option<(usize, Box<dyn FnOnce() + Send>)>>,
    /// What stock reads back instead of the text, for a misedit.
    misread: Option<fn(Value) -> Value>,
}

impl Fake {
    fn new() -> Fake {
        Fake {
            roster_fails: false,
            normalize: |config| config,
            checks: AtomicUsize::new(0),
            on_check: Mutex::new(None),
            misread: None,
        }
    }
}

impl Stock for Fake {
    async fn roster(&self) -> Result<Roster, Fault> {
        if self.roster_fails {
            return Err(Fault::new(
                "stock",
                "Cannot determine installed stock catalog roster",
            ));
        }
        Ok(view::roster_for_tests())
    }

    async fn check(&self, text: &str) -> Result<Checked, Fault> {
        let number = self.checks.fetch_add(1, Ordering::SeqCst) + 1;
        let hook = {
            let mut slot = self.on_check.lock().unwrap();
            if slot.as_ref().is_some_and(|(at, _)| *at == number) {
                slot.take()
            } else {
                None
            }
        };
        if let Some((_, hook)) = hook {
            hook();
        }
        let mut raw = read_json(text);
        if let Some(misread) = self.misread {
            raw = misread(raw);
        }
        if raw["providers"].as_object().is_some_and(|providers| {
            providers
                .values()
                .any(|entry| entry.get("api").and_then(Value::as_str) == Some("not-a-stock-api"))
        }) {
            return Err(Fault::new(
                "models_config",
                "models.yml does not satisfy stock omp ModelsConfigSchema",
            ));
        }
        Ok(Checked {
            config: (self.normalize)(raw.clone()),
            raw,
        })
    }
}

fn folder(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ompdesk-models-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn minimal() -> Value {
    json!({
        "id": "test-provider",
        "api": "openai-completions",
        "baseUrl": "https://api.test/v1",
        "models": [{ "id": "model-a" }],
    })
}

fn saved(dir: &Path) -> (String, Value) {
    let text = fs::read_to_string(models_path(dir)).unwrap();
    let json = read_json(&text);
    (text, json)
}

/// `models.list`'s providers.
async fn views(stock: &impl Stock, dir: &Path) -> Result<Vec<Value>, Fault> {
    let listed = list(stock, dir).await?;
    assert_eq!(listed["options"]["builtinProviders"], json!(["anthropic"]));
    Ok(listed["providers"].as_array().unwrap().clone())
}

#[tokio::test]
async fn upsert_creates_lists_and_deletes() {
    let dir = folder("create");
    let stock = Fake::new();
    assert!(
        upsert(
            &stock,
            &dir,
            &with(json!({ "apiKey": " sk-secret-1234 " })),
            false
        )
        .await
        .unwrap()
    );
    let (_, file) = saved(&dir);
    assert_eq!(
        file["providers"]["test-provider"],
        json!({ "baseUrl": "https://api.test/v1", "api": "openai-completions", "apiKey": "sk-secret-1234", "models": [{ "id": "model-a" }] })
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(models_path(&dir))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    let listed = views(&stock, &dir).await.unwrap();
    assert_eq!(listed[0]["hasApiKey"], json!(true));
    assert_eq!(listed[0]["apiKeyPreview"], json!("•••1234"));
    assert!(listed[0].get("apiKey").is_none());
    // The key stays through an edit that does not give one, and goes when cleared.
    upsert(
        &stock,
        &dir,
        &with(json!({ "baseUrl": "https://api.test/v2" })),
        false,
    )
    .await
    .unwrap();
    assert_eq!(
        saved(&dir).1["providers"]["test-provider"]["apiKey"],
        json!("sk-secret-1234")
    );
    upsert(&stock, &dir, &with(json!({ "clearApiKey": true })), false)
        .await
        .unwrap();
    assert!(
        saved(&dir).1["providers"]["test-provider"]
            .get("apiKey")
            .is_none()
    );
    // Inserting where the id exists writes nothing.
    let before = saved(&dir).0;
    assert!(
        !upsert(
            &stock,
            &dir,
            &with(json!({ "baseUrl": "http://other" })),
            true
        )
        .await
        .unwrap()
    );
    assert_eq!(saved(&dir).0, before);
    delete(&stock, &dir, "test-provider").await.unwrap();
    assert_eq!(saved(&dir).1, json!({ "providers": {} }));
    assert!(views(&stock, &dir).await.unwrap().is_empty());
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
}

fn minimal_map() -> Map<String, Value> {
    minimal().as_object().unwrap().clone()
}

/// `minimal()` with `extra`'s fields over it.
fn with(extra: Value) -> Value {
    let mut input = minimal_map();
    input.extend(extra.as_object().unwrap().clone());
    Value::Object(input)
}

#[tokio::test]
async fn an_edit_keeps_comments_layout_and_unrendered_fields() {
    let dir = folder("comments");
    let original = "# Company gateway\nproviders:\n  untouched: # Leave this provider alone\n    api: openai-completions\n    baseUrl: https://legacy.test/v1\n  test-provider:\n    api: openai-completions\n    baseUrl: https://api.test/v1 # Keep this endpoint comment\n    remoteCompaction: {enabled: true, model: compact-model}\n    modelOverrides: {model-a: {contextWindow: 128000}}\n    compat: {supportsStore: true, extraBody: {seed: 42}}\n    models:\n      - id: model-a\n        compactionModel: compact-model\n        thinking: {mode: effort, efforts: [low, high], effortMap: {low: low}, requiresEffort: true}\n        cost: {input: 1, output: 2, cacheRead: 0, cacheWrite: 0}\n";
    fs::write(models_path(&dir), original).unwrap();
    let stock = Fake::new();
    let view = views(&stock, &dir)
        .await
        .unwrap()
        .into_iter()
        .find(|view| view["id"] == "test-provider")
        .unwrap();
    let mut model = view["models"][0].clone();
    model["name"] = json!("Renamed");
    let mut input = minimal_map();
    input.insert("baseUrl".into(), json!("https://api.test/v2"));
    input.insert("extraBody".into(), json!({ "temperature": 0.5 }));
    input.insert("models".into(), json!([model]));
    upsert(&stock, &dir, &Value::Object(input), false)
        .await
        .unwrap();
    let (text, file) = saved(&dir);
    for kept in [
        "# Company gateway",
        "# Leave this provider alone",
        "https://api.test/v2 # Keep this endpoint comment",
        "remoteCompaction: {enabled: true, model: compact-model}",
    ] {
        assert!(text.contains(kept), "{kept} missing from\n{text}");
    }
    let entry = &file["providers"]["test-provider"];
    assert_eq!(
        entry["compat"],
        json!({ "supportsStore": true, "extraBody": { "temperature": 0.5 } })
    );
    assert_eq!(
        entry["modelOverrides"],
        json!({ "model-a": { "contextWindow": 128000 } })
    );
    assert_eq!(entry["models"][0]["name"], json!("Renamed"));
    assert_eq!(
        entry["models"][0]["compactionModel"],
        json!("compact-model")
    );
    assert_eq!(
        entry["models"][0]["thinking"]["effortMap"],
        json!({ "low": "low" })
    );
    assert_eq!(
        entry["models"][0]["thinking"]["requiresEffort"],
        json!(true)
    );
    assert_eq!(
        file["providers"]["untouched"],
        json!({ "api": "openai-completions", "baseUrl": "https://legacy.test/v1" })
    );
}

#[tokio::test]
async fn the_editor_skeleton_takes_a_provider_as_block_yaml() {
    let dir = folder("skeleton");
    fs::write(models_path(&dir), SKELETON).unwrap();
    let stock = Fake::new();
    let mut input = minimal_map();
    input.insert(
        "headers".into(),
        json!({ "X-Key": "yes", "Odd": "a: b #c", "Num": "0x10", "Empty": "" }),
    );
    upsert(&stock, &dir, &Value::Object(input), false)
        .await
        .unwrap();
    let (text, file) = saved(&dir);
    assert!(
        text.starts_with("# Custom model providers.\nproviders:\n  test-provider:\n"),
        "{text}"
    );
    assert_eq!(
        file["providers"]["test-provider"]["headers"],
        json!({ "X-Key": "yes", "Odd": "a: b #c", "Num": "0x10", "Empty": "" })
    );
}

fn thinking_ranges(mut config: Value) -> Value {
    for entry in config["providers"]
        .as_object_mut()
        .into_iter()
        .flat_map(|providers| providers.values_mut())
    {
        for model in entry["models"].as_array_mut().into_iter().flatten() {
            if let Some(thinking) = model.get_mut("thinking").and_then(Value::as_object_mut)
                && let (Some(min), Some(max)) = (
                    thinking.shift_remove("minLevel"),
                    thinking.shift_remove("maxLevel"),
                )
            {
                thinking.insert("efforts".into(), json!([min, "medium", max]));
            }
        }
    }
    config
}

#[tokio::test]
async fn stocks_normalization_is_written_back() {
    let dir = folder("normalize");
    fs::write(
        models_path(&dir),
        "providers:\n  test-provider:\n    api: openai-completions\n    baseUrl: https://api.test/v1\n    models:\n      - id: ranged # comment\n        thinking: {mode: effort, minLevel: low, maxLevel: high}\n",
    )
    .unwrap();
    let stock = Fake {
        normalize: thinking_ranges,
        ..Fake::new()
    };
    let view = views(&stock, &dir).await.unwrap().remove(0);
    assert_eq!(
        view["models"][0]["thinking"]["efforts"],
        json!(["low", "medium", "high"])
    );
    let mut input = minimal_map();
    input.insert("models".into(), view["models"].clone());
    upsert(&stock, &dir, &Value::Object(input), false)
        .await
        .unwrap();
    let (text, file) = saved(&dir);
    assert_eq!(
        file["providers"]["test-provider"]["models"][0]["thinking"],
        json!({ "mode": "effort", "efforts": ["low", "medium", "high"] })
    );
    assert!(text.contains("# comment"), "{text}");
}

#[tokio::test]
async fn a_built_in_models_override_is_written_and_reset_away() {
    let dir = folder("override");
    fs::write(
        models_path(&dir),
        "providers:\n  anthropic:\n    modelOverrides:\n      claude-x:\n        cost: {input: 1, output: 2, cacheRead: 0, cacheWrite: 0}\n        compat: {supportsStore: false}\n",
    )
    .unwrap();
    let stock = Fake::new();
    let input = json!({
        "contextWindow": 64000,
        "maxTokens": 8000,
        "api": "anthropic-messages",
        "thinking": { "mode": "effort", "efforts": ["low", "high"], "effortMap": { "high": "max" } },
        "replayReasoning": true,
    });
    set_override(&stock, &dir, "anthropic", "claude-x", Some(&input))
        .await
        .unwrap();
    let written = saved(&dir).1["providers"]["anthropic"]["modelOverrides"]["claude-x"].clone();
    assert_eq!(
        written["compat"],
        json!({ "supportsStore": false, "requiresReasoningContentForToolCalls": true })
    );
    assert_eq!(
        written["cost"],
        json!({ "input": 1, "output": 2, "cacheRead": 0, "cacheWrite": 0 })
    );
    let view = views(&stock, &dir).await.unwrap().remove(0);
    assert_eq!(view["builtin"], json!(true));
    assert_eq!(
        view["modelOverrides"]["claude-x"],
        json!({ "api": "anthropic-messages", "thinking": { "mode": "effort", "efforts": ["low", "high"], "effortMap": { "high": "max" } }, "contextWindow": 64000, "maxTokens": 8000, "replayReasoning": true })
    );
    set_override(&stock, &dir, "anthropic", "claude-x", Some(&json!({})))
        .await
        .unwrap();
    assert_eq!(
        saved(&dir).1["providers"]["anthropic"]["modelOverrides"]["claude-x"],
        json!({ "cost": { "input": 1, "output": 2, "cacheRead": 0, "cacheWrite": 0 }, "compat": { "supportsStore": false } })
    );
    set_override(&stock, &dir, "anthropic", "claude-x", None)
        .await
        .unwrap();
    assert_eq!(saved(&dir).1, json!({ "providers": {} }));
}

#[tokio::test]
async fn refusals_write_nothing() {
    let dir = folder("refusals");
    let stock = Fake::new();
    upsert(&stock, &dir, &Value::Object(minimal_map()), false)
        .await
        .unwrap();
    let before = saved(&dir).0;
    let mut bad = minimal_map();
    bad.insert("api".into(), json!("not-a-stock-api"));
    let fault = upsert(&stock, &dir, &Value::Object(bad), false)
        .await
        .unwrap_err();
    assert!(
        fault.message.contains("ModelsConfigSchema"),
        "{}",
        fault.message
    );
    let mut builtin = minimal_map();
    builtin.insert("id".into(), json!("anthropic"));
    assert_eq!(
        upsert(&stock, &dir, &Value::Object(builtin), false)
            .await
            .unwrap_err()
            .code,
        "provider_id_builtin"
    );
    assert_eq!(
        delete(&stock, &dir, "anthropic").await.unwrap_err().code,
        "provider_builtin_delete"
    );
    let no_roster = Fake {
        roster_fails: true,
        ..Fake::new()
    };
    assert!(
        upsert(&no_roster, &dir, &Value::Object(minimal_map()), false)
            .await
            .unwrap_err()
            .message
            .contains("catalog roster")
    );
    assert!(
        delete(&no_roster, &dir, "test-provider")
            .await
            .unwrap_err()
            .message
            .contains("catalog roster")
    );
    // A text the editor would misread is never written.
    let misread = Fake {
        misread: Some(|mut raw| {
            raw["providers"]["test-provider"]["baseUrl"] = json!("elsewhere");
            raw
        }),
        ..Fake::new()
    };
    let mut renamed = minimal_map();
    renamed.insert("baseUrl".into(), json!("https://moved.test"));
    assert_eq!(
        upsert(&misread, &dir, &Value::Object(renamed), false)
            .await
            .unwrap_err()
            .code,
        "models_edit"
    );
    assert_eq!(saved(&dir).0, before);
}

#[tokio::test]
async fn a_file_edited_elsewhere_during_a_save_is_kept() {
    let dir = folder("raced");
    let seeded =
        "providers:\n  other:\n    api: openai-completions\n    baseUrl: https://other.test/v1\n";
    fs::write(models_path(&dir), seeded).unwrap();
    let edited = format!("{seeded}# edited externally\n");
    let file = models_path(&dir);
    let stock = Fake::new();
    let write_edit = edited.clone();
    // Check 1 is the read, 2 the edited text: the other editor saves in between.
    *stock.on_check.lock().unwrap() =
        Some((2, Box::new(move || fs::write(&file, write_edit).unwrap())));
    let fault = upsert(&stock, &dir, &Value::Object(minimal_map()), false)
        .await
        .unwrap_err();
    assert!(
        fault.message.contains("changed on disk"),
        "{}",
        fault.message
    );
    assert_eq!(saved(&dir).0, edited);
}

#[tokio::test]
async fn the_text_editors_save_is_checked() {
    let dir = folder("text");
    let stock = Fake {
        normalize: thinking_ranges,
        ..Fake::new()
    };
    let opened = text(&dir).unwrap();
    assert_eq!((opened.text.as_str(), opened.exists), (SKELETON, false));
    let duplicate = "providers:\n  a: {api: x}\n  a: {api: y}\n".to_owned();
    let fault = save_text(&stock, &dir, duplicate, &opened.stamp)
        .await
        .unwrap_err();
    assert_eq!(fault.code, "invalid_content");
    assert!(fault.message.contains("unique"), "{}", fault.message);
    let unclosed = "providers:\n  a: [1, 2\n".to_owned();
    assert_eq!(
        save_text(&stock, &dir, unclosed, &opened.stamp)
            .await
            .unwrap_err()
            .code,
        "invalid_content"
    );
    assert!(!models_path(&dir).exists());
    let typed = "# mine\nproviders:\n  p:\n    api: openai-completions\n    models:\n      - id: m\n        thinking: {mode: effort, minLevel: low, maxLevel: high}\n".to_owned();
    let stamp_after = save_text(&stock, &dir, typed, &opened.stamp).await.unwrap();
    let reopened = text(&dir).unwrap();
    assert_eq!(reopened.stamp, stamp_after);
    assert!(reopened.text.starts_with("# mine\n"));
    assert_eq!(
        read_json(&reopened.text)["providers"]["p"]["models"][0]["thinking"]["efforts"],
        json!(["low", "medium", "high"])
    );
    let stale = save_text(&stock, &dir, SKELETON.to_owned(), &opened.stamp)
        .await
        .unwrap_err();
    assert_eq!(stale.code, "invalid_content");
    assert!(stale.message.contains("changed on disk"));
}

#[cfg(unix)]
#[tokio::test]
async fn a_symlinked_file_stays_a_link_with_its_targets_mode() {
    use std::os::unix::fs::PermissionsExt;
    let dir = folder("link");
    let target = dir.join("dotfiles").join("models.yml");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::write(&target, "providers: {}\n").unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).unwrap();
    std::os::unix::fs::symlink(&target, models_path(&dir)).unwrap();
    upsert(&Fake::new(), &dir, &Value::Object(minimal_map()), false)
        .await
        .unwrap();
    assert!(
        fs::symlink_metadata(models_path(&dir))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(
        read_json(&fs::read_to_string(&target).unwrap())["providers"]
            .get("test-provider")
            .is_some()
    );
    assert_eq!(
        fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o640
    );
    assert_eq!(fs::read_dir(target.parent().unwrap()).unwrap().count(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn a_dangling_link_is_reported_not_replaced() {
    let dir = folder("dangling");
    let missing = dir.join("dotfiles").join("models.yml");
    std::os::unix::fs::symlink(&missing, models_path(&dir)).unwrap();
    let fault = upsert(&Fake::new(), &dir, &Value::Object(minimal_map()), false)
        .await
        .unwrap_err();
    assert!(
        fault.message.contains(&missing.display().to_string()),
        "{}",
        fault.message
    );
    assert!(
        fs::symlink_metadata(models_path(&dir))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(!missing.exists());
}
