use super::*;
use serde_json::{Value, json};

const ID: &str = "{12345678-abcd-0000-0000-123456789abc}";
const OLD: &str = "{12345678-abcd-0000-0000-000000000001}";

#[test]
fn registry_default_binds_by_id_and_only_a_registered_v2_can_be_probed() {
    let distro = |id: &str, name: &str, version| {
        Distribution::registered(id.into(), name.into(), version, Some(OLD)).unwrap()
    };
    let mut inventory = Inventory {
        app_version: Some("2.7.13.0".into()),
        distributions: vec![
            distro(OLD, "이전", 1),
            distro(&ID.to_uppercase(), "작업", 2),
        ],
    };
    assert_eq!(
        serde_json::to_value(&inventory).unwrap(),
        json!({
            "appVersion": "2.7.13.0", "distributions": [
                {"id": OLD, "name": "이전", "version": 1, "isDefault": true},
                {"id": ID, "name": "작업", "version": 2, "isDefault": false}
            ]
        })
    );
    assert_eq!(inventory.registered_v2(&ID.to_uppercase()).unwrap().id, ID);
    assert_eq!(inventory.registered_v2(OLD).unwrap_err().code, "wsl_not_v2");
    for other in ["작업", "{12345678-abcd-0000-0000-000000000002}"] {
        assert_eq!(
            inventory.registered_v2(other).unwrap_err().code,
            "wsl_not_registered"
        );
    }
    assert!(Distribution::registered(ID.into(), "x".into(), 0, None).is_err());
    assert!(Distribution::registered(ID.into(), "x\ny".into(), 2, None).is_err());
    assert!(Distribution::registered("-d Ubuntu".into(), "x".into(), 2, None).is_err());
    assert_eq!(package_version("2.7.13.0"), Some([2, 7, 13, 0]));
    assert_eq!(package_version("2.7.13"), Some([2, 7, 13, 0]));
    assert_eq!(package_version("WSL version: 2.7.13.0"), None);
}

fn measured() -> Value {
    json!({"git":"2.43.0", "bun":"1.3.14", "omp":serde_json::from_str::<&str>(MINIMUM).unwrap(),
        "enginesBun":">=1.3.14", "launchable":true})
}

fn line(v: &Value) -> Vec<u8> {
    let mut buf = serde_json::to_vec(v).unwrap();
    buf.push(b'\n');
    buf
}

#[test]
fn readiness_requires_a_safe_package_and_both_real_floors_without_losing_observed_versions() {
    let good = measured();
    assert!(parse_tools(&line(&good)).unwrap().ready);
    for (field, value) in [
        ("launchable", json!(false)),
        ("git", Value::Null),
        ("omp", json!("18.10.4")),
        ("bun", json!("1.3.13")),
        ("bun", json!("1.4.0-beta.1")),
        ("enginesBun", json!(">=1.3.15")),
        ("enginesBun", Value::Null),
    ] {
        let mut raw = good.clone();
        raw[field] = value;
        let reply = serde_json::to_value(parse_tools(&line(&raw)).unwrap()).unwrap();
        raw["ready"] = json!(false);
        assert_eq!(reply, raw, "{field}");
    }
    let mut raw = good;
    raw["enginesBun"] = json!("  >= v1.3.14 ");
    raw["bun"] = json!("1.3.14+build.1");
    let parsed = parse_tools(&line(&raw)).unwrap();
    assert!(parsed.ready);
    assert_eq!(parsed.tools.engines_bun.as_deref(), Some(">=1.3.14"));
}

#[test]
fn malformed_output_and_non_version_payloads_never_cross_the_rpc_boundary() {
    let good = measured();
    let mut probes = vec![
        line(&json!(["2.1.0", "1.3.14", "19.2.0", ">=1.3.14", true])),
        format!("{good}\n{good}\n").into_bytes(),
        serde_json::to_vec(&good).unwrap(),
        format!("{good}{}\n", " ".repeat(4096)).into_bytes(),
    ];
    for field in ["git", "bun", "omp", "enginesBun", "launchable"] {
        let mut raw = good.clone();
        raw.as_object_mut().unwrap().remove(field);
        probes.push(line(&raw));
    }
    for (field, value) in [
        ("cwd", "/project"),
        ("ready", "true"),
        ("git", "2.43.0\nsecret"),
        ("bun", "/usr/bin/bun"),
        ("enginesBun", "*"),
        ("omp", "19.2.0-rc.1"),
    ] {
        let mut raw = good.clone();
        raw[field] = json!(value);
        probes.push(line(&raw));
    }
    for bytes in probes {
        assert_eq!(parse_tools(&bytes).err().unwrap(), failed());
    }
}

#[cfg(unix)]
fn fake_system(script: &str) -> tempfile::TempDir {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let exe = dir.path().join("wsl.exe");
    std::fs::write(&exe, format!("#!/bin/sh\nset -eu\n{script}\n")).unwrap();
    std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o700)).unwrap();
    dir
}

#[cfg(unix)]
#[tokio::test]
async fn sends_only_the_embedded_probe_over_stdin_to_the_exact_id() {
    let dir = fake_system(
        r#"
[ "$#" -eq 12 ]
[ "$*" = '--distribution-id {12345678-abcd-0000-0000-123456789abc} --cd / --exec /usr/bin/env -i /usr/bin/timeout --kill-after=1s 10s /bin/sh -s' ]
[ "${HOME-unset}" = unset ]
[ "$WSLENV" = '' ]
/usr/bin/cmp -s expected -
/bin/cat reply
"#,
    );
    std::fs::write(dir.path().join("expected"), PROBE).unwrap();
    std::fs::write(dir.path().join("reply"), line(&measured())).unwrap();
    assert!(
        probe(ID, &Scope::detached(), dir.path())
            .await
            .unwrap()
            .ready
    );
}

#[cfg(unix)]
#[tokio::test(start_paused = true)]
async fn bounds_a_silent_launcher_without_needing_a_real_distribution() {
    let dir = fake_system("exec /bin/sleep 60");
    assert_eq!(
        probe(ID, &Scope::detached(), dir.path())
            .await
            .err()
            .unwrap(),
        failed()
    );
}
