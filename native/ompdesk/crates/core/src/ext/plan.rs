//! `ExtensionApplyPlan` (`src/main/extension-reload.ts`): what live tabs do after an extension update. The extension
//! updater merges one per pass; the pool merges a plan into the one a busy tab still owes.

use serde_json::{Value, json};

/// `EMPTY_APPLY_PLAN`.
pub fn empty() -> Value {
    json!({"reload": false, "restart": false, "reconnect": []})
}

fn flag(plan: &Value, key: &str) -> bool {
    plan[key].as_bool().unwrap_or(false)
}

fn names(plan: &Value, key: &str) -> Vec<Value> {
    plan[key].as_array().cloned().unwrap_or_default()
}

/// `planIsEmpty`.
pub fn is_empty(plan: &Value) -> bool {
    !flag(plan, "reload")
        && !flag(plan, "restart")
        && names(plan, "reconnect").is_empty()
        && plan.get("mcp").is_none_or(Value::is_null)
}

/// Each name once, in the order first seen (`[...new Set([...a, ...b])]`).
fn union(a: Vec<Value>, b: Vec<Value>) -> Vec<Value> {
    let mut all = a;
    for name in b {
        if !all.contains(&name) {
            all.push(name);
        }
    }
    all
}

/// `mergeApplyPlans`.
pub fn merge(a: &Value, b: &Value) -> Value {
    let mut plan = json!({
        "reload": flag(a, "reload") || flag(b, "reload"),
        "restart": flag(a, "restart") || flag(b, "restart"),
        "reconnect": union(names(a, "reconnect"), names(b, "reconnect")),
    });
    let (ma, mb) = (&a["mcp"], &b["mcp"]);
    if !ma.is_null() || !mb.is_null() {
        plan["mcp"] = if flag(ma, "all") || flag(mb, "all") {
            json!({"names": [], "all": true})
        } else {
            json!({"names": union(names(ma, "names"), names(mb, "names"))})
        };
    }
    plan
}

#[cfg(test)]
mod tests {
    use super::*;

    // extension-reload.test.ts: merge/union.
    #[test]
    fn merges_flags_names_once_and_mcp_changes() {
        let a = json!({"reload": true, "restart": false, "reconnect": ["x", "y"]});
        let b = json!({"reload": false, "restart": true, "reconnect": ["y", "z"]});
        assert_eq!(
            merge(&a, &b),
            json!({"reload": true, "restart": true, "reconnect": ["x", "y", "z"]})
        );
        assert!(is_empty(&empty()));
        assert!(!is_empty(
            &json!({"reload": false, "restart": false, "reconnect": [], "mcp": {"names": ["m"]}})
        ));
        let one = json!({"reload": false, "restart": false, "reconnect": [], "mcp": {"names": ["m", "n"]}});
        let two = json!({"reload": false, "restart": false, "reconnect": [], "mcp": {"names": ["n", "o"]}});
        assert_eq!(merge(&one, &two)["mcp"], json!({"names": ["m", "n", "o"]}));
        assert_eq!(merge(&one, &empty())["mcp"], json!({"names": ["m", "n"]}));
        let all = json!({"reload": false, "restart": false, "reconnect": [], "mcp": {"names": [], "all": true}});
        assert_eq!(merge(&one, &all)["mcp"], json!({"names": [], "all": true}));
        assert!(merge(&a, &b).get("mcp").is_none());
    }
}
