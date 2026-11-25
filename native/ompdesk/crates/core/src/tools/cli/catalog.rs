//! The vendor CLIs OMPdesk keeps current, and which connected providers make each one relevant (`cli-tools/
//! catalog.ts`). A tool's owner comes from where its executable resolves (`detect.rs`); this table only says what the
//! tool is and what its own updater is. Provider ids are stock pi-ai's (`registry/oauth/*`).

use super::TOOLS;

/// A tool's own updater, run with its executable. `registry`: OMPdesk asks npm for `npm`'s latest first and runs the
/// updater only when that is newer; otherwise the updater checks by itself (a no-op when current), so OMPdesk compares
/// the version before and after.
pub struct SelfUpdate {
    pub args: &'static [&'static str],
    pub registry: bool,
}

pub struct Spec {
    /// Executable name (Windows also tries `.exe` and `.cmd`).
    pub bin: &'static str,
    /// Stock provider ids whose stored credential makes this tool relevant.
    pub providers: &'static [&'static str],
    /// A tool machine setup installs: listed whenever it is installed, connected or not.
    pub setup: bool,
    pub update: Option<SelfUpdate>,
    /// Its npm package (the registry a `registry` check asks).
    pub npm: Option<&'static str>,
    /// Its winget id (Windows).
    pub winget: Option<&'static str>,
    /// Machine setup's archive for it (updated only when it lives in the managed tools dir).
    pub managed: Option<&'static str>,
    /// Only the managed copy counts: a system or version-manager copy of it is the user's, never listed.
    pub managed_only: bool,
    /// A running process of it loads files from its package dir after start (a Node CLI): an update that replaces
    /// that dir (npm, Bun, Homebrew) waits until no process of it runs.
    pub lazy_loads: bool,
}

const NONE: Spec = Spec {
    bin: "",
    providers: &[],
    setup: false,
    update: None,
    npm: None,
    winget: None,
    managed: None,
    managed_only: false,
    lazy_loads: false,
};

/// `CLI_TOOL_SPECS`, in `TOOLS` order.
const SPECS: [Spec; 9] = [
    Spec {
        bin: "claude",
        providers: &["anthropic"],
        update: Some(SelfUpdate {
            args: &["update"],
            registry: true,
        }),
        npm: Some("@anthropic-ai/claude-code"),
        lazy_loads: true,
        ..NONE
    },
    Spec {
        bin: "codex",
        providers: &["openai-codex", "openai"],
        npm: Some("@openai/codex"),
        lazy_loads: true,
        ..NONE
    },
    Spec {
        bin: "gemini",
        providers: &["google-gemini-cli", "google"],
        npm: Some("@google/gemini-cli"),
        lazy_loads: true,
        ..NONE
    },
    Spec {
        bin: "cursor-agent",
        providers: &["cursor"],
        update: Some(SelfUpdate {
            args: &["update"],
            registry: false,
        }),
        ..NONE
    },
    Spec {
        bin: "copilot",
        providers: &["github-copilot"],
        npm: Some("@github/copilot"),
        lazy_loads: true,
        ..NONE
    },
    Spec {
        bin: "gh",
        providers: &["github-copilot"],
        setup: true,
        winget: Some("GitHub.cli"),
        managed: Some("gh"),
        ..NONE
    },
    // Detected through gh (`gh extension list`), updated by `gh extension upgrade gh-copilot`.
    Spec {
        bin: "gh",
        providers: &["github-copilot"],
        update: Some(SelfUpdate {
            args: &["extension", "upgrade", "gh-copilot"],
            registry: false,
        }),
        ..NONE
    },
    Spec {
        bin: "node",
        setup: true,
        managed: Some("node"),
        managed_only: true,
        ..NONE
    },
    Spec {
        bin: "agent-desktop",
        setup: true,
        managed: Some("agent-desktop"),
        managed_only: true,
        ..NONE
    },
];

/// The spec of `id`, one of `TOOLS`.
pub fn spec(id: &str) -> &'static Spec {
    let at = TOOLS.iter().position(|tool| *tool == id).unwrap_or(0);
    &SPECS[at]
}

/// The tools a set of connected providers (and machine setup) makes relevant, in display order, each with the
/// connected providers that use it.
pub fn relevant_tools(connected: &[String]) -> Vec<(&'static str, Vec<String>)> {
    TOOLS
        .iter()
        .zip(&SPECS)
        .filter_map(|(id, spec)| {
            let using: Vec<String> = spec
                .providers
                .iter()
                .filter(|provider| connected.iter().any(|c| c == *provider))
                .map(|provider| (*provider).to_owned())
                .collect();
            (spec.setup || !using.is_empty()).then_some((*id, using))
        })
        .collect()
}
