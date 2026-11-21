use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::server::{Answer, Fault, Registry, Reply};
use serde::Deserialize;

pub(super) fn register(registry: &mut Registry) {
    registry.add("setup.isCompiledOmp", |call| {
        launcher_io(move || {
            let p: InspectLauncher = call.params()?;
            Reply::json(&is_compiled(&p.file, p.windows))
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
            call.params::<LauncherRepair>()?.settle();
            Reply::json(&())
        })
    });
}

#[derive(Deserialize)]
struct InspectLauncher {
    file: PathBuf,
    windows: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LauncherRepair {
    bun_install: PathBuf,
    windows: bool,
    now: i64,
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
fn is_compiled(file: &Path, windows: bool) -> bool {
    let mut head = [0; 4096];
    let Ok(read) = File::open(file).and_then(|mut f| f.read(&mut head)) else {
        return false;
    };
    if read < 4 {
        return false;
    }
    if !windows {
        return matches!(
            u32::from_be_bytes(head[..4].try_into().unwrap()),
            0x7f454c46 | 0xfeedface | 0xfeedfacf | 0xcefaedfe | 0xcffaedfe | 0xcafebabe
        );
    }
    if read < 0x40 || &head[..2] != b"MZ" {
        return false;
    }
    let pe = u32::from_le_bytes(head[0x3c..0x40].try_into().unwrap()) as usize;
    let Some(header) = head[0..read].get(pe..) else {
        return false;
    };
    if header.len() < 24 || !header.starts_with(b"PE\0\0") {
        return false;
    }
    let sections = u16::from_le_bytes([header[6], header[7]]) as usize;
    let table = 24 + u16::from_le_bytes([header[20], header[21]]) as usize;
    header.get(table..).is_some_and(|rest| {
        rest.chunks_exact(40)
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
        launcher.with_file_name(format!("{}{TAG}{}", self.name(), self.now))
    }

    fn set_aside(&self) -> bool {
        let bin = self.bun_install.join("bin");
        let name = self.name();
        if let Ok(entries) = fs::read_dir(&bin) {
            for entry in entries.flatten() {
                if entry
                    .file_name()
                    .to_str()
                    .and_then(|s| s.strip_prefix(name))
                    .is_some_and(|s| s.starts_with(TAG))
                {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        let launcher = bin.join(name);
        is_compiled(&launcher, self.windows) && fs::rename(&launcher, self.aside(&launcher)).is_ok()
    }

    fn settle(&self) {
        let launcher = self.bun_install.join("bin").join(self.name());
        let aside = self.aside(&launcher);
        // A running Windows executable may still be undeletable. The next repair sweeps it.
        if launcher.exists() {
            let _ = fs::remove_file(aside);
        } else {
            let _ = fs::rename(aside, launcher);
        }
    }
}
