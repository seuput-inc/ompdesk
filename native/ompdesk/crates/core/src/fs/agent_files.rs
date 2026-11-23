//! Agent Studio file operations. Main gets the roots and validates Markdown with the live stock session.

use std::borrow::Cow;
use std::ffi::OsStr;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::disk;
use super::error::NodeError;
use crate::disk::tree;
use crate::server::{Call, Fault, Reply, Scope};

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Request {
    Locate(Entry),
    Delete(Entry),
    Prepare {
        dir: PathBuf,
    },
    Install(Destination),
    Write {
        #[serde(flatten)]
        destination: Destination,
        previous: Option<Entry>,
    },
}

#[derive(Deserialize)]
struct Entry {
    file: String,
    /// `path.resolve(path.dirname(file))`, including for a root-relative Windows path.
    parent: PathBuf,
    project: PathBuf,
    user: PathBuf,
}

#[derive(Serialize)]
struct Located<'a> {
    file: &'a str,
    scope: &'static str,
}

#[derive(Deserialize)]
struct Destination {
    dir: PathBuf,
    name: String,
}

fn real(path: &Path) -> Cow<'_, Path> {
    match fs::canonicalize(path) {
        Ok(real) => Cow::Owned(real),
        Err(_) => Cow::Borrowed(path),
    }
}

fn outside() -> Fault {
    Fault::new(
        "path_outside",
        "The file is outside the user and project agent directories.",
    )
}

impl Entry {
    fn scope(&self) -> Result<&'static str, Fault> {
        let path = Path::new(&self.file);
        let Some(parent) = path
            .parent()
            .filter(|_| path.has_root() && path.extension() == Some(OsStr::new("md")))
        else {
            return Err(Fault::new(
                "path_outside",
                "Not an agent definition file path.",
            ));
        };
        let checked = real(&self.parent);
        // A symlink before `..` can give the OS a different parent from Node's lexical dirname.
        if parent != self.parent.as_path()
            && let Ok(actual) = fs::canonicalize(parent)
            && actual.as_os_str() != checked.as_os_str()
        {
            return Err(outside());
        }
        for (scope, dir) in [("project", &self.project), ("user", &self.user)] {
            if checked.as_os_str() == real(dir).as_os_str() {
                return Ok(scope);
            }
        }
        Err(outside())
    }
}

fn node(error: NodeError) -> Fault {
    Fault::new(error.code, error.message)
}

/// `fs.rm` without `recursive`: a missing source on a move is fine, a directory is never removed.
fn remove(file: &str, force: bool) -> Result<(), Fault> {
    let meta = match disk::lstat(file) {
        Ok(meta) => meta,
        Err(err) if force && err.code == "ENOENT" => return Ok(()),
        Err(err) => return Err(node(err)),
    };
    if meta.is_dir() {
        return Err(Fault::new(
            "ERR_FS_EISDIR",
            format!("Path is a directory: rm returned EISDIR (is a directory) {file}"),
        ));
    }
    match tree::unlink(Path::new(file), &meta) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other.map_err(|err| node(NodeError::new(&err, "unlink", Some(file)))),
    }
}

impl Destination {
    fn target(&self) -> Result<PathBuf, Fault> {
        let name = Path::new(&self.name);
        if !self.dir.is_absolute()
            || name.file_name() != Some(name.as_os_str())
            || name.extension() != Some(OsStr::new("md"))
        {
            return Err(Fault::new("invalid_name", "Invalid agent name."));
        }
        Ok(self.dir.join(name))
    }

    fn create(&self, target: &Path, bytes: &[u8], scope: &Scope) -> Result<(), Fault> {
        let mut options = fs::File::options();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o644);
        let (temp, mut staged) = loop {
            let mut nonce = [0; 8];
            crate::sys::random(&mut nonce[2..]).map_err(|err| Fault::new("io", err.to_string()))?;
            let suffix = u64::from_be_bytes(nonce);
            let temp = self.dir.join(format!(".{}.{suffix:012x}.tmp", self.name));
            match options.open(&temp) {
                Ok(staged) => break (temp, staged),
                Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(err) => return Err(node(NodeError::new(&err, "open", temp.to_str()))),
            }
        };
        let written = (|| {
            staged
                .write_all(bytes)
                .map_err(|err| node(NodeError::new(&err, "write", None)))?;
            drop(staged);
            tree::live(scope)?;
            fs::hard_link(&temp, target).map_err(|err| {
                if err.kind() == io::ErrorKind::AlreadyExists {
                    Fault::new(
                        "exists",
                        format!("An agent file named {} already exists.", self.name),
                    )
                } else {
                    node(NodeError::with_dest(
                        &err,
                        "link",
                        temp.to_str(),
                        target.to_str(),
                    ))
                }
            })
        })();
        match fs::remove_file(&temp) {
            Err(err) if err.kind() != io::ErrorKind::NotFound => {
                Err(node(NodeError::new(&err, "unlink", temp.to_str())))
            }
            _ => written,
        }
    }
}

pub(super) fn run(call: Call) -> Result<Reply, Fault> {
    let request = call.params::<Request>()?;
    let scope = &call.scope;
    tree::live(scope)?;
    let bytes = || {
        call.bin
            .as_deref()
            .ok_or_else(|| Fault::new("invalid_params", "Missing agent file contents"))
    };
    match request {
        Request::Locate(entry) => {
            return Reply::json(&Located {
                file: &entry.file,
                scope: entry.scope()?,
            });
        }
        Request::Delete(entry) => {
            entry.scope()?;
            tree::live(scope)?;
            remove(&entry.file, false)?;
        }
        Request::Prepare { dir } => tree::make_dirs(&dir, 0o777)?,
        Request::Install(dest) => dest.create(&dest.target()?, bytes()?, scope)?,
        Request::Write {
            destination,
            previous,
        } => {
            let target = destination.target()?;
            let bytes = bytes()?;
            if let Some(entry) = &previous {
                entry.scope()?;
            }
            tree::make_dirs(&destination.dir, 0o777)?;
            if previous.as_ref().is_some_and(|entry| {
                real(Path::new(&entry.file)).as_os_str() == real(&target).as_os_str()
            }) {
                if !tree::write_atomic(&target, bytes, 0o644, 0o777, scope)? {
                    return Err(Fault::cancelled());
                }
            } else {
                destination.create(&target, bytes, scope)?;
                if let Some(entry) = previous {
                    remove(&entry.file, true)?;
                }
            }
        }
    }
    Reply::json(&())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_direct_markdown_filename_can_be_written() {
        let dir = std::env::current_dir().unwrap();
        for (name, allowed) in [
            ("one.md", true),
            ("a.b.md", true),
            ("../escape.md", false),
            ("nested/other.md", false),
            ("./alias.md", false),
            (".md", false),
            ("not-markdown", false),
        ] {
            let result = Destination {
                dir: dir.clone(),
                name: name.into(),
            }
            .target();
            assert_eq!(result.is_ok(), allowed, "{name}");
        }
    }
}
