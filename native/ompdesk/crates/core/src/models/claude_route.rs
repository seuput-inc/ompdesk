//! Claude API key route host policy (was `src/main/local/claude-api-route.ts`): tracks per-key assignment order across
//! local tabs so simultaneous fresh sessions take distinct verified keys, while honoring a session's pinned key without
//! advancing the round-robin sequence.
//!
//! `models.claudeRoutePick {eligible, pinned?}` runs synchronously on the server read loop (`server::at_once`), so
//! concurrent selections from main serialize in arrival order and reserve atomically before answering.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use serde::Deserialize;

use super::locked;
use crate::server::{Call, Fault, Registry, Reply, at_once};

/// Dedicated numbered Claude API key provider ids (`anthropic-api-key`, `anthropic-api-key-2`, …), matching
/// `resources/gui-bridge/claude-key-id.ts`.
pub(super) fn is_claude_key_id(id: &str) -> bool {
    id == "anthropic-api-key"
        || id
            .strip_prefix("anthropic-api-key-")
            .is_some_and(|suffix| !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit()))
}

pub(super) fn register(registry: &mut Registry) {
    registry.add("models.claudeRoutePick", |call| at_once(pick(&call)));
}

#[derive(Default)]
struct Router {
    assigned: HashMap<String, u64>,
    sequence: u64,
}

static ROUTER: LazyLock<Mutex<Router>> = LazyLock::new(Default::default);

#[derive(Deserialize)]
struct PickParams {
    eligible: Vec<String>,
    #[serde(default)]
    pinned: Option<String>,
}

impl Router {
    fn pick(&mut self, eligible: &[String], pinned: Option<&str>) -> Result<String, Fault> {
        let chosen = match pinned {
            Some(id) => Some(id),
            None => eligible.iter().map(String::as_str).fold(None, |least, id| {
                let pick = match least {
                    None => true,
                    Some(best) => {
                        self.assigned.get(id).copied().unwrap_or(0)
                            < self.assigned.get(best).copied().unwrap_or(0)
                    }
                };
                if pick { Some(id) } else { least }
            }),
        };
        let valid = chosen.filter(|id| !id.is_empty() && eligible.iter().any(|item| item == id));
        let Some(provider) = valid else {
            let has_pin = pinned.is_some_and(|id| !id.is_empty());
            return Err(if has_pin {
                Fault::new(
                    "claude_route_pinned_unavailable",
                    "The pinned Claude API key does not offer this model",
                )
            } else {
                Fault::new(
                    "claude_route_unavailable",
                    "No verified Claude API key offers this model",
                )
            });
        };
        let provider = provider.to_owned();
        if pinned.is_none_or(str::is_empty) {
            self.sequence += 1;
            self.assigned.insert(provider.clone(), self.sequence);
        }
        Ok(provider)
    }
}

fn pick(call: &Call) -> Result<Reply, Fault> {
    let params: PickParams = call.params()?;
    let provider = locked(&ROUTER).pick(&params.eligible, params.pinned.as_deref())?;
    Reply::json(&provider)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    fn list(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn recognizes_numbered_claude_key_provider_ids() {
        for valid in [
            "anthropic-api-key",
            "anthropic-api-key-0",
            "anthropic-api-key-2",
            "anthropic-api-key-42",
        ] {
            assert!(is_claude_key_id(valid), "{valid}");
        }
        for invalid in [
            "",
            "anthropic",
            "anthropic-api-key-",
            "anthropic-api-key-a",
            "anthropic-api-key-2-extra",
            "custom",
        ] {
            assert!(!is_claude_key_id(invalid), "{invalid}");
        }
    }

    #[test]
    fn picks_least_recently_assigned_key_and_preserves_order_on_ties() {
        let mut router = Router::default();
        let eligible = list(&["anthropic-api-key", "anthropic-api-key-2"]);
        assert_eq!(router.pick(&eligible, None).unwrap(), "anthropic-api-key");
        assert_eq!(router.pick(&eligible, None).unwrap(), "anthropic-api-key-2");
        assert_eq!(router.pick(&eligible, None).unwrap(), "anthropic-api-key");
        // A newly added verified key (never assigned) takes priority over previously assigned ones.
        let expanded = list(&[
            "anthropic-api-key",
            "anthropic-api-key-2",
            "anthropic-api-key-3",
        ]);
        assert_eq!(router.pick(&expanded, None).unwrap(), "anthropic-api-key-3");
        assert_eq!(router.pick(&expanded, None).unwrap(), "anthropic-api-key-2");
    }

    #[test]
    fn honors_eligible_pin_without_advancing_sequence_and_refuses_unavailable_pin() {
        let mut router = Router::default();
        let eligible = list(&["anthropic-api-key", "anthropic-api-key-2"]);
        assert_eq!(router.pick(&eligible, None).unwrap(), "anthropic-api-key");
        assert_eq!(
            router.pick(&eligible, Some("anthropic-api-key-2")).unwrap(),
            "anthropic-api-key-2"
        );
        // Pinning key-2 did not reserve it, so the next unpinned session still takes key-2.
        assert_eq!(router.pick(&eligible, None).unwrap(), "anthropic-api-key-2");
        let fault = router
            .pick(&eligible, Some("anthropic-api-key-3"))
            .unwrap_err();
        assert_eq!(fault.code, "claude_route_pinned_unavailable");
        assert_eq!(
            fault.message,
            "The pinned Claude API key does not offer this model"
        );
    }

    #[test]
    fn refuses_empty_eligible_list_and_empty_string_pin() {
        let mut router = Router::default();
        let empty = router.pick(&[], None).unwrap_err();
        assert_eq!(empty.code, "claude_route_unavailable");
        assert_eq!(
            empty.message,
            "No verified Claude API key offers this model"
        );

        let eligible = list(&["anthropic-api-key"]);
        let blank_pin = router.pick(&eligible, Some("")).unwrap_err();
        assert_eq!(blank_pin.code, "claude_route_unavailable");
        assert_eq!(
            blank_pin.message,
            "No verified Claude API key offers this model"
        );
    }

    #[tokio::test]
    async fn wire_pick_reserves_distinct_keys_for_back_to_back_requests() {
        let (client, server_io) = tokio::io::duplex(1 << 16);
        let (server_read, server_write) = tokio::io::split(server_io);
        let mut registry = Registry::default();
        register(&mut registry);
        let server = tokio::spawn(crate::serve(server_read, server_write, registry));
        let (client_read, mut client_write) = tokio::io::split(client);
        let mut lines = BufReader::new(client_read);

        let eligible = json!(["wire-claude-key-1", "wire-claude-key-2"]);
        let batch = format!(
            "{}\n{}\n{}\n{}\n",
            json!({"id": 1, "method": "models.claudeRoutePick", "params": {"eligible": eligible}}),
            json!({"id": 2, "method": "models.claudeRoutePick", "params": {"eligible": eligible}}),
            json!({"id": 3, "method": "models.claudeRoutePick", "params": {"eligible": eligible, "pinned": "wire-claude-key-2"}}),
            json!({"id": 4, "method": "models.claudeRoutePick", "params": {"eligible": eligible, "pinned": "wire-claude-key-3"}}),
        );
        client_write.write_all(batch.as_bytes()).await.unwrap();
        client_write.shutdown().await.unwrap();

        let mut answers = HashMap::new();
        let mut line = String::new();
        while lines.read_line(&mut line).await.unwrap() > 0 {
            let frame: Value = serde_json::from_str(&line).unwrap();
            if let Some(id) = frame.get("id").and_then(Value::as_u64) {
                answers.insert(id, frame);
            }
            line.clear();
        }
        server.await.unwrap().unwrap();
        assert_eq!(answers[&1]["result"], "wire-claude-key-1");
        assert_eq!(answers[&2]["result"], "wire-claude-key-2");
        assert_eq!(answers[&3]["result"], "wire-claude-key-2");
        assert_eq!(answers[&4]["ok"], false);
        assert_eq!(
            answers[&4]["error"]["message"],
            "The pinned Claude API key does not offer this model"
        );
    }
}
