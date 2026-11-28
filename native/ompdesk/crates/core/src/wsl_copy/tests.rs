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

fn bytes(w: &Writer, data: &[u8], source: &str) -> Vec<u8> {
    framed(
        header(w.session.key(), w.spawn_id(), data, source),
        data,
        &crate::hex(&Sha256::digest(data)),
    )
}

fn receive(w: &mut Writer, data: &str, source: &str, turn: TurnDisposition<'_>) -> Receipt {
    let input = bytes(w, data.as_bytes(), source);
    w.receive(input.as_slice(), || Ok(true), turn).unwrap()
}

fn snapshot(w: &mut Writer, data: &str) -> Receipt {
    receive(w, data, SOURCE, TurnDisposition::SnapshotOnly)
}

#[test]
fn ordinary_linked_profile_is_empty_but_a_store_under_it_is_not_trusted() {
    let dir = tempdir().unwrap();
    let target = dir.path().join("profile");
    let link = dir.path().join("alias");
    fs::create_dir(&target).unwrap();
    #[cfg(windows)]
    crate::sys::junction(&target, &link).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, &link).unwrap();
    assert!(catalog::rows(&link).unwrap().is_empty());
    assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
    let session = Store::open(&target)
        .unwrap()
        .register(registration())
        .unwrap();
    let key = reference::format_ref(session.key());
    assert!(catalog::rows(&link).is_err());
    assert!(catalog::lookup(&link, &key).is_err());
}

#[test]
fn catalog_lists_only_published_content_with_host_identity() {
    let profile = tempdir().unwrap();
    let profile = profile.path();
    let ordinary = profile.join("ordinary.jsonl");
    fs::write(&ordinary, journal("ordinary")).unwrap();
    let rows = || serde_json::to_value(catalog::rows(profile).unwrap()).unwrap();
    assert_eq!(rows(), json!([]));
    for value in [
        ordinary.to_str().unwrap(),
        "ompdesk-wsl:../ordinary.jsonl",
        "ompdesk-wsl:00000000000000000000000000000000",
    ] {
        assert!(catalog::lookup(profile, value).is_err());
    }
    assert_eq!(fs::read_dir(profile).unwrap().count(), 1);
    let store = Store::open(profile).unwrap();
    let mut registration = registration();
    registration.cwd = r"\\wsl.localhost\Test\workspace".into();
    let first = store.register(registration.clone()).unwrap();
    let key = reference::format_ref(first.key());
    assert_eq!(catalog::lookup(profile, &key).unwrap(), registration);
    let mut w = first.admit().unwrap();
    assert_eq!(w.session_key(), first.key());
    assert_eq!(w.registration(), &registration);
    w.bind_stock_id(STOCK).unwrap();
    let header = format!(
        "{}\n{}\n",
        json!({"type":"title","title":"first\u{001b}"}),
        json!({"type":"session","id":STOCK,"timestamp":"2026-01-01T00:00:00.000Z",
            "cwd":"guest","parentSession":"guest","openedBySession":"guest","kind":"chat"})
    );
    snapshot(&mut w, &header);
    assert_eq!(rows(), json!([]));
    let prompt = format!(
        "{header}{}\n",
        json!({"type":"message","id":"u","message":{"role":"user","timestamp":1767225601000_i64,
            "content":[{"type":"text","text":"synthetic"},{"type":"image","path":"forged"},
                {"type":"text","text":"prompt"}]}})
    );
    assert_eq!(snapshot(&mut w, &prompt).change, Change::Append);
    assert_eq!(
        rows(),
        json!([{
            "path":key, "id":key, "title":"first", "cwd":registration.cwd,
            "openedBySession":"host-parent", "created":"2026-01-01T00:00:00.000Z",
            "modified":"2026-01-01T00:00:01.000Z", "size":prompt.len(), "messageCount":1,
            "firstMessage":"synthetic prompt", "status":"pending"
        }])
    );
    let renamed = prompt.replace("first", "other") + &entry("a", "assistant");
    assert_eq!(snapshot(&mut w, &renamed).change, Change::Replacement);
    let listed = rows();
    assert_eq!(listed[0]["title"], "other");
    assert_eq!(listed[0]["messageCount"], 2);
    assert_eq!(listed[0]["status"], "complete");
    assert_eq!(listed[0]["path"], key);
    assert_eq!(catalog::lookup(profile, &key).unwrap(), registration);

    // A later registration with the same private stock ID is another row, not a cache hit for the first.
    let later = store
        .register(Registration {
            parent: Some(key.clone()),
            ..registration
        })
        .unwrap();
    let mut next = later.admit().unwrap();
    next.bind_stock_id(STOCK).unwrap();
    snapshot(&mut next, &prompt);
    let listed = rows();
    let later_ref = reference::format_ref(later.key());
    let child = listed
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == later_ref)
        .unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 2);
    assert_eq!(child["openedBySession"], key);
    assert_eq!(child["path"], later_ref);
    assert_eq!(fs::read_to_string(ordinary).unwrap(), journal("ordinary"));
}

#[test]
fn legacy_checkpoint_backfills_on_retry_and_corrupt_copies_cannot_reopen() {
    let profile = tempdir().unwrap();
    let store = Store::open(profile.path()).unwrap();
    let s = store.register(registration()).unwrap();
    let key = reference::format_ref(s.key());
    let mut w = s.admit().unwrap();
    w.bind_stock_id(STOCK).unwrap();
    let input = journal("legacy") + &entry("a", "assistant");
    let checkpoint = snapshot(&mut w, &input).checkpoint;
    let mut old = state(&s.dir).unwrap();
    old.published = None;
    files::commit(&s.dir, &old).unwrap();
    assert_eq!(
        catalog::lookup(profile.path(), &key).unwrap(),
        registration()
    );
    assert!(catalog::rows(profile.path()).unwrap().is_empty());
    assert_eq!(snapshot(&mut w, &input).checkpoint, checkpoint);
    let listed = || serde_json::to_value(catalog::rows(profile.path()).unwrap()).unwrap();
    let restored = listed();
    assert_eq!(restored[0]["title"], "legacy");
    let slot = s.dir.join(old.verified.unwrap().slot.name());
    fs::write(&slot, vec![b'x'; input.len()]).unwrap();
    File::options()
        .write(true)
        .open(&slot)
        .unwrap()
        .set_modified(UNIX_EPOCH + std::time::Duration::from_secs(1_000_000_000))
        .unwrap();
    assert!(catalog::rows(profile.path()).is_err());
    assert!(catalog::lookup(profile.path(), &key).is_err());
    let receipt = snapshot(&mut w, &input);
    assert!(receipt.repaired_host_copy);
    assert_eq!(receipt.checkpoint, checkpoint);
    assert_eq!(listed(), restored);
    fs::write(s.dir.join("journal"), b"{}").unwrap();
    assert!(catalog::lookup(profile.path(), &key).is_err());
    assert!(catalog::rows(profile.path()).is_err());
}

#[tokio::test]
async fn list_and_lookup_wire_invalidate_only_the_matching_open_index() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufStream, DuplexStream};

    async fn call(
        client: &mut BufStream<DuplexStream>,
        method: &str,
        params: Value,
    ) -> (Value, Vec<Value>) {
        let frame = json!({"id":1,"method":method,"params":params});
        client
            .write_all(format!("{frame}\n").as_bytes())
            .await
            .unwrap();
        client.flush().await.unwrap();
        let mut changes = Vec::new();
        loop {
            let mut line = String::new();
            assert_ne!(client.read_line(&mut line).await.unwrap(), 0);
            let frame: Value = serde_json::from_str(&line).unwrap();
            if frame["id"] == 1 {
                return (frame, changes);
            }
            if frame["event"] == "sessions.changed" {
                changes.push(frame["data"].clone());
            }
        }
    }
    let profile = tempdir().unwrap();
    let other = tempdir().unwrap();
    let (client, server) = tokio::io::duplex(1 << 16);
    let mut client = BufStream::new(client);
    let (read, write) = tokio::io::split(server);
    let server = tokio::spawn(crate::serve(read, write, crate::registry()));
    let root = profile.path().join("ordinary");
    for (index, p) in [("catalog-wire", &profile), ("catalog-unrelated", &other)] {
        let params = json!({"index":index,"root":root,"wslProfile":p.path()});
        assert_eq!(
            call(&mut client, "sessions.watch", params).await.0["ok"],
            true
        );
    }
    let params = json!({"profile":profile.path()});
    let (empty, changes) = call(&mut client, "sessions.wslRows", params.clone()).await;
    assert_eq!(empty["result"], json!({"rows":[]}));
    assert!(changes.is_empty());
    assert_eq!(fs::read_dir(profile.path()).unwrap().count(), 0);
    let s = Store::open(profile.path())
        .unwrap()
        .register(registration())
        .unwrap();
    let key = reference::format_ref(s.key());
    let mut w = s.admit().unwrap();
    w.bind_stock_id(STOCK).unwrap();
    let input = journal("synthetic") + &entry("a", "assistant");
    let refused = bytes(&w, input.as_bytes(), SOURCE);
    assert!(
        w.receive(&refused[..], || Ok(false), TurnDisposition::SnapshotOnly)
            .is_err()
    );
    let (unsealed, changes) = call(&mut client, "sessions.wslRows", params.clone()).await;
    assert_eq!(unsealed["result"], json!({"rows":[]}));
    assert!(changes.is_empty());
    snapshot(&mut w, &input);
    let changed = vec![json!({"index":"catalog-wire","names":null})];
    let (listed, changes) = call(&mut client, "sessions.wslRows", params.clone()).await;
    assert_eq!(listed["result"]["rows"][0]["path"], key);
    assert_eq!(changes, changed);
    let lookup = json!({"profile":profile.path(),"sessionRef":key});
    let (found, changes) = call(&mut client, "sessions.wslLookup", lookup).await;
    assert_eq!(
        found["result"],
        json!({"cwd":"/project","parent":"host-parent"})
    );
    assert!(changes.is_empty());
    w.begin_turn().unwrap();
    let (pending, changes) = call(&mut client, "sessions.wslRows", params.clone()).await;
    assert_eq!(pending["result"]["rows"][0]["status"], "pending");
    assert_eq!(changes, changed);
    snapshot(&mut w, &input);
    let (_, changes) = call(&mut client, "sessions.wslRows", params.clone()).await;
    assert!(changes.is_empty());
    for index in ["catalog-wire", "catalog-unrelated"] {
        let (closed, _) = call(&mut client, "sessions.close", json!({"index":index})).await;
        assert_eq!(closed["ok"], true);
    }
    let end = input + &entry("done", "assistant");
    receive(
        &mut w,
        &end,
        SOURCE,
        TurnDisposition::ConfirmedJournalTurn("done"),
    );
    let (closed, changes) = call(&mut client, "sessions.wslRows", params).await;
    assert_eq!(closed["result"]["rows"][0]["status"], "complete");
    assert!(changes.is_empty());
    drop(client);
    server.await.unwrap().unwrap();
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
