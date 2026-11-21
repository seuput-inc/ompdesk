use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::server::{Answer, Fault, Registry, Reply};
use serde::Deserialize;

pub(super) fn register(registry: &mut Registry) {
    registry.add("setup.firstPackageCandidate", |call| {
        launcher_io(move || {
            let p: Candidates = call.params()?;
            let skipped = p
                .files
                .iter()
                .take_while(|f| is_compiled(f, p.windows) == Some(true))
                .count();
            Reply::json(&skipped)
        })
    });
    registry.add("setup.setAsideCompiledOmp", |call| {
        launcher_io(move || {
            let p: LauncherRepair = call.params()?;
            Reply::json(&p.set_aside())
        })
    });
    registry.add("setup.settleCompiledOmp", |call| {
        launcher_io(move || {
            let p: Settlement = call.params()?;
            p.repair.settle(p.installed);
            Reply::json(&())
        })
    });
}

#[derive(Deserialize)]
struct Candidates {
    files: Vec<PathBuf>,
    windows: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LauncherRepair {
    bun_install: PathBuf,
    windows: bool,
    now: i64,
    nonce: u64,
}

#[derive(Deserialize)]
struct Settlement {
    #[serde(flatten)]
    repair: LauncherRepair,
    installed: bool,
}

fn launcher_io(work: impl FnOnce() -> Result<Reply, Fault> + Send + 'static) -> Answer {
    Box::pin(async move {
        tokio::task::spawn_blocking(work)
            .await
            .map_err(|error| Fault::new("internal", error.to_string()))?
    })
}

/// A Windows Bun shim is a PE too; only the standalone has a complete `.bun` section header.
/// Follow symlinks for this read, but rename the launcher itself during repair.
fn is_compiled(file: &Path, windows: bool) -> Option<bool> {
    let mut head = [0; 4096];
    let read = File::open(file).and_then(|mut f| f.read(&mut head)).ok()?;
    Some(compiled_header(&head[..read], windows))
}

fn compiled_header(head: &[u8], windows: bool) -> bool {
    if head.len() < 4 {
        return false;
    }
    if !windows {
        return matches!(
            u32::from_be_bytes(head[..4].try_into().unwrap()),
            0x7f454c46 | 0xfeedface | 0xfeedfacf | 0xcefaedfe | 0xcffaedfe | 0xcafebabe
        );
    }
    if head.len() < 0x40 || &head[..2] != b"MZ" {
        return false;
    }
    let pe = u32::from_le_bytes(head[0x3c..0x40].try_into().unwrap()) as usize;
    let Some(header) = head.get(pe..) else {
        return false;
    };
    if header.len() < 24 || !header.starts_with(b"PE\0\0") {
        return false;
    }
    let sections = u16::from_le_bytes([header[6], header[7]]) as usize;
    let table = 24 + u16::from_le_bytes([header[20], header[21]]) as usize;
    header.get(table..).is_some_and(|rest| {
        rest.as_chunks::<40>()
            .0
            .iter()
            .take(sections)
            .any(|section| &section[..8] == b".bun\0\0\0\0")
    })
}

const TAG: &str = ".ompdesk-compiled-";

impl LauncherRepair {
    fn name(&self) -> &'static str {
        if self.windows { "omp.exe" } else { "omp" }
    }

    fn aside(&self, launcher: &Path) -> PathBuf {
        launcher.with_file_name(format!("{}{TAG}{}-{}", self.name(), self.now, self.nonce))
    }

    fn set_aside(&self) -> bool {
        let bin = self.bun_install.join("bin");
        let name = self.name();
        let launcher = bin.join(name);
        // After an interrupted repair an aside may be the only surviving launcher.
        if !fs::metadata(&launcher).is_ok_and(|m| m.is_file()) {
            return false;
        }
        match is_compiled(&launcher, self.windows) {
            Some(true) => {
                crate::sys::move_launcher_exclusive(&launcher, &self.aside(&launcher)).is_ok()
            }
            Some(false) => {
                self.sweep_older(&bin);
                false
            }
            None => false,
        }
    }

    fn sweep_older(&self, bin: &Path) {
        let prefix = format!("{}{TAG}", self.name());
        let Ok(entries) = fs::read_dir(bin) else {
            return;
        };
        for entry in entries.flatten() {
            let file = entry.file_name();
            let Some(suffix) = file.to_str().and_then(|s| s.strip_prefix(&prefix)) else {
                continue;
            };
            if suffix.parse::<i64>().is_ok_and(|t| t < self.now) {
                // Legacy timestamp-only backup, from before repairs had per-attempt names.
                let _ = fs::remove_file(entry.path());
            } else if let Some(id) = suffix.strip_suffix(".retired")
                && let Some((time, nonce)) = id.split_once('-')
                && time.parse::<i64>().is_ok()
                && nonce.parse::<u64>().is_ok()
            {
                let backup = entry.path().with_extension("");
                if !matches!(fs::remove_file(backup), Err(e) if e.kind() != std::io::ErrorKind::NotFound)
                {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }

    fn settle(&self, installed: bool) {
        let bin = self.bun_install.join("bin");
        let launcher = bin.join(self.name());
        let aside = self.aside(&launcher);
        // Only a confirmed replacement can retire a backup. A later sweep never touches an unmarked repair.
        if installed
            && fs::metadata(&launcher).is_ok_and(|m| m.is_file())
            && is_compiled(&launcher, self.windows) == Some(false)
        {
            self.sweep_older(&bin);
            if let Err(error) = fs::remove_file(&aside)
                && error.kind() != std::io::ErrorKind::NotFound
            {
                // A running Windows executable can still deny deletion after a successful install.
                let _ = File::create_new(aside.with_added_extension("retired"));
            }
        } else {
            let _ = crate::sys::move_launcher_exclusive(&aside, &launcher);
        }
    }
}
