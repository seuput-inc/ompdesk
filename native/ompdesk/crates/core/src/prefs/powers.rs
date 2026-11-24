//! The one-time "every agent power on" migration (was `src/main/agent-power-migration.ts`). The user's decision,
//! 29 Oct 2026: agents have every power by default, no setup. It runs once per profile (`VERSION`): every power an
//! older build or the person had stored off is on again; later changes in Settings are the person's and are never
//! touched, because the stored version stops a rerun. Main asks for it (`migratePowers`) before its first read.

use std::path::Path;

use serde::Serialize;
use serde_json::{Map, Value};
use yaml_edit::YamlNode;

use super::{read_key, remove_key, write_key};
use crate::disk::tree::write_atomic_if;
use crate::server::Fault;
use crate::yaml;

/// The pref holding the version of this migration that already ran.
const MIGRATED: &str = "agentPowersMigrated";
/// Bump only for another one-time "turn every power on" decision.
const VERSION: u64 = 1;

/// Switches that default on (only a stored `false` is off; `src/shared/agent-control.ts`, `ecc.ts`, `pstack.ts`): an
/// old explicit off is dropped.
const POWER_PREFS: &[&str] = &[
    "agentControl",
    "agentControlFull",
    "agentControlManage",
    "agentControlApprove",
    "pstack",
    "ecc",
];

/// A config.yml setting (`[section, key]`) and whether a value of it is the on one.
type StockPower = ([&'static str; 2], fn(&YamlNode) -> bool);

/// Stock settings in config.yml that gate an agent's power. A value that is not the on one is removed so stock's
/// default (`tools.approvalMode` yolo) and OMPdesk's held default (`computer.enabled`: on for the built-in engine,
/// held off while an omp runs on agent-desktop, `src/shared/computer-use.ts`) apply again.
const STOCK_POWERS: &[StockPower] = &[
    (["computer", "enabled"], |value| {
        // YAML 1.2's core schema `true`, as the `yaml` package read it.
        matches!(value, YamlNode::Scalar(scalar) if !scalar.is_quoted() && matches!(scalar.as_string().trim(), "true" | "True" | "TRUE"))
    }),
    (
        ["tools", "approvalMode"],
        |value| matches!(value, YamlNode::Scalar(scalar) if scalar.as_string() == "yolo"),
    ),
];

#[derive(Serialize, Debug, PartialEq)]
pub struct Report {
    /// Prefs that were stored off and are on again.
    pub prefs: Vec<String>,
    /// Dotted config.yml keys that were off (or stricter) and were removed.
    pub stock: Vec<String>,
    /// Why config.yml was left alone (unreadable, malformed, not writable); the prefs part still ran.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The migration on `store`, with the agent folder's `config.yml`; `None` when it had already run.
pub(super) fn migrate(
    store: &mut Map<String, Value>,
    agent_dir: &Path,
) -> Result<Option<Report>, Fault> {
    if read_key(store, MIGRATED)?
        .and_then(|done| done.as_f64())
        .is_some_and(|done| done >= VERSION as f64)
    {
        return Ok(None);
    }
    let mut report = Report {
        prefs: Vec::new(),
        stock: Vec::new(),
        error: None,
    };
    for key in POWER_PREFS {
        if read_key(store, key)? == Some(Value::Bool(false)) {
            remove_key(store, key)?;
            report.prefs.push((*key).to_owned());
        }
    }
    match reset_stock_powers(&agent_dir.join("config.yml")) {
        Ok(removed) => report.stock = removed,
        Err(error) => report.error = Some(error),
    }
    write_key(store, MIGRATED, Value::from(VERSION))?;
    Ok(Some(report))
}

/// Removes every power setting of config.yml that is not on, and a section it leaves empty; comments and the rest stay.
fn reset_stock_powers(file: &Path) -> Result<Vec<String>, String> {
    let text = match std::fs::read(file) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("{}: {error}", file.display())),
    };
    let doc =
        yaml::parse(&text).map_err(|error| format!("config.yml is not valid YAML: {error}"))?;
    let Some(root) = doc.as_mapping() else {
        return Ok(Vec::new());
    };
    let mut removed = Vec::new();
    for ([section, key], on) in STOCK_POWERS {
        let Some(YamlNode::Mapping(parent)) = root.get(*section) else {
            continue;
        };
        let Some(value) = parent.get(*key) else {
            continue;
        };
        if on(&value) {
            continue;
        }
        parent.remove(*key);
        if parent.is_empty() {
            root.remove(*section);
        }
        removed.push(format!("{section}.{key}"));
    }
    if removed.is_empty() {
        return Ok(removed);
    }
    // A config.yml that is a link (a dotfiles repository) stays one: its target takes the write, with its mode.
    let target =
        std::fs::canonicalize(file).map_err(|error| format!("{}: {error}", file.display()))?;
    let mode = file_mode(&target)?;
    write_atomic_if(&target, doc.to_string().as_bytes(), mode, 0o700, &|| true)
        .map_err(|fault| fault.message)?;
    Ok(removed)
}

#[cfg(unix)]
fn file_mode(target: &Path) -> Result<Option<u32>, String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(target)
        .map(|meta| Some(meta.permissions().mode() & 0o7777))
        .map_err(|error| format!("{}: {error}", target.display()))
}

#[cfg(not(unix))]
fn file_mode(_target: &Path) -> Result<Option<u32>, String> {
    Ok(None)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn folder(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ompdesk-powers-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn store(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn a_fresh_profile_records_that_it_ran() {
        let dir = folder("fresh");
        let mut prefs = Map::new();
        let report = migrate(&mut prefs, &dir).unwrap().unwrap();
        assert_eq!(
            report,
            Report {
                prefs: vec![],
                stock: vec![],
                error: None
            }
        );
        assert_eq!(prefs, store(json!({ "agentPowersMigrated": 1 })));
    }

    #[test]
    fn an_old_off_is_on_again_once_and_a_later_off_stays() {
        let dir = folder("prefs");
        let mut prefs = store(json!({
            "agentControl": false, "agentControlFull": false, "agentControlManage": false,
            "agentControlApprove": false, "pstack": false, "ecc": false, "language": "ko",
            "proxyUrl": "x",
        }));
        assert_eq!(migrate(&mut prefs, &dir).unwrap().unwrap().prefs.len(), 6);
        assert_eq!(
            prefs,
            store(json!({ "language": "ko", "proxyUrl": "x", "agentPowersMigrated": 1 }))
        );
        prefs.insert("pstack".into(), json!(false));
        assert_eq!(migrate(&mut prefs, &dir).unwrap(), None);
        assert_eq!(prefs["pstack"], json!(false));
        let mut kept = store(json!({ "ecc": true, "agentControlApprove": true }));
        assert!(migrate(&mut kept, &dir).unwrap().unwrap().prefs.is_empty());
        assert_eq!(kept["ecc"], json!(true));
    }

    #[test]
    fn config_yml_loses_only_the_settings_that_are_off() {
        let dir = folder("stock");
        let file = dir.join("config.yml");
        std::fs::write(
            &file,
            "theme: dark # mine\ncomputer:\n  enabled: false\ntools:\n  approvalMode: always-ask\n  approval:\n    bash: prompt\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let report = migrate(&mut Map::new(), &dir).unwrap().unwrap();
        assert_eq!(report.stock, ["computer.enabled", "tools.approvalMode"]);
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "theme: dark # mine\ntools:\n  approval:\n    bash: prompt\n"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let on = "computer:\n  enabled: true\ntools:\n  approvalMode: yolo\n";
        std::fs::write(&file, on).unwrap();
        assert!(
            migrate(&mut Map::new(), &dir)
                .unwrap()
                .unwrap()
                .stock
                .is_empty()
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), on);
        assert_eq!(
            migrate(&mut Map::new(), &dir.join("absent"))
                .unwrap()
                .unwrap()
                .stock,
            Vec::<String>::new()
        );
    }

    #[test]
    fn a_malformed_config_yml_is_reported_and_left_alone() {
        let dir = folder("malformed");
        let file = dir.join("config.yml");
        std::fs::write(&file, "a: [unclosed\n").unwrap();
        let mut prefs = store(json!({ "pstack": false }));
        let report = migrate(&mut prefs, &dir).unwrap().unwrap();
        assert_eq!(report.prefs, ["pstack"]);
        assert!(
            report
                .error
                .unwrap()
                .contains("config.yml is not valid YAML")
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "a: [unclosed\n");
        assert_eq!(prefs["agentPowersMigrated"], json!(1));
    }
}
