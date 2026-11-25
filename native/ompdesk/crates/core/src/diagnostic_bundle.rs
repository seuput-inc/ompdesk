//! Save the already-redacted stock archive with the local diagnostics report. Local archives never cross the wire.

use std::fs::File;
use std::io::{self, BufReader, Cursor, Read, Seek, Write};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::server::{Call, Fault, Registry, Reply, Scope};

const REPORT: &str = "ompdesk-diagnostics.txt";

#[derive(Deserialize)]
struct Params {
    source: Option<PathBuf>,
    file: PathBuf,
    #[serde(default)]
    unique: bool,
    diagnostics: String,
}

pub(crate) fn register(registry: &mut Registry) {
    registry.add("diagnosticBundle.save", |call| Box::pin(handle(call)));
}

async fn handle(call: Call) -> Result<Reply, Fault> {
    let params: Params = call.params()?;
    tokio::task::spawn_blocking(move || {
        let file = match (&params.source, call.bin) {
            (Some(path), None) => {
                let input = File::open(path).map_err(|e| failed(path, e))?;
                save(BufReader::new(input), &params, &call.scope)
            }
            (None, Some(bytes)) => save(Cursor::new(bytes), &params, &call.scope),
            _ => {
                return Err(Fault::new(
                    "invalid_params",
                    "Expected a local archive or host bytes",
                ));
            }
        }?;
        Reply::json(&file)
    })
    .await
    .map_err(|e| Fault::new("internal", e.to_string()))?
}

fn failed(path: &Path, error: io::Error) -> Fault {
    Fault::new("diagnostic_bundle", format!("{}: {error}", path.display()))
}

fn save(input: impl Read + Seek, params: &Params, scope: &Scope) -> Result<PathBuf, Fault> {
    if scope.cancelled() {
        return Err(Fault::cancelled());
    }
    let file = &params.file;
    let dir = file
        .parent()
        .ok_or_else(|| Fault::new("invalid_path", "Expected a bundle filename"))?;
    // Preserve writeFile's 0666 & umask for a new file without exposing a partial archive in the chosen folder.
    #[cfg(unix)]
    let private = tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir_in(dir)
        .map_err(|e| failed(file, e))?;
    #[cfg(unix)]
    let staged = tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o666))
        .tempfile_in(private.path());
    #[cfg(not(unix))]
    let staged = tempfile::NamedTempFile::new_in(dir);
    let mut staged = staged.map_err(|e| failed(file, e))?;
    assemble(input, staged.as_file_mut(), &params.diagnostics, scope)
        .map_err(|e| failed(file, e))?;
    if scope.cancelled() {
        return Err(Fault::cancelled());
    }
    let stem = file
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| Fault::new("invalid_path", "Expected a bundle filename"))?;
    let mut candidate = file.clone();
    let mut n = 1_u64;
    loop {
        match staged.persist_noclobber(&candidate) {
            Ok(_) => return Ok(candidate),
            Err(e)
                if e.error.kind() == io::ErrorKind::AlreadyExists
                    || (params.unique && std::fs::symlink_metadata(&candidate).is_ok()) =>
            {
                if scope.cancelled() {
                    return Err(Fault::cancelled());
                }
                if !params.unique {
                    // fsp.writeFile followed links and kept the existing inode and its permissions.
                    let mut source = e.file;
                    source.rewind().map_err(|e| failed(file, e))?;
                    let mut out = File::create(file).map_err(|e| failed(file, e))?;
                    io::copy(&mut source, &mut out).map_err(|e| failed(file, e))?;
                    return Ok(candidate);
                }
                staged = e.file;
                n += 1;
                candidate.set_file_name(format!("{stem} ({n}).zip"));
            }
            Err(e) => return Err(failed(&candidate, e.error)),
        }
    }
}

fn assemble(input: impl Read + Seek, out: &mut File, text: &str, scope: &Scope) -> io::Result<()> {
    let mut archive = ZipArchive::new(input)?;
    if archive.has_overlapping_entries()? {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Overlapping ZIP members",
        ));
    }
    let mut zip = ZipWriter::new(out);
    let report = |zip: &mut ZipWriter<&mut File>| -> io::Result<()> {
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        zip.start_file(REPORT, options)?;
        zip.write_all(text.as_bytes())
    };
    let mut wrote_report = false;
    for index in 0..archive.len() {
        if scope.cancelled() {
            return Err(io::Error::other("The request was cancelled"));
        }
        let member = archive.by_index(index)?;
        let name = member.name()?;
        if member.is_symlink()
            || member.enclosed_name().is_none()
            || name.contains(['\\', ':', '\0'])
            || name
                .trim_end_matches('/')
                .split('/')
                .any(|p| matches!(p, "" | "." | ".."))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Unsafe ZIP member",
            ));
        }
        if name == REPORT {
            report(&mut zip)?;
            wrote_report = true;
        } else {
            // Keep stock's compressed bytes without inflating a transcript (or an untrusted host's entry).
            zip.raw_copy_file(member)?;
        }
    }
    if !wrote_report {
        report(&mut zip)?;
    }
    zip.finish()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine, engine::general_purpose::STANDARD};

    // JSZip's deflated input for the captured saveDiagnosticBundle result, including a pre-existing report.
    const STOCK: &str = concat!(
        "UEsDBAoAAAAIAAAAIlATfEIIEQAAAA8AAAAJAAAAYS9ub3RlLm1kS04sKCktSlV4O3XOqx0NXABQSwMECgAA",
        "AAgAAAAiUNydzwIKAAAACAAAABcAAABvbXBkZXNrLWRpYWdub3N0aWNzLnR4dCsoSi3LzC8tBgBQSwECFAAK",
        "AAAACAAAACJQE3xCCBEAAAAPAAAACQAAAAAAAAAAAAAAAAAAAAAAYS9ub3RlLm1kUEsBAhQACgAAAAgAAAAiUNyd",
        "zwIKAAAACAAAABcAAAAAAAAAAAAAAAAAOAAAAG9tcGRlc2stZGlhZ25vc3RpY3MudHh0UEsFBgAAAAACAAIAfAAA",
        "AHcAAAAAAA=="
    );

    #[test]
    fn captured_members_and_failure_leave_the_chosen_file_intact() {
        let dir = tempfile::tempdir().unwrap();
        let params = Params {
            source: None,
            file: dir.path().join("chosen.zip"),
            unique: false,
            diagnostics: "report\n".into(),
        };
        let scope = Scope::detached();
        let input = STANDARD.decode(STOCK).unwrap();
        let path = save(Cursor::new(&input), &params, &scope).unwrap();
        let saved = std::fs::read(&path).unwrap();
        let mut zip = ZipArchive::new(Cursor::new(&saved)).unwrap();
        assert_eq!(zip.len(), 2);
        let expected = [("a/note.md", "capture 한글\n"), (REPORT, "report\n")];
        for (i, (name, content)) in expected.into_iter().enumerate() {
            let mut entry = zip.by_index(i).unwrap();
            assert_eq!(entry.name().unwrap(), name);
            let mut text = String::new();
            entry.read_to_string(&mut text).unwrap();
            assert_eq!(text, content);
        }
        assert!(save(Cursor::new(b"not a zip"), &params, &scope).is_err());
        scope.cancel();
        assert!(save(Cursor::new(&input), &params, &scope).is_err());
        assert_eq!(std::fs::read(path).unwrap(), saved);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
