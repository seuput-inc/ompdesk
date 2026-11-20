//! The project boundary inside the service (`rules/boundary.rs` decides): the facts of one caller and one target,
//! the refusals, the line a list shows instead of another project's sessions, and the line `log` mode writes.
//! Main names every project (`project` of a tab, a stored row and a summary, and the `project` ask for a folder); the
//! core never reads a folder.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Map, Value, json};

use super::AgentControl;
use super::fail::{R, fail};
use super::host::HostState;
use super::text::waits;
use super::types::{
    ControlTab, ScheduleRow, SessionSummary, StoredSession, StoredWork, TabStatus, Target, Tool,
};
use crate::agentctl::journal::send_outbox::receiver_key;
use crate::agentctl::rules::boundary::{
    BoundaryFacts, BoundaryMode, BoundaryVerdict, boundary_verdict,
};

pub const OTHER_PROJECT: &str = "That session is in another project; another project's sessions show counts only. The user can allow this session to work across projects in its sidebar menu.";
const OTHER_FOLDER: &str = "That folder is in another project, or OMPdesk cannot tell its project yet; this session starts work only in its own project. The user can allow this session to work across projects in its sidebar menu.";
const APP_SESSIONS: &str = "ompdesk_app's sessions.saved and sessions.search list every project's saved sessions; use ompdesk_sessions, which keeps to this project. The user can allow this session to work across projects in its sidebar menu.";
pub const OTHER_SCHEDULE: &str = "That scheduled run is in another project; another project's schedules show as a count only. The user can allow this session to work across projects in its sidebar menu.";

/// The asks whose work main may hand to a paired host over the link: each carries who is asking (`claim`), so the
/// host judges the request by its own project boundary too.
const CLAIMED_ASKS: [&str; 21] = [
    "command",
    "spawn",
    "stored",
    "storedMessages",
    "sessionPace",
    "answer",
    "land",
    "deleteSession",
    "deleteStored",
    "branchFacts",
    "branchEvidence",
    "mergeBranch",
    "landing",
    "removeSafeWorktree",
    "discardWorktree",
    "schedules.command",
    "schedules.create",
    "autopilot.plan",
    "autopilot.start",
    "autopilot.status",
    "autopilot.stop",
];

/// The tool call the running work belongs to: the one line `log` mode writes of it, and who is calling.
pub(super) struct Call {
    tool: &'static str,
    logged: AtomicBool,
    /// Set once the call's caller is known (`AgentControl::claim`).
    claim: OnceLock<Value>,
}

impl Call {
    pub(super) fn new(tool: Tool) -> Call {
        Call {
            tool: tool.name(),
            logged: AtomicBool::new(false),
            claim: OnceLock::new(),
        }
    }
}

/// Who is calling, for an ask of `method` made inside a tool call; None outside one and for an ask that stays here.
pub(super) fn claim_for(method: &str) -> Option<Value> {
    if !CLAIMED_ASKS.contains(&method) {
        return None;
    }
    CALL.try_with(|call| call.claim.get().cloned())
        .ok()
        .flatten()
}

tokio::task_local! {
    pub(super) static CALL: Call;
}

/// What a session a list leaves out does, for its counts.
#[derive(Clone, Copy)]
pub enum Doing {
    Running,
    Waiting,
    Idle,
}

impl Doing {
    pub fn of_tab(tab: &ControlTab) -> Doing {
        if waits(tab) {
            Doing::Waiting
        } else if tab.busy
            || matches!(
                tab.status,
                TabStatus::Starting | TabStatus::Restarting | TabStatus::Waiting
            )
        {
            Doing::Running
        } else {
            Doing::Idle
        }
    }

    pub fn of_summary(summary: &SessionSummary) -> Doing {
        if summary.ask.is_some() {
            Doing::Waiting
        } else if matches!(summary.status, TabStatus::Running | TabStatus::Starting) {
            Doing::Running
        } else {
            Doing::Idle
        }
    }

    pub fn of_row(row: &StoredSession) -> Doing {
        match row.elsewhere.as_ref().and_then(|open| open.work) {
            Some(StoredWork::Turn | StoredWork::Background) => Doing::Running,
            Some(StoredWork::Waiting) => Doing::Waiting,
            _ => Doing::Idle,
        }
    }
}

/// Another project's sessions a list leaves out: counts, and nothing that names one.
#[derive(Default)]
pub struct Outside {
    sessions: usize,
    projects: HashSet<String>,
    /// Some of them are in a project main has not resolved: counted as one more.
    unknown: bool,
    running: usize,
    waiting: usize,
    idle: usize,
}

impl Outside {
    pub fn add(&mut self, project: Option<&str>, doing: Doing) {
        self.sessions += 1;
        match project {
            Some(project) => {
                self.projects.insert(project.to_owned());
            }
            None => self.unknown = true,
        }
        match doing {
            Doing::Running => self.running += 1,
            Doing::Waiting => self.waiting += 1,
            Doing::Idle => self.idle += 1,
        }
    }

    /// The one line a list ends its rows with; "" when it left nothing out.
    pub fn line(&self) -> String {
        if self.sessions == 0 {
            return String::new();
        }
        let projects = self.projects.len() + usize::from(self.unknown);
        format!(
            "\n{} session{} in {projects} other project{}: {} running, {} waiting for the user, {} idle (another project's sessions show counts only)",
            self.sessions,
            if self.sessions == 1 { "" } else { "s" },
            if projects == 1 { "" } else { "s" },
            self.running,
            self.waiting,
            self.idle
        )
    }
}

impl AgentControl {
    /// The person allowed `caller`'s session to work across projects: by its file, this computer's sessions only.
    fn granted(state: &HostState, caller: &ControlTab) -> bool {
        caller.device.is_none()
            && caller
                .session_path
                .as_ref()
                .is_some_and(|path| state.boundary.granted.contains(path))
    }

    /// The boundary filters what `caller` reaches: it enforces and the caller holds no grant.
    pub fn bounded(state: &HostState, caller: &ControlTab) -> bool {
        state.boundary.mode == BoundaryMode::Enforce && !Self::granted(state, caller)
    }

    /// `caller` opened this through a check that passed (`Mem.checked`): by its tab, or by its session file.
    fn through_check(
        &self,
        caller: &ControlTab,
        tab_id: Option<&str>,
        path: Option<&str>,
        device: Option<&str>,
    ) -> bool {
        let mut mem = self.mem();
        let Some(checked) = mem.checked.get_mut(&caller.tab_id) else {
            return false;
        };
        let key = path
            .filter(|path| !path.is_empty())
            .map(|path| receiver_key(path, device));
        if key.as_ref().is_some_and(|key| checked.contains(key)) {
            return true;
        }
        if !tab_id.is_some_and(|id| checked.contains(id)) {
            return false;
        }
        // A child with no file yet when it opened: its file names it once its tab is gone.
        if let Some(key) = key {
            checked.insert(key);
        }
        true
    }

    fn verdict(
        &self,
        state: &HostState,
        caller: &ControlTab,
        project: Option<&str>,
        through_check: bool,
        opened: bool,
    ) -> BoundaryVerdict {
        boundary_verdict(&BoundaryFacts {
            mode: state.boundary.mode,
            granted: Self::granted(state, caller),
            caller_project: caller.project.as_deref(),
            target_project: project,
            opened_through_check: through_check,
            opened_earlier: opened && !through_check,
            earlier_opened: state.boundary.earlier_opened,
        })
    }

    pub fn tab_verdict(
        &self,
        state: &HostState,
        caller: &ControlTab,
        tab: &ControlTab,
    ) -> BoundaryVerdict {
        if state.boundary.mode == BoundaryMode::Off || tab.tab_id == caller.tab_id {
            return BoundaryVerdict::Allow;
        }
        let through = self.through_check(
            caller,
            Some(&tab.tab_id),
            tab.session_path.as_deref(),
            tab.device.as_deref(),
        );
        let opened = state.parent_of(&tab.tab_id) == Some(caller.tab_id.as_str())
            || self
                .mem()
                .opened
                .get(&caller.tab_id)
                .is_some_and(|opened| opened.contains(&tab.tab_id));
        self.verdict(state, caller, tab.project.as_deref(), through, opened)
    }

    pub fn row_verdict(
        &self,
        state: &HostState,
        caller: &ControlTab,
        row: &StoredSession,
    ) -> BoundaryVerdict {
        // Its own computer already left it out (a paired host that enforces): whatever this computer's mode says.
        if row.outside {
            return BoundaryVerdict::Refuse;
        }
        let own = row.device == caller.device
            && caller.session_path.as_deref() == Some(row.path.as_str());
        if state.boundary.mode == BoundaryMode::Off || own {
            return BoundaryVerdict::Allow;
        }
        let device = row.device.as_deref();
        let through = self.through_check(caller, None, Some(&row.path), device);
        let opened = self.own_closed(state, caller, &row.path, device);
        self.verdict(state, caller, row.project.as_deref(), through, opened)
    }

    /// A session open in a tab no window of this app holds: by its project alone.
    pub fn summary_verdict(
        &self,
        state: &HostState,
        caller: &ControlTab,
        summary: &SessionSummary,
    ) -> BoundaryVerdict {
        self.verdict(state, caller, summary.project.as_deref(), false, false)
    }

    /// Whether a list shows a row: another project's is counted in `outside` instead, and under `log` written down.
    pub fn listed(
        &self,
        caller: &ControlTab,
        verdict: BoundaryVerdict,
        outside: &mut Outside,
        target: &str,
        project: Option<&str>,
        doing: Doing,
    ) -> bool {
        match verdict {
            BoundaryVerdict::Allow => true,
            BoundaryVerdict::Log => {
                self.log_crossing(caller, target, project);
                true
            }
            BoundaryVerdict::Refuse => {
                outside.add(project, doing);
                false
            }
        }
    }

    /// Under `log`: one line per tool call, of the first thing it reached that `enforce` would refuse.
    pub fn log_crossing(&self, caller: &ControlTab, target: &str, project: Option<&str>) {
        let tool = CALL
            .try_with(|call| (!call.logged.swap(true, Ordering::Relaxed)).then_some(call.tool))
            .unwrap_or(Some(""));
        let Some(tool) = tool else {
            return;
        };
        self.host.boundary_log(&json!({
            "tool": tool,
            "caller": caller.session_path.as_deref().unwrap_or(&caller.tab_id),
            "target": target,
            "callerProject": caller.project,
            "targetProject": project,
        }));
    }

    /// What a name resolved to while the boundary does not filter: under `log`, written down when it would.
    pub fn note_target(&self, state: &HostState, caller: &ControlTab, target: &Target) {
        match target {
            Target::Tab(tab) if self.tab_verdict(state, caller, tab) == BoundaryVerdict::Log => {
                self.log_crossing(
                    caller,
                    tab.session_path.as_deref().unwrap_or(&tab.cwd),
                    tab.project.as_deref(),
                );
            }
            Target::Stored(row) if self.row_verdict(state, caller, row) == BoundaryVerdict::Log => {
                self.log_crossing(caller, &row.path, row.project.as_deref());
            }
            _ => {}
        }
    }

    /// A folder a call would start work in, with `folder` and `device` as `SpawnRequest` reads them: another
    /// project's, or one main cannot place, is refused before anything is made. True when a check ran and passed.
    pub async fn folder_check(
        &self,
        caller: &ControlTab,
        folder: Option<&str>,
        device: Option<Option<&str>>,
    ) -> R<bool> {
        let state = self.host.state();
        if state.boundary.mode == BoundaryMode::Off {
            return Ok(false);
        }
        let folder = folder.filter(|folder| !folder.is_empty());
        // The caller's own folder on its own computer is its own project, resolved or not.
        let own =
            folder.is_none() && device.is_none_or(|device| device == caller.device.as_deref());
        if own || Self::granted(&state, caller) {
            return Ok(true);
        }
        let placed = self.placed(caller).await?;
        let caller = &placed;
        let project = self.host.project(&caller.tab_id, folder, device).await?;
        match self.verdict(&state, caller, project.as_deref(), false, false) {
            BoundaryVerdict::Allow => Ok(true),
            BoundaryVerdict::Log => {
                self.log_crossing(caller, folder.unwrap_or(""), project.as_deref());
                Ok(false)
            }
            BoundaryVerdict::Refuse => fail(OTHER_FOLDER),
        }
    }

    /// `caller` opened `tab_id` (and the saved session it holds) through a check that passed: it stays in scope.
    pub fn checked_add(
        &self,
        caller: &ControlTab,
        tab_id: &str,
        path: Option<(&str, Option<&str>)>,
    ) {
        let mut mem = self.mem();
        let checked = mem.checked.entry(caller.tab_id.clone()).or_default();
        checked.insert(tab_id.to_owned());
        if let Some((path, device)) = path {
            checked.insert(receiver_key(path, device));
        }
    }

    /// `caller` with its project: a tab so new that main has not placed its folder yet is asked about now.
    async fn placed(&self, caller: &ControlTab) -> R<ControlTab> {
        if caller.project.is_some() {
            return Ok(caller.clone());
        }
        Ok(ControlTab {
            project: self.host.project(&caller.tab_id, None, None).await?,
            ..caller.clone()
        })
    }

    /// Who is calling, as a paired host reads it when a request of this call reaches it (`claim_for`): where the
    /// caller runs and works, whether the person allowed it across projects, and the sessions and folders it opened:
    /// `own` through a check that passed, `earlier` with none (the host keeps those in reach only while its own
    /// `earlierOpened` says `visible`, as `boundary_verdict` does here).
    pub(super) fn claim(&self, state: &HostState, caller: &ControlTab, tabs: &[ControlTab]) {
        let mut own: Vec<String> = Vec::new();
        let mut earlier: Vec<String> = Vec::new();
        {
            let mem = self.mem();
            let opened = mem.opened.get(&caller.tab_id);
            let checked = mem.checked.get(&caller.tab_id);
            let passed = |tab_id: Option<&str>, path: Option<&str>, device: Option<&str>| {
                checked.is_some_and(|checked| {
                    tab_id.is_some_and(|id| checked.contains(id))
                        || path.is_some_and(|path| checked.contains(&receiver_key(path, device)))
                })
            };
            for tab in tabs {
                if state.parent_of(&tab.tab_id) == Some(caller.tab_id.as_str())
                    || opened.is_some_and(|opened| opened.contains(&tab.tab_id))
                {
                    let path = tab.session_path.as_deref();
                    let list = if passed(Some(&tab.tab_id), path, tab.device.as_deref()) {
                        &mut own
                    } else {
                        &mut earlier
                    };
                    list.push(tab.cwd.clone());
                    list.extend(path.map(str::to_owned));
                }
            }
            for key in checked.into_iter().flatten() {
                own.extend(key.split_once('\n').map(|(_, path)| path.to_owned()));
            }
            if let Some(session) = caller.session_path.as_deref() {
                for child in &state.closed_children {
                    if child.opened_by_session == session {
                        let list = if passed(None, Some(&child.path), child.device.as_deref()) {
                            &mut own
                        } else {
                            &mut earlier
                        };
                        list.push(child.path.clone());
                        list.push(child.cwd.clone());
                    }
                }
            }
        }
        own.sort_unstable();
        own.dedup();
        earlier.sort_unstable();
        earlier.dedup();
        earlier.retain(|entry| own.binary_search(entry).is_err());
        let claim = json!({
            "caller": caller.session_path.as_deref().unwrap_or(&caller.tab_id),
            "device": caller.device,
            "cwd": caller.cwd,
            "granted": Self::granted(state, caller),
            "own": own,
            "earlier": earlier,
        });
        let _ = CALL.try_with(|call| call.claim.set(claim));
    }

    /// The schedules of one computer as `caller` may see them: those of its project (and its own wake-ups), and the
    /// ones left out. Each is judged by the project of the folder it runs in.
    pub async fn schedules_in_scope(
        &self,
        caller: &ControlTab,
        device: Option<&str>,
        rows: Vec<ScheduleRow>,
    ) -> R<(Vec<ScheduleRow>, Vec<ScheduleRow>)> {
        let state = self.host.state();
        if state.boundary.mode == BoundaryMode::Off || Self::granted(&state, caller) {
            return Ok((rows, Vec::new()));
        }
        let caller = self.placed(caller).await?;
        let mut projects: HashMap<String, Option<String>> = HashMap::new();
        let (mut seen, mut hidden) = (Vec::new(), Vec::new());
        for row in rows {
            let own = device == caller.device.as_deref()
                && row.wake_session.is_some()
                && row.wake_session == caller.session_path;
            if own {
                seen.push(row);
                continue;
            }
            let project = match projects.get(&row.cwd) {
                Some(project) => project.clone(),
                None => {
                    let project = self
                        .host
                        .project(&caller.tab_id, Some(&row.cwd), Some(device))
                        .await?;
                    projects.insert(row.cwd.clone(), project.clone());
                    project
                }
            };
            match self.verdict(&state, &caller, project.as_deref(), false, false) {
                BoundaryVerdict::Allow => seen.push(row),
                BoundaryVerdict::Log => {
                    self.log_crossing(&caller, &row.cwd, project.as_deref());
                    seen.push(row);
                }
                BoundaryVerdict::Refuse => hidden.push(row),
            }
        }
        Ok((seen, hidden))
    }

    /// Something that reaches every project at once (`what`): refused with `refusal` while the boundary keeps the
    /// caller to its project, written down under `log`.
    pub fn every_project(&self, caller: &ControlTab, what: &str, refusal: &str) -> R<()> {
        let state = self.host.state();
        if state.boundary.mode == BoundaryMode::Off || Self::granted(&state, caller) {
            return Ok(());
        }
        if state.boundary.mode == BoundaryMode::Log {
            self.log_crossing(caller, what, None);
            return Ok(());
        }
        fail(refusal)
    }

    /// `ompdesk_app` actions that reach saved sessions. `sessions.saved` and `sessions.search` list every project's
    /// and are refused whole. An action that names sessions by file (`sessions.rename`, `.delete`, `.dump_bundle`,
    /// `sidebar.pin_session`, `.archive_sessions`) is judged file by file, and a file no list knows is refused.
    pub async fn app_check(
        &self,
        caller: &ControlTab,
        action: &str,
        args: Option<&Map<String, Value>>,
    ) -> R<()> {
        let state = self.host.state();
        if state.boundary.mode == BoundaryMode::Off || Self::granted(&state, caller) {
            return Ok(());
        }
        let text = |key: &str| -> Vec<String> {
            args.and_then(|args| args.get(key))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .into_iter()
                .collect()
        };
        // The sessions.* actions act on the computer the caller runs on, the sidebar's on this one.
        let (paths, device) = match action {
            "sessions.saved" | "sessions.search" => {
                return self.every_project(caller, action, APP_SESSIONS);
            }
            "sessions.rename" | "sessions.delete" => (text("sessionPath"), caller.device.clone()),
            "sessions.dump_bundle" => (text("session"), caller.device.clone()),
            "sidebar.pin_session" => (text("sessionPath"), None),
            "sidebar.archive_sessions" => (
                args.and_then(|args| args.get("sessionPaths"))
                    .and_then(Value::as_array)
                    .map(|paths| {
                        paths
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default(),
                None,
            ),
            _ => return Ok(()),
        };
        if paths.is_empty() {
            return Ok(());
        }
        let rows = self.host.stored(device.as_deref(), None).await?;
        for path in paths {
            let unlisted;
            let row = match rows.iter().find(|row| row.path == path) {
                Some(row) => row,
                None => {
                    unlisted = StoredSession {
                        path: path.clone(),
                        device: device.clone(),
                        ..StoredSession::default()
                    };
                    &unlisted
                }
            };
            match self.row_verdict(&state, caller, row) {
                BoundaryVerdict::Allow => {}
                BoundaryVerdict::Log => self.log_crossing(caller, &path, row.project.as_deref()),
                BoundaryVerdict::Refuse => return fail(OTHER_PROJECT),
            }
        }
        Ok(())
    }
}
