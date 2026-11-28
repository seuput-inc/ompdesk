//! Only the registration supplies host identity. Transcript fields are bounded display data.
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize, Serializer};

use super::{Registration, Store, files, invalid, reference, state, wire};
use crate::schedules::rules::iso;

pub(super) const DIRECTORY: &str = "wsl-session-copies";

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Status {
    Complete,
    Interrupted,
    Aborted,
    Error,
    Pending,
    #[default]
    Unknown,
}

#[derive(Default, Deserialize, Serialize)]
pub(super) struct Summary {
    pub title: Option<String>,
    pub first_message: String,
    pub message_count: u32,
    pub created: Option<i64>,
    pub modified: Option<i64>,
    pub status: Status,
}

#[derive(Deserialize, Serialize)]
pub(super) struct Published {
    pub summary: Summary,
    pub mtime: SystemTime,
}

pub(crate) struct Row {
    reference: String,
    registration: Registration,
    summary: Summary,
    size: u64,
    verified_ms: i64,
}

impl Serialize for Row {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct SessionInfo<'a> {
            path: &'a str,
            id: &'a str,
            cwd: &'a str,
            opened_by_session: Option<&'a str>,
            title: Option<&'a str>,
            first_message: &'a str,
            message_count: u32,
            created: String,
            modified: String,
            size: u64,
            status: Status,
        }
        let s = &self.summary;
        SessionInfo {
            path: &self.reference,
            id: &self.reference,
            cwd: &self.registration.cwd,
            opened_by_session: self.registration.parent.as_deref(),
            title: s.title.as_deref(),
            first_message: if s.first_message.is_empty() {
                "\0no-text-prompt"
            } else {
                &s.first_message
            },
            message_count: s.message_count,
            created: iso(s.created.unwrap_or(self.verified_ms)),
            modified: iso(s.modified.unwrap_or(self.verified_ms)),
            size: self.size,
            status: s.status,
        }
        .serialize(serializer)
    }
}

pub(crate) fn root(profile: &Path) -> io::Result<PathBuf> {
    if !profile.is_absolute() {
        return Err(invalid("expected an absolute host profile"));
    }
    files::directory(profile, false)?;
    Ok(profile.canonicalize()?.join(DIRECTORY))
}

fn row(dir: &Path, key: &str) -> io::Result<Option<Row>> {
    files::directory(dir, false)?;
    let gate = files::lock(&dir.join("gate"), false)?;
    let s = state(dir)?;
    let (Some(verified), Some(mut published)) = (s.verified, s.published) else {
        return Ok(None);
    };
    if published.summary.message_count == 0 {
        return Ok(None);
    }
    let mut file = files::open(&dir.join(verified.slot.name()))?;
    drop(gate);
    let meta = file.metadata()?;
    if meta.len() != verified.info.bytes
        || (meta.modified()? != published.mtime && !wire::intact_prefix(&mut file, &verified.info)?)
    {
        return Err(invalid("damaged local checkpoint"));
    }
    if s.turn.is_some() {
        published.summary.status = Status::Pending;
    }
    Ok(Some(Row {
        reference: reference::format_ref(key),
        registration: s.registration,
        summary: published.summary,
        size: verified.info.bytes,
        verified_ms: verified.info.verified_ms as i64,
    }))
}

fn visit_keys(
    profile: &Path,
    mut visit: impl FnMut(&Path, &str) -> io::Result<()>,
) -> io::Result<()> {
    // An ordinary Windows profile may itself be a junction. No copy directory means no WSL rows;
    // a directory that exists but is not safe to read must not be reported as an authoritative empty list.
    if profile.is_absolute()
        && fs::symlink_metadata(profile.join(DIRECTORY))
            .is_err_and(|e| e.kind() == io::ErrorKind::NotFound)
    {
        return Ok(());
    }
    let root = root(profile)?;
    files::directory(&root, false)?;
    let entries = fs::read_dir(&root)?;
    for entry in entries {
        let entry = entry?;
        if let Some(key) = entry.file_name().to_str()
            && reference::valid_key(key)
        {
            visit(&entry.path(), key)?;
        }
    }
    Ok(())
}

pub(crate) fn issued_folders(profile: &Path) -> io::Result<Vec<String>> {
    let mut folders = Vec::new();
    visit_keys(profile, |dir, _| {
        files::directory(dir, false)?;
        let _gate = files::lock(&dir.join("gate"), false)?;
        let s = state(dir)?;
        if s.issued.is_some() {
            folders.push(s.registration.cwd);
        }
        Ok(())
    })?;
    Ok(folders)
}

pub(crate) fn rows(profile: &Path) -> io::Result<Vec<Row>> {
    let mut rows = Vec::new();
    visit_keys(profile, |dir, key| {
        if let Some(row) = row(dir, key)? {
            rows.push(row);
        }
        Ok(())
    })?;
    rows.sort_unstable_by(|a, b| {
        b.summary
            .modified
            .unwrap_or(b.verified_ms)
            .cmp(&a.summary.modified.unwrap_or(a.verified_ms))
            .then_with(|| a.reference.cmp(&b.reference))
    });
    Ok(rows)
}

pub(crate) fn lookup(profile: &Path, value: &str) -> io::Result<Registration> {
    let key =
        reference::parse_ref(value).ok_or_else(|| invalid("not a WSL session reference"))??;
    let root = root(profile)?;
    files::directory(&root, false)?;
    let session = Store { root }.session(key)?;
    // Listing reads host summaries. An explicit reopen must reject a corrupted pinned version.
    drop(session.verified()?);
    Ok(session.registration)
}
