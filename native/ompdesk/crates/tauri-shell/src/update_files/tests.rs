use super::handle;
use serde_json::{Value, json};
use std::fs;
use std::os::unix::fs::symlink;
use tempfile::tempdir;

const ASSET: &str = "ompdesk-1.2.3-rc.4+build.5-arm64.dmg";

#[test]
fn destination_uses_linked_downloads_but_never_follows_installer_links() {
    let tmp = tempdir().unwrap();
    let volume = tmp.path().join("volume");
    fs::create_dir(&volume).unwrap();
    let downloads = tmp.path().join("Downloads");
    symlink(&volume, &downloads).unwrap();
    let root = downloads.as_path();
    symlink("missing", root.join(ASSET)).unwrap();
    let chosen = "ompdesk-1.2.3-rc.4+build.5-arm64 (2).dmg";
    assert_eq!(
        handle(
            "app.updateDestination",
            &json!({"asset": ASSET}),
            root,
            root
        )
        .unwrap(),
        json!(root.join(chosen))
    );
    assert!(!root.join(chosen).exists());
    let debris = "ompdesk-1.2.3.dmg.download-12";
    fs::write(volume.join(debris), b"old").unwrap();
    assert_eq!(
        handle(
            "app.sweepUpdateFiles",
            &json!({"area":"downloads"}),
            root,
            root
        )
        .unwrap(),
        json!([debris])
    );
    assert!(!volume.join(debris).exists());
}

#[test]
fn downloads_sweep_keeps_lookalikes_directories_and_active_collisions() {
    let tmp = tempdir().unwrap();
    let root = tmp.path();
    let legacy = "ompdesk-...-arm64 (00).dmg.download-01";
    let stale = "ompdesk-..9.dmg.partial";
    let keep = [
        "ompdesk-1.0.0-rc.1-arm64.dmg.partial",
        "ompdesk-١.٢.٣.dmg.download-123",
        "ompdesk-1.2.3.dmg.download-١",
        "ompdesk-1.2.3.dmg.partial\n",
        "ompdesk-1.2.3-arm64 (2).dmg.partial",
        "holiday.dmg.partial",
    ];
    for name in keep.into_iter().chain([legacy, stale]) {
        fs::write(root.join(name), b"keep").unwrap();
    }
    let folder = root.join("ompdesk-...dmg.download-1");
    fs::create_dir(&folder).unwrap();
    assert_eq!(
        handle(
            "app.sweepUpdateFiles",
            &json!({"area":"downloads"}),
            root,
            root
        )
        .unwrap(),
        json!([legacy])
    );
    assert_eq!(
        handle(
            "app.sweepUpdateFiles",
            &json!({"area":"downloads", "asset":"ompdesk-1.2.3-arm64 (2).dmg"}),
            root,
            root,
        )
        .unwrap(),
        json!([stale])
    );
    for name in keep {
        assert_eq!(fs::read(root.join(name)).unwrap(), b"keep");
    }
    assert!(folder.is_dir());
}

#[test]
fn private_sweep_unlinks_symlinks_and_rejects_a_linked_staging_root() {
    let tmp = tempdir().unwrap();
    let downloads = tmp.path().join("downloads");
    let updates = tmp.path().join("updates");
    fs::create_dir(&downloads).unwrap();
    fs::create_dir_all(updates.join("old.app/Contents")).unwrap();
    let sentinel = downloads.join("personal");
    fs::write(&sentinel, b"mine").unwrap();
    symlink(&downloads, updates.join("old.app/Contents/external")).unwrap();
    symlink(&sentinel, updates.join("shortcut")).unwrap();
    let partial = format!("{ASSET}.partial");
    for keep in [ASSET, &partial, "swap.log"] {
        fs::write(updates.join(keep), keep).unwrap();
    }
    let params = json!({"area":"updates", "asset": ASSET});
    assert_eq!(
        handle("app.sweepUpdateFiles", &params, &downloads, &updates).unwrap(),
        Value::Null
    );
    for keep in [ASSET, &partial, "swap.log"] {
        assert_eq!(fs::read_to_string(updates.join(keep)).unwrap(), keep);
    }
    assert!(!updates.join("old.app").exists());
    assert!(fs::symlink_metadata(updates.join("shortcut")).is_err());
    let linked = tmp.path().join("linked-updates");
    symlink(&downloads, &linked).unwrap();
    assert!(handle("app.sweepUpdateFiles", &params, &downloads, &linked).is_err());
    assert_eq!(fs::read(sentinel).unwrap(), b"mine");
}

#[test]
fn bad_requests_do_not_sweep_either_area() {
    let tmp = tempdir().unwrap();
    let root = tmp.path();
    let sentinel = root.join("ompdesk-1.dmg.download-1");
    fs::write(&sentinel, b"keep").unwrap();
    for params in [
        json!({"area": "downloads", "asset": "../ompdesk-1.2.3.dmg"}),
        json!({"area": "downloads", "asset": null}),
        json!({"area": "downloads", "directory": "elsewhere"}),
        json!({"area": "updates"}),
        json!({"area": "elsewhere", "asset": ASSET}),
    ] {
        assert!(handle("app.sweepUpdateFiles", &params, root, root).is_err());
    }
    assert_eq!(fs::read(sentinel).unwrap(), b"keep");
}
