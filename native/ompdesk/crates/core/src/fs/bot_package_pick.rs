//! A native picker or authenticated web directory listing may offer a file. A bot command can only take it.
use std::collections::VecDeque;
use std::fs::File;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::server::{Call, Fault, Reply};

struct Pick {
    caller: String,
    id: String,
    issued: Instant,
    file: File,
}

// Keep the open file, not its path: replacing the listed file cannot redirect an outstanding selection.
static PICKS: Mutex<VecDeque<Pick>> = Mutex::new(VecDeque::new());
const TTL: Duration = Duration::from_secs(300);

pub(crate) fn offer(caller: &str, path: &Path) -> Result<String, Fault> {
    let file = super::editor::regular_file(path)?;
    let mut bytes = [0; 16];
    crate::sys::random(&mut bytes).map_err(|error| Fault::new("io", error.to_string()))?;
    let id = crate::hex(&bytes);
    let mut picks = PICKS.lock().unwrap();
    picks.retain(|p| p.caller != caller && p.issued.elapsed() < TTL);
    if picks.len() == 64 {
        picks.pop_front();
    }
    picks.push_back(Pick {
        caller: caller.to_owned(),
        id: id.clone(),
        issued: Instant::now(),
        file,
    });
    Ok(id)
}

pub(crate) fn take(caller: &str, id: &str) -> Option<File> {
    let mut picks = PICKS.lock().unwrap();
    let index = picks
        .iter()
        .position(|p| p.caller == caller && p.id == id)?;
    let pick = picks.remove(index)?;
    (pick.issued.elapsed() < TTL).then_some(pick.file)
}

pub(super) fn native(call: Call) -> Result<Reply, Fault> {
    #[derive(Deserialize)]
    struct Params {
        caller: String,
        file: std::path::PathBuf,
    }
    let p: Params = call.params()?;
    Reply::json(&offer(&p.caller, &p.file)?)
}
