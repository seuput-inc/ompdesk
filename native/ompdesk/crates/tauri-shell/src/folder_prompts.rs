//! macOS asks "OMPdesk would like to access files in your Documents folder" whenever a session's omp (or a tool it
//! runs) reads a protected folder, because TCC names OMPdesk as the responsible app; a person who works in those folders
//! sees the dialog again and again. The system log says when such a dialog is shown (was `src/main/mac-tcc-watch.ts`;
//! Orca M87, approach after Orca, MIT, stablyai/orca `src/main/macos-permissions/macos-tcc-prompt-watch.ts`,
//! re-implemented). `system.watchFolderPrompts` starts reading it and each dialog on OMPdesk's account reaches Node as
//! the event `system.folderPrompt {service, responsible}`; `system.unwatchFolderPrompts` stops. Main shows the one Full
//! Disk Access notice (once ever, pref `folderAccessNoticeShown`) and then stops the watch. Nothing off macOS.
//!
//! `log stream` ignores its parent's death, so it runs under a small shell that ends it when its stdin closes: the app
//! quitting or crashing ends the watch. A watch that ends by itself is started again once.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde_json::json;

use crate::host::{self, Call};

/// The app's bundle id: the one TCC names as responsible for what OMPdesk and its children read.
const BUNDLE_ID: &str = "com.seuput.ompdesk";

/// The folder services Full Disk Access covers.
const FOLDER_SERVICES: &[&str] = &[
    "kTCCServiceSystemPolicyAppData",
    "kTCCServiceSystemPolicyAllFiles",
    "kTCCServiceSystemPolicyDocumentsFolder",
    "kTCCServiceSystemPolicyDesktopFolder",
    "kTCCServiceSystemPolicyDownloadsFolder",
    "kTCCServiceSystemPolicyRemovableVolumes",
    "kTCCServiceSystemPolicyNetworkVolumes",
];

const PREDICATE: &str =
    r#"subsystem == "com.apple.TCC" AND eventMessage CONTAINS "AUTHREQ_PROMPTING""#;

/// Ends `log stream` when this script's stdin closes; the stdin is kept on fd 3 because `&` hands /dev/null.
const WRAPPER: &str = r#"set +eu
exec 3<&0
/usr/bin/log stream --predicate "$1" --info --style compact </dev/null 3<&- &
pid=$!
{ read -r _ <&3; kill "$pid" 2>/dev/null; } &
wait "$pid""#;

#[derive(Debug, PartialEq, Eq)]
struct TccPrompt {
    service: String,
    responsible: String,
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// What follows each `key` in `line` that starts a word (a regex's `\bkey`), in order.
fn after<'a>(line: &'a str, key: &'a str) -> impl Iterator<Item = &'a str> + 'a {
    line.match_indices(key)
        .filter(move |(at, _)| !line[..*at].chars().next_back().is_some_and(is_word))
        .map(move |(at, _)| &line[at + key.len()..])
}

/// A `log stream --style compact` line of a TCC dialog being shown, else none: the first
/// `\bservice=(kTCCService\w+)` and the first `\bResp:\{TCCDProcess:\s*identifier=([^,}]+)`, trimmed.
fn parse(line: &str) -> Option<TccPrompt> {
    if !line.contains("AUTHREQ_PROMPTING") {
        return None;
    }
    let service = after(line, "service=").find_map(|rest| {
        let word = &rest[..rest.find(|c: char| !is_word(c)).unwrap_or(rest.len())];
        (word.len() > "kTCCService".len() && word.starts_with("kTCCService")).then_some(word)
    })?;
    let responsible = after(line, "Resp:{TCCDProcess:").find_map(|rest| {
        let value = rest.trim_start().strip_prefix("identifier=")?;
        let value = &value[..value.find([',', '}']).unwrap_or(value.len())];
        (!value.is_empty()).then_some(value)
    })?;
    let responsible = responsible.trim();
    (!responsible.is_empty()).then(|| TccPrompt {
        service: service.to_string(),
        responsible: responsible.to_string(),
    })
}

/// A folder dialog macOS shows on OMPdesk's account.
fn is_ompdesk_folder_prompt(prompt: &TccPrompt) -> bool {
    prompt.responsible == BUNDLE_ID && FOLDER_SERVICES.contains(&prompt.service.as_str())
}

struct State {
    child: Option<Child>,
    /// Bumped by every start and stop: a reader of an older run that ends changes nothing.
    run: u64,
    restarted: bool,
    stopped: bool,
}

static STATE: Mutex<State> = Mutex::new(State {
    child: None,
    run: 0,
    restarted: false,
    stopped: true,
});

fn state() -> MutexGuard<'static, State> {
    STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn handle(call: Call) {
    match call.method.as_str() {
        "system.watchFolderPrompts" => {
            let mut state = state();
            if state.stopped {
                state.stopped = false;
                state.restarted = false;
                start(&mut state);
            }
            drop(state);
            call.ok(json!({}));
        }
        "system.unwatchFolderPrompts" => {
            let mut state = state();
            state.stopped = true;
            state.run += 1;
            if let Some(mut child) = state.child.take() {
                drop(child.stdin.take());
                let _ = child.kill();
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
            }
            drop(state);
            call.ok(json!({}));
        }
        _ => call.unsupported(),
    }
}

fn start(state: &mut State) {
    if !cfg!(target_os = "macos") {
        return;
    }
    state.run += 1;
    let run = state.run;
    let Ok(mut child) = Command::new("/bin/sh")
        .args(["-c", WRAPPER, "sh", PREDICATE])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        return;
    };
    state.child = Some(child);
    let read = move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Some(prompt) = parse(&line).filter(is_ompdesk_folder_prompt) {
                host::event(
                    "system.folderPrompt",
                    json!({ "service": prompt.service, "responsible": prompt.responsible }),
                );
            }
        }
        ended(run);
    };
    if std::thread::Builder::new()
        .name("folder-prompts".into())
        .spawn(read)
        .is_err()
        && let Some(mut child) = state.child.take()
    {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// The log of run `run` ended: its process is reaped and, the first time it ended by itself, started again.
fn ended(run: u64) {
    let mut held = state();
    if held.run != run {
        return;
    }
    if let Some(mut child) = held.child.take() {
        drop(child.stdin.take());
        let _ = child.wait();
    }
    if held.stopped || held.restarted {
        return;
    }
    held.restarted = true;
    drop(held);
    std::thread::sleep(Duration::from_secs(1));
    let mut held = state();
    if !held.stopped && held.run == run {
        start(&mut held);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The shape of tccd's AUTHREQ_PROMPTING line in `log stream --style compact`, as Orca's parser reads it.
    fn line(service: &str, responsible: &str) -> String {
        format!(
            "2026-11-25 10:00:00.000 Df tccd[123:abc] [com.apple.TCC:access] AUTHREQ_PROMPTING: msgID=1.2, service={service}, subject=Sub:{{/Users/me/.bun/bin/omp}}Resp:{{TCCDProcess: identifier={responsible}, pid=456, auid=501, euid=501, binary_path=/Applications/OMPdesk.app/Contents/MacOS/OMPdesk}},"
        )
    }

    #[test]
    fn tells_ompdesk_s_folder_dialogs_from_other_apps_and_other_services() {
        let documents = parse(&line(
            "kTCCServiceSystemPolicyDocumentsFolder",
            "com.seuput.ompdesk",
        ))
        .unwrap();
        assert_eq!(
            documents,
            TccPrompt {
                service: "kTCCServiceSystemPolicyDocumentsFolder".into(),
                responsible: "com.seuput.ompdesk".into(),
            }
        );
        assert!(is_ompdesk_folder_prompt(&documents));

        let other = parse(&line(
            "kTCCServiceSystemPolicyDocumentsFolder",
            "com.apple.Terminal",
        ))
        .unwrap();
        assert!(!is_ompdesk_folder_prompt(&other));
        let camera = parse(&line("kTCCServiceCamera", "com.seuput.ompdesk")).unwrap();
        assert!(!is_ompdesk_folder_prompt(&camera));
        assert_eq!(
            parse("tccd: AUTHREQ_RESULT service=kTCCServiceSystemPolicyDocumentsFolder"),
            None
        );
    }
}
