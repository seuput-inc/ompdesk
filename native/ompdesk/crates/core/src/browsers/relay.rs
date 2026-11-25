//! The omp relay extension of one browser, installed with stock's CLI into its final folder: the native host
//! authorizes the extension ID that folder's path determines.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::run::{Exec, Opts, Runner};
use crate::server::{Fault, Scope};

use super::Id;

/// How long stock's install may take.
const INSTALL_TIMEOUT_MS: u64 = 30_000;

/// What omp's output is kept up to (the TypeScript kept all of it; only its words in a failure are read).
const OMP_OUTPUT_KEPT: usize = 4 * 1024 * 1024;

/// Where `id`'s own copy of the extension lives, and where the browser's profile records loading it from. One copy
/// per browser: another browser's copy never counts for this one.
pub fn extension_dir(home: &str, id: Id) -> PathBuf {
    Path::new(home)
        .join(".omp")
        .join("browser-relay")
        .join(format!("extension-{}", id.name()))
}

/// How main runs omp: its binary (a `.cmd` shim goes through cmd.exe, as std runs one) and its whole environment
/// (`ompRunEnv`: main's, the spawn PATH with omp's own folders, telemetry off).
#[derive(Deserialize)]
pub struct Omp {
    bin: String,
    env: BTreeMap<String, String>,
}

#[derive(Deserialize)]
pub struct InstallParams {
    omp: Omp,
    id: Id,
    home: String,
}

/// Stock installs the browser's copy in its final folder without editing a profile; only the user loads it into
/// one. Answers the folder.
pub async fn install(params: InstallParams, scope: Scope) -> Result<String, Fault> {
    let dir = extension_dir(&params.home, params.id);
    let dir = dir.to_string_lossy().into_owned();
    let runner = Runner {
        bin: params.omp.bin,
        args: Vec::new(),
        env: params.omp.env,
        timeout_ms: INSTALL_TIMEOUT_MS,
        max_bytes: OMP_OUTPUT_KEPT,
    };
    let ended = Exec::new(runner, scope, "omp")
        .run_kept(
            ".",
            &["browser-relay", "install", "--dir", &dir, "--no-chrome"],
            Opts::default(),
        )
        .await?;
    if ended.timed_out {
        return Err(Fault::new(
            "omp_timeout",
            format!("omp browser-relay timed out after {INSTALL_TIMEOUT_MS}ms"),
        ));
    }
    let output = ended.output;
    if output.code == 0 {
        return Ok(dir);
    }
    let stderr = output.stderr.trim();
    let stdout = output.text();
    let message = if !stderr.is_empty() {
        stderr.to_owned()
    } else if !stdout.trim().is_empty() {
        stdout.trim().to_owned()
    } else {
        format!("omp browser-relay install exited {}", output.code)
    };
    Err(Fault::new("omp_exit", message))
}
