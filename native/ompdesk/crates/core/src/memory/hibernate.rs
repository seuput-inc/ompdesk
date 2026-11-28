//! Rust-owned idle session hibernation engine (Orca parity, Phase 1).
//!
//! Decides when a hidden, finished, child-free session tab may give its `omp` sidecar back,
//! preserving its resumable session handle (`sessionPath`, `cwd`) so switching back wakes it
//! transparently via `sidecar.wake` / `pool.ensureStarted`.
//!
//! Supports three complementary eviction tiers:
//! 1. **Critical / Memory Pressure**: accelerates eviction when OS pressure is `warn`/`critical`
//!    or available RAM falls below `reserveFraction` (draining up to `maxEvictionsCritical` tabs
//!    per sample under critical pressure).
//! 2. **Soft Resident Cap**: when more than `maxResidentTabs` sidecars are live simultaneously,
//!    hibernates the largest quiet hidden tabs past `capQuietMs` until back at the cap.
//! 3. **Proactive Idle Window**: hibernates quiet hidden tabs past `proactiveQuietMs` even while
//!    RAM is plentiful, preventing unbounded background sidecar accumulation across long workdays.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::idle::WatchProcesses;
use super::{Pressure, ProcessRow, Reading};
use crate::server::{Call, Fault, Registry, Reply};

/// Default proactive idle hibernation window (15 minutes).
pub const DEFAULT_PROACTIVE_QUIET_MS: u64 = 15 * 60_000;
/// Default quiet window under memory pressure (`warn` or < `reserve_fraction` available).
pub const DEFAULT_PRESSURE_QUIET_MS: u64 = 5 * 60_000;
/// Default quiet window under `critical` OS memory pressure (1 minute).
pub const DEFAULT_CRITICAL_QUIET_MS: u64 = 60_000;
/// Default minimum quiet duration before soft resident-cap eviction (2 minutes).
pub const DEFAULT_CAP_QUIET_MS: u64 = 2 * 60_000;
/// Default available RAM headroom threshold below which memory reads as short (15%).
pub const DEFAULT_RESERVE_FRACTION: f64 = 0.15;
/// Default soft cap on simultaneously live resident sidecars.
pub const DEFAULT_MAX_RESIDENT_TABS: usize = 6;
/// Default post-wake / post-attempt cooldown to prevent sleep/wake thrashing (1 minute).
pub const DEFAULT_COOLDOWN_MS: u64 = 60_000;
/// Default max evictions per evaluation tick under normal/warn conditions.
pub const DEFAULT_MAX_EVICTIONS_NORMAL: usize = 1;
/// Default max evictions per evaluation tick under critical OS memory pressure.
pub const DEFAULT_MAX_EVICTIONS_CRITICAL: usize = 3;

/// Configurable policy controlling proactive, soft-cap, and pressure-driven hibernation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HibernatePolicy {
    /// Proactive idle window in ms when memory is normal; `None` or `Some(0)` disables proactive eviction.
    pub proactive_quiet_ms: Option<u64>,
    /// Quiet window in ms when memory is short (`warn` or below `reserveFraction`).
    pub pressure_quiet_ms: u64,
    /// Quiet window in ms when OS memory pressure is `critical`.
    pub critical_quiet_ms: u64,
    /// Headroom fraction below which available RAM reads as short (`0.0..=0.5`).
    pub reserve_fraction: f64,
    /// Optional soft cap on live resident sidecars (`None` or `Some(0)` disables soft-cap eviction).
    pub max_resident_tabs: Option<usize>,
    /// Minimum quiet duration in ms before a tab can be evicted for the soft resident cap.
    pub cap_quiet_ms: u64,
    /// Maximum tabs evicted per tick when not under critical pressure.
    pub max_evictions_normal: usize,
    /// Maximum tabs evicted per tick under critical OS memory pressure.
    pub max_evictions_critical: usize,
    /// Backoff in ms after a wake or eviction attempt before the same tab can be picked again.
    pub cooldown_ms: u64,
}

impl Default for HibernatePolicy {
    fn default() -> Self {
        Self {
            proactive_quiet_ms: Some(DEFAULT_PROACTIVE_QUIET_MS),
            pressure_quiet_ms: DEFAULT_PRESSURE_QUIET_MS,
            critical_quiet_ms: DEFAULT_CRITICAL_QUIET_MS,
            reserve_fraction: DEFAULT_RESERVE_FRACTION,
            max_resident_tabs: Some(DEFAULT_MAX_RESIDENT_TABS),
            cap_quiet_ms: DEFAULT_CAP_QUIET_MS,
            max_evictions_normal: DEFAULT_MAX_EVICTIONS_NORMAL,
            max_evictions_critical: DEFAULT_MAX_EVICTIONS_CRITICAL,
            cooldown_ms: DEFAULT_COOLDOWN_MS,
        }
    }
}

impl HibernatePolicy {
    fn sanitize(&mut self) {
        if !self.reserve_fraction.is_finite() {
            self.reserve_fraction = DEFAULT_RESERVE_FRACTION;
        } else {
            self.reserve_fraction = self.reserve_fraction.clamp(0.0, 0.5);
        }
        self.max_evictions_normal = self.max_evictions_normal.max(1);
        self.max_evictions_critical = self.max_evictions_critical.max(1);
        if self.proactive_quiet_ms == Some(0) {
            self.proactive_quiet_ms = None;
        }
        if self.max_resident_tabs == Some(0) {
            self.max_resident_tabs = None;
        }
    }
}

/// Owned snapshot of `memory.watchProcesses` (live scan or injected by callers/tests).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSample {
    pub rows: Vec<ProcessRow>,
    pub busy_parents: Option<Vec<u32>>,
    pub quiet_trees: Vec<(u32, u64)>,
}

impl ProcessSample {
    pub fn from_rows(rows: Vec<ProcessRow>, windows: bool) -> Self {
        let watch = WatchProcesses::new(&rows, windows);
        let busy_parents = watch.busy_parents().map(ToOwned::to_owned);
        let quiet_trees = watch.quiet_trees().to_vec();
        Self {
            rows,
            busy_parents,
            quiet_trees,
        }
    }

    /// Resident bytes for each PID whose sidecar has no live child work (mirrors `idleFootprints`).
    pub fn idle_footprints(&self, pids: impl IntoIterator<Item = u32>) -> HashMap<u32, u64> {
        let mut bytes = HashMap::new();
        if let Some(busy) = &self.busy_parents {
            for pid in pids {
                bytes.insert(pid, 0);
            }
            for &pid in busy {
                bytes.remove(&pid);
            }
            if !bytes.is_empty() {
                for row in &self.rows {
                    if let Some(slot) = bytes.get_mut(&row.pid) {
                        *slot = row.bytes;
                    }
                }
            }
        }
        for &(pid, size) in &self.quiet_trees {
            bytes.insert(pid, size);
        }
        bytes
    }
}

/// Per-tab facts fed into an evaluation pass.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabInput {
    pub tab_id: String,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub session_path: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// Legacy aggregate quiet flag from `SidecarPool.memoryTabs`.
    #[serde(default)]
    pub quiet: Option<bool>,
    /// Whether the tab is visible in any active window, split pane, or paired device view.
    #[serde(default)]
    pub visible: bool,
    /// Sidecar status (`"ready"`, `"starting"`, `"asleep"`, `"error"`, `"exited"`).
    #[serde(default)]
    pub status: Option<String>,
    /// Active turn streaming, settling, or compacting.
    #[serde(default)]
    pub busy: bool,
    /// Pending approval/ask dialog, unsent composer draft, unsaved prompt, or active sign-in.
    #[serde(default)]
    pub pending_interaction: bool,
    /// Auto-retry, scheduled retry, awaiting connection, resuming, or pending omp/extension restart.
    #[serde(default)]
    pub pending_work: bool,
    /// Opened by another agent/bot rather than directly by the user.
    #[serde(default)]
    pub agent_owned: bool,
}

/// Why a tab is currently ineligible for hibernation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BlockReason {
    NoProcess,
    Visible,
    NotReady,
    NoSessionFile,
    Busy,
    PendingInteraction,
    PendingWork,
    AgentOwned,
    NotQuiet,
    HasChildProcesses,
    Cooldown,
}

/// Why an eligible tab was selected for hibernation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EvictReason {
    ProactiveIdle,
    ResidentCap,
    MemoryPressure,
    CriticalPressure,
}

impl EvictReason {
    fn priority(self) -> u8 {
        match self {
            EvictReason::ProactiveIdle => 1,
            EvictReason::ResidentCap => 2,
            EvictReason::MemoryPressure => 3,
            EvictReason::CriticalPressure => 4,
        }
    }
}

/// Per-tab eligibility state reported for diagnostics and UI transparency.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum TabEligibility {
    Blocked {
        reason: BlockReason,
    },
    WarmingQuiet {
        #[serde(rename = "quietMs")]
        quiet_ms: u64,
        bytes: u64,
    },
    Eligible {
        #[serde(rename = "quietMs")]
        quiet_ms: u64,
        bytes: u64,
        reason: EvictReason,
    },
}

/// One tab selected for hibernation in this evaluation pass.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvictCandidate {
    pub tab_id: String,
    pub pid: u32,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub bytes: u64,
    pub quiet_ms: u64,
    pub reason: EvictReason,
}

/// Per-tab diagnostic record from an evaluation pass.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabEvaluation {
    pub tab_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    pub eligibility: TabEligibility,
}

/// Output of one `HibernateEngine::evaluate` pass.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HibernatePass {
    pub memory_short: bool,
    pub pressure: Option<Pressure>,
    pub resident_count: usize,
    pub evict: Vec<EvictCandidate>,
    pub evaluations: Vec<TabEvaluation>,
}

/// Resumable metadata preserved while a tab is hibernated (`status == "asleep"`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HibernatedTab {
    pub tab_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub label: String,
    pub hibernated_at_ms: u64,
    pub freed_bytes: u64,
    pub reason: EvictReason,
}

/// Cumulative hibernation engine counters.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HibernateStats {
    pub hibernations_total: u64,
    pub wakes_total: u64,
    pub estimated_bytes_freed: u64,
}

/// Snapshot of the engine's current configuration, tracked state, and cumulative stats.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HibernateStatus {
    pub policy: HibernatePolicy,
    pub quiet_tracked: usize,
    pub cooldown_tracked: usize,
    pub hibernated: Vec<HibernatedTab>,
    pub stats: HibernateStats,
}

/// Whether the OS memory reading indicates memory shortage under `reserve_fraction`.
pub fn is_memory_short(reading: Option<&Reading>, reserve_fraction: f64) -> bool {
    let Some(reading) = reading else {
        return false;
    };
    reading.pressure != Pressure::Normal
        || (reading.available_bytes as f64) < (reading.total_bytes as f64) * reserve_fraction
}

/// Stateful Rust-native sidecar idle hibernation engine.
#[derive(Debug, Default)]
pub struct HibernateEngine {
    policy: HibernatePolicy,
    /// When each currently quiet, child-free tab entered its uninterrupted quiet streak.
    quiet_since: HashMap<String, u64>,
    /// Earliest timestamp when a tab may next enter quiet tracking (post-wake / post-eviction backoff).
    cooldown_until: HashMap<String, u64>,
    /// Metadata for tabs currently sleeping so wake/resume can restore seamlessly.
    hibernated: HashMap<String, HibernatedTab>,
    stats: HibernateStats,
}

impl HibernateEngine {
    pub fn new(mut policy: HibernatePolicy) -> Self {
        policy.sanitize();
        Self {
            policy,
            ..Self::default()
        }
    }

    pub fn policy(&self) -> &HibernatePolicy {
        &self.policy
    }

    pub fn configure(&mut self, mut policy: HibernatePolicy) -> HibernatePolicy {
        policy.sanitize();
        self.policy = policy.clone();
        policy
    }

    /// Evaluate all tabs against the latest memory reading and process tree snapshot.
    pub fn evaluate(
        &mut self,
        now_ms: u64,
        reading: Option<&Reading>,
        tabs: &[TabInput],
        sample: &ProcessSample,
    ) -> HibernatePass {
        let short = is_memory_short(reading, self.policy.reserve_fraction);
        let critical = reading.is_some_and(|r| r.pressure == Pressure::Critical);
        let resident_count = tabs.iter().filter(|t| t.pid.is_some()).count();
        let over_cap = self
            .policy
            .max_resident_tabs
            .map_or(0, |cap| resident_count.saturating_sub(cap));

        let footprints = sample.idle_footprints(
            tabs.iter()
                .filter(|tab| Self::static_block(tab).is_none())
                .filter_map(|tab| tab.pid),
        );

        let seen: HashSet<&str> = tabs.iter().map(|tab| tab.tab_id.as_str()).collect();
        self.quiet_since.retain(|id, _| seen.contains(id.as_str()));
        self.cooldown_until
            .retain(|id, until| seen.contains(id.as_str()) && now_ms < *until);

        let mut evaluations = Vec::with_capacity(tabs.len());
        let mut ready: Vec<EvictCandidate> = Vec::new();

        for tab in tabs {
            // A tab that has a live process again is no longer hibernated.
            if tab.pid.is_some() {
                self.hibernated.remove(&tab.tab_id);
            }

            if let Some(reason) = Self::static_block(tab) {
                self.quiet_since.remove(&tab.tab_id);
                evaluations.push(TabEvaluation {
                    tab_id: tab.tab_id.clone(),
                    pid: tab.pid,
                    eligibility: TabEligibility::Blocked { reason },
                });
                continue;
            }

            let pid = tab.pid.expect("static_block checked pid");
            let Some(&bytes) = footprints.get(&pid) else {
                self.quiet_since.remove(&tab.tab_id);
                evaluations.push(TabEvaluation {
                    tab_id: tab.tab_id.clone(),
                    pid: Some(pid),
                    eligibility: TabEligibility::Blocked {
                        reason: BlockReason::HasChildProcesses,
                    },
                });
                continue;
            };

            if self
                .cooldown_until
                .get(&tab.tab_id)
                .is_some_and(|&until| now_ms < until)
            {
                self.quiet_since.remove(&tab.tab_id);
                evaluations.push(TabEvaluation {
                    tab_id: tab.tab_id.clone(),
                    pid: Some(pid),
                    eligibility: TabEligibility::Blocked {
                        reason: BlockReason::Cooldown,
                    },
                });
                continue;
            }

            let since = *self.quiet_since.entry(tab.tab_id.clone()).or_insert(now_ms);
            let quiet_ms = now_ms.saturating_sub(since);
            let trigger = self.evict_reason(quiet_ms, short, critical, over_cap > 0);
            match trigger {
                Some(reason) => {
                    evaluations.push(TabEvaluation {
                        tab_id: tab.tab_id.clone(),
                        pid: Some(pid),
                        eligibility: TabEligibility::Eligible {
                            quiet_ms,
                            bytes,
                            reason,
                        },
                    });
                    ready.push(EvictCandidate {
                        tab_id: tab.tab_id.clone(),
                        pid,
                        label: tab.label.clone(),
                        session_path: tab.session_path.clone(),
                        cwd: tab.cwd.clone(),
                        bytes,
                        quiet_ms,
                        reason,
                    });
                }
                None => {
                    evaluations.push(TabEvaluation {
                        tab_id: tab.tab_id.clone(),
                        pid: Some(pid),
                        eligibility: TabEligibility::WarmingQuiet { quiet_ms, bytes },
                    });
                }
            }
        }

        // Highest urgency first, then largest memory footprint, then longest quiet streak, then deterministic id.
        ready.sort_by(|a, b| {
            b.reason
                .priority()
                .cmp(&a.reason.priority())
                .then_with(|| b.bytes.cmp(&a.bytes))
                .then_with(|| b.quiet_ms.cmp(&a.quiet_ms))
                .then_with(|| a.tab_id.cmp(&b.tab_id))
        });

        let limit = if critical {
            self.policy.max_evictions_critical
        } else {
            self.policy.max_evictions_normal
        };

        let mut evict = Vec::new();
        let mut cap_used = 0usize;
        for candidate in ready {
            if evict.len() >= limit {
                break;
            }
            if candidate.reason == EvictReason::ResidentCap {
                if cap_used >= over_cap {
                    continue;
                }
                cap_used += 1;
            }
            self.quiet_since.remove(&candidate.tab_id);
            if self.policy.cooldown_ms > 0 {
                self.cooldown_until.insert(
                    candidate.tab_id.clone(),
                    now_ms.saturating_add(self.policy.cooldown_ms),
                );
            }
            evict.push(candidate);
        }

        HibernatePass {
            memory_short: short,
            pressure: reading.map(|r| r.pressure),
            resident_count,
            evict,
            evaluations,
        }
    }

    fn static_block(tab: &TabInput) -> Option<BlockReason> {
        if tab.pid.is_none() {
            return Some(BlockReason::NoProcess);
        }
        if tab.visible {
            return Some(BlockReason::Visible);
        }
        if tab
            .status
            .as_deref()
            .is_some_and(|status| status != "ready")
        {
            return Some(BlockReason::NotReady);
        }
        if tab.busy {
            return Some(BlockReason::Busy);
        }
        if tab.pending_interaction {
            return Some(BlockReason::PendingInteraction);
        }
        if tab.pending_work {
            return Some(BlockReason::PendingWork);
        }
        if tab.agent_owned {
            return Some(BlockReason::AgentOwned);
        }
        if tab.quiet == Some(false) {
            return Some(BlockReason::NotQuiet);
        }
        if tab
            .session_path
            .as_deref()
            .is_some_and(|path| path.is_empty())
            || (tab.quiet.is_none() && tab.session_path.is_none())
        {
            return Some(BlockReason::NoSessionFile);
        }
        None
    }

    fn evict_reason(
        &self,
        quiet_ms: u64,
        short: bool,
        critical: bool,
        over_cap: bool,
    ) -> Option<EvictReason> {
        if critical && quiet_ms >= self.policy.critical_quiet_ms {
            return Some(EvictReason::CriticalPressure);
        }
        if short && quiet_ms >= self.policy.pressure_quiet_ms {
            return Some(EvictReason::MemoryPressure);
        }
        if over_cap && quiet_ms >= self.policy.cap_quiet_ms {
            return Some(EvictReason::ResidentCap);
        }
        if self
            .policy
            .proactive_quiet_ms
            .is_some_and(|window| quiet_ms >= window)
        {
            return Some(EvictReason::ProactiveIdle);
        }
        None
    }

    /// Record that a tab has been safely hibernated, preserving its resume handle metadata.
    pub fn mark_hibernated(&mut self, meta: HibernatedTab) {
        self.quiet_since.remove(&meta.tab_id);
        self.stats.hibernations_total += 1;
        self.stats.estimated_bytes_freed = self
            .stats
            .estimated_bytes_freed
            .saturating_add(meta.freed_bytes);
        self.hibernated.insert(meta.tab_id.clone(), meta);
    }

    /// Record that a hibernated tab was transparently woken; applies post-wake cooldown.
    pub fn mark_woken(&mut self, tab_id: &str, now_ms: u64) -> Option<HibernatedTab> {
        self.quiet_since.remove(tab_id);
        if self.policy.cooldown_ms > 0 {
            self.cooldown_until.insert(
                tab_id.to_owned(),
                now_ms.saturating_add(self.policy.cooldown_ms),
            );
        }
        let previous = self.hibernated.remove(tab_id);
        if previous.is_some() {
            self.stats.wakes_total += 1;
        }
        previous
    }

    /// Forget all state for a closed tab.
    pub fn forget(&mut self, tab_id: &str) {
        self.quiet_since.remove(tab_id);
        self.cooldown_until.remove(tab_id);
        self.hibernated.remove(tab_id);
    }

    /// Reset tracked timers, hibernated records, and stats (preserving policy unless reconfigured).
    pub fn reset(&mut self) {
        self.quiet_since.clear();
        self.cooldown_until.clear();
        self.hibernated.clear();
        self.stats = HibernateStats::default();
    }

    pub fn status(&self) -> HibernateStatus {
        let mut hibernated: Vec<HibernatedTab> = self.hibernated.values().cloned().collect();
        hibernated.sort_by(|a, b| a.tab_id.cmp(&b.tab_id));
        HibernateStatus {
            policy: self.policy.clone(),
            quiet_tracked: self.quiet_since.len(),
            cooldown_tracked: self.cooldown_until.len(),
            hibernated,
            stats: self.stats.clone(),
        }
    }
}

// ---- Core RPC wiring -----------------------------------------------------------------------------------------------

static ENGINE: LazyLock<Mutex<HibernateEngine>> =
    LazyLock::new(|| Mutex::new(HibernateEngine::default()));

fn engine() -> MutexGuard<'static, HibernateEngine> {
    ENGINE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvaluateParams {
    tabs: Vec<TabInput>,
    #[serde(default)]
    now_ms: Option<u64>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    /// Optional injected reading (for tests or pre-sampled callers); absent reads the live OS.
    #[serde(default)]
    reading: Option<Reading>,
    /// Optional injected process sample; absent reads the live OS via `memory::processes`.
    #[serde(default)]
    watch_processes: Option<ProcessSample>,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
enum MarkParams {
    Hibernated {
        #[serde(rename = "tabId")]
        tab_id: String,
        #[serde(rename = "sessionPath", default)]
        session_path: Option<String>,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        label: String,
        #[serde(rename = "hibernatedAtMs", default)]
        hibernated_at_ms: Option<u64>,
        #[serde(rename = "freedBytes", default)]
        freed_bytes: u64,
        #[serde(default = "default_evict_reason")]
        reason: EvictReason,
    },
    Woken {
        #[serde(rename = "tabId")]
        tab_id: String,
        #[serde(rename = "nowMs", default)]
        now_ms: Option<u64>,
    },
    Forget {
        #[serde(rename = "tabId")]
        tab_id: String,
    },
    Reset,
}

fn default_evict_reason() -> EvictReason {
    EvictReason::ProactiveIdle
}

pub(super) fn register(registry: &mut Registry) {
    registry.add("memory.hibernateConfigure", |call| {
        Box::pin(async move {
            let policy: HibernatePolicy = call.params()?;
            let applied = engine().configure(policy);
            Reply::json(&applied)
        })
    });
    registry.add("memory.hibernateEvaluate", |call| {
        Box::pin(evaluate_rpc(call))
    });
    registry.add("memory.hibernateStatus", |_call| {
        Box::pin(async move { Reply::json(&engine().status()) })
    });
    registry.add("memory.hibernateMark", |call| {
        Box::pin(async move {
            let params: MarkParams = call.params()?;
            let mut guard = engine();
            match params {
                MarkParams::Hibernated {
                    tab_id,
                    session_path,
                    cwd,
                    label,
                    hibernated_at_ms,
                    freed_bytes,
                    reason,
                } => {
                    let meta = HibernatedTab {
                        tab_id,
                        session_path,
                        cwd,
                        label,
                        hibernated_at_ms: hibernated_at_ms.unwrap_or_else(now_epoch_ms),
                        freed_bytes,
                        reason,
                    };
                    guard.mark_hibernated(meta.clone());
                    Reply::json(&meta)
                }
                MarkParams::Woken { tab_id, now_ms } => {
                    let prev = guard.mark_woken(&tab_id, now_ms.unwrap_or_else(now_epoch_ms));
                    Reply::json(&prev)
                }
                MarkParams::Forget { tab_id } => {
                    guard.forget(&tab_id);
                    Reply::json(&serde_json::json!({ "ok": true }))
                }
                MarkParams::Reset => {
                    guard.reset();
                    Reply::json(&serde_json::json!({ "ok": true }))
                }
            }
        })
    });
}

async fn evaluate_rpc(call: Call) -> Result<Reply, Fault> {
    let params: EvaluateParams = call.params()?;
    let timeout_ms = params.timeout_ms.unwrap_or(4_000);
    let reading = match params.reading {
        Some(reading) => Some(reading),
        None => super::reading(timeout_ms, call.scope.clone()).await?,
    };
    let sample = match params.watch_processes {
        Some(sample) => sample,
        None => {
            let rows = super::processes(timeout_ms, call.scope.clone()).await?;
            ProcessSample::from_rows(rows, cfg!(windows))
        }
    };
    let now_ms = params.now_ms.unwrap_or_else(now_epoch_ms);
    let pass = engine().evaluate(now_ms, reading.as_ref(), &params.tabs, &sample);
    Reply::json(&pass)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::Machine;

    const GIB: u64 = 1 << 30;

    fn reading(available_gb: u64, pressure: Pressure) -> Reading {
        Reading {
            total_bytes: 16 * GIB,
            available_bytes: available_gb * GIB,
            pressure,
            machine: Machine::default(),
        }
    }

    fn posix_sample(entries: &[(u32, u64)], busy_parents: &[u32]) -> ProcessSample {
        ProcessSample {
            rows: entries
                .iter()
                .map(|&(pid, bytes)| ProcessRow {
                    pid,
                    ppid: 1,
                    bytes,
                    name: None,
                    cpu_ms: None,
                })
                .collect(),
            busy_parents: Some(busy_parents.to_vec()),
            quiet_trees: Vec::new(),
        }
    }

    fn quiet_tab(id: &str, pid: u32) -> TabInput {
        TabInput {
            tab_id: id.into(),
            pid: Some(pid),
            label: format!("Session {id}"),
            session_path: Some(format!("/sessions/{id}.jsonl")),
            cwd: Some(format!("/work/{id}")),
            status: Some("ready".into()),
            ..TabInput::default()
        }
    }

    #[test]
    fn proactive_idle_hibernates_hidden_finished_tabs_without_waiting_for_pressure() {
        let mut eng = HibernateEngine::new(HibernatePolicy {
            proactive_quiet_ms: Some(100_000),
            max_resident_tabs: None,
            cooldown_ms: 30_000,
            ..HibernatePolicy::default()
        });
        let tabs = vec![quiet_tab("a", 10), quiet_tab("b", 20)];
        let sample = posix_sample(&[(10, 300 << 20), (20, 700 << 20)], &[1]);
        let healthy = reading(10, Pressure::Normal);

        let p0 = eng.evaluate(0, Some(&healthy), &tabs, &sample);
        assert!(!p0.memory_short);
        assert!(p0.evict.is_empty());

        let p1 = eng.evaluate(99_999, Some(&healthy), &tabs, &sample);
        assert!(p1.evict.is_empty());

        // Past proactive_quiet_ms: largest quiet hidden tab is evicted first.
        let p2 = eng.evaluate(100_000, Some(&healthy), &tabs, &sample);
        assert_eq!(p2.evict.len(), 1);
        assert_eq!(p2.evict[0].tab_id, "b");
        assert_eq!(p2.evict[0].reason, EvictReason::ProactiveIdle);
        assert_eq!(
            p2.evict[0].session_path.as_deref(),
            Some("/sessions/b.jsonl")
        );

        // Next tick picks "a"; "b" is on cooldown so it isn't picked again even if still present.
        let p3 = eng.evaluate(105_000, Some(&healthy), &tabs, &sample);
        assert_eq!(p3.evict.len(), 1);
        assert_eq!(p3.evict[0].tab_id, "a");
        assert_eq!(
            p3.evaluations
                .iter()
                .find(|e| e.tab_id == "b")
                .unwrap()
                .eligibility,
            TabEligibility::Blocked {
                reason: BlockReason::Cooldown
            }
        );
    }

    #[test]
    fn soft_resident_cap_evicts_excess_largest_quiet_tabs_only_down_to_cap() {
        let mut eng = HibernateEngine::new(HibernatePolicy {
            proactive_quiet_ms: None,
            max_resident_tabs: Some(2),
            cap_quiet_ms: 60_000,
            max_evictions_normal: 2,
            ..HibernatePolicy::default()
        });
        let tabs = vec![
            TabInput {
                visible: true,
                ..quiet_tab("active", 10)
            },
            quiet_tab("small", 20),
            quiet_tab("big", 30),
        ];
        let sample = posix_sample(&[(10, 400 << 20), (20, 200 << 20), (30, 900 << 20)], &[1]);
        let healthy = reading(10, Pressure::Normal);

        assert!(
            eng.evaluate(0, Some(&healthy), &tabs, &sample)
                .evict
                .is_empty()
        );
        // 3 resident tabs vs cap 2 => over_cap = 1 => evicts only "big", never drops below cap 2.
        let pass = eng.evaluate(60_000, Some(&healthy), &tabs, &sample);
        assert_eq!(pass.resident_count, 3);
        assert_eq!(pass.evict.len(), 1);
        assert_eq!(pass.evict[0].tab_id, "big");
        assert_eq!(pass.evict[0].reason, EvictReason::ResidentCap);
    }

    #[test]
    fn critical_pressure_drains_multiple_tabs_per_tick_faster() {
        let mut eng = HibernateEngine::new(HibernatePolicy {
            proactive_quiet_ms: None,
            max_resident_tabs: None,
            critical_quiet_ms: 30_000,
            max_evictions_critical: 2,
            ..HibernatePolicy::default()
        });
        let tabs = vec![
            quiet_tab("t1", 10),
            quiet_tab("t2", 20),
            quiet_tab("t3", 30),
        ];
        let sample = posix_sample(&[(10, 200 << 20), (20, 800 << 20), (30, 500 << 20)], &[1]);
        let crit = reading(1, Pressure::Critical);

        assert!(
            eng.evaluate(0, Some(&crit), &tabs, &sample)
                .evict
                .is_empty()
        );
        let pass = eng.evaluate(30_000, Some(&crit), &tabs, &sample);
        assert!(pass.memory_short);
        let ids: Vec<&str> = pass.evict.iter().map(|c| c.tab_id.as_str()).collect();
        assert_eq!(ids, ["t2", "t3"]);
        assert!(
            pass.evict
                .iter()
                .all(|c| c.reason == EvictReason::CriticalPressure)
        );
    }

    #[test]
    fn safety_invariants_block_visible_busy_unsaved_pending_and_child_process_tabs() {
        let mut eng = HibernateEngine::new(HibernatePolicy {
            proactive_quiet_ms: Some(1_000),
            max_resident_tabs: None,
            ..HibernatePolicy::default()
        });
        let tabs = vec![
            TabInput {
                visible: true,
                ..quiet_tab("visible", 10)
            },
            TabInput {
                busy: true,
                ..quiet_tab("busy", 11)
            },
            TabInput {
                pending_interaction: true,
                ..quiet_tab("ask", 12)
            },
            TabInput {
                pending_work: true,
                ..quiet_tab("retry", 13)
            },
            TabInput {
                agent_owned: true,
                ..quiet_tab("child-agent", 14)
            },
            TabInput {
                session_path: None,
                ..quiet_tab("unsaved", 15)
            },
            TabInput {
                status: Some("starting".into()),
                ..quiet_tab("starting", 16)
            },
            quiet_tab("has-server", 17),
            TabInput {
                pid: None,
                ..quiet_tab("asleep", 18)
            },
        ];
        // PID 17 has a child process (in busy_parents).
        let sample = posix_sample(
            &[
                (10, 100 << 20),
                (11, 100 << 20),
                (12, 100 << 20),
                (13, 100 << 20),
                (14, 100 << 20),
                (15, 100 << 20),
                (16, 100 << 20),
                (17, 100 << 20),
            ],
            &[1, 17],
        );

        let _ = eng.evaluate(0, None, &tabs, &sample);
        let pass = eng.evaluate(10_000, None, &tabs, &sample);
        assert!(pass.evict.is_empty());

        let reason_of = |id: &str| {
            pass.evaluations
                .iter()
                .find(|e| e.tab_id == id)
                .unwrap()
                .eligibility
                .clone()
        };
        assert_eq!(
            reason_of("visible"),
            TabEligibility::Blocked {
                reason: BlockReason::Visible
            }
        );
        assert_eq!(
            reason_of("busy"),
            TabEligibility::Blocked {
                reason: BlockReason::Busy
            }
        );
        assert_eq!(
            reason_of("ask"),
            TabEligibility::Blocked {
                reason: BlockReason::PendingInteraction
            }
        );
        assert_eq!(
            reason_of("retry"),
            TabEligibility::Blocked {
                reason: BlockReason::PendingWork
            }
        );
        assert_eq!(
            reason_of("child-agent"),
            TabEligibility::Blocked {
                reason: BlockReason::AgentOwned
            }
        );
        assert_eq!(
            reason_of("unsaved"),
            TabEligibility::Blocked {
                reason: BlockReason::NoSessionFile
            }
        );
        assert_eq!(
            reason_of("starting"),
            TabEligibility::Blocked {
                reason: BlockReason::NotReady
            }
        );
        assert_eq!(
            reason_of("has-server"),
            TabEligibility::Blocked {
                reason: BlockReason::HasChildProcesses
            }
        );
        assert_eq!(
            reason_of("asleep"),
            TabEligibility::Blocked {
                reason: BlockReason::NoProcess
            }
        );
    }

    #[test]
    fn mark_hibernated_and_mark_woken_preserve_resume_metadata_and_apply_cooldown() {
        let mut eng = HibernateEngine::new(HibernatePolicy {
            proactive_quiet_ms: Some(10_000),
            cooldown_ms: 60_000,
            max_resident_tabs: None,
            ..HibernatePolicy::default()
        });
        eng.mark_hibernated(HibernatedTab {
            tab_id: "tab-1".into(),
            session_path: Some("/sessions/s1.jsonl".into()),
            cwd: Some("/repo".into()),
            label: "Fix bug".into(),
            hibernated_at_ms: 1_000,
            freed_bytes: 450 << 20,
            reason: EvictReason::ProactiveIdle,
        });
        let status = eng.status();
        assert_eq!(status.hibernated.len(), 1);
        assert_eq!(status.stats.hibernations_total, 1);
        assert_eq!(status.stats.estimated_bytes_freed, 450 << 20);

        // Transparent wake returns preserved session handle and arms post-wake cooldown.
        let woken = eng.mark_woken("tab-1", 5_000).expect("was hibernated");
        assert_eq!(woken.session_path.as_deref(), Some("/sessions/s1.jsonl"));
        assert_eq!(eng.status().stats.wakes_total, 1);
        assert!(eng.status().hibernated.is_empty());

        // Immediately evaluating while within cooldown blocks re-hibernation.
        let tabs = vec![quiet_tab("tab-1", 99)];
        let sample = posix_sample(&[(99, 300 << 20)], &[1]);
        let during_cooldown = eng.evaluate(30_000, None, &tabs, &sample);
        assert!(during_cooldown.evict.is_empty());
        assert_eq!(
            during_cooldown.evaluations[0].eligibility,
            TabEligibility::Blocked {
                reason: BlockReason::Cooldown
            }
        );

        // Once cooldown expires at 65_000, quiet window begins fresh and evicts at 75_000.
        assert!(eng.evaluate(65_000, None, &tabs, &sample).evict.is_empty());
        let after_quiet = eng.evaluate(75_000, None, &tabs, &sample);
        assert_eq!(after_quiet.evict.len(), 1);
        assert_eq!(after_quiet.evict[0].tab_id, "tab-1");
    }

    #[test]
    fn windows_launcher_tree_counts_whole_tree_and_ignores_conhost() {
        let rows = vec![
            ProcessRow {
                pid: 10,
                ppid: 1,
                bytes: 5 << 20,
                name: Some("omp.exe".into()),
                cpu_ms: None,
            },
            ProcessRow {
                pid: 11,
                ppid: 10,
                bytes: 2 << 20,
                name: Some("conhost.exe".into()),
                cpu_ms: None,
            },
            ProcessRow {
                pid: 12,
                ppid: 10,
                bytes: 400 << 20,
                name: Some("bun.exe".into()),
                cpu_ms: None,
            },
            // Launcher 20 has bun.exe (22) which spawned a dev server (23): NOT quiet.
            ProcessRow {
                pid: 20,
                ppid: 1,
                bytes: 5 << 20,
                name: Some("omp.exe".into()),
                cpu_ms: None,
            },
            ProcessRow {
                pid: 22,
                ppid: 20,
                bytes: 500 << 20,
                name: Some("bun.exe".into()),
                cpu_ms: None,
            },
            ProcessRow {
                pid: 23,
                ppid: 22,
                bytes: 250 << 20,
                name: Some("node.exe".into()),
                cpu_ms: None,
            },
        ];
        let sample = ProcessSample::from_rows(rows, true);
        let tabs = vec![quiet_tab("clean", 10), quiet_tab("with-server", 20)];
        let mut eng = HibernateEngine::new(HibernatePolicy {
            proactive_quiet_ms: Some(1_000),
            max_resident_tabs: None,
            ..HibernatePolicy::default()
        });
        let _ = eng.evaluate(0, None, &tabs, &sample);
        let pass = eng.evaluate(1_000, None, &tabs, &sample);
        assert_eq!(pass.evict.len(), 1);
        assert_eq!(pass.evict[0].tab_id, "clean");
        assert_eq!(pass.evict[0].bytes, (5 + 2 + 400) << 20);
        assert_eq!(
            pass.evaluations
                .iter()
                .find(|e| e.tab_id == "with-server")
                .unwrap()
                .eligibility,
            TabEligibility::Blocked {
                reason: BlockReason::HasChildProcesses
            }
        );
    }

    #[tokio::test]
    async fn wire_rpcs_configure_evaluate_mark_and_report_status() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

        let (client, server_io) = tokio::io::duplex(1 << 16);
        let (server_read, server_write) = tokio::io::split(server_io);
        let server = tokio::spawn(crate::serve(server_read, server_write, crate::registry()));
        let (client_read, mut client_write) = tokio::io::split(client);
        let mut lines = tokio::io::BufReader::new(client_read);

        let mut line = String::new();
        lines.read_line(&mut line).await.unwrap();
        assert!(line.contains("\"event\":\"ready\""), "{line}");

        let requests = [
            serde_json::json!({"id": 1, "method": "memory.hibernateMark", "params": {"action": "reset"}}),
            serde_json::json!({
                "id": 2,
                "method": "memory.hibernateConfigure",
                "params": {"proactiveQuietMs": 10_000, "maxResidentTabs": null, "cooldownMs": 30_000}
            }),
            serde_json::json!({
                "id": 3,
                "method": "memory.hibernateEvaluate",
                "params": {
                    "nowMs": 1_000,
                    "reading": {"totalBytes": 16 * GIB, "availableBytes": 12 * GIB, "pressure": "normal"},
                    "watchProcesses": {"rows": [{"pid": 55, "ppid": 1, "bytes": 300 << 20}], "busyParents": [1], "quietTrees": []},
                    "tabs": [{"tabId": "wire-tab", "pid": 55, "label": "Wire", "sessionPath": "/s/w.jsonl", "status": "ready"}]
                }
            }),
            serde_json::json!({
                "id": 4,
                "method": "memory.hibernateEvaluate",
                "params": {
                    "nowMs": 11_000,
                    "reading": {"totalBytes": 16 * GIB, "availableBytes": 12 * GIB, "pressure": "normal"},
                    "watchProcesses": {"rows": [{"pid": 55, "ppid": 1, "bytes": 300 << 20}], "busyParents": [1], "quietTrees": []},
                    "tabs": [{"tabId": "wire-tab", "pid": 55, "label": "Wire", "sessionPath": "/s/w.jsonl", "status": "ready"}]
                }
            }),
            serde_json::json!({
                "id": 5,
                "method": "memory.hibernateMark",
                "params": {
                    "action": "hibernated",
                    "tabId": "wire-tab",
                    "sessionPath": "/s/w.jsonl",
                    "label": "Wire",
                    "hibernatedAtMs": 11_001,
                    "freedBytes": 300 << 20,
                    "reason": "proactiveIdle"
                }
            }),
            serde_json::json!({"id": 6, "method": "memory.hibernateStatus", "params": {}}),
            serde_json::json!({"id": 7, "method": "memory.hibernateMark", "params": {"action": "woken", "tabId": "wire-tab", "nowMs": 20_000}}),
            serde_json::json!({"id": 8, "method": "memory.hibernateMark", "params": {"action": "reset"}}),
        ];

        for req in &requests {
            client_write
                .write_all(format!("{req}\n").as_bytes())
                .await
                .unwrap();
            line.clear();
            lines.read_line(&mut line).await.unwrap();
            let resp: serde_json::Value = serde_json::from_str(&line).unwrap();
            assert_eq!(resp["ok"], true, "failed response: {resp}");
            match resp["id"].as_u64().unwrap() {
                3 => assert_eq!(resp["result"]["evict"], serde_json::json!([])),
                4 => {
                    assert_eq!(resp["result"]["evict"][0]["tabId"], "wire-tab");
                    assert_eq!(resp["result"]["evict"][0]["reason"], "proactiveIdle");
                }
                6 => {
                    assert_eq!(resp["result"]["stats"]["hibernationsTotal"], 1);
                    assert_eq!(resp["result"]["hibernated"][0]["sessionPath"], "/s/w.jsonl");
                }
                7 => assert_eq!(resp["result"]["sessionPath"], "/s/w.jsonl"),
                _ => {}
            }
        }

        client_write.shutdown().await.unwrap();
        drop(client_write);
        server.await.unwrap().unwrap();
    }

    #[test]
    fn twenty_tab_multi_session_hibernation_stress() {
        let mut engine = HibernateEngine::new(HibernatePolicy {
            proactive_quiet_ms: Some(15 * 60_000),
            max_resident_tabs: Some(6),
            cap_quiet_ms: 2 * 60_000,
            max_evictions_normal: 1,
            cooldown_ms: 60_000,
            ..HibernatePolicy::default()
        });

        let healthy = reading(12, Pressure::Normal);
        let tab_bytes: u64 = 350 << 20; // 350 MiB per live omp sidecar
        let mut live_tabs: Vec<TabInput> = (0..20)
            .map(|i| {
                let mut tab = quiet_tab(&format!("tab-{i}"), 1_000 + i as u32);
                tab.visible = i == 0; // 1 active + 19 finished background
                tab.cwd = Some(format!("/work/repo-{i}"));
                tab
            })
            .collect();

        let sample_for = |tabs: &[TabInput]| {
            let rows: Vec<ProcessRow> = tabs
                .iter()
                .filter_map(|t| {
                    t.pid.map(|pid| ProcessRow {
                        pid,
                        ppid: 1,
                        bytes: tab_bytes,
                        name: None,
                        cpu_ms: None,
                    })
                })
                .collect();
            ProcessSample::from_rows(rows, false)
        };

        // Initial seed at t = 0: all 20 tabs live (7,000 MiB baseline).
        let t0 = engine.evaluate(0, Some(&healthy), &live_tabs, &sample_for(&live_tabs));
        assert_eq!(t0.resident_count, 20);
        assert!(t0.evict.is_empty());

        // Stage 1 (soft resident cap): after 2m+ quiet, drain 14 excess background tabs down to cap = 6.
        let mut now = 2 * 60_000 + 5_000;
        for _ in 0..14 {
            let pass = engine.evaluate(now, Some(&healthy), &live_tabs, &sample_for(&live_tabs));
            assert_eq!(pass.evict.len(), 1);
            let victim = &pass.evict[0];
            assert_eq!(victim.reason, EvictReason::ResidentCap);
            assert_ne!(victim.tab_id, "tab-0");
            engine.mark_hibernated(HibernatedTab {
                tab_id: victim.tab_id.clone(),
                session_path: victim.session_path.clone(),
                cwd: victim.cwd.clone(),
                label: victim.label.clone(),
                hibernated_at_ms: now,
                freed_bytes: victim.bytes,
                reason: victim.reason,
            });
            if let Some(slot) = live_tabs.iter_mut().find(|t| t.tab_id == victim.tab_id) {
                slot.pid = None;
                slot.status = Some("asleep".into());
            }
            now += 5_000;
        }
        assert_eq!(engine.status().hibernated.len(), 14);

        // Stage 2 (proactive idle): after 15m quiet, hibernate the remaining 5 background tabs.
        now = 16 * 60_000;
        for _ in 0..5 {
            let pass = engine.evaluate(now, Some(&healthy), &live_tabs, &sample_for(&live_tabs));
            assert_eq!(pass.evict.len(), 1);
            let victim = &pass.evict[0];
            assert_eq!(victim.reason, EvictReason::ProactiveIdle);
            assert_ne!(victim.tab_id, "tab-0");
            engine.mark_hibernated(HibernatedTab {
                tab_id: victim.tab_id.clone(),
                session_path: victim.session_path.clone(),
                cwd: victim.cwd.clone(),
                label: victim.label.clone(),
                hibernated_at_ms: now,
                freed_bytes: victim.bytes,
                reason: victim.reason,
            });
            if let Some(slot) = live_tabs.iter_mut().find(|t| t.tab_id == victim.tab_id) {
                slot.pid = None;
                slot.status = Some("asleep".into());
            }
            now += 5_000;
        }

        // Steady state: 19/19 background tabs hibernated, 1 active tab untouched, 6,650 MiB (95%) reclaimed.
        let status = engine.status();
        assert_eq!(status.hibernated.len(), 19);
        assert_eq!(status.stats.hibernations_total, 19);
        assert_eq!(status.stats.estimated_bytes_freed, 19 * tab_bytes);
        assert!(status.hibernated.iter().all(|h| h.session_path.is_some()));

        let final_pass = engine.evaluate(now, Some(&healthy), &live_tabs, &sample_for(&live_tabs));
        assert_eq!(final_pass.resident_count, 1);
        assert!(final_pass.evict.is_empty());
    }
}
