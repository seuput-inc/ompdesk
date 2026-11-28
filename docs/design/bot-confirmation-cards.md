# Why bots cannot answer OMPdesk confirmation cards

`cards.answer` remains unavailable to agents in this implementation. A registered bot chat can answer an ordinary work question routed to it. That answer is not the person's approval. A host-routed message identifies a session and registry membership, not who authorized its contents.

The 2026-11-28 design review identified two prerequisites for an exclusive delegation guarantee:

1. A protected designation and revocation path that requires the person's confirmation. Neither an agent tool nor a process running with the agent's OS privileges may grant or widen it. Revocation must apply to open cards. The current [same-user threat model](../../.omp/rules/multi-viewer-web.md) does not provide that isolation.
2. A host-issued runtime identity that another session cannot obtain. A sidecar identifies its tab. The [bot registry](../../native/ompdesk/crates/core/src/agentctl/journal/bots.rs) recognizes more than one chat, including sessions observed in the bot's folder. Neither identifies a privileged bot runtime.

On 2026-11-28 the coordinator reported the owner's decision to accept impersonation by other processes under the same OS user. That accepts a limit of OS isolation; it does not turn every chat registered to the same bot into one authenticated caller. App-boundary tests could check a host-issued caller, default-off configuration, denial of agent configuration writes, revocation and one-shot request consumption. They would not prove that a same-user process could not impersonate a caller or tamper with local state. See [residual risk and the local control socket](../../.omp/rules/multi-viewer-web.md#threat-model). No grant or card-answer API is added here.

Even then, the host would need to issue and consume one live request for one immutable operation and target, reject replacements and retries, and distinguish person and bot decisions in the audit. A release needs the exact repo, ref and commit. An Autopilot start has no final commit to bind. The current [confirmation transport](../../src/main/agent-control/host.ts) passes a title and message and returns a boolean.

## Which agent-control operations raise cards?

Inventory at `6a6c5b9f9`. **A** means the manage switch does not lift the catalog card; **M** means it does. Full control skips both catalog classes; it does not let an agent answer an existing card. **S** denotes a service-specific condition. “Candidate” is a design assessment, not a grant.

| Operation | Gate | Effect and reversibility | Assessment |
|---|---|---|---|
| `sessions.delete` | A | Erases a saved session permanently | Person: data loss |
| `sessions.hand_off` | M | Moves a session to another device; can move it back | Person: cannot recall disclosed data |
| `updates.check` | M | Checks a release server; installs nothing | Candidate: a read for one host |
| `updates.download` | M | Downloads a removable file; installs nothing | Candidate only for a pinned artifact and host |
| `updates.apply` | A | Installs code and restarts the app; rollback not assured | Person: affects other sessions |
| `app.quit` | A | Ends all running turns; reopening may resume them | Person: interrupts others |
| `accounts.github_sign_in` | A | Starts account linking; disconnecting is separate | Person: account access |
| `accounts.provider_sign_in` | A | Starts provider login; disconnecting is separate | Person: account access |
| `mobile_web.set_enabled` | A on, M off | Changes network access; switch is reversible | Person: access policy |
| `extensions.install_plugin` | A | Installs executable code; removing it cannot undo execution | Person: code installation |
| `extensions.install_mcp` | A | Adds executable code or a network endpoint | Person: removing configuration does not undo access |
| `extensions.mcp_use` | A | Enables another tool's server definition | Person: enables execution or network access |
| `extensions.mcp_sign_in` | A | Starts server login; revocation is separate | Person: account access |
| `memory.purge` | A | Erases all memory permanently | Person: data loss |
| `memory.delete_page` | A | Removes a page; restore is available | Person: deleting user data |
| `memory.sweep` | A | Evicts pages without a batch restore guarantee | Person: data loss |
| `remote.connect` | A | Connects a device; can block it later | Person: access policy |
| `remote.block` | M | Blocks a device; can unblock | Person: access policy |
| `remote.unblock` | A | Lets a blocked device reconnect | Person: access policy |
| `remote.set_allowed_users` | A | Changes allowed accounts; previous list can be restored | Person: access policy |
| `settings.proxy` | A | Redirects app traffic; restoring the setting cannot undo disclosure | Person: privacy |
| `settings.appAutoUpdate` | M | Changes automatic app installation; reversible setting | Person: future code changes |
| `settings.toolsAutoUpdate` | M | Changes automatic tool installation; reversible setting | Person: future code changes |
| `settings.rotation` | M | Changes which account runs a session | Person: account and billing attribution |
| `app.undo` | S | Restores the last eligible setting | Person: depends on the actual setting and restored value |
| Bot creation | S | Creates a persistent agent; removing it does not undo its work | Person: future activity |
| Session stop | S | Interrupts another session's work | Person: exact run may not resume |
| Session close | S | Closes another session's tab | Person: active work may be interrupted |
| Open-session deletion | S | Erases the session file permanently | Person: data loss |
| Stored-session deletion | S | Erases the session file permanently | Person: data loss |
| Worktree merge | S | Changes the parent checkout; a later commit can revert it | Person: current card does not pin both commits |
| Schedule creation | S | Creates future runs; cancellation cannot undo prior runs | Person: effects not yet known |
| Schedule creation with a precheck | S | Schedules a command | Person: cancellation cannot undo command effects |
| Schedule update with a new precheck | S | Replaces an executable command | Person: cannot undo prior execution |
| Autopilot stop | S | Ends or interrupts another run | Person: current cycle may not resume |
| Autopilot start, commit | S | Starts producing future commits | Person: no fixed commit |
| Autopilot start, push | S | Can publish future commits | Person: published data cannot be recalled |
| Autopilot start, release | S | Can publish future releases | Person: no fixed release artifact |

Sources: [catalog](../../native/ompdesk/crates/core/src/agentctl/app/catalog.rs), [settings](../../native/ompdesk/crates/core/src/agentctl/app/settings.rs), [catalog gate and undo](../../native/ompdesk/crates/core/src/agentctl/app/control.rs), [session stop](../../native/ompdesk/crates/core/src/agentctl/service/sessions/stop.rs), [merge](../../native/ompdesk/crates/core/src/agentctl/service/work.rs), [bots](../../native/ompdesk/crates/core/src/agentctl/service/work/bots.rs), [schedules and Autopilot](../../native/ompdesk/crates/core/src/agentctl/service/work/schedule.rs). `agent_power.set` requires full control; it does not issue a card. Provider and desktop safety confirmations are separate and remain person-only.
