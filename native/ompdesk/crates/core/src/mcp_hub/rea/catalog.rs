use std::sync::LazyLock;

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::{error, field};
use crate::remote::events::js;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Config {
    pub version: String,
    curated_tools: Vec<String>,
}

pub(super) static CONFIG: LazyLock<Config> = LazyLock::new(|| {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../resources/omp-builtin/rea/rea-config.json"
    )))
    .expect("bundled REA configuration")
});
static META_TOOLS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("meta-tools.json")).expect("relay tool descriptors")
});

#[derive(Default)]
pub(super) struct Catalog(pub Map<String, Value>);

pub(super) enum ToolCall {
    Answer(Value),
    Relay(Value),
}

impl Catalog {
    pub fn append(&mut self, tools: Value) -> Result<(), Value> {
        if let Value::Array(tools) = tools {
            for tool in tools {
                if let Some(name) = tool["name"].as_str()
                    && tool["inputSchema"].is_object()
                {
                    self.0.insert(name.to_owned(), tool);
                } else {
                    return Err(error(-32603, "REA returned an invalid tool catalog"));
                }
            }
            Ok(())
        } else {
            Err(error(-32603, "REA returned an invalid tool catalog"))
        }
    }

    pub fn same(&self, other: &Self) -> bool {
        self.0.len() == other.0.len()
            && self
                .0
                .values()
                .zip(other.0.values())
                .all(|(a, b)| js::same_json(a, b))
    }

    pub fn list(&self) -> Value {
        let tools = self
            .0
            .iter()
            .filter(|(name, _)| CONFIG.curated_tools.contains(name))
            .map(|(_, tool)| tool)
            .chain(META_TOOLS.iter())
            .cloned()
            .collect();
        field("tools", Value::Array(tools))
    }

    pub fn call(&self, mut params: Value) -> Result<ToolCall, Value> {
        let name = params["name"]
            .as_str()
            .ok_or_else(|| error(-32602, "Expected tool name and object arguments"))?;
        let empty = Map::new();
        let args = params
            .get("arguments")
            .map_or(Some(&empty), Value::as_object)
            .ok_or_else(|| error(-32602, "Expected tool name and object arguments"))?;
        match name {
            "rea_catalog" => self.search(args).map(ToolCall::Answer),
            "rea_call" => {
                let Some(target) = args.get("name").and_then(Value::as_str) else {
                    return Err(error(-32602, "Expected REA name and object arguments"));
                };
                if args.len() != 2 || !args.get("arguments").is_some_and(Value::is_object) {
                    return Err(error(-32602, "Expected REA name and object arguments"));
                }
                if !self.0.contains_key(target) {
                    return Err(error(-32602, format!("Unknown REA tool: {target}")));
                }
                let mut input = params["arguments"].take();
                params["name"] = input["name"].take();
                params["arguments"] = input["arguments"].take();
                Ok(ToolCall::Relay(params))
            }
            name if CONFIG.curated_tools.iter().any(|allowed| allowed == name)
                && self.0.contains_key(name) =>
            {
                Ok(ToolCall::Relay(params))
            }
            name => Err(error(
                -32602,
                format!("Tool is not exposed: {name}; use rea_call"),
            )),
        }
    }

    fn search(&self, args: &Map<String, Value>) -> Result<Value, Value> {
        if args
            .iter()
            .any(|(key, value)| !matches!(key.as_str(), "query" | "name") || !value.is_string())
        {
            return Err(error(-32602, "Expected optional query and name strings"));
        }
        let name = args.get("name").and_then(Value::as_str);
        if let Some(name) = name
            && !self.0.contains_key(name)
        {
            return Err(error(-32602, format!("Unknown REA tool: {name}")));
        }
        let exact = name.filter(|name| !name.is_empty());
        let query = args
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        let words: Vec<_> = query
            .split(|c: char| c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}'))
            .filter(|s| !s.is_empty())
            .collect();
        let mut tools = Vec::new();
        for (name, tool) in &self.0 {
            if exact.is_some_and(|wanted| wanted != name) {
                continue;
            }
            let description = tool["description"].as_str().unwrap_or("");
            if !words.is_empty() {
                let text = format!("{name} {description}").to_lowercase();
                if !words.iter().all(|word| text.contains(word)) {
                    continue;
                }
            }
            tools.push(if exact.is_some() {
                tool.clone()
            } else {
                let first = description
                    .split_once('\n')
                    .map_or(description, |(line, _)| {
                        line.strip_suffix('\r').unwrap_or(line)
                    });
                json!({"name": name, "description": first})
            });
        }
        let text = js::stringify(&field("tools", Value::Array(tools)));
        Ok(json!({"content":[{"type":"text", "text":text}]}))
    }
}
