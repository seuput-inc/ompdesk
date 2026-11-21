use std::io::{self, Read, Seek, SeekFrom};
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

fn read_window(profile: &Path, archive: bool, limit: u64) -> io::Result<(Vec<u8>, bool)> {
    let mut file = super::files::open(profile, archive)?;
    let size = file.metadata()?.len();
    let length = size.min(limit);
    if size > length {
        file.seek(SeekFrom::Start(size - length))?;
    }
    let mut bytes = Vec::with_capacity(length as usize);
    file.take(length).read_to_end(&mut bytes)?;
    Ok((bytes, size > length))
}

pub(super) fn lines(profile: &Path, selection: Selection) -> Vec<String> {
    let (files, bytes, count): (&[bool], _, _) = match selection {
        Selection::Current => (&[false], MIB, 3000),
        Selection::Archive => (&[true], MIB, 3000),
        Selection::Probes => (&[false, true], 5 * MIB, 30),
        Selection::Feedback(count) => (&[false], 256 * 1024, count),
    };
    let mut newest = Vec::new();
    for &archive in files {
        let Ok((window, truncated)) = read_window(profile, archive, bytes) else {
            continue;
        };
        let mut rows = window.split(|&b| b == b'\n');
        if truncated {
            rows.next();
        }
        for line in rows.rev().filter(|line| !line.is_empty()) {
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
