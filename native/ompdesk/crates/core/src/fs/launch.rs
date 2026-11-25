use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::error::NodeError;
use crate::server::{Fault, Reply};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct InitialCwd {
    argv: Vec<String>,
    last_project: Option<String>,
    cwd: String,
    home: String,
}

#[derive(Serialize)]
struct Selected<'a> {
    cwd: &'a str,
    explicit: bool,
}

pub(super) fn initial_cwd(input: InitialCwd) -> Result<Reply, Fault> {
    let base = Path::new(&input.cwd);
    // Explicit argv historically accepts any existing path, including a file or the root.
    if let Some(arg) = input.argv.iter().find(|arg| !arg.starts_with('-'))
        && !arg.is_empty()
        && base.join(arg).exists()
    {
        return Reply::json(&Selected {
            cwd: arg,
            explicit: true,
        });
    }
    let cwd = [input.last_project.as_deref(), Some(input.cwd.as_str())]
        .into_iter()
        .flatten()
        .find(|&p| !p.is_empty() && p != "/" && base.join(p).is_dir())
        .unwrap_or(&input.home);
    Reply::json(&Selected {
        cwd,
        explicit: false,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Workspace {
    agent_dir: PathBuf,
    create: bool,
}

pub(super) fn workspace(input: Workspace) -> Result<Reply, Fault> {
    let dir = input
        .agent_dir
        .parent()
        .unwrap_or(&input.agent_dir)
        .join("work");
    if input.create {
        std::fs::create_dir_all(&dir).map_err(|err| {
            let error = NodeError::new(&err, "mkdir", dir.to_str());
            Fault::new(error.code, error.message)
        })?;
    }
    Reply::json(&dir)
}
