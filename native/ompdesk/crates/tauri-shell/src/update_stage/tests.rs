use super::*;
use std::cell::RefCell;
use tempfile::{TempDir, tempdir};

const VERSION: &str = "0.18.0";
const ID: &str = "com.seuput.ompdesk";

struct Fixture {
    home: TempDir,
    dmg: PathBuf,
    temp: PathBuf,
    own: PathBuf,
    system: Option<&'static str>,
    minimum: Option<&'static str>,
    version: Option<&'static str>,
    bundle_id: Option<&'static str>,
    own_id: Option<&'static str>,
    has_app: bool,
    failures: &'static [&'static str],
    refuse_cleanup: bool,
    calls: RefCell<Vec<String>>,
}

impl Fixture {
    fn new() -> Self {
        let home = tempdir().unwrap();
        let updates = home.path().join("updates");
        fs::create_dir(&updates).unwrap();
        let dmg = updates.join("ompdesk-0.18.0-arm64.dmg");
        fs::write(&dmg, b"test image").unwrap();
        Self {
            dmg,
            temp: home.path().join("mnt"),
            own: home.path().join("Own.app"),
            home,
            system: Some("14.0.0"),
            minimum: Some("14.0.0"),
            version: Some(VERSION),
            bundle_id: Some(ID),
            own_id: Some(ID),
            has_app: true,
            failures: &[],
            refuse_cleanup: false,
            calls: RefCell::default(),
        }
    }

    fn folder(&self) -> PathBuf {
        self.home.path().join("updates").join(VERSION)
    }

    fn sentinel(&self) -> PathBuf {
        fs::create_dir(self.folder()).unwrap();
        let file = self.folder().join("sentinel");
        fs::write(&file, "old").unwrap();
        file
    }

    fn stage(&self) -> Result<PathBuf, Failure> {
        stage_with(
            self.home.path(),
            &self.temp,
            &self.dmg,
            VERSION,
            &self.own,
            &|tool, args| self.tool(tool, args),
        )
    }

    fn tool(&self, tool: &str, args: &[&OsStr]) -> Option<String> {
        let args: Vec<_> = args.iter().map(|s| s.to_str().unwrap()).collect();
        let op = match (tool, args.as_slice()) {
            (
                HDIUTIL,
                [
                    "attach",
                    "-nobrowse",
                    "-readonly",
                    "-noautoopen",
                    "-mountpoint",
                    _,
                    _,
                ],
            ) => "attach",
            (HDIUTIL, ["detach", _]) => "detach",
            (HDIUTIL, ["detach", "-force", _]) => "force",
            ("/usr/bin/sw_vers", ["-productVersion"]) => "system",
            ("/usr/bin/ditto", [_, _]) => "copy",
            ("/usr/bin/codesign", ["--verify", "--deep", "--strict", _]) => "sign",
            ("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", _]) => key,
            _ => panic!("unexpected tool: {tool} {args:?}"),
        };
        self.calls.borrow_mut().push(op.to_string());
        if self.failures.contains(&op) {
            return None;
        }
        match op {
            "system" => self.system.map(str::to_string),
            "attach" => {
                let mount = Path::new(args[5]);
                assert_eq!(mount.parent(), Some(self.temp.as_path()));
                assert_eq!(Path::new(args[6]), self.dmg);
                #[cfg(unix)]
                std::os::unix::fs::symlink(self.home.path(), mount.join("Alias.app")).unwrap();
                if self.has_app {
                    let contents = mount.join("OMPdesk.app/Contents");
                    fs::create_dir_all(&contents).unwrap();
                    fs::write(contents.join("marker"), b"new").unwrap();
                }
                Some(String::new())
            }
            "copy" => {
                let contents = Path::new(args[1]).join("Contents");
                fs::create_dir_all(&contents).unwrap();
                fs::copy(
                    Path::new(args[0]).join("Contents/marker"),
                    contents.join("marker"),
                )
                .unwrap();
                Some(String::new())
            }
            "detach" | "force" => {
                let mount = Path::new(args.last().unwrap());
                if self.has_app {
                    fs::remove_dir_all(mount.join("OMPdesk.app")).unwrap();
                }
                #[cfg(unix)]
                fs::remove_file(mount.join("Alias.app")).unwrap();
                if self.refuse_cleanup {
                    fs::write(mount.join("did not disappear"), []).unwrap();
                }
                Some(String::new())
            }
            "sign" => {
                assert_eq!(Path::new(args[3]), self.folder().join("OMPdesk.app"));
                Some(String::new())
            }
            "LSMinimumSystemVersion" => {
                assert!(Path::new(args[5]).starts_with(&self.temp));
                self.minimum.map(str::to_string)
            }
            "CFBundleIdentifier" => {
                let plist = Path::new(args[5]);
                if plist == self.own.join("Contents/Info.plist") {
                    self.own_id.map(str::to_string)
                } else {
                    assert_eq!(plist, self.folder().join("OMPdesk.app/Contents/Info.plist"));
                    self.bundle_id.map(str::to_string)
                }
            }
            "CFBundleShortVersionString" => {
                assert_eq!(
                    Path::new(args[5]),
                    self.folder().join("OMPdesk.app/Contents/Info.plist")
                );
                self.version.map(str::to_string)
            }
            _ => panic!("unexpected operation: {op}"),
        }
    }
}

#[test]
fn refuses_old_unavailable_or_invalid_host_before_touching_staging() {
    for version in [
        Some("12.7.6"),
        Some("13.6.9"),
        Some(""),
        Some("14.beta"),
        Some("14.0.0.0"),
        Some("999999999999999999999.0"),
        Some("14.00"),
        Some("9007199254740992"),
        None,
    ] {
        let mut f = Fixture::new();
        f.system = version;
        let old = f.sentinel();
        assert_eq!(f.stage().unwrap_err().reason, Some("compatibility"));
        assert_eq!(fs::read(old).unwrap(), b"old");
        assert!(!f.temp.exists());
        assert_eq!(*f.calls.borrow(), ["system"]);
    }
}

#[test]
fn checks_the_mounted_minimum_before_replacing_staging() {
    for minimum in [
        Some("15.0"),
        Some(""),
        Some("14.beta"),
        Some("14.0.0.0"),
        Some("999999999999999999999.0"),
        None,
    ] {
        let mut f = Fixture::new();
        f.minimum = minimum;
        let old = f.sentinel();
        assert_eq!(f.stage().unwrap_err().reason, Some("compatibility"));
        assert_eq!(fs::read(old).unwrap(), b"old");
        assert_eq!(
            *f.calls.borrow(),
            ["system", "attach", "LSMinimumSystemVersion", "detach"]
        );
        assert_eq!(fs::read_dir(&f.temp).unwrap().count(), 0);
    }
}

#[test]
fn returns_only_the_verified_app_after_detaching() {
    for failures in [&[][..], &["detach"][..]] {
        let mut f = Fixture::new();
        f.system = Some("14");
        f.minimum = Some("14.0");
        f.failures = failures;
        let old = f.sentinel();
        let staged = f.stage().unwrap();
        assert!(!old.exists());
        assert_eq!(staged, f.folder().join("OMPdesk.app"));
        assert_eq!(fs::read(staged.join("Contents/marker")).unwrap(), b"new");
        assert_eq!(fs::read_dir(f.folder()).unwrap().count(), 1);
        assert_eq!(fs::read_dir(&f.temp).unwrap().count(), 0);
        let mut expected = vec![
            "system",
            "attach",
            "LSMinimumSystemVersion",
            "copy",
            "detach",
        ];
        if !failures.is_empty() {
            expected.push("force");
        }
        expected.extend([
            "sign",
            "CFBundleIdentifier",
            "CFBundleIdentifier",
            "CFBundleShortVersionString",
        ]);
        assert_eq!(*f.calls.borrow(), expected);
    }
}

#[test]
fn rejects_wrong_identity_version_signature_or_unreadable_plist_and_removes_the_copy() {
    for case in ["id", "own", "version", "missing", "sign"] {
        let mut f = Fixture::new();
        match case {
            "id" => f.bundle_id = Some("com.example.other"),
            "own" => f.own_id = None,
            "version" => f.version = Some("0.18.00"),
            "missing" => f.bundle_id = None,
            "sign" => f.failures = &["sign"],
            _ => unreachable!(),
        }
        assert_eq!(f.stage().unwrap_err().reason, Some("verify"));
        assert!(!f.folder().exists());
        assert_eq!(fs::read_dir(&f.temp).unwrap().count(), 0);
    }
}

#[test]
fn reports_mount_missing_and_copy_refusals_and_cleans_the_mountpoint() {
    for reason in ["mount", "missing", "copy"] {
        let mut f = Fixture::new();
        match reason {
            "mount" => f.failures = &["attach"],
            "missing" => f.has_app = false,
            _ => f.failures = &["copy"],
        }
        assert_eq!(f.stage().unwrap_err().reason, Some(reason));
        assert_eq!(fs::read_dir(&f.temp).unwrap().count(), 0);
        assert_eq!(
            f.calls.borrow().iter().any(|v| v == "detach"),
            reason != "mount"
        );
        assert_eq!(
            f.calls.borrow().iter().any(|v| v == "copy"),
            reason == "copy"
        );
    }
}

#[test]
fn failed_detaches_leave_the_mounted_image_intact_and_follow_any_copy_error() {
    for minimum in ["15", "14"] {
        let mut f = Fixture::new();
        f.minimum = Some(minimum);
        f.failures = &["detach", "force"];
        let err = f.stage().unwrap_err();
        let mut reasons = vec![Some("mount"), Some("mount")];
        if minimum == "15" {
            reasons.insert(0, Some("compatibility"));
        }
        assert_eq!(err.message, "Could not detach the update disk image");
        assert_eq!(
            err.errors.iter().map(|e| e.reason).collect::<Vec<_>>(),
            reasons
        );
        assert!(err.errors.last().unwrap().message.contains("detach -force"));
        let mount = fs::read_dir(&f.temp)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(
            fs::read(mount.join("OMPdesk.app/Contents/marker")).unwrap(),
            b"new"
        );
        assert!(!f.calls.borrow().iter().any(|v| v == "sign"));
    }
}

#[test]
fn rmdir_failure_preserves_the_original_failure_or_stands_alone() {
    for minimum in ["15", "14"] {
        let mut f = Fixture::new();
        f.minimum = Some(minimum);
        f.refuse_cleanup = true;
        let error = f.stage().unwrap_err();
        assert_eq!(error.reason, None);
        if minimum == "15" {
            assert_eq!(error.message, "Update staging and mount cleanup failed");
            assert_eq!(error.errors.len(), 2);
            assert_eq!(error.errors[0].reason, Some("compatibility"));
            assert!(error.errors[1].message.contains("rmdir"));
        } else {
            assert!(error.message.contains("rmdir"));
        }
        assert!(!f.calls.borrow().iter().any(|v| v == "sign"));
    }
}

#[test]
fn refuses_paths_outside_updates_and_reserved_names_without_mounting() {
    let f = Fixture::new();
    let keep = f.sentinel();
    for (version, dmg) in [
        ("../0.18.0", &f.dmg),
        ("swap.log", &f.dmg),
        (".", &f.dmg),
        (VERSION, &keep),
    ] {
        let result = stage_with(
            f.home.path(),
            &f.temp,
            dmg,
            version,
            &f.own,
            &|tool, args| f.tool(tool, args),
        );
        assert_eq!(result.unwrap_err().reason, Some("mount"));
    }
    let nested = f.folder().join("mount-here");
    let result = stage_with(
        f.home.path(),
        &nested,
        &f.dmg,
        VERSION,
        &f.own,
        &|tool, args| f.tool(tool, args),
    );
    assert_eq!(result.unwrap_err().reason, Some("mount"));
    assert!(!nested.exists());
    assert_eq!(fs::read(keep).unwrap(), b"old");
    assert!(!f.temp.exists());
}

#[cfg(unix)]
#[test]
fn never_follows_staging_or_image_symlinks_outside_the_profile() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let elsewhere = tempdir().unwrap();
    let keep = elsewhere.path().join("keep");
    fs::write(&keep, "old").unwrap();
    symlink(elsewhere.path(), f.folder()).unwrap();
    f.stage().unwrap();
    assert_eq!(fs::read(&keep).unwrap(), b"old");
    fs::remove_file(&f.dmg).unwrap();
    symlink(&keep, &f.dmg).unwrap();
    assert_eq!(f.stage().unwrap_err().reason, Some("mount"));
    fs::remove_dir_all(f.home.path().join("updates")).unwrap();
    symlink(elsewhere.path(), f.home.path().join("updates")).unwrap();
    fs::write(elsewhere.path().join(f.dmg.file_name().unwrap()), "image").unwrap();
    assert_eq!(f.stage().unwrap_err().reason, Some("mount"));
    assert_eq!(fs::read(keep).unwrap(), b"old");
}

#[cfg(target_os = "macos")]
#[test]
fn stages_a_real_signed_bundle_from_a_read_only_dmg() {
    use std::process::Command;
    let dir = tempdir().unwrap();
    let source = dir.path().join("image");
    let app = source.join("OMPdesk.app");
    let contents = app.join("Contents");
    fs::create_dir_all(contents.join("MacOS")).unwrap();
    fs::copy("/bin/echo", contents.join("MacOS/fixture")).unwrap();
    fs::write(
        contents.join("Info.plist"),
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>{ID}</string>
<key>CFBundleShortVersionString</key><string>{VERSION}</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleExecutable</key><string>fixture</string>
<key>CFBundleName</key><string>OMPdesk</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>14.0.0</string>
</dict></plist>"#
        ),
    )
    .unwrap();
    let sign = Command::new("/usr/bin/codesign")
        .args(["--force", "--sign", "-", "--timestamp=none"])
        .arg(&app)
        .output()
        .unwrap();
    assert!(
        sign.status.success(),
        "{}",
        String::from_utf8_lossy(&sign.stderr)
    );
    std::os::unix::fs::symlink("/Applications", source.join("Applications")).unwrap();
    let updates = dir.path().join("updates");
    fs::create_dir(&updates).unwrap();
    let dmg = updates.join("ompdesk-0.18.0-arm64.dmg");
    let create = Command::new(HDIUTIL)
        .args(["create", "-format", "UDZO", "-srcfolder"])
        .arg(source)
        .arg(&dmg)
        .output()
        .unwrap();
    assert!(
        create.status.success(),
        "{}",
        String::from_utf8_lossy(&create.stderr)
    );
    // A failed detach must not put a live volume below any test TempDir destructor.
    let mount_root = tempdir().unwrap().keep();
    let reply = stage(dir.path(), &mount_root, &dmg, VERSION, &app);
    assert!(
        matches!(&reply, StageReply::Staged { staged } if staged == &updates.join(VERSION).join("OMPdesk.app")),
        "{reply:?}"
    );
    fs::remove_dir(mount_root).unwrap();
    assert_eq!(
        fs::read(
            updates
                .join(VERSION)
                .join("OMPdesk.app/Contents/MacOS/fixture")
        )
        .unwrap(),
        fs::read(contents.join("MacOS/fixture")).unwrap()
    );
}
