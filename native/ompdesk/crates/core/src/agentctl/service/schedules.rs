//! The Schedules service as `ompdesk_schedule` sees it (`ScheduleSource`, built in `host.ts` over `SchedulesApi`):
//! rows, save, update, enable, run now and kept runs, over main's two asks `schedules.command` and `schedules.create`.

use serde_json::json;

use super::AgentControl;
use super::fail::{Fail, R};
use super::host::Host;
use super::types::{Schedule, ScheduleDraft, ScheduleRow, ScheduleRun, SchedulesState};

/// `field` is absent, present but empty after trimming, or present and nonempty.
pub(super) fn action_issues(
    action: &str,
    field: impl Fn(&str) -> Option<bool>,
    mut issue: impl FnMut(&str),
) {
    let has = |key| field(key).is_some();
    let filled = |key| field(key) == Some(true);
    let starts = ["every_minutes", "daily_at", "at", "in_minutes", "on"]
        .into_iter()
        .filter(|&key| has(key))
        .count();
    if has("days") && !has("daily_at") {
        issue("days goes with daily_at");
    }
    if (has("by") || has("within_minutes")) && !has("on") {
        issue("by and within_minutes go with on");
    }
    if has("by") && has("within_minutes") {
        issue("take one of by or within_minutes");
    }
    if has("results_to") && has("target") {
        issue("results_to is for a fresh run: it takes no target");
    }
    if action == "create" {
        if !filled("name") {
            issue("create needs name");
        }
        if !filled("prompt") {
            issue("create needs prompt");
        }
        if starts != 1 {
            issue("create needs exactly one of every_minutes, daily_at, at, in_minutes or on");
        }
        if has("target") {
            if has("folder") {
                issue("target self wakes this session: it takes no folder");
            }
            if has("model") {
                issue("target self wakes this session: it takes no model");
            }
            if has("device") {
                issue("target self wakes this session on this computer: it takes no device");
            }
        }
    } else {
        if action != "list" && !filled("id") {
            issue(&format!("{action} needs id"));
        }
        if action == "update" && starts > 1 {
            issue("update takes at most one of every_minutes, daily_at, at, in_minutes or on");
        }
        if action != "update"
            && (starts > 0
                || ["name", "prompt", "model", "target"]
                    .into_iter()
                    .any(filled)
                || ["precheck", "results_to", "by", "within_minutes"]
                    .into_iter()
                    .any(has))
        {
            issue(&format!("{action} takes only id (and device)"));
        }
    }
}

/// The Schedules service of this computer (`device` None) or of a paired host.
pub struct ScheduleSource<'a> {
    host: &'a Host,
    device: Option<String>,
}

fn row_of(state: &SchedulesState, schedule: &Schedule) -> ScheduleRow {
    ScheduleRow {
        id: schedule.id.clone(),
        name: schedule.draft.name.clone(),
        frequency: schedule.draft.frequency.clone(),
        cwd: schedule.draft.cwd.clone(),
        enabled: schedule.draft.enabled,
        next_run: state.next_runs.get(&schedule.id).cloned().flatten(),
        last_status: state
            .runs
            .iter()
            .find(|run| run.schedule_id == schedule.id)
            .map(|run| run.status.clone()),
        wakes: schedule.draft.wake_session.is_some(),
    }
}

impl ScheduleSource<'_> {
    async fn command(&self, request: serde_json::Value) -> R<SchedulesState> {
        self.host
            .schedules_command(self.device.as_deref(), &request)
            .await
    }

    pub async fn list(&self) -> R<Vec<ScheduleRow>> {
        let state = self.command(json!({ "action": "get" })).await?;
        Ok(state
            .schedules
            .iter()
            .map(|schedule| row_of(&state, schedule))
            .collect())
    }

    /// Every saved schedule with its draft (`wakeSession` included), as the service holds it.
    pub async fn schedules(&self) -> R<Vec<Schedule>> {
        Ok(self.command(json!({ "action": "get" })).await?.schedules)
    }

    /// The id comes from the save itself: a diff against an earlier read would hand a concurrent create's schedule to
    /// this caller.
    pub async fn save(&self, draft: &ScheduleDraft) -> R<ScheduleRow> {
        let created = self
            .host
            .schedules_create(self.device.as_deref(), draft)
            .await?;
        match created
            .state
            .schedules
            .iter()
            .find(|schedule| schedule.id == created.id)
        {
            Some(made) => Ok(row_of(&created.state, made)),
            None => Err(Fail::other("The schedule was not saved.")),
        }
    }

    pub async fn remove(&self, id: &str) -> R<()> {
        self.command(json!({ "action": "delete", "id": id }))
            .await?;
        Ok(())
    }

    /// Saves `change` of the schedule's stored draft (a webhook keeps its key); fails with the service's reason.
    pub async fn update(
        &self,
        id: &str,
        change: impl FnOnce(ScheduleDraft) -> ScheduleDraft,
    ) -> R<ScheduleRow> {
        let state = self.command(json!({ "action": "get" })).await?;
        let Some(before) = state
            .schedules
            .into_iter()
            .find(|schedule| schedule.id == id)
        else {
            return Err(Fail::other("The schedule is gone."));
        };
        let draft = change(before.draft);
        let state = self
            .command(json!({ "action": "save", "id": id, "draft": draft }))
            .await?;
        match state.schedules.iter().find(|schedule| schedule.id == id) {
            Some(saved) => Ok(row_of(&state, saved)),
            None => Err(Fail::other("The schedule is gone.")),
        }
    }

    pub async fn set_enabled(&self, id: &str, enabled: bool) -> R<ScheduleRow> {
        let state = self
            .command(json!({ "action": "setEnabled", "id": id, "enabled": enabled }))
            .await?;
        match state.schedules.iter().find(|schedule| schedule.id == id) {
            Some(saved) => Ok(row_of(&state, saved)),
            None => Err(Fail::other("The schedule is gone.")),
        }
    }

    /// A test run now; fails when it already runs.
    pub async fn run_now(&self, id: &str) -> R<()> {
        self.command(json!({ "action": "runNow", "id": id }))
            .await?;
        Ok(())
    }

    /// Its kept runs, newest first.
    pub async fn runs(&self, id: &str) -> R<Vec<ScheduleRun>> {
        let state = self.command(json!({ "action": "get" })).await?;
        Ok(state
            .runs
            .into_iter()
            .filter(|run| run.schedule_id == id)
            .collect())
    }
}

impl AgentControl {
    /// `host.schedules(device)`: None where there is no Schedules service (this computer's, or the paired host's).
    pub fn schedule_source(&self, device: Option<&str>) -> Option<ScheduleSource<'_>> {
        self.host
            .state()
            .has_schedules(device)
            .then(|| ScheduleSource {
                host: &self.host,
                device: device.map(str::to_owned),
            })
    }
}
