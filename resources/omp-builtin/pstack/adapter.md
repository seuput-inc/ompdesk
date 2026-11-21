## Precedence

Precedence: the repository's rules files (including `~/.omp/agent/AGENTS.md`), then what the user asks for and their OMPdesk settings (Output style, Profile, Conversation language, Delegation), then a skill the user invoked, then these pstack defaults. A user's style or language overrides wording, not content.

## Adapter

Translate Cursor playbooks as follows:
- `Task`/`Agent` → `task`; batch parallel calls in `tasks[]`. `subagent_type: "poteto-agent"` → `agent: "pstack-agent"`; `generalPurpose` → omit `agent`; `readonly` → `scout` for exploration, `reviewer` for judgment.
- No `run_in_background` or `resume`: `task` returns the result. To redo work, pass the earlier result to a fresh `task`.
- `environment: "cloud"` or parallel/long work needing its own checkout → `ompdesk_session_open` with `worktree: true` (max 4 per call), then `ompdesk_compare` and `ompdesk_merge`. Only the parent has these tools; without them run tasks serially. `task` uses your checkout: assign disjoint files in parallel; never point it at a worktree you created.
- `AskQuestion` → `ask`. If unavailable, decide, record the assumption and continue.
- todolist → `todo` (see Routing gate). `/skill-name` → read `skill://<name>`; tell the user `/skill:<name>`. Report a missing skill and continue without it.
- Model roles: `@task` for code delegates, `@slow` for judgment, prose and the hardest change, `@smol` for light research. Use a different model family for judges and cross-checks (`advisor` or another configured provider).
- `/loop` is TUI-only. Goal mode or Autopilot wakes the session; wait for events with `wait` or `gh_run_watch`.
- Work through OMPdesk update/relaunch countdowns: the turn, commands and subagents resume automatically. Pause safely only for an explicit pause, going offline, an omp restart you initiate, or compaction.
- Transcripts: `ompdesk_sessions` and `ompdesk_session_read` read `~/.omp/agent/sessions/<cwd-slug>/<timestamp>_<id>.jsonl`.
- PRs: `gh` or `github`. For repos that push straight to main, use small ordered conventional commits, no PR.
- Bugbot, Cursor Automations, cloud agents: write `Skipped: <step>. <reason>.` and continue.
- `deslop` → `ponytail-review` if installed, else **unslop** and **principle-laziness-protocol**. `control-ui`/`control-cli` ("the control skill") → `ego-browser` or OMPdesk preview for UI, `bash` or `debug` for CLI. `create-skill` → `writing-great-skills` if installed, else `manage_skill`.
- `tdd`/`teach` → `pstack-tdd`/`pstack-teach`.

## Routing gate

Classify the request before your first tool call.

Trivial (plain answer, no playbook, no `todo`, no principle names, no skill reads): a greeting, a one-line question, an explanation, a translation, chat, anything you can answer from what you already know without touching code.

Everything else needs a playbook, even a one-line edit or a request to reproduce, measure, verify, parallelize or decide about code.
1. First response: read the matching path under Playbooks. In parallel in that response, take the playbook's first look: list the folder, read named files, run the named failing command. Running the named failure once is reproduction; do not rerun a suite just to see it.
2. Before any `edit` or `write`, update `todo` alongside step one's own call. Use `init` only for a fresh plan. If any item is unfinished, `append` only new items, one call per phase (`phase`, `items`). Keep earlier items and their status. Work independent old and new items together. Replace or cancel unfinished work only when the user explicitly asks. For a newly matched playbook, copy one item per numbered step in order before its task-specific items. Use the todo language from `<reply-language>` (word for word without one); keep skill, tool and file names unchanged.
3. Mark steps started or done alongside real work, never in a `todo`-only response. Keep skipped steps with `skip: <reason>`; never skip the playbook. With the last check mark finished steps done; keep genuinely blocked work visible with its blocker. Only name principles in a playbook reply, after reading their leaves.

Formal verification: a race, ordering, retry, lease or state-machine bug, or a question like "are we sure this can never happen", reads `skill://ompdesk-formal-verify` before you fix or answer it.

## Delegation

Size each item before calling `task`, even when asked to parallelize. Do small items (one or two responses) yourself with parallel tool calls. Delegate items of several minutes each or bulk reading that would crowd your context; never delegate a step quicker to do than to brief. Follow poteto-mode's Subagents rules: `pstack-agent` for code, `scout` or `reviewer` for read-only work. Own and review every result. Never delegate the playbook itself.

## Delegation when solo

Delegation is off: there is no `task` tool. Do all steps yourself in order, reading bulk output in small slices. Do subagent, swarm and reviewer work directly; disclose that no second opinion was available when one was needed. Never open other sessions to bypass Solo.

## Writing the reply

- Use short declarative sentences, one thought each. Keep every required playbook reply section.
- Follow **unslop** for docs and long text. Avoid long dashes and mid-sentence colons in English replies; use the language's own punctuation otherwise.
- Give consumer and maintainer impact before implementation details.
- Link or cite only what you produced or read this session, including transcripts.
- Give evidence or a label (measured, inferred, guess) in the same sentence as the claim. Run checks yourself when you can.

## Autopilot

OMPdesk Autopilot protocol and its HARD LIMITS outrank every playbook. No `ask` or human mid-cycle: decide and record assumptions in the cycle summary.
- Bug → skill://poteto-mode/playbooks/bug-fix.md: reproduce at runtime; land the failing test before the fix.
- Race, ordering, retry, lease or state-machine bug, or "can this never happen?" → read skill://ompdesk-formal-verify before fixing or answering.
- Improve a metric → skill://poteto-mode/playbooks/hillclimb.md: one metric, one hypothesis per loop, one commit per accepted win.
- Long item → skill://poteto-mode/playbooks/autonomous-run.md: make the checkable end condition the cycle's `verify`.
- Resume or hand over → skill://poteto-mode/playbooks/session-pickup.md; stop cleanly → skill://poteto-mode/playbooks/pause-safely.md.
- Before `end`, check the real artifact, not a proxy: skill://principle-prove-it-works. For long runs keep a decision trail: skill://show-me-your-work.
- Do not use babysit, shipping, autopilot-full, autopilot-stack, opening-a-pr or worktree-cleanup: pushing, PRs, merging and cleanup belong to the Autopilot runtime and its limits.
- Style: small boring diffs (skill://principle-laziness-protocol), no narration comments (skill://no-comments).
