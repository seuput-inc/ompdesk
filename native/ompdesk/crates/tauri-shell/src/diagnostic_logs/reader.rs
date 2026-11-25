use super::log_tail::LogTail;
use std::path::Path;

pub(super) enum Selection {
    Current,
    Archive,
    Probes,
    Feedback(usize),
}

const MIB: u64 = 1024 * 1024;
const PROBE_SOURCES: [&str; 4] = [
    r#""source":"console-window""#,
    r#""source":"slow-step""#,
    r#""source":"turn-wait""#,
    r#""source":"machine-state""#,
];

pub(super) fn lines(profile: &Path, selection: Selection) -> Vec<String> {
    let (files, bytes, count): (&[bool], _, _) = match selection {
        Selection::Current => (&[false], MIB, 3000),
        Selection::Archive => (&[true], MIB, 3000),
        Selection::Probes => (&[false, true], 5 * MIB, 30),
        Selection::Feedback(count) => (&[false], 256 * 1024, count),
    };
    let mut newest = Vec::new();
    for &archive in files {
        let Ok(tail) =
            super::files::open(profile, archive).and_then(|file| LogTail::read(file, bytes))
        else {
            continue;
        };
        for line in tail.newest() {
            if matches!(selection, Selection::Probes)
                && !line.utf8_chunks().any(|chunk| {
                    PROBE_SOURCES
                        .iter()
                        .any(|source| chunk.valid().contains(source))
                })
            {
                continue;
            }
            newest.push(String::from_utf8_lossy(line).into_owned());
            if newest.len() == count {
                break;
            }
        }
        if newest.len() == count {
            break;
        }
    }
    newest.reverse();
    newest
}

#[cfg(test)]
#[path = "reader_tests.rs"]
mod tests;
