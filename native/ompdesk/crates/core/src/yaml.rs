//! A YAML file the app edits for the person (`models.yml`, the agent's `config.yml`), changed in place on yaml-edit's
//! lossless tree, as `models-config.ts` did on the `yaml` package's Document: a changed value is set where it stands,
//! a mapping is diffed key by key and a list of the same length item by item, so every comment and the layout of what
//! the edit does not reach stay as the person wrote them. A new value is written as block YAML (flow inside a flow
//! collection), a string quoted only when plain text would read as something else.
//!
//! This module only edits. Stock reads its files with Bun.YAML, and yaml-edit both accepts some text Bun refuses and
//! is a second reader, so a caller whose edit must mean exactly something checks the text against stock's own parse
//! (`models/file`).

use std::str::FromStr;

use serde_json::Value;
use yaml_edit::{Document, YamlNode};

/// The text as a document, refused when it does not parse or a mapping repeats a key (the `yaml` package refused
/// that; Bun.YAML keeps the last, so the person would lose the first without a word).
pub(crate) fn parse(text: &str) -> Result<Document, String> {
    let doc = Document::from_str(text).map_err(|error| error.to_string())?;
    if let Some(root) = doc.as_mapping() {
        unique_keys(&YamlNode::Mapping(root))?;
    } else if let Some(root) = doc.as_sequence() {
        unique_keys(&YamlNode::Sequence(root))?;
    }
    Ok(doc)
}

fn unique_keys(node: &YamlNode) -> Result<(), String> {
    match node {
        YamlNode::Mapping(mapping) => {
            let mut seen = std::collections::HashSet::new();
            for (key, value) in mapping.iter() {
                if let YamlNode::Scalar(key) = &key
                    && !seen.insert(key.as_string())
                {
                    return Err(format!("Map keys must be unique: \"{}\"", key.as_string()));
                }
                unique_keys(&value)?;
            }
            Ok(())
        }
        YamlNode::Sequence(sequence) => sequence.values().try_for_each(|item| unique_keys(&item)),
        _ => Ok(()),
    }
}

/// `text` (read as `before`) changed to say `after`. A text with no top-level mapping (missing, empty or only
/// comments) keeps what it has and gets `after` appended.
pub(crate) fn edit(text: &str, before: &Value, after: &Value) -> Result<String, String> {
    // yaml-edit is a young crate: a panic inside it refuses the edit instead of ending the core.
    std::panic::catch_unwind(|| edit_unguarded(text, before, after))
        .unwrap_or_else(|_| Err("the YAML editor failed on this file".into()))
}

fn edit_unguarded(text: &str, before: &Value, after: &Value) -> Result<String, String> {
    if before == after {
        return Ok(text.to_owned());
    }
    let doc = parse(text)?;
    let Some(root) = doc.as_mapping() else {
        if !matches!(before, Value::Null) && before.as_object().is_none_or(|map| !map.is_empty()) {
            return Err("models.yml's top level is not a mapping".into());
        }
        let kept = text.trim_end();
        let body = emit(after, 0);
        let body = body.trim_start_matches('\n');
        return Ok(if kept.is_empty() {
            format!("{body}\n")
        } else {
            format!("{kept}\n{body}\n")
        });
    };
    if !apply(&YamlNode::Mapping(root), before, after, false) {
        return Err("models.yml's top level cannot be edited in place".into());
    }
    Ok(doc.to_string())
}

/// Puts `after` into `target`, which reads as `before`; false when it cannot be done in place and the caller replaces
/// the whole node (a scalar, a list whose length changed, a collection that becomes empty).
fn apply(target: &YamlNode, before: &Value, after: &Value, in_flow: bool) -> bool {
    match (target, before, after) {
        (YamlNode::Mapping(mapping), Value::Object(old), Value::Object(new)) => {
            let flow = mapping.is_flow_style();
            if new.is_empty() && !old.is_empty() || flow && old.is_empty() && !in_flow {
                return false;
            }
            for key in old.keys() {
                if !new.contains_key(key) {
                    mapping.remove(key.as_str());
                }
            }
            for (key, value) in new {
                if old.get(key) == Some(value) {
                    continue;
                }
                let in_place = match (old.get(key), mapping.get(key.as_str())) {
                    (Some(was), Some(child)) => apply(&child, was, value, flow),
                    _ => false,
                };
                if !in_place {
                    mapping.set(key.as_str(), node(value, flow));
                }
            }
            true
        }
        (YamlNode::Sequence(sequence), Value::Array(old), Value::Array(new))
            if old.len() == new.len() && sequence.len() == old.len() =>
        {
            let flow = sequence.is_flow_style();
            for (index, (was, value)) in old.iter().zip(new).enumerate() {
                if was == value {
                    continue;
                }
                let in_place = sequence
                    .get(index)
                    .is_some_and(|child| apply(&child, was, value, flow));
                if !in_place {
                    sequence.set(index, node(value, flow));
                }
            }
            true
        }
        _ => false,
    }
}

/// `value` as a node to put in: block YAML, or flow inside a flow collection.
fn node(value: &Value, flow: bool) -> YamlNode {
    let text = if flow {
        format!("x: {}\n", emit_flow(value))
    } else {
        format!("x:{}\n", emit(value, 2))
    };
    // Text this module wrote from JSON always parses to one mapping with `x`.
    Document::from_str(&text)
        .ok()
        .and_then(|doc| doc.as_mapping())
        .and_then(|mapping| mapping.get("x"))
        .expect("emitted YAML parses")
}

/// `value` as what follows `key:` in block YAML, its nested lines at `indent`.
fn emit(value: &Value, indent: usize) -> String {
    let pad = " ".repeat(indent);
    match value {
        Value::Object(map) if map.is_empty() => " {}".into(),
        Value::Array(list) if list.is_empty() => " []".into(),
        Value::Object(map) => map
            .iter()
            .map(|(key, value)| {
                format!("\n{pad}{}:{}", string(key, false), emit(value, indent + 2))
            })
            .collect(),
        Value::Array(list) => list
            .iter()
            .map(|item| match item {
                // An item's mapping starts on the dash's line.
                Value::Object(map) if !map.is_empty() => {
                    format!("\n{pad}- {}", emit(item, indent + 2).trim_start())
                }
                _ => format!("\n{pad}-{}", emit(item, indent + 2)),
            })
            .collect(),
        _ => format!(" {}", scalar(value, false)),
    }
}

fn emit_flow(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let pairs: Vec<String> = map
                .iter()
                .map(|(key, value)| format!("{}: {}", string(key, true), emit_flow(value)))
                .collect();
            format!("{{{}}}", pairs.join(", "))
        }
        Value::Array(list) => {
            let items: Vec<String> = list.iter().map(emit_flow).collect();
            format!("[{}]", items.join(", "))
        }
        _ => scalar(value, true),
    }
}

fn scalar(value: &Value, flow: bool) -> String {
    match value {
        Value::String(text) => string(text, flow),
        other => other.to_string(),
    }
}

/// A string plain when YAML can only read it back as that string, else double-quoted (JSON's escapes are YAML's).
fn string(text: &str, flow: bool) -> String {
    if plain(text, flow) {
        text.to_owned()
    } else {
        Value::String(text.to_owned()).to_string()
    }
}

fn plain(text: &str, flow: bool) -> bool {
    let mut chars = text.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || "-_./@+".contains(c) || c == ':' && !flow)
        && !text.ends_with(':')
        && !matches!(
            text.to_ascii_lowercase().as_str(),
            "true" | "false" | "null" | "yes" | "no" | "on" | "off" | "y" | "n"
        )
}
