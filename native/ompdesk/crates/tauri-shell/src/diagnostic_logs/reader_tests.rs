use super::{Selection, lines};
use std::fs;
use tempfile::{TempDir, tempdir};

fn profile() -> TempDir {
    let dir = tempdir().unwrap();
    fs::create_dir(dir.path().join("logs")).unwrap();
    dir
}

#[test]
fn current_tail_counts_nonempty_lines_and_preserves_their_bytes() {
    let dir = profile();
    let mut data = (0..3000)
        .map(|n| format!("{n}\n\n"))
        .collect::<String>()
        .into_bytes();
    data.extend_from_slice(b"\r\n \n\xef\xbb\xbf\xe2\x82!\xff");
    fs::write(dir.path().join("logs/gui-runtime.jsonl"), data).unwrap();
    let mut expected: Vec<_> = (3..3000).map(|n| n.to_string()).collect();
    expected.extend(["\r", " ", "\u{feff}�!�"].map(String::from));
    assert_eq!(lines(dir.path(), Selection::Current), expected);
    assert!(lines(dir.path(), Selection::Archive).is_empty());
}

#[test]
fn one_mib_cuts_drop_the_first_fragment_even_at_a_line_boundary() {
    let dir = profile();
    let file = dir.path().join("logs/gui-runtime.jsonl.1");
    let mut window = b"first\n".to_vec();
    window.resize(1024 * 1024 - 4, b'\n');
    window.extend_from_slice(b"last");
    fs::write(&file, &window).unwrap();
    assert_eq!(lines(dir.path(), Selection::Archive), ["first", "last"]);
    fs::write(&file, [b"\n".as_slice(), &window].concat()).unwrap();
    assert_eq!(lines(dir.path(), Selection::Archive), ["last"]);
    window[..2].copy_from_slice(&[0x82, 0xac]);
    fs::write(&file, [b"\xe2".as_slice(), &window].concat()).unwrap();
    assert_eq!(lines(dir.path(), Selection::Archive), ["last"]);
}

#[test]
fn probes_search_five_mib_of_each_file_for_literal_substrings() {
    let dir = profile();
    let early = r#"early "source":"console-window""#;
    let late = r#"late "source":"machine-state""#;
    let mut window = format!("{early}\n").into_bytes();
    window.resize(5 * 1024 * 1024 - late.len(), b'\n');
    window.extend_from_slice(late.as_bytes());
    for (file, prefix) in [("gui-runtime.jsonl", ""), ("gui-runtime.jsonl.1", "x\n")] {
        fs::write(
            dir.path().join("logs").join(file),
            [prefix.as_bytes(), &window].concat(),
        )
        .unwrap();
    }
    assert_eq!(lines(dir.path(), Selection::Probes), [late, early, late]);
}

#[test]
fn newest_thirty_probes_top_up_from_archive_in_order() {
    let dir = profile();
    assert!(lines(dir.path(), Selection::Probes).is_empty());
    let old: Vec<_> = (0..35)
        .map(|n| format!(r#"{n} "source":"slow-step""#))
        .collect();
    fs::write(dir.path().join("logs/gui-runtime.jsonl.1"), old.join("\n")).unwrap();
    assert_eq!(lines(dir.path(), Selection::Probes), old[5..]);
    let file = dir.path().join("logs/gui-runtime.jsonl");
    let latest = r#"new "source":"turn-wait""#;
    fs::write(
        &file,
        format!("\"source\": \"turn-wait\"\n\"source\":\"slow-step-more\"\n{latest}"),
    )
    .unwrap();
    let mut expected = old[6..].to_vec();
    expected.push(latest.into());
    assert_eq!(lines(dir.path(), Selection::Probes), expected);
    fs::write(file, format!("{latest}\n").repeat(31)).unwrap();
    assert_eq!(lines(dir.path(), Selection::Probes), vec![latest; 30]);
}
