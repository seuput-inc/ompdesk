use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::{disk, order::is_js_space};
use crate::git::read::resolve;
use crate::server::{Fault, Reply};

#[derive(Deserialize)]
pub(super) struct Params {
    cwd: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Folder {
    linked_root: Option<String>,
}

pub(super) fn folder(params: Params) -> Result<Reply, Fault> {
    let cwd = Path::new(&params.cwd);
    Reply::json(&cwd.is_dir().then(|| Folder {
        linked_root: linked_root(cwd),
    }))
}

// /^gitdir:\s*(.+?)\s*$/m accepts a path on the next line, but the capture never crosses a line.
fn gitdir(text: &str) -> Option<&str> {
    const END: [char; 4] = ['\r', '\n', '\u{2028}', '\u{2029}'];
    let (at, prefix) = text
        .match_indices("gitdir:")
        .find(|&(i, _)| i == 0 || text[..i].ends_with(END))?;
    let rest = &text[at + prefix.len()..];
    let path = rest.trim_start_matches(is_js_space);
    if path.is_empty() {
        // With only whitespace, the regex backtracks to capture the last non-line-break character.
        let spaces = rest.trim_end_matches(END);
        return spaces.char_indices().next_back().map(|(i, _)| &spaces[i..]);
    }
    Some(path.split(END).next()?.trim_end_matches(is_js_space))
}

fn linked_root(cwd: &Path) -> Option<String> {
    let cwd = std::path::absolute(cwd).ok()?;
    let cwd = cwd.to_str()?;
    let bytes = fs::read(resolve(cwd, ".git")).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let target = gitdir(&text)?;
    // On Windows a leading separator inherits the checkout's drive. A drive-relative path uses
    // the checkout on that drive, or the process's directory for a different drive.
    #[cfg(windows)]
    let absolute;
    #[cfg(windows)]
    let target = {
        use std::path::Component;
        let path = Path::new(target);
        let mut components = path.components();
        match components.next() {
            Some(Component::Prefix(drive)) if !path.has_root() => {
                let base = Path::new(cwd).components().next()?.as_os_str();
                if base.eq_ignore_ascii_case(drive.as_os_str()) {
                    components.as_path().to_str()?
                } else {
                    absolute = std::path::absolute(path).ok()?;
                    absolute.to_str()?
                }
            }
            Some(Component::RootDir) => {
                absolute = Path::new(cwd).join(path);
                absolute.to_str()?
            }
            _ => target,
        }
    };
    let dir = resolve(cwd, target);
    let worktrees = Path::new(&dir).parent()?;
    let common = worktrees.parent()?;
    if worktrees.file_name()? != "worktrees" || common.file_name()? != ".git" {
        return None;
    }
    let root = common.parent()?;
    Some(match fs::canonicalize(root) {
        Ok(real) => disk::spelled(&real),
        Err(_) => root.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gitdir_captures_from_the_typescript() {
        for (text, expected) in [
            (
                "gitdir: ../repo/.git/worktrees/agent\n",
                Some("../repo/.git/worktrees/agent"),
            ),
            (
                "log\r\ngitdir:\t ../a b/.git/worktrees/x \r\n",
                Some("../a b/.git/worktrees/x"),
            ),
            (
                "gitdir:\n   ../repo/.git/worktrees/x\n",
                Some("../repo/.git/worktrees/x"),
            ),
            (
                "gitdir:\n\ngitdir: ../repo/.git/worktrees/x\n",
                Some("gitdir: ../repo/.git/worktrees/x"),
            ),
            ("gitdir:    \n", Some(" ")),
            ("gitdir:\n", None),
            (" gitdir: x", None),
            ("GITDIR: x", None),
            ("gitdir: invalid\ngitdir: valid", Some("invalid")),
            (
                "notes\u{2028}gitdir:\u{feff} ../repo/.git/worktrees/x/  ",
                Some("../repo/.git/worktrees/x/"),
            ),
            ("gitdir: \n\n", Some(" ")),
            ("gitdir:\n   \n", Some(" ")),
        ] {
            assert_eq!(gitdir(text), expected, "{text:?}");
        }
    }
}
