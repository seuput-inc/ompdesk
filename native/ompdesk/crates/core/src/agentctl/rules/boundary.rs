//! The project boundary: whether a caller may reach a session or a folder of another project through the control
//! tools. It keeps an agent from crossing projects by accident; session files stay readable with bash, so it is no
//! security boundary. Pure; the service gathers the facts (`service/boundary.rs`), main names the projects.

use serde::Deserialize;

/// `agentProjectBoundary.mode`: `Log` refuses nothing and writes down what `Enforce` would refuse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BoundaryMode {
    #[default]
    Off,
    Log,
    Enforce,
}

/// `agentProjectBoundary.earlierOpened`: what becomes of the sessions a caller opened before the boundary checked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EarlierOpened {
    /// They stay in scope.
    #[default]
    Visible,
    /// They are any other target: in scope only by project or grant.
    Grant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BoundaryFacts<'a> {
    pub mode: BoundaryMode,
    /// The person allowed the caller's session to work across projects. An outside caller never has it.
    pub granted: bool,
    /// None while main has not resolved it: never equal to anything (fail closed). An outside caller's is its cwd's.
    pub caller_project: Option<&'a str>,
    pub target_project: Option<&'a str>,
    /// The caller opened the target through a check that passed.
    pub opened_through_check: bool,
    /// The caller opened the target with no such check (before the boundary existed, or while it only logged).
    pub opened_earlier: bool,
    pub earlier_opened: EarlierOpened,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoundaryVerdict {
    Allow,
    /// Allowed, and written down as what `Enforce` would refuse.
    Log,
    Refuse,
}

pub fn boundary_verdict(facts: &BoundaryFacts) -> BoundaryVerdict {
    let same = facts.caller_project.is_some() && facts.caller_project == facts.target_project;
    let earlier = facts.opened_earlier && facts.earlier_opened == EarlierOpened::Visible;
    if facts.granted || same || facts.opened_through_check || earlier {
        return BoundaryVerdict::Allow;
    }
    match facts.mode {
        BoundaryMode::Off => BoundaryVerdict::Allow,
        BoundaryMode::Log => BoundaryVerdict::Log,
        BoundaryMode::Enforce => BoundaryVerdict::Refuse,
    }
}
