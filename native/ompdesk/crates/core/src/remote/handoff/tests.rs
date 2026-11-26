//! Each step of a hand-over on the receiving side and the failures between them: a lost answer, a sender that
//! restarted mid-transfer, a retry, and a commit that arrives after the sender called the transfer off.

use super::*;

const ID: &str = "0f6c1d2e-aaaa-4bbb-8ccc-123456789abc";
const FILE: &str = "2026-11-26T10-00-00-000Z_sess-1.jsonl";

struct World {
    root: PathBuf,
    user_data: PathBuf,
    sessions: PathBuf,
    blobs: PathBuf,
    cwd: PathBuf,
}

fn world(name: &str) -> World {
    let root = std::env::temp_dir().join(format!("ompdesk-handoff-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let world = World {
        user_data: root.join("profile"),
        sessions: root.join("sessions").join("--mini-project--"),
        blobs: root.join("blobs"),
        cwd: root.join("project"),
        root,
    };
    fs::create_dir_all(&world.user_data).unwrap();
    fs::create_dir_all(&world.cwd).unwrap();
    world
}

fn of(world: &World, from: &str) -> Of {
    Of {
        user_data: world.user_data.clone(),
        from: from.into(),
        id: ID.into(),
    }
}

fn part(world: &World, rel: &str, offset: u64, bytes: &[u8]) -> Result<Value, Fault> {
    put(
        &Put {
            of: of(world, "macbook"),
            rel: rel.into(),
            offset,
        },
        bytes,
    )
}

fn landing(world: &World, from: &str) -> Commit {
    Commit {
        of: of(world, from),
        file_name: FILE.into(),
        cwd: world.cwd.to_string_lossy().into_owned(),
        session_dir: world.sessions.clone(),
        blobs_dir: world.blobs.clone(),
    }
}

/// Stock's journal: the fixed-size title slot, the header, then the entries.
const TITLE: &str = "{\"type\":\"title\",\"v\":1,\"title\":\"Fix login\",\"pad\":\"      \"}";

fn journal() -> Vec<u8> {
    let header =
        json!({ "type": "session", "id": "sess-1", "cwd": "/Users/a/project", "version": 3 });
    format!("{TITLE}\n{header}\n{{\"type\":\"message\",\"text\":\"hi\"}}\n").into_bytes()
}

fn header_of(journal: &[u8]) -> Value {
    serde_json::from_slice(journal.split(|&b| b == b'\n').nth(1).unwrap()).unwrap()
}

const PICTURE: &[u8] = b"a picture";

fn picture_hash() -> String {
    crate::hex(&Sha256::digest(PICTURE))
}

/// Every part of one session: the journal in two parts, one artifact, one picture.
fn send_all(world: &World) {
    let journal = journal();
    let (head, tail) = journal.split_at(10);
    part(world, "session.jsonl", 0, head).unwrap();
    part(world, "session.jsonl", head.len() as u64, tail).unwrap();
    part(world, "artifacts/tool/out.txt", 0, b"output").unwrap();
    part(world, &format!("blobs/{}", picture_hash()), 0, PICTURE).unwrap();
}

fn target(world: &World) -> PathBuf {
    world.sessions.join(FILE)
}

fn state(world: &World) -> State {
    Record::load(&world.user_data).unwrap().transfers[ID]
        .state
        .clone()
}

#[test]
fn a_whole_transfer_lands_once_with_its_artifacts_and_pictures() {
    let world = world("whole");
    send_all(&world);
    assert_eq!(state(&world), State::Staged);
    let answer = commit(&landing(&world, "macbook")).unwrap();
    let path = target(&world).to_string_lossy().into_owned();
    assert_eq!(answer, json!({ "sessionPath": path }));
    let landed = fs::read(target(&world)).unwrap();
    let header = header_of(&landed);
    assert_eq!(header["cwd"], json!(world.cwd.to_string_lossy()));
    assert_eq!(header["id"], json!("sess-1"));
    assert!(landed.ends_with(b"{\"type\":\"message\",\"text\":\"hi\"}\n"));
    assert_eq!(
        fs::read(artifacts_of(&target(&world)).join("tool").join("out.txt")).unwrap(),
        b"output"
    );
    assert_eq!(fs::read(world.blobs.join(picture_hash())).unwrap(), PICTURE);
    assert!(!staging(&world.user_data, ID).exists());
    assert_eq!(state(&world), State::Done { path: path.clone() });
    // The answer was lost and the sender asks again: the same session, no second copy.
    assert_eq!(
        commit(&landing(&world, "macbook")).unwrap(),
        json!({ "sessionPath": path })
    );
    assert_eq!(
        part(&world, "session.jsonl", 0, b"late").unwrap(),
        json!({ "received": 4 })
    );
    assert_eq!(fs::read(target(&world)).unwrap(), landed);
    assert_eq!(
        fs::read_dir(&world.sessions).unwrap().count(),
        2,
        "the journal and its artifacts folder only"
    );
    // A sender that restarted asks who owns it: this computer, at that path.
    assert_eq!(
        abort(&of(&world, "macbook")).unwrap(),
        json!({ "state": "moved", "sessionPath": path })
    );
    let _ = fs::remove_dir_all(&world.root);
}

#[test]
fn an_abort_is_kept_and_a_late_part_or_commit_is_refused() {
    let world = world("late");
    send_all(&world);
    assert_eq!(
        abort(&of(&world, "macbook")).unwrap(),
        json!({ "state": "aborted" })
    );
    assert_eq!(state(&world), State::Aborted);
    assert!(!staging(&world.user_data, ID).exists());
    // A commit that was on its way when the sender called it off, read after a restart of this computer too.
    let refused = commit(&landing(&world, "macbook")).unwrap_err();
    assert_eq!(refused.code, "handoff_aborted");
    assert_eq!(
        part(&world, "session.jsonl", 0, b"x").unwrap_err().code,
        "handoff_aborted"
    );
    assert!(!target(&world).exists());
    // Asking again answers the same.
    assert_eq!(
        abort(&of(&world, "macbook")).unwrap(),
        json!({ "state": "aborted" })
    );
    let _ = fs::remove_dir_all(&world.root);
}

#[test]
fn an_abort_of_a_transfer_never_heard_of_still_fences_it() {
    let world = world("never");
    assert_eq!(
        abort(&of(&world, "macbook")).unwrap(),
        json!({ "state": "aborted" })
    );
    assert_eq!(
        part(&world, "session.jsonl", 0, b"x").unwrap_err().code,
        "handoff_aborted"
    );
    assert_eq!(
        commit(&landing(&world, "macbook")).unwrap_err().code,
        "handoff_aborted"
    );
    let _ = fs::remove_dir_all(&world.root);
}

#[test]
fn a_crash_before_the_rename_is_undone_by_the_abort() {
    let world = world("crash-before");
    send_all(&world);
    // The commit recorded its target and moved the artifacts, then this computer stopped.
    let temp = world.sessions.join(format!(".{FILE}.{ID}.handoff"));
    fs::create_dir_all(&world.sessions).unwrap();
    fs::write(&temp, journal()).unwrap();
    move_dir(
        &staging(&world.user_data, ID).join("artifacts"),
        &artifacts_of(&target(&world)),
    )
    .unwrap();
    let mut record = Record::load(&world.user_data).unwrap();
    record.set(
        ID,
        "macbook",
        State::Committing {
            target: target(&world).to_string_lossy().into_owned(),
            temp: temp.to_string_lossy().into_owned(),
        },
    );
    record.save().unwrap();
    assert_eq!(
        abort(&of(&world, "macbook")).unwrap(),
        json!({ "state": "aborted" })
    );
    assert!(!target(&world).exists());
    assert!(!temp.exists());
    assert!(!artifacts_of(&target(&world)).exists());
    let _ = fs::remove_dir_all(&world.root);
}

#[test]
fn a_crash_before_the_rename_lets_a_commit_sent_again_finish() {
    let world = world("crash-retry");
    send_all(&world);
    let temp = world.sessions.join(format!(".{FILE}.{ID}.handoff"));
    fs::create_dir_all(&world.sessions).unwrap();
    fs::write(&temp, b"half").unwrap();
    move_dir(
        &staging(&world.user_data, ID).join("artifacts"),
        &artifacts_of(&target(&world)),
    )
    .unwrap();
    let mut record = Record::load(&world.user_data).unwrap();
    record.set(
        ID,
        "macbook",
        State::Committing {
            target: target(&world).to_string_lossy().into_owned(),
            temp: temp.to_string_lossy().into_owned(),
        },
    );
    record.save().unwrap();
    commit(&landing(&world, "macbook")).unwrap();
    assert!(target(&world).is_file());
    assert!(!temp.exists());
    assert_eq!(
        fs::read(artifacts_of(&target(&world)).join("tool").join("out.txt")).unwrap(),
        b"output"
    );
    let _ = fs::remove_dir_all(&world.root);
}

#[test]
fn a_crash_after_the_rename_reads_as_moved() {
    let world = world("crash-after");
    send_all(&world);
    fs::create_dir_all(&world.sessions).unwrap();
    fs::write(target(&world), journal()).unwrap();
    let mut record = Record::load(&world.user_data).unwrap();
    let path = target(&world).to_string_lossy().into_owned();
    record.set(
        ID,
        "macbook",
        State::Committing {
            target: path.clone(),
            temp: world.sessions.join("gone").to_string_lossy().into_owned(),
        },
    );
    record.save().unwrap();
    // A session handed back to a path this computer once left: the crash came before the commit cleared it.
    crate::sessions::deleted::add(&path, None);
    assert_eq!(
        abort(&of(&world, "macbook")).unwrap(),
        json!({ "state": "moved", "sessionPath": path })
    );
    assert!(!crate::sessions::deleted::has(&path, None));
    assert_eq!(state(&world), State::Done { path });
    let _ = fs::remove_dir_all(&world.root);
}

#[test]
fn another_device_can_neither_land_nor_call_off_a_transfer() {
    let world = world("other");
    send_all(&world);
    assert_eq!(
        commit(&landing(&world, "phone")).unwrap_err().code,
        "handoff_unknown"
    );
    assert_eq!(
        abort(&of(&world, "phone")).unwrap_err().code,
        "handoff_unknown"
    );
    assert_eq!(state(&world), State::Staged);
    let _ = fs::remove_dir_all(&world.root);
}

#[test]
fn parts_land_in_order_and_a_part_sent_again_lands_where_it_did() {
    let world = world("order");
    part(&world, "session.jsonl", 0, b"abc").unwrap();
    assert_eq!(
        part(&world, "session.jsonl", 9, b"z").unwrap_err().code,
        "invalid_params"
    );
    part(&world, "session.jsonl", 3, b"def").unwrap();
    part(&world, "session.jsonl", 3, b"def").unwrap();
    assert_eq!(
        fs::read(staging(&world.user_data, ID).join("session.jsonl")).unwrap(),
        b"abcdef"
    );
    for rel in [
        "../x",
        "/etc/passwd",
        "artifacts/../../x",
        "artifacts/a//b",
        "artifacts/a\\..\\b",
        "artifacts/",
        "blobs/zz",
        "blobs/../x",
        "other.jsonl",
    ] {
        assert_eq!(
            part(&world, rel, 0, b"x").unwrap_err().code,
            "invalid_params",
            "{rel}"
        );
    }
    let _ = fs::remove_dir_all(&world.root);
}

#[test]
fn a_damaged_picture_lands_nothing_and_can_still_be_called_off() {
    let world = world("damaged");
    part(&world, "session.jsonl", 0, &journal()).unwrap();
    part(
        &world,
        &format!("blobs/{}", picture_hash()),
        0,
        b"not the picture",
    )
    .unwrap();
    assert_eq!(
        commit(&landing(&world, "macbook")).unwrap_err().code,
        "handoff_corrupt"
    );
    assert_eq!(state(&world), State::Staged);
    assert!(!target(&world).exists());
    assert_eq!(
        abort(&of(&world, "macbook")).unwrap(),
        json!({ "state": "aborted" })
    );
    let _ = fs::remove_dir_all(&world.root);
}

#[test]
fn a_journal_without_a_session_header_lands_nothing() {
    let world = world("not-a-journal");
    part(&world, "session.jsonl", 0, b"{\"type\":\"message\"}\n").unwrap();
    assert_eq!(
        commit(&landing(&world, "macbook")).unwrap_err().code,
        "handoff_corrupt"
    );
    assert!(!target(&world).exists());
    let _ = fs::remove_dir_all(&world.root);
}
#[test]
fn a_session_this_computer_already_has_is_refused_and_left_alone() {
    let world = world("exists");
    send_all(&world);
    fs::create_dir_all(&world.sessions).unwrap();
    fs::write(target(&world), b"mine").unwrap();
    assert_eq!(
        commit(&landing(&world, "macbook")).unwrap_err().code,
        "session_exists"
    );
    assert_eq!(fs::read(target(&world)).unwrap(), b"mine");
    assert_eq!(state(&world), State::Staged);
    let _ = fs::remove_dir_all(&world.root);
}

#[test]
fn a_session_handed_back_to_a_path_it_once_left_is_listed_again() {
    let world = world("back");
    send_all(&world);
    let path = target(&world).to_string_lossy().into_owned();
    crate::sessions::deleted::add(&path, None);
    assert!(crate::sessions::deleted::has(&path, None));
    commit(&landing(&world, "macbook")).unwrap();
    assert!(!crate::sessions::deleted::has(&path, None));
    let _ = fs::remove_dir_all(&world.root);
}

#[test]
fn a_damaged_record_refuses_every_step() {
    let world = world("record");
    fs::write(world.user_data.join(RECORD), b"{not json").unwrap();
    assert_eq!(
        abort(&of(&world, "macbook")).unwrap_err().code,
        "handoff_record"
    );
    assert_eq!(
        part(&world, "session.jsonl", 0, b"x").unwrap_err().code,
        "handoff_record"
    );
    let _ = fs::remove_dir_all(&world.root);
}

#[test]
fn the_header_names_this_computers_folder_and_must_match_its_file() {
    let rewritten = with_cwd(&journal(), "/Volumes/mini/project", FILE).unwrap();
    let header = header_of(&rewritten);
    assert_eq!(header["cwd"], json!("/Volumes/mini/project"));
    assert_eq!(header["version"], json!(3));
    // The title slot keeps its bytes: stock rewrites it in place at its fixed size.
    assert!(rewritten.starts_with(format!("{TITLE}\n").as_bytes()));
    assert!(with_cwd(&journal(), "/x", "sess-1.jsonl").is_ok());
    assert_eq!(
        with_cwd(&journal(), "/x", "2026_other.jsonl")
            .unwrap_err()
            .code,
        "handoff_corrupt"
    );
}
