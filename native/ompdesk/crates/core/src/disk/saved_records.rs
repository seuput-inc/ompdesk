//! The recovery record, its private archive, and the destructive step it guards. Main supplies the live
//! same-worktree proof between preparation and removal, and runs the repository hook before finishing a restore.

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{saved, tree};
use crate::fs::disk::{linked, spelled};
use crate::git::read::{blocking, resolve};
use crate::git::run::Git;
use crate::run::Runner;
use crate::server::{Call, Fault, Registry, Reply, Scope};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    id: String,
    path: String,
    repo: String,
    branch: Option<String>,
    head: String,
    saved_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    staged: Option<String>,
    removed_at: u64,
    archived_files: usize,
    archived_bytes: u64,
}

fn unlinked(path: &Path) -> Result<(), Fault> {
    match fs::symlink_metadata(path) {
        Ok(meta) if linked(&meta) => Err(saved::keep(format!(
            "{} is a link; nothing was changed",
            path.display()
        ))),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(tree::fault(&e, "lstat", path)),
    }
}

fn archive_path(dir: &Path, id: &str) -> Result<PathBuf, Fault> {
    // IDs are single generated names, never paths supplied by the saved file.
    if id.is_empty()
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(saved::keep(
            "invalid saved worktree id; nothing was changed",
        ));
    }
    let root = dir.join("saved");
    unlinked(&root)?;
    let path = root.join(id);
    unlinked(&path)?;
    Ok(path)
}

fn new_archive(dir: &Path, now: u64) -> Result<(String, String), Fault> {
    let mut digits = [0; 13]; // A u64 in base 36.
    let mut start = digits.len();
    let mut n = now;
    loop {
        start -= 1;
        digits[start] = b"0123456789abcdefghijklmnopqrstuvwxyz"[(n % 36) as usize];
        n /= 36;
        if n == 0 {
            break;
        }
    }
    let stamp = std::str::from_utf8(&digits[start..]).unwrap();
    let mut nonce = [0; 4];
    crate::sys::random(&mut nonce).map_err(|e| Fault::new("io", e.to_string()))?;
    let id = format!("{stamp}-{:08x}", u32::from_be_bytes(nonce));
    let archive = archive_path(dir, &id)?;
    match fs::symlink_metadata(&archive) {
        Ok(_) => Err(saved::keep("the saved archive name is already taken")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok((id, spelled(&archive))),
        Err(e) => Err(tree::fault(&e, "lstat", &archive)),
    }
}

fn records(file: &Path) -> Result<Vec<Value>, Fault> {
    unlinked(file)?;
    match fs::read(file) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|e| Fault::new("saved_records", e.to_string()))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(tree::fault(&e, "open", file)),
    }
}

// Different repositories share saved.json. Serialize only this read/modify/rename, never a git or an archive copy.
static WRITER: Mutex<()> = Mutex::new(());

enum Change<'a> {
    Add(&'a Record),
    Remove(&'a str),
}

fn change(dir: &Path, edit: Change<'_>, scope: &Scope) -> Result<(), Fault> {
    let _writer = WRITER.lock().unwrap_or_else(|e| e.into_inner());
    tree::live(scope)?;
    let file = dir.join("saved.json");
    // A broken or unreadable existing file is not an empty one that a mutation may overwrite.
    let mut rows = records(&file)?;
    tree::live(scope)?;
    match edit {
        Change::Add(record) => rows.insert(
            0,
            serde_json::to_value(record).map_err(|e| Fault::new("saved_records", e.to_string()))?,
        ),
        Change::Remove(id) => rows.retain(|row| row["id"].as_str() != Some(id)),
    }
    let mut bytes =
        serde_json::to_vec_pretty(&rows).map_err(|e| Fault::new("saved_records", e.to_string()))?;
    bytes.push(b'\n');
    if tree::write_atomic(&file, &bytes, 0o600, 0o700, scope)? {
        Ok(())
    } else {
        Err(Fault::cancelled())
    }
}

fn real_folder(cwd: &Path, folder: &str) -> String {
    fs::canonicalize(cwd.join(folder))
        .map(|p| spelled(&p))
        .unwrap_or_else(|_| resolve(&cwd.to_string_lossy(), folder))
}

#[derive(Deserialize)]
struct List {
    dir: PathBuf,
    cwd: PathBuf,
    primary: String,
}

fn list(p: List, scope: &Scope) -> Result<Vec<Value>, Fault> {
    tree::live(scope)?;
    let wanted = real_folder(&p.cwd, &p.primary);
    let mut matches = Vec::new();
    for row in records(&p.dir.join("saved.json")).unwrap_or_default() {
        tree::live(scope)?;
        if row["repo"]
            .as_str()
            .is_some_and(|repo| real_folder(&p.cwd, repo) == wanted)
        {
            matches.push(row);
        }
    }
    // Stable for equal removal times, as Array.sort was.
    matches.sort_by_key(|row| std::cmp::Reverse(row["removedAt"].as_u64().unwrap_or_default()));
    Ok(matches)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Lookup {
    Folder(String),
    Id(String),
}

#[derive(Deserialize)]
struct Find {
    dir: PathBuf,
    cwd: PathBuf,
    #[serde(flatten)]
    lookup: Lookup,
}

fn find(p: Find, scope: &Scope) -> Result<Option<Value>, Fault> {
    tree::live(scope)?;
    let rows = records(&p.dir.join("saved.json")).unwrap_or_default();
    match p.lookup {
        Lookup::Id(id) => {
            let row = rows.into_iter().find(|row| row["id"].as_str() == Some(&id));
            if row.is_some() {
                archive_path(&p.dir, &id)?;
            } // Refuse an unsafe record before restore adds a checkout.
            Ok(row)
        }
        Lookup::Folder(folder) => {
            let wanted = real_folder(&p.cwd, &folder);
            for row in rows {
                tree::live(scope)?;
                if row["path"]
                    .as_str()
                    .is_some_and(|path| real_folder(&p.cwd, path) == wanted)
                {
                    return Ok(Some(row));
                }
            }
            Ok(None)
        }
    }
}

#[derive(Deserialize)]
struct Target {
    path: String,
    primary: String,
    branch: Option<String>,
}

#[derive(Deserialize)]
struct SaveTarget {
    #[serde(flatten)]
    location: Target,
    unlanded: bool,
}

#[derive(Deserialize)]
struct Work {
    git: Runner,
    dir: PathBuf,
    target: SaveTarget,
    head: String,
    staged: bool,
    exclude: Vec<String>,
    archive: Vec<String>,
    overwrite: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Prepared {
    record: Record,
    saved_sha: Option<String>,
}

async fn prepare(call: Call) -> Result<Reply, Fault> {
    let Work {
        git,
        dir,
        target,
        head,
        staged,
        exclude,
        archive,
        overwrite,
    } = call.params()?;
    let Target {
        path,
        primary,
        branch,
    } = target.location;
    let scope = call.scope;
    let git = Git::new(git, scope.clone());
    let now = crate::clock::now_ms();
    let (id, archive_dir) = blocking(move || new_archive(&dir, now)).await??;
    let name = Path::new(&path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let mut day = crate::aimemory::value::iso(now);
    day.truncate(10);
    let work = saved::work(
        &git,
        saved::Save {
            worktree: path,
            primary,
            branch,
            unlanded: target.unlanded,
            head,
            staged,
            exclude,
            archive,
            overwrite,
            archive_dir,
            name,
            day,
        },
        &scope,
    )
    .await?;
    Reply::json(&Prepared {
        record: Record {
            id,
            path: work.path,
            repo: work.repo,
            branch: work.branch,
            head: work.head,
            saved_branch: work.saved_branch,
            staged: work.staged,
            removed_at: now,
            archived_files: work.archived_files,
            archived_bytes: work.archived_bytes,
        },
        saved_sha: work.saved_sha,
    })
}

#[derive(Deserialize)]
struct Finish {
    git: Runner,
    dir: PathBuf,
    prepared: Prepared,
    unchanged: Option<bool>,
    #[serde(default)]
    exclude: Vec<String>,
    #[serde(default)]
    regenerable: Vec<String>,
}

async fn finish_save(call: Call) -> Result<Reply, Fault> {
    let Finish {
        git,
        dir,
        prepared: Prepared {
            mut record,
            saved_sha,
        },
        unchanged,
        exclude,
        regenerable,
    } = call.params()?;
    let scope = call.scope;
    let git = Git::new(git, scope.clone());
    let present = unchanged == Some(false)
        && saved::sources_present(
            &git,
            &record.path,
            saved_sha.as_deref().unwrap_or(&record.head),
            &scope,
        )
        .await
        .unwrap_or(false);
    let held = scope.clone();
    let (record, archive, rollback, written) = blocking(move || {
        tree::live(&held)?;
        let archive = archive_path(&dir, &record.id)?;
        record.removed_at = crate::clock::now_ms();
        // A known change with a still-present checkout aborts the save. On an unreadable or missing source retain recovery.
        let rollback = present
            && (record.archived_files == 0
                || saved::recovery::sources_present(
                    &record.path,
                    &archive,
                    (record.archived_files, record.archived_bytes),
                    &held,
                )?);
        let written = if rollback {
            Ok(())
        } else {
            change(&dir, Change::Add(&record), &held)
        };
        Ok::<_, Fault>((record, archive, rollback, written))
    })
    .await??;
    if rollback {
        saved::rollback(
            &git,
            &record.repo,
            record.saved_branch.as_deref(),
            saved_sha.as_deref(),
            &archive.to_string_lossy(),
            &scope,
        )
        .await;
        written?;
        return Reply::json(&());
    }
    if unchanged != Some(true) {
        written?;
        return Reply::json(&());
    }
    // Publication can wait for another repository's write. Verify against the recovery copies after that wait.
    let tip = if let (Some(branch), Some(sha)) = (&record.saved_branch, &saved_sha) {
        let resolved = git
            .raw(
                &record.repo,
                &["rev-parse", "--verify", &format!("refs/heads/{branch}")],
            )
            .await?;
        resolved.code == 0 && crate::fs::order::js_trim(&resolved.text()) == sha
    } else {
        record.saved_branch.is_none() && saved_sha.is_none()
    };
    let git_intact = tip
        && saved::holds_work(
            &git,
            &record.path,
            record.branch.as_deref(),
            &record.head,
            record.staged.as_deref(),
            saved_sha.as_deref().unwrap_or(&record.head),
            &exclude,
        )
        .await?;
    let required = if git_intact {
        saved::private_files(&git, &record.path, &regenerable).await?
    } else {
        None
    };
    let held = scope.clone();
    let (record, archive, intact) = blocking(move || {
        let intact = match required {
            None => false,
            Some(names) if record.archived_files == 0 => {
                names.is_empty() && record.archived_bytes == 0
            }
            Some(names) => saved::recovery::matches(
                &record.path,
                &archive,
                (record.archived_files, record.archived_bytes),
                &names,
                &held,
            )?,
        };
        Ok::<_, Fault>((record, archive, intact))
    })
    .await??;
    if let Err(error) = written {
        if intact {
            saved::rollback(
                &git,
                &record.repo,
                record.saved_branch.as_deref(),
                saved_sha.as_deref(),
                &archive.to_string_lossy(),
                &scope,
            )
            .await;
        }
        return Err(error);
    }
    if !intact {
        return Err(saved::keep(
            "it changed while it was being saved; the recovery copies were kept",
        ));
    }
    // From the first attempt to remove, even a failure can have taken files. Never roll back the recovery copies.
    if let Some(reason) = saved::force_remove(&git, &record.repo, &record.path).await? {
        let reference = record
            .saved_branch
            .as_ref()
            .or(record.branch.as_ref())
            .unwrap_or(&record.head);
        return Err(Fault::new(
            "git_exit",
            format!(
                "git worktree remove failed for {} ({reason}); its work stays saved on {reference} and in archive {}",
                record.path, record.id
            ),
        ));
    }
    Reply::json(&record)
}

#[derive(Deserialize)]
struct Archive {
    git: Runner,
    dir: PathBuf,
    target: Target,
    entries: Vec<String>,
}

async fn archive(call: Call) -> Result<Reply, Fault> {
    let Archive {
        git,
        dir,
        target: Target {
            path,
            primary,
            branch,
        },
        entries,
    } = call.params()?;
    let scope = call.scope;
    let git = Git::new(git, scope.clone());
    let (id, archive) = blocking(move || new_archive(&dir, crate::clock::now_ms())).await??;
    let value = saved::archive(&git, &path, entries, archive, &scope).await?;
    Reply::json(&value.map(|(archived_files, archived_bytes, head)| Record {
        id,
        path,
        repo: primary,
        branch,
        head,
        saved_branch: None,
        staged: None,
        removed_at: crate::clock::now_ms(),
        archived_files,
        archived_bytes,
    }))
}

#[derive(Deserialize)]
struct Settle {
    dir: PathBuf,
    record: Record,
    removed: bool,
}

fn settle(p: Settle, scope: &Scope) -> Result<(), Fault> {
    tree::live(scope)?;
    let archive = archive_path(&p.dir, &p.record.id)?;
    if !p.removed
        && saved::recovery::settle(
            &p.record.path,
            &archive.to_string_lossy(),
            (p.record.archived_files, p.record.archived_bytes),
            scope,
        )?
    {
        return Ok(());
    }
    change(&p.dir, Change::Add(&p.record), scope)
}

#[derive(Deserialize)]
struct Restore {
    dir: PathBuf,
    record: Record,
    root: saved::entry::RootId,
}

#[derive(Serialize)]
struct Restored {
    restored: usize,
    skipped: usize,
}

fn finish_restore(p: Restore, scope: &Scope) -> Result<Restored, Fault> {
    tree::live(scope)?;
    let worktree = Path::new(&p.record.path);
    let held = saved::entry::verified_directory(worktree, p.root)?;
    let archive = archive_path(&p.dir, &p.record.id)?;
    let absent =
        matches!(fs::symlink_metadata(&archive), Err(e) if e.kind() == io::ErrorKind::NotFound);
    let archive = archive.to_string_lossy();
    let (restored, skipped) =
        if p.record.archived_files == 0 && p.record.archived_bytes == 0 && absent {
            (0, 0)
        } else {
            saved::recovery::restore(
                &p.record.path,
                &held,
                &archive,
                (p.record.archived_files, p.record.archived_bytes),
                scope,
            )?
        };
    if skipped == 0 {
        saved::entry::verified_directory(worktree, p.root)?;
        change(&p.dir, Change::Remove(&p.record.id), scope)?;
        if !absent {
            saved::forget(&archive, scope)?;
        }
    }
    Ok(Restored { restored, skipped })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Blob {
    worktree: String,
    path: String,
    named_secret: bool,
}

fn worktree_blob(p: Blob, scope: &Scope) -> Result<Reply, Fault> {
    tree::live(scope)?;
    tree::relative_entries([p.path.as_str()])?;
    use saved::entry::{Entry, Kind};
    let path = Path::new(&p.path);
    let candidate = match Entry::at(Path::new(&p.worktree), path, false) {
        Ok(entry) => entry,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Reply::json(&"skip"),
        Err(e) => return Err(tree::fault(&e, "open", path)),
    };
    match candidate.kind() {
        Ok(Kind::Directory | Kind::Link) => return Reply::json(&"skip"),
        Ok(Kind::Other) => return Err(saved::keep("a changed entry is not an ordinary file")),
        Ok(Kind::File) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Reply::json(&"skip"),
        Err(e) => return Err(tree::fault(&e, "lstat", path)),
    }
    if p.named_secret {
        return Reply::json(&"archive");
    }
    let Ok(file) = candidate.file(false) else {
        return Reply::json(&"archive");
    };
    let Ok(meta) = file.metadata() else {
        return Reply::json(&"archive");
    };
    let limit = saved::SECRET_SCAN_MAX_BYTES as u64;
    if meta.len() > limit {
        return Reply::json(&"archive");
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    if (&file).take(limit + 1).read_to_end(&mut bytes).is_err()
        || bytes.len() > saved::SECRET_SCAN_MAX_BYTES
        || !candidate.still_names(&file).unwrap_or(false)
    {
        return Reply::json(&"archive");
    }
    tree::live(scope)?;
    if bytes.is_empty() {
        return Reply::json(&"skip");
    }
    Ok(Reply::json(&"scan")?.with_bin(bytes))
}

pub(super) fn register(registry: &mut Registry) {
    registry.add("disk.savedWorktrees", |call| {
        Box::pin(async move {
            let p = call.params()?;
            blocking(move || Reply::json(&list(p, &call.scope)?)).await?
        })
    });
    registry.add("disk.findSavedWorktree", |call| {
        Box::pin(async move {
            let p = call.params()?;
            blocking(move || Reply::json(&find(p, &call.scope)?)).await?
        })
    });
    registry.add("disk.worktreeBlob", |call| {
        Box::pin(async move {
            let p = call.params()?;
            blocking(move || worktree_blob(p, &call.scope)).await?
        })
    });
    registry.add("disk.saveWork", |call| Box::pin(prepare(call)));
    registry.add("disk.finishSave", |call| Box::pin(finish_save(call)));
    registry.add("disk.archive", |call| Box::pin(archive(call)));
    registry.add("disk.settleArchive", |call| {
        Box::pin(async move {
            let p = call.params()?;
            blocking(move || Reply::json(&settle(p, &call.scope)?)).await?
        })
    });
    registry.add("disk.finishRestore", |call| {
        Box::pin(async move {
            let p = call.params()?;
            blocking(move || Reply::json(&finish_restore(p, &call.scope)?)).await?
        })
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_replaced_checkout_after_seeding_keeps_the_record_and_archive() {
        let dir = crate::fs::disk::make_temp_dir("ompdesk-restore-identity-").unwrap();
        let worktree = dir.join("work");
        let archive = dir.join("saved/one");
        fs::create_dir(&worktree).unwrap();
        let scope = Scope::detached();
        fs::write(worktree.join("notes"), b"saved").unwrap();
        let path = worktree.to_str().unwrap();
        let (files, bytes) = saved::write_archive(
            path,
            &["notes".into()],
            archive.to_str().unwrap(),
            &[],
            &scope,
        )
        .unwrap();
        let record = Record {
            id: "one".into(),
            path: path.into(),
            repo: dir.to_string_lossy().into_owned(),
            branch: None,
            head: "test".into(),
            saved_branch: None,
            staged: None,
            removed_at: 1,
            archived_files: files,
            archived_bytes: bytes,
        };
        change(&dir, Change::Add(&record), &scope).unwrap();
        let root = saved::entry::identity(&saved::entry::directory(&worktree).unwrap()).unwrap();
        fs::rename(&worktree, dir.join("original")).unwrap();
        fs::create_dir(&worktree).unwrap();
        let error = finish_restore(
            Restore {
                dir: dir.clone(),
                record,
                root,
            },
            &scope,
        )
        .err()
        .unwrap();
        assert_eq!(
            error.message,
            "the checkout directory changed during restore"
        );
        assert!(!worktree.join("notes").exists());
        assert_eq!(fs::read(archive.join("files/notes")).unwrap(), b"saved");
        assert_eq!(records(&dir.join("saved.json")).unwrap()[0]["id"], "one");
        tree::remove(&dir, false, &scope).unwrap();
    }

    #[test]
    fn an_archive_id_is_one_component_and_its_directory_is_not_a_link() {
        let dir = crate::fs::disk::make_temp_dir("ompdesk-record-id-").unwrap();
        for id in ["", ".", "..", "../other", "one/two", "one\\two", "C:one"] {
            assert!(archive_path(&dir, id).is_err());
        }
        let actual = dir.join("other");
        fs::create_dir(&actual).unwrap();
        #[cfg(windows)]
        crate::sys::junction(&actual, &dir.join("saved")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&actual, dir.join("saved")).unwrap();
        assert!(archive_path(&dir, "one").is_err());
        assert!(fs::read_dir(&actual).unwrap().next().is_none());
        tree::remove(&dir, false, &Scope::detached()).unwrap();
    }
}
