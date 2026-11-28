use std::fs;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;

use serde_json::{Value, json};
use tempfile::{TempDir, tempdir};

use super::*;
use crate::wsl_copy::{Store, TurnDisposition};

const DISTRO: &str = "{06744d8e-f876-4161-955d-5beadbb75d41}";
const TAB: &str = "0123456789abcdef0123456789abcdef";
const INVOCATION: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

// Stand-in for wsl.exe, not for the host pipes, state file, lease or subprocess exit.
const FIXTURE: &str = r##"#!/bin/sh
set -eu
[ -z "${HOME+x}${WSLENV+x}" ]
[ "$1/$2/$3/$4/$5/$6/$7/$8/$9" = '--distribution-id/{06744d8e-f876-4161-955d-5beadbb75d41}/--cd///--exec//usr/bin/env/-i//bin/sh/-c' ]
shift 11
if [ "$#" = 2 ]; then
    [ "$1" = 'C:\assigned project' ] && [ "$2" = 'C:\Pack aged\gui-bridge' ] || exit 1
    cat report
    exit 0
fi
[ "$1" = /home/fiction ] && [ "$2" = 1001 ] && [ "$3" = 'C:\Pack aged\gui-bridge' ] || exit 1
op=$4
shift 4
IFS= read -r mode < mode
case $op in
run)
    [ "$#" = 3 ] && [ "$2" = 'C:\assigned project' ] && [ "$3" = '/mnt/c/assigned project' ] || exit 1
    printf 'issued\n' > started
    case $mode in
    missing) exit 0;;
    root) printf '{"type":"ompdesk-wsl-attached","invocationId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","uid":0}\n' >&2; exit 0;;
    long) printf '%04100d' 0 >&2; exit 0;;
    cancel)
        printf '{"type":"ompdesk-wsl-attached","invocationId":"' >&2
        if IFS= read -r forbidden; then exit 1; fi
        printf 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","uid":1001}\n' >&2
        exit 0;;
    esac
    printf '{"type":"ompdesk-wsl-attached","invocationId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","uid":1001}\n' >&2
    IFS= read -r header || exit 1
    printf '%s\n' "$header" > header
    [ -f persisted ]
    if [ "$mode" = badready ]; then printf '{"type":"ompdesk-wsl-ready","spawnId":"wrong"}\n' >&2; exit 0; fi
    printf '{"type":"ompdesk-wsl-ready","spawnId":"%s"}\nstderr remainder' "$1" >&2
    IFS= read -r rpc
    printf 'reply to %s\n' "$rpc";;
stop|bridge|checkpoint)
    [ "$2" = bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ] && [ "$3" = 1001 ] || exit 1
    case $op in
    stop)
        [ "$#" = 3 ]
        printf '%s %s %s' "$1" "$2" "$3" > stopped
        case $mode in stopfail) printf 'stopped\n'; exit 1;; junk) printf 'stopped\nother\n';; *) printf 'stopped\n';; esac;;
    bridge) [ "$#" = 3 ]; printf 'OK\nbridge remainder';;
    checkpoint) [ "$#" = 6 ] && [ "$5" = journal.jsonl ] && [ "$6" = 'id with spaces' ] || exit 1; cat snapshot;;
    esac;;
*) exit 1;;
esac
"##;

struct Rig {
    guest: Guest,
    writer: Writer,
    dir: TempDir,
}

impl Rig {
    fn new(mode: &str) -> Self {
        let dir = tempdir().unwrap();
        let exe = dir.path().join("synthetic wsl");
        fs::write(&exe, FIXTURE).unwrap();
        fs::set_permissions(&exe, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(dir.path().join("mode"), format!("{mode}\n")).unwrap();
        let registration = Registration {
            distro: DISTRO.into(),
            parent: Some("not sent".into()),
            cwd: r"C:\assigned project".into(),
        };
        let writer = Store::open(dir.path())
            .unwrap()
            .register(registration.clone())
            .unwrap()
            .admit()
            .unwrap();
        let guest = Guest::fixture(exe, registration);
        Self { guest, writer, dir }
    }

    fn persist(&self, w: &Witness) -> io::Result<()> {
        self.writer.attached(&w.invocation_id, w.uid)?;
        assert!(!self.dir.path().join("header").exists());
        fs::write(self.dir.path().join("persisted"), [])
    }

    fn stopped(&self) -> String {
        fs::read_to_string(self.dir.path().join("stopped")).unwrap()
    }
}

#[tokio::test]
async fn registered_launch_preserves_stdio_binds_header_and_stops_only_with_guest_proof() {
    let rig = Rig::new("ok");
    let mut stock = rig
        .guest
        .launch(&rig.writer, TAB, None, |w| rig.persist(w))
        .await
        .unwrap();
    let header: Value =
        serde_json::from_slice(&fs::read(rig.dir.path().join("header")).unwrap()).unwrap();
    assert_eq!(
        header,
        json!({"tabTag":TAB,"spawnId":rig.writer.spawn_id(),"sessionKey":rig.writer.session_key(),
        "cwd":"/mnt/c/assigned project","bridgeDir":"/mnt/c/Pack aged/gui-bridge","minimumOmpVersion":serde_json::from_str::<&str>(MINIMUM).unwrap()})
    );
    stock.stdin.write_all(b"stock RPC\n").await.unwrap();
    let mut out = String::new();
    stock.stdout.read_to_string(&mut out).await.unwrap();
    assert_eq!(out, "reply to stock RPC\n");
    out.clear();
    stock.stderr.read_to_string(&mut out).await.unwrap();
    assert_eq!(out, "stderr remainder");
    assert!(stock.child.wait().await.unwrap().success());
    assert!(rig.writer.prior().unwrap().is_some());
    assert!(!rig.dir.path().join("stopped").exists());
    let spawn = rig.writer.spawn_id();
    let mut bridge = rig.guest.bridge(spawn, &stock.witness).await.unwrap();
    out.clear();
    bridge.stdout.read_to_string(&mut out).await.unwrap();
    assert_eq!(out, "bridge remainder");
    assert!(bridge.child.wait().await.unwrap().success());
    drop(bridge.stdin);
    rig.guest.stop(spawn, &stock.witness).await.unwrap();
    assert_eq!(rig.stopped(), format!("{spawn} {INVOCATION} 1001"));
}

#[tokio::test]
async fn unresolved_prior_and_unwitnessed_launch_never_admit_another_stock() {
    let rig = Rig::new("ok");
    rig.writer.issue().unwrap();
    assert!(
        rig.guest
            .launch(&rig.writer, TAB, None, |_| panic!())
            .await
            .is_err()
    );
    assert!(!rig.dir.path().join("started").exists());
    for mode in ["missing", "root", "long"] {
        let rig = Rig::new(mode);
        assert!(
            rig.guest
                .launch(&rig.writer, TAB, None, |_| panic!())
                .await
                .is_err()
        );
        assert!(rig.writer.prior().unwrap().unwrap().receipt.is_none());
        assert!(!rig.dir.path().join("header").exists());
        assert!(!rig.dir.path().join("stopped").exists());
    }
}

#[tokio::test]
async fn both_failed_registration_and_wrong_ready_call_exact_stop() {
    for mode in ["no-receipt", "badready"] {
        let rig = Rig::new(mode);
        let start = rig
            .guest
            .launch(&rig.writer, TAB, None, |w| {
                if mode == "no-receipt" {
                    Ok(())
                } else {
                    rig.persist(w)
                }
            })
            .await;
        assert!(start.is_err());
        assert_eq!(rig.dir.path().join("header").exists(), mode == "badready");
        assert_eq!(
            rig.stopped(),
            format!("{} {INVOCATION} 1001", rig.writer.spawn_id())
        );
    }
}

#[tokio::test]
async fn changed_uid_bad_exit_or_extra_stdout_is_not_a_stop() {
    for mode in ["stopfail", "junk"] {
        let rig = Rig::new(mode);
        let spawn = rig.writer.spawn_id();
        let mut w = Witness {
            invocation_id: INVOCATION.into(),
            uid: 2000,
        };
        assert!(rig.guest.stop(spawn, &w).await.is_err());
        assert!(!rig.dir.path().join("stopped").exists());
        w.uid = 1001;
        assert!(rig.guest.stop(spawn, &w).await.is_err());
    }
}

#[test]
// The synchronous journal receiver runs on a worker with the Tokio process driver available.
fn checkpoint_only_serves_the_registered_original_to_the_bound_writer() {
    use sha2::{Digest, Sha256};
    let mut rig = Rig::new("ok");
    let writer = &mut rig.writer;
    let w = Witness {
        invocation_id: INVOCATION.into(),
        uid: 1001,
    };
    writer.issue().unwrap();
    writer.attached(&w.invocation_id, w.uid).unwrap();
    let stock = "id with spaces";
    writer.bind_stock_id(stock).unwrap();
    writer.remember_original("journal.jsonl").unwrap();
    let data = format!("{}\n", json!({"type":"session", "id":stock}));
    let header = json!({"v":1,"spawnId":writer.spawn_id(),"sessionKey":writer.session_key(),"stockId":stock,"bytes":data.len(),"source":"3:5"});
    let seal = json!({"sha256":crate::hex(&Sha256::digest(data.as_bytes()))});
    fs::write(
        rig.dir.path().join("snapshot"),
        format!("{header}\n{data}{seal}\n"),
    )
    .unwrap();
    for name in ["../journal.jsonl", "other.jsonl"] {
        assert!(
            rig.guest
                .checkpoint(writer, &w, name, stock, TurnDisposition::SnapshotOnly)
                .is_err()
        );
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let _entered = runtime.enter();
    let receipt = rig
        .guest
        .checkpoint(
            writer,
            &w,
            "journal.jsonl",
            stock,
            TurnDisposition::SnapshotOnly,
        )
        .unwrap();
    assert_eq!(receipt.checkpoint.bytes, data.len() as u64);
    let mut published = String::new();
    Store::open(rig.dir.path())
        .unwrap()
        .session(writer.session_key())
        .unwrap()
        .verified()
        .unwrap()
        .unwrap()
        .1
        .read_to_string(&mut published)
        .unwrap();
    assert_eq!(published, data);
}

#[test]
fn paths_belong_only_to_the_project_drive_or_registered_unc_distribution() {
    for (input, expected) in [
        (r"\\?\C:\space & text", r"C:\space & text"),
        (r"\\?\UNC\WSL.LOCALHOST\Test\a b", "/a b"),
        (r"\\wsl$\test\", "/"),
    ] {
        assert_eq!(command::translate(input, "Test").unwrap(), expected);
    }
    for input in [
        r"\\wsl$\OTHER\home",
        r"\\?\UNC\NAS\share\x",
        r"\\.\C:\x",
        r"\\?\GLOBALROOT\Device\x",
        r"C:relative",
        r"C:\x:stream",
        r"C:\a\..\b",
        r"C:\CON.txt",
        r"C:\a\COM¹.exe",
        r"/etc/passwd",
    ] {
        assert!(command::translate(input, "Test").is_err(), "{input}");
    }
    assert!(command::guest_path("/mnt/c/space & text"));
    assert!(!command::guest_path("/tmp/../boot"));
}

#[tokio::test]
async fn cancellation_before_the_receipt_finishes_uses_only_that_invocation_to_stop() {
    let rig = Rig::new("cancel");
    let mut launch = Box::pin(rig.guest.launch(&rig.writer, TAB, None, |_| panic!()));
    tokio::select! { biased;
        _ = &mut launch => panic!("fixture waits for EOF"),
        () = std::future::ready(()) => {}
    }
    drop(launch);
    let expected = format!("{} {INVOCATION} 1001", rig.writer.spawn_id());
    timeout(Duration::from_secs(3), async {
        while fs::read_to_string(rig.dir.path().join("stopped"))
            .ok()
            .as_ref()
            != Some(&expected)
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(rig.writer.prior().unwrap().unwrap().receipt.is_none());
    assert!(!rig.dir.path().join("header").exists());
}

#[tokio::test]
async fn guest_reports_cannot_supply_a_windows_path_or_change_the_packaged_script() {
    let rig = Rig::new("ok");
    let guest = &rig.guest;
    let prep = || {
        Guest::from_paths(
            guest.target.clone(),
            guest.project.clone(),
            guest.package.clone(),
            guest.registration.clone(),
        )
    };
    fs::write(
        rig.dir.path().join("report"),
        b"1001\n/home/fiction\n/mnt/c/assigned project\n/mnt/c/Pack aged/gui-bridge\n",
    )
    .unwrap();
    assert_eq!(prep().await.unwrap().home, "/home/fiction");
    fs::write(
        rig.dir.path().join("report"),
        b"1001\n/home/fiction\n/mnt/c/assigned project\n/tmp/substitute-package\n",
    )
    .unwrap();
    let forged = prep().await.unwrap();
    let witness = Witness {
        invocation_id: INVOCATION.into(),
        uid: 1001,
    };
    forged.stop(rig.writer.spawn_id(), &witness).await.unwrap();
    assert_eq!(
        rig.stopped(),
        format!("{} {INVOCATION} 1001", rig.writer.spawn_id())
    );
    for report in [
        "0\n/root\n/p\n/b\n",
        "1001\n/home/u\nC:\\unassigned\n/b\n",
        "1001\n/home/u\n/p\n/tmp/../b\n",
        "1001\n/home/u\n/p\n/b\ncommand\n",
    ] {
        fs::write(rig.dir.path().join("report"), report).unwrap();
        assert!(prep().await.is_err());
    }
}
