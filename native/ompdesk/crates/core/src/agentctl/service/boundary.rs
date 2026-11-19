//! The project boundary inside the service (`rules/boundary.rs` decides): the facts of one caller and one target,
//! the refusals, the line a list shows instead of another project's sessions, and the line `log` mode writes.
//! Main names every project (`project` of a tab, a stored row and a summary, and the `project` ask for a folder); the
//! core never reads a folder.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::json;

use super::AgentControl;
use super::fail::{R, fail};
use super::host::HostState;
use super::text::waits;
use super::types::{
    ControlTab, SessionSummary, StoredSession, StoredWork, TabStatus, Target, Tool,
};
use crate::agentctl::journal::send_outbox::receiver_key;
use crate::agentctl::rules::boundary::{
    BoundaryFacts, BoundaryMode, BoundaryVerdict, boundary_verdict,
};

pub const OTHER_PROJECT: &str = "That session is in another project; another project's sessions show counts only. The user can allow this session to work across projects in its sidebar menu.";
const OTHER_FOLDER: &str = "That folder is in another project, or OMPdesk cannot tell its project yet; this session starts work only in its own project. The user can allow this session to work across projects in its sidebar menu.";
const APP_SESSIONS: &str = "ompdesk_app's sessions.* actions read and change every project's saved sessions; use ompdesk_sessions and the ompdesk_session_* tools, which keep to this project. The user can allow this session to work across projects in its sidebar menu.";

/// The tool call the running work belongs to, for the one line `log` mode writes of it.
pub(super) struct Call {
    tool: &'static str,
    logged: AtomicBool,
}

impl Call {
    pub(super) fn new(tool: Tool) -> Call {
        Call {
            tool: tool.name(),
            logged: AtomicBool::new(false),
        }
    }
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
        // A tab so new that main has not placed its own folder yet: asked now instead of refused.
        let placed;
        let caller = if caller.project.is_none() {
            placed = ControlTab {
                project: self.host.project(&caller.tab_id, None, None).await?,
                ..caller.clone()
            };
            &placed
        } else {
            caller
        };
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

    /// `ompdesk_app`'s `sessions.*` actions name any project's saved sessions by file: refused whole while the
    /// boundary filters, since they have no project filter of their own.
    pub fn app_sessions_check(
        &self,
        caller: &ControlTab,
        action: &str,
        names_session: bool,
    ) -> R<()> {
        let all = matches!(
            action,
            "sessions.saved" | "sessions.search" | "sessions.rename" | "sessions.delete"
        ) || (action == "sessions.dump_bundle" && names_session);
        let state = self.host.state();
        if !all || state.boundary.mode == BoundaryMode::Off || Self::granted(&state, caller) {
            return Ok(());
        }
        if state.boundary.mode == BoundaryMode::Log {
            self.log_crossing(caller, action, None);
            return Ok(());
        }
        fail(APP_SESSIONS)
    }
}
