use super::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::Cursor;
use std::process::Command;
use tempfile::tempdir;

const STOCK: &str = "synthetic:대화-42";
const SOURCE: &str = "8:1234";

fn registration() -> Registration {
    Registration {
        distro: "test-distro".into(),
        parent: Some("host-parent".into()),
        cwd: "/project".into(),
    }
}

fn journal(title: &str) -> String {
    format!(
        "{}   \n{}\n",
        json!({"type":"title", "title":title}),
        json!({"type":"session", "id":STOCK, "cwd":r"C:\not-the-host-project", "parentSession":r"..\sessions\real.jsonl"})
    )
}

fn entry(id: &str, role: &str) -> String {
    format!(
        "{}\n",
        json!({"type":"message", "id":id, "message":{"role":role}})
    )
}

fn header(key: &str, spawn: &str, bytes: &[u8], source: &str) -> Value {
    json!({"v":1,"sessionKey":key,"spawnId":spawn,"stockId":STOCK,"bytes":bytes.len(),"source":source})
}

fn framed(h: Value, data: &[u8], seal: &str) -> Vec<u8> {
    let mut input = format!("{h}\n").into_bytes();
    input.extend_from_slice(data);
    input.extend_from_slice(format!("{}\n", json!({"sha256":seal})).as_bytes());
    input
}

fn bytes(w: &Writer<'_>, data: &[u8], source: &str) -> Vec<u8> {
    framed(
        header(w.session.key(), w.spawn_id(), data, source),
        data,
        &crate::hex(&Sha256::digest(data)),
    )
}

fn receive(w: &mut Writer<'_>, data: &str, source: &str, turn: TurnDisposition<'_>) -> Receipt {
    let input = bytes(w, data.as_bytes(), source);
    w.receive(input.as_slice(), || Ok(true), turn).unwrap()
}

fn snapshot(w: &mut Writer<'_>, data: &str) -> Receipt {
    receive(w, data, SOURCE, TurnDisposition::SnapshotOnly)
}

fn contents(mut file: File) -> String {
    let mut data = String::new();
    file.read_to_string(&mut data).unwrap();
    data
}

#[test]
fn immutable_publication_and_registration_are_separate_from_windows_sessions() {
    let profile = tempdir().unwrap();
    let ordinary = profile.path().join("sessions");
    fs::create_dir(&ordinary).unwrap();
    fs::write(ordinary.join("real.jsonl"), b"untouched").unwrap();
    let store = Store::open(profile.path()).unwrap();
    let s = store.register(registration()).unwrap();
    assert!(s.verified().unwrap().is_none());
    assert!(store.session(r"..\sessions\real.jsonl").is_err());
    let mut w = s.admit().unwrap();
    w.bind_stock_id(STOCK).unwrap();
    let original = journal("first");
    let first = snapshot(&mut w, &original);
    assert_eq!(first.change, Change::First);
    let v1 = s.verified().unwrap().unwrap().1;
    let extended = original.clone() + &entry("a", "assistant");
    assert_eq!(snapshot(&mut w, &extended).change, Change::Append);
    let renamed = journal("other") + &entry("a", "assistant");
    assert_eq!(renamed.len(), extended.len());
    let replacement = snapshot(&mut w, &renamed);
    assert_eq!(replacement.change, Change::Replacement);
    let retry = snapshot(&mut w, &renamed);
    assert_eq!(retry.change, Change::Unchanged);
    assert_eq!(retry.checkpoint, replacement.checkpoint);
    let rename_plus_append = extended + &entry("b", "assistant");
    assert_eq!(
        snapshot(&mut w, &rename_plus_append).change,
        Change::Replacement
    );
    assert_eq!(snapshot(&mut w, &original).change, Change::Replacement);
    let new_inode = receive(&mut w, &original, "8:7777", TurnDisposition::SnapshotOnly);
    assert_eq!(new_inode.change, Change::Replacement);
    assert_eq!(new_inode.checkpoint.bytes, original.len() as u64);
    assert_eq!(new_inode.checkpoint.source, "8:7777");
    assert_eq!(
        new_inode.checkpoint.sha256,
        crate::hex(&Sha256::digest(original.as_bytes()))
    );
    assert_eq!(contents(v1), original);
    let reopened = Store::open(profile.path())
        .unwrap()
        .session(s.key())
        .unwrap();
    assert_eq!(reopened.registration(), &registration());
    assert_eq!(contents(reopened.verified().unwrap().unwrap().1), original);
    assert_eq!(fs::read(ordinary.join("real.jsonl")).unwrap(), b"untouched");
}

#[test]
fn bindings_frames_and_actual_journal_header_are_checked() {
    let profile = tempdir().unwrap();
    let store = Store::open(profile.path()).unwrap();
    let s = store.register(registration()).unwrap();
    let mut w = s.admit().unwrap();
    let data = journal("a");
    let plain = bytes(&w, data.as_bytes(), SOURCE);
    let none = TurnDisposition::SnapshotOnly;
    assert!(w.receive(plain.as_slice(), || Ok(true), none).is_err());
    assert!(w.bind_stock_id("").is_err());
    w.bind_stock_id(STOCK).unwrap();
    let base = snapshot(&mut w, &data).checkpoint;
    let h = header(s.key(), w.spawn_id(), data.as_bytes(), SOURCE);
    let digest = crate::hex(&Sha256::digest(data.as_bytes()));
    let mut bad = Vec::new();
    for (field, value) in [
        ("v", json!(2)),
        ("bytes", json!(512 * 1024 * 1024 + 1)),
        ("bytes", json!(-1)),
        ("bytes", json!(data.len() - 1)),
        ("bytes", json!(data.len() + 1)),
        ("stockId", json!("foreign")),
        ("sessionKey", json!("../sessions")),
        ("spawnId", json!("stale")),
        ("source", json!(r"C:\sessions\a")),
    ] {
        let mut wrong = h.clone();
        wrong[field] = value;
        bad.push(framed(wrong, data.as_bytes(), &digest));
    }
    bad.push(framed(h.clone(), data.as_bytes(), "00"));
    let mut trailing = plain.clone();
    trailing.push(b' ');
    bad.push(trailing);
    bad.push(plain[..plain.len() - 1].to_vec());
    let mut big_header = vec![b' '; 4096];
    big_header.extend_from_slice(&plain);
    bad.push(big_header);
    let mut big_seal = format!("{h}\n{data}{}", " ".repeat(4096)).into_bytes();
    big_seal.extend_from_slice(format!("{}\n", json!({"sha256":digest})).as_bytes());
    bad.push(big_seal);
    for journal in [
        "{\"type\":\"session\",\"id\":\"foreign\"}\n".into(),
        data.trim_end().to_owned(),
        data.clone() + "{bad}\n",
        data.clone() + "[]\n",
        data.clone() + "\n",
        data.clone() + &data,
        format!("{{\"type\":\"title\"}}\n{data}"),
    ] {
        bad.push(bytes(&w, journal.as_bytes(), SOURCE));
    }
    let mut utf8 = data.as_bytes().to_vec();
    utf8.extend_from_slice(b"{\"attachment\":\"\xff\"}\n");
    bad.push(bytes(&w, &utf8, SOURCE));
    for input in bad {
        assert!(
            w.receive(input.as_slice(), || Ok(true), TurnDisposition::SnapshotOnly)
                .is_err()
        );
        assert_eq!(s.verified().unwrap().unwrap().0, base);
    }
    assert!(
        w.receive(
            plain.as_slice(),
            || Ok(false),
            TurnDisposition::SnapshotOnly
        )
        .is_err()
    );
    assert_eq!(s.verified().unwrap().unwrap().0, base);
    assert!(w.bind_stock_id("contradiction").is_err());
    assert!(
        w.receive(
            plain.as_slice(),
            || panic!("not bound"),
            TurnDisposition::SnapshotOnly
        )
        .is_err()
    );
}

#[test]
fn same_length_local_damage_is_not_published_as_verified_or_mistaken_for_guest_replacement() {
    let profile = tempdir().unwrap();
    let store = Store::open(profile.path()).unwrap();
    let s = store.register(registration()).unwrap();
    let mut w = s.admit().unwrap();
    w.bind_stock_id(STOCK).unwrap();
    let data = journal("synthetic");
    let original = snapshot(&mut w, &data).checkpoint;
    drop(w);
    let slot = state(&s.dir).unwrap().verified.unwrap().slot;
    fs::write(s.dir.join(slot.name()), vec![0; data.len()]).unwrap();
    let fresh = Store::open(profile.path())
        .unwrap()
        .session(s.key())
        .unwrap();
    assert!(matches!(fresh.verified(), Err(e) if e.kind() == io::ErrorKind::InvalidData));
    let mut w = fresh.admit().unwrap();
    w.bind_stock_id(STOCK).unwrap();
    let repaired = snapshot(&mut w, &data);
    assert_eq!(repaired.change, Change::Unchanged);
    assert!(repaired.repaired_host_copy);
    assert_eq!(repaired.checkpoint, original);
    assert_eq!(contents(fresh.verified().unwrap().unwrap().1), data);
}

#[test]
fn commit_failure_after_eof_and_exit_preserves_the_last_good_transcript() {
    use std::cell::Cell;

    struct ObserveEof<'a>(Cursor<Vec<u8>>, &'a Cell<bool>);
    impl Read for ObserveEof<'_> {
        fn read(&mut self, dst: &mut [u8]) -> io::Result<usize> {
            let n = self.0.read(dst)?;
            if n == 0 {
                self.1.set(true);
            }
            Ok(n)
        }
    }
    let profile = tempdir().unwrap();
    let store = Store::open(profile.path()).unwrap();
    let s = store.register(registration()).unwrap();
    let mut w = s.admit().unwrap();
    w.bind_stock_id(STOCK).unwrap();
    let first = journal("a");
    let good = snapshot(&mut w, &first).checkpoint;
    let next = first + &entry("next", "assistant");
    let eof = Cell::new(false);
    let input = ObserveEof(Cursor::new(bytes(&w, next.as_bytes(), SOURCE)), &eof);
    let stage = s.dir.join("stage");
    let result = w.receive(
        input,
        || {
            assert!(eof.get());
            fs::create_dir(&stage)?;
            Ok(true)
        },
        TurnDisposition::SnapshotOnly,
    );
    assert!(result.is_err());
    fs::remove_dir(stage).unwrap();
    drop(w);
    let fresh = Store::open(profile.path())
        .unwrap()
        .session(s.key())
        .unwrap();
    assert_eq!(fresh.verified().unwrap().unwrap().0, good);
    assert_eq!(contents(fresh.interrupted().unwrap().unwrap().1), next);
    let mut w = fresh.admit().unwrap();
    w.bind_stock_id(STOCK).unwrap();
    assert_eq!(snapshot(&mut w, &next).recovery, Recovery::Matched);
    assert_eq!(contents(fresh.verified().unwrap().unwrap().1), next);
}

#[test]
fn turn_needs_matching_new_assistant_entry_not_live_progress_or_an_old_id() {
    let profile = tempdir().unwrap();
    let store = Store::open(profile.path()).unwrap();
    let s = store.register(registration()).unwrap();
    let mut w = s.admit().unwrap();
    w.bind_stock_id(STOCK).unwrap();
    assert!(w.begin_turn().is_err());
    let baseline = journal("a") + &entry("old", "assistant");
    let first = snapshot(&mut w, &baseline);
    w.begin_turn().unwrap();
    // A process may die after live output but before the first byte of a checkpoint.
    drop(w);
    let s = Store::open(profile.path())
        .unwrap()
        .session(s.key())
        .unwrap();
    assert_eq!(s.open_turn().unwrap().unwrap().baseline, first.checkpoint);
    assert!(s.interrupted().unwrap().is_none());
    let mut w = s.admit().unwrap();
    assert!(w.bind_stock_id("different").is_err());
    w.bind_stock_id(STOCK).unwrap();
    assert!(w.begin_turn().is_err());
    let confirmed = TurnDisposition::ConfirmedJournalTurn;
    assert!(!receive(&mut w, &baseline, SOURCE, confirmed("old")).turn_resolved);
    let duplicate = baseline.clone() + &entry("old", "assistant");
    assert!(!receive(&mut w, &duplicate, SOURCE, confirmed("old")).turn_resolved);
    let title_rewrite = journal("b") + &entry("old", "assistant") + &entry("new", "assistant");
    assert!(!receive(&mut w, &title_rewrite, SOURCE, confirmed("new")).turn_resolved);
    let user = baseline + &entry("new", "user");
    assert!(!receive(&mut w, &user, SOURCE, confirmed("new")).turn_resolved);
    let large = "x".repeat(128 * 1024);
    let complete = user
        + &format!(
            "{}\n",
            json!({"type":"message","id":"done","message":{"role":"assistant","content":large}})
        );
    assert!(!snapshot(&mut w, &complete).turn_resolved);
    assert!(!receive(&mut w, &complete, SOURCE, confirmed("missing")).turn_resolved);
    let settled = receive(&mut w, &complete, SOURCE, confirmed("done"));
    assert!(settled.turn_resolved);
    assert_eq!(settled.change, Change::Unchanged);
    assert!(s.open_turn().unwrap().is_none());
    w.begin_turn().unwrap();
}

// The test executable is a disposable host process. Exit in the middle of a read or just before the receipt commit;
// no Drop implementation runs. All filesystem paths are in the parent's synthetic, private profile.
#[test]
fn interrupted_process() {
    let Some(profile) = std::env::var_os("OMPDESK_WSL_COPY_TEST_PROFILE") else {
        return;
    };
    let key = std::env::var("OMPDESK_WSL_COPY_TEST_KEY").unwrap();
    let s = Store::open(Path::new(&profile))
        .unwrap()
        .session(&key)
        .unwrap();
    let mut w = s.admit().unwrap();
    w.bind_stock_id(STOCK).unwrap();
    let payload = journal("a") + &entry("crash", "assistant");
    let mut wire = bytes(&w, payload.as_bytes(), SOURCE);
    if std::env::var_os("OMPDESK_WSL_COPY_TEST_PARTIAL").is_some() {
        struct Cut(Cursor<Vec<u8>>);
        impl Read for Cut {
            fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
                let n = self.0.read(out)?;
                if n == 0 {
                    std::process::exit(37);
                }
                Ok(n)
            }
        }
        wire.truncate(wire.iter().position(|&b| b == b'\n').unwrap() + 1 + payload.len() - 3);
        let _ = w.receive(
            Cut(Cursor::new(wire)),
            || panic!("no EOF"),
            TurnDisposition::SnapshotOnly,
        );
    } else {
        let _ = w.receive(
            wire.as_slice(),
            || std::process::exit(37),
            TurnDisposition::SnapshotOnly,
        );
    }
    panic!("checkpoint should have been interrupted");
}

#[test]
fn process_death_releases_lease_but_not_baseline_or_unsealed_bytes() {
    for partial in [true, false] {
        let profile = tempdir().unwrap();
        let s = Store::open(profile.path())
            .unwrap()
            .register(registration())
            .unwrap();
        let mut w = s.admit().unwrap();
        w.bind_stock_id(STOCK).unwrap();
        let old = journal("a");
        let base = snapshot(&mut w, &old).checkpoint;
        w.begin_turn().unwrap();
        let stale = bytes(&w, old.as_bytes(), SOURCE);
        assert!(
            Store::open(profile.path())
                .unwrap()
                .session(s.key())
                .unwrap()
                .admit()
                .is_err()
        );
        drop(w);
        let mut process = Command::new(std::env::current_exe().unwrap());
        process
            .args(["--exact", "wsl_copy::tests::interrupted_process"])
            .env("OMPDESK_WSL_COPY_TEST_PROFILE", profile.path())
            .env("OMPDESK_WSL_COPY_TEST_KEY", s.key())
            .env_remove("OMPDESK_WSL_COPY_TEST_PARTIAL");
        if partial {
            process.env("OMPDESK_WSL_COPY_TEST_PARTIAL", "yes");
        }
        assert_eq!(process.status().unwrap().code(), Some(37));
        let fresh = Store::open(profile.path())
            .unwrap()
            .session(s.key())
            .unwrap();
        let (span, file) = fresh.interrupted().unwrap().unwrap();
        assert_eq!(span.baseline.as_ref(), Some(&base));
        let complete = old.clone() + &entry("crash", "assistant");
        let received = if partial {
            &complete[..complete.len() - 3]
        } else {
            &complete
        };
        assert_eq!(contents(file), received);
        assert_eq!(fresh.verified().unwrap().unwrap().0, base);
        let mut w = fresh.admit().unwrap();
        w.bind_stock_id(STOCK).unwrap();
        assert!(
            w.receive(
                stale.as_slice(),
                || panic!("not current spawn"),
                TurnDisposition::SnapshotOnly
            )
            .is_err()
        );
        let different = old + &entry("other", "assistant");
        let recovery = receive(
            &mut w,
            &different,
            SOURCE,
            TurnDisposition::ConfirmedJournalTurn("other"),
        );
        assert_eq!(recovery.recovery, Recovery::Divergent);
        assert!(!recovery.turn_resolved);
        assert_eq!(contents(fresh.interrupted().unwrap().unwrap().1), received);
        assert_eq!(contents(fresh.verified().unwrap().unwrap().1), different);
        assert!(w.begin_turn().is_err());
        drop(w);
        let reopened = Store::open(profile.path())
            .unwrap()
            .session(fresh.key())
            .unwrap();
        let mut w = reopened.admit().unwrap();
        w.bind_stock_id(STOCK).unwrap();
        let matched = receive(
            &mut w,
            &complete,
            SOURCE,
            TurnDisposition::ConfirmedJournalTurn("crash"),
        );
        assert_eq!(matched.recovery, Recovery::Matched);
        assert!(matched.turn_resolved);
        assert!(reopened.interrupted().unwrap().is_none());
        assert!(reopened.open_turn().unwrap().is_none());
    }
}
