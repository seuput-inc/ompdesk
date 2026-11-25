//! Windows executable lookup for callers ported from Node's libuv spawn. Rust's default search
//! also considers the core's executable and system directories, which may not be on the spawn PATH.

use std::path::{Path, PathBuf};

pub(crate) fn find(
    cwd: &Path,
    mut path: &str,
    search_cwd: bool,
    names: &[&str],
) -> Option<PathBuf> {
    let in_dir = |dir: &Path| {
        names
            .iter()
            .map(|name| dir.join(name))
            .find(|candidate| candidate.is_file())
    };
    if search_cwd && let Some(found) = in_dir(cwd) {
        return Some(found);
    }
    while !path.is_empty() {
        // A separator inside a quoted directory belongs to the directory (libuv accepts both quotes).
        let end_quote = match path.as_bytes()[0] {
            quote @ (b'\'' | b'"') => path[1..]
                .find(char::from(quote))
                .map_or(path.len(), |i| i + 1),
            _ => 0,
        };
        let end = path[end_quote..]
            .find(';')
            .map_or(path.len(), |i| end_quote + i);
        let dir = &path[..end];
        if !dir.is_empty() {
            let dir = dir.strip_prefix(['\'', '"']).unwrap_or(dir);
            let dir = dir.strip_suffix(['\'', '"']).unwrap_or(dir);
            if let Some(found) = in_dir(&cwd.join(dir)) {
                return Some(found);
            }
        }
        path = path.get(end + 1..).unwrap_or("");
    }
    None
}
