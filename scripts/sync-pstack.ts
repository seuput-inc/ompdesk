/**
 * Vendor pstack (cursor/plugins `pstack`, MIT, Lauren Tan) at the commit pinned in
 * `resources/omp-builtin/pstack/pstack-config.json` into `resources/omp-builtin/pstack/` and translate its Cursor and
 * Claude names to omp and OMPdesk ones. Run after every pin bump:
 *
 *   bun run sync:pstack            copy + translate + regenerate (needs network, or PSTACK_SRC=<clone at the pin>)
 *   bun run sync:pstack -- --check pin vs the newest upstream (scripts/skill-packs.ts check pstack)
 *
 * Owned by OMPdesk and never touched here: `pstack-config.json` (the one version pin), `adapter.md`,
 * `agents/pstack-agent.md`, `README.md`, and the translated `skills/why/` and `skills/reflect/` from 0.15.36.
 * `pstack-manifest.json` holds every pack file's sha256, checked by `src/main/pstack/pack-drift.test.ts`.
 * Every translation rule must match at least once: when upstream rewords a line a rule hung on, this script fails
 * instead of quietly shipping an untranslated Cursor name.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import config from "../resources/omp-builtin/pstack/pstack-config.json" with { type: "json" };
import { assemblePstackSections, renderTextModule } from "./pstack-section";

const ROOT = path.resolve(import.meta.dir, "..");
const PACK = path.join(ROOT, "resources/omp-builtin/pstack");
const TEXT_MODULE = path.join(ROOT, "resources/gui-bridge/modes/pstack-text.ts");
const LICENSE_COPY = path.join(ROOT, "LICENSES/MIT-pstack.txt");
const MANIFEST = path.join(PACK, "pstack-manifest.json");

/**
 * Upstream skills the pack does not carry: Cursor-only, replaced by OMPdesk's own settings, or (the three
 * formal-verification ones) folded into the built-in `ompdesk-formal-verify` skill.
 */
const SKIPPED_SKILLS = new Set([
	"setup-pstack",
	"poteto-help",
	"make-bot-ui",
	"create-formal-verification-skill",
	"maintain-formal-verification-skill",
	"statechart",
]);
/** Files under `skills/` the pack does not carry (paths relative to `skills/`). */
const SKIPPED_PATHS: RegExp[] = [
	/^poteto-mode\/scripts\/(watch-pr|orch)\//,
	/^poteto-mode\/scripts\/(bootstrap\.ts|bun\.lock|package\.json|check-plan\.test\.ts)$/,
	/^poteto-mode\/playbooks\/orchestrate\.md$/,
	/^poteto-mode\/references\/bugbot-triage\.md$/,
	// Upstream's own test suites and their fixtures: no skill reads them, and a `*.test.*` file under `resources/` is
	// collected by this repository's vitest node project (pstack 0.15.30's statechart suite turned main's CI red).
	/^[^/]+\/scripts\/test\//,
	/\.test\.[cm]?[jt]sx?$/,
];
/** Skills renamed so none collides with a stock or common user skill (`tdd`, `teach`). */
const RENAMED_SKILLS: Record<string, string> = { tdd: "pstack-tdd", teach: "pstack-teach" };
/** The complete 0.15.36 investigations and reviewer prompts are OMPdesk-owned, not upstream's replacements. */
const OWNED_SKILLS = ["why", "reflect"];
const OWNED = [
	"pstack-config.json",
	"adapter.md",
	"agents/pstack-agent.md",
	"README.md",
	...OWNED_SKILLS.map(name => `skills/${name}/`),
];

interface Rule {
	id: string;
	/** Matches the path relative to `skills/` (or `agents/<file>`). */
	files: RegExp;
	from: string | RegExp;
	to: string;
}

const MODEL_ROLES =
	"Model roles: `@task` for code delegates, `@slow` for judgment, prose and the hardest change, `@smol` for light research, and a judge or cross-check on a model family different from the parent's (the `advisor` role, or another configured provider).";
const PLAYBOOK_TODOS =
	"Use `todo` `init` only for a fresh plan. If any item is unfinished, `append` only new items, one call per phase. List each user-requested outcome once. Follow playbook steps internally; do not add them as todo items. Use the todo language from `<reply-language>` (word for word without one). Keep skill, tool and file names unchanged.";

const ANY = /.*/;
const rule = (id: string, files: RegExp, from: string | RegExp, to: string): Rule => ({ id, files, from, to });

const RULES: Rule[] = [
	// ── poteto-mode ──────────────────────────────────────────────────────────────────────────────
	rule(
		"mode-cite",
		/^poteto-mode\/SKILL\.md$/,
		"In your reply, name each principle that shaped a decision",
		"When a playbook shaped the work, name in your reply each principle that shaped a decision",
	),
	rule(
		"mode-intro",
		/^poteto-mode\/SKILL\.md$/,
		"Bundled skills live at `../<name>/SKILL.md` from this file, so put this file's absolute path in every `poteto-agent` prompt.",
		"Bundled skills are read as `skill://<name>`. Tell every `pstack-agent` you spawn to read `skill://poteto-mode` first.",
	),
	rule(
		"mode-worker",
		/^poteto-mode\/SKILL\.md$/,
		/- Starting any agent, whether a Task subagent or a Project worker → [^\n]*? for a `poteto-agent`\./,
		"- Starting a subagent or an OMPdesk worktree session → tell it to read `skill://poteto-mode/worker.md` before starting its task. Give it the operator's goal and its assignment. A `pstack-agent` reads `skill://poteto-mode` first.",
	),
	rule(
		"worker-kickoff",
		/^poteto-mode\/worker\.md$/,
		"the first line of its kickoff is `Read <path>/worker.md before anything else.`, with `<path>` the absolute path of the folder that holds this file.",
		"tell it to read `skill://poteto-mode/worker.md` before starting its task.",
	),
	rule(
		"mode-deslop",
		/^poteto-mode\/SKILL\.md$/,
		"- Before commit → `/deslop` from the `cursor-team-kit` plugin.",
		"- Before commit → the user's `ponytail-review` skill when installed, else **unslop** with **principle-laziness-protocol**.",
	),
	rule(
		"mode-control",
		/^poteto-mode\/SKILL\.md$/,
		"Shipping UI / IDE / CLI → `control-ui` or `control-cli` from `cursor-team-kit`.",
		"Shipping a UI → drive it through the `ego-browser` skill or the OMPdesk preview. For a CLI or TUI, use `bash` or `debug`.",
	),
	rule(
		"mode-babysit",
		/^poteto-mode\/SKILL\.md$/,
		"not Cursor's built-in babysit skill",
		"not any other babysit skill",
	),
	rule(
		"mode-subagents",
		/^poteto-mode\/SKILL\.md$/,
		/## Subagents\n[\s\S]*?(?=\n## Writing the reply)/,
		'## Subagents\n\nSubagents run through omp\'s `task` tool. Pass `agent: "pstack-agent"` for code-writing delegates and ad-hoc helpers (it reads this skill first), leave `agent` out for the default `task` agent, use `scout` or `reviewer` for read-only work. The chat that runs the playbook never delegates the playbook itself. Routed workflow skills (`how`, `why`, `interrogate`, `reflect`, `swarm`) set their own spawns, so respect what they prescribe.\n\n' +
			`${MODEL_ROLES} Hand a hard change to \`@slow\` through the task call's model override. File pointers beat inlined context. You own every subagent's work: review the diff and write your own summary. A second opinion is the same prompt on a different model, and agreement is high-signal. Give new work to a fresh subagent with the consolidated brief, every later directive and the prior report. Reuse one only when the new work strictly needs state that lives in it (its checkout, uncommitted changes, a running process). A session you opened with \`ompdesk_session_open\` is the exception: continue it with \`ompdesk_session_send\`.\n`,
	),
	rule("mode-todolist", /^poteto-mode\/SKILL\.md$/, "Copy its steps into the todolist tool first.", PLAYBOOK_TODOS),
	rule(
		"mode-playbooks-file",
		/^poteto-mode\/SKILL\.md$/,
		"open its steps at `playbooks/<title>.md`, with the title in kebab case.",
		"read its steps. The Playbooks section of `skill://pstack-adapter` gives each description and path.",
	),
	// ── skills that spawn model-specific subagents ───────────────────────────────────────────────
	rule(
		"interrogate-spawn",
		/^interrogate\/SKILL\.md$/,
		/with four changes\. Read the `interrogate reviewers` line in place of `arena runners`\. Copy the scope's uncommitted changes into each worktree\. Spawn each adversary as `generalPurpose`\./,
		"with three changes. Copy the scope's uncommitted changes into each worktree. Spawn each adversary as the default `task` agent (leave `agent` out): it has to run code.",
	),
	rule(
		"swarm-model",
		/^swarm\/SKILL\.md$/,
		/3\. Pick the worker model from the `swarm workers` line[^\n]*?For a model race, name each arm's model up front\./,
		"3. Pick the worker model: `@task` by default. If the task tool rejects a model, use `@task` and say so. For a model race, name each arm's model up front.",
	),
	rule(
		"swarm-spawn",
		/^swarm\/SKILL\.md$/,
		/Spawn all N workers in one message with `subagent_type: generalPurpose`[^\n]*\n\nWhen a worker must start from a non-default pushed branch, pass `cloud_base_branch`\./,
		"Spawn all N workers in one `task` call (a `tasks[]` batch) with the step 3 model. A worker that writes files and needs its own checkout runs as an OMPdesk session instead: `ompdesk_session_open` with `worktree: true` (at most 4 per call), compared with `ompdesk_compare`. A worker that must start from another branch gets that base in the session brief.",
	),
	// Fan-out only pays for items of minutes each (measured 20 Oct 2026, see feature-delegate-speed).
	rule(
		"swarm-size",
		/^swarm\/SKILL\.md$/,
		/## Start\n\n/,
		"## Start\n\nSwarm only items that each take minutes of work: a worker starts from nothing and takes a minute or more before its first edit, so a few small edits finish sooner as parallel tool calls in one response, even when the request asks for parallel work.\n\n",
	),
	rule(
		"mode-fanout-size",
		/^poteto-mode\/SKILL\.md$/,
		"Fan-out → **swarm**.",
		"Fan-out of items that each take minutes → **swarm**. A few small edits go as parallel tool calls in one response instead.",
	),
	rule(
		"how-spawn",
		/^how\/SKILL\.md$/,
		"Spawn one Task subagent with `subagent_type: generalPurpose` and `readonly: true`",
		'Spawn one read-only `task` subagent (`agent: "scout"`) on `@slow`',
	),
	rule(
		"arena-runners",
		/^arena\/SKILL\.md$/,
		/3\. Pick the runners from the `arena runners` line in `~\/\.cursor\/rules\/pstack-models\.mdc`[^\n]*? Spawn more for multiple design directions/,
		"3. Pick at least two runners. Default to one `@slow` and one on a different model family (the `advisor` role, or another configured provider). If a model is unavailable, use another configured model and say so. Spawn more for multiple design directions",
	),
	rule(
		"arena-bg",
		/^arena\/SKILL\.md$/,
		"Spawn all N subagents in one message with `run_in_background: true`, each with",
		"Spawn all N subagents in one `task` call (a `tasks[]` batch), each with",
	),
	rule(
		"arena-judge",
		/^arena\/SKILL\.md$/,
		/spawn one readonly judge from the `arena cross-judge pool` line in `~\/\.cursor\/rules\/pstack-models\.mdc`[^\n]*? or skip the judge, and say so\./,
		'spawn one read-only judge (`agent: "reviewer"`) on a different vendor from the parent (the `advisor` role or another configured provider). If no such model runs, skip the judge, pick the base alone in Phase D, and say so.',
	),
	rule(
		"no-comments-spawn",
		/^no-comments\/SKILL\.md$/,
		'Spawn `Task` with `subagent_type: "comment-sicko"`.',
		'Spawn a `task` with `agent: "comment-sicko"`.',
	),
	// ── playbooks: model slugs and delegation ────────────────────────────────────────────────────
	rule(
		"playbook-model",
		/^poteto-mode\/playbooks\/(bug-fix|feature|perf-issue|hillclimb|refactoring)\.md$/,
		/ using your configured [a-z-]+ model \(default `claude-opus-5-5-xhigh-fast`\)/,
		" on `@task` (`@slow` for the hardest change)",
	),
	rule(
		"playbook-tdd",
		/^poteto-mode\/playbooks\/bug-fix\.md$/,
		"See the **tdd** skill",
		"See the **pstack-tdd** skill",
	),
	rule(
		"bugfix-formal",
		/^poteto-mode\/playbooks\/bug-fix\.md$/,
		"When program state is unclear, add instrumentation or logging and read it as the code runs. Don't guess.",
		"When program state is unclear, add instrumentation or logging and read it as the code runs. Don't guess. A race, ordering, retry, lease or state-machine bug, or a claim that something can never happen, is a class tests reach poorly: read `skill://ompdesk-formal-verify` before you fix it.",
	),
	rule(
		"eval-dispatch-model",
		/^poteto-mode\/playbooks\/eval\.md$/,
		"An agent that only dispatches, polls, or packs results runs on `claude-opus-5-5-medium-fast`.",
		"An agent that only dispatches, waits, or collects results runs on `@smol`.",
	),
	rule(
		"auto-wake",
		/^poteto-mode\/playbooks\/autonomous-run\.md$/,
		/Pick the wake mechanism using Cursor's `\/loop` command \(a built-in, not a pstack skill\)\. An event to watch \(CI, a merge, a ref advancing\) gets a watcher subagent that wakes you on the event, with a long time-based heartbeat as fallback\. No event gets a fixed-interval heartbeat sized to when the result is worth re-checking\./,
		"Pick the wake mechanism. OMPdesk's Goal mode or Autopilot already wakes the session, so do not build another loop. An event to watch (CI, a merge, a ref advancing) is a `wait` on a background job or `gh_run_watch`, with a long time-based heartbeat as fallback. No event gets a fixed-interval heartbeat sized to when the result is worth re-checking (`/loop` in the omp TUI).",
	),
	rule("auto-ask", /^poteto-mode\/playbooks\/autonomous-run\.md$/, "`AskQuestion`", "`ask`"),
	// Delegation for speed only when it is faster (measured 20 Oct 2026: three small independent edits fanned out to
	// three subagents took 96–152 s on GPT-6.1 against 39–52 s solo on Claude Code and Codex). The review separation
	// the playbook wants stays: a small item's own author reviews its diff fresh before verifying.
	rule(
		"feature-delegate-speed",
		/^poteto-mode\/playbooks\/feature\.md$/,
		"Mandatory: no skip-with-reason escape, and Laziness Protocol does not override it (the gain is review separation, not lines saved).",
		"Delegate whenever an item takes minutes of writing; Laziness Protocol does not override that (the gain is review separation, not lines saved). An item you finish in a response or two (a few edits, a test, a help line) is faster written by you, several of them as parallel tool calls in one response: then reread your own diff against the source, as you would review a delegate's, before you verify.",
	),
	rule(
		"visual-loop",
		/^poteto-mode\/playbooks\/visual-parity\.md$/,
		"`/loop` per component until the diff is zero.",
		"Repeat per component until the diff is zero.",
	),
	rule(
		"pr-deslop",
		/^poteto-mode\/playbooks\/opening-a-pr\.md$/,
		"Run `/deslop` from `cursor-team-kit` over the diff before commit",
		"Run the user's `ponytail-review` skill when it is installed (else `/unslop` with **principle-laziness-protocol**) over the diff before commit",
	),
	rule(
		"autofull-deslop",
		/^poteto-mode\/playbooks\/autopilot-full\.md$/,
		"(the `deslop` skill from the `cursor-team-kit` plugin (`/deslop`))",
		"(the user's `ponytail-review` skill when installed, else the **unslop** skill)",
	),
	rule(
		"autofull-loop",
		/^poteto-mode\/playbooks\/autopilot-full\.md$/,
		"arm `/loop 1h` to audit",
		"arm a recurring audit (`/loop 1h` in the omp TUI, or an OMPdesk schedule) to audit",
	),
	rule(
		"autofull-rebase-gate",
		/^poteto-mode\/playbooks\/autopilot-full\.md$/,
		"Where that playbook says to report a rebase, the owner rebases its own branch and publishes it with `git push --force-with-lease`.",
		"When Babysit reports a required rebase, stop and report it. Do not rewrite the published branch without the operator's explicit approval of the reviewed change.",
	),
	rule(
		"autofull-approved-push",
		/^poteto-mode\/playbooks\/autopilot-full\.md$/,
		"Force-push only your own branch, with `--force-with-lease` pinned to the SHA you last pushed or took over",
		"Only after the operator approves publishing the reviewed rewrite, force-push your own branch with `--force-with-lease` pinned to the SHA you last pushed or took over",
	),
	// ── PR playbooks: Bugbot, watch-pr, Origin ───────────────────────────────────────────────────
	rule(
		"babysit-watch",
		/^poteto-mode\/playbooks\/babysit\.md$/,
		"On GitHub, status comes from the mode's watcher at `scripts/watch-pr/watch-pr`. In `check` mode pass `--status-only`. The watcher covers GitHub only.",
		"On GitHub, read `gh pr view <pr> --json mergeable,mergeStateStatus,reviewDecision,statusCheckRollup`, `gh pr checks <pr>`, and the review threads via `gh api`. In `check` mode read once and stop; only `drive` waits with `gh pr checks <pr> --watch`.",
	),
	rule(
		"babysit-bugbot",
		/^poteto-mode\/playbooks\/babysit\.md$/,
		"Verify each claim against the code per `../references/bugbot-triage.md`.",
		"Verify each claim against the code before acting.",
	),
	rule(
		"ship-watch",
		/^poteto-mode\/playbooks\/shipping\.md$/,
		"On GitHub, watch the run with `scripts/watch-pr/watch-pr --queued-stack` under `/loop` until it reports `COMPLETE` at the ceiling. Pass the run's PR numbers, bottom-to-top, in `--stack-prs`, and pass the same list each time you restart the watcher.",
		"On GitHub, watch the run with `gh pr view <pr> --json state,mergeStateStatus` for each PR, bottom to top, re-reading after every `gh pr checks <pr> --watch` return, until the ceiling reads merged.",
	),
	rule(
		"cleanup-audit",
		/^poteto-mode\/playbooks\/worktree-cleanup\.md$/,
		"run `scripts/worktree-audit.sh",
		"run `skill://poteto-mode/scripts/worktree-audit.sh",
	),
	// ── transcripts ──────────────────────────────────────────────────────────────────────────────
	rule(
		"transcript-active",
		ANY,
		/under the active workspace's `agent-transcripts\/` directory \((?:the system prompt names (?:the|this) path)\)/g,
		"under the active workspace's folder in `~/.omp/agent/sessions/` (`<timestamp>_<id>.jsonl`, or `ompdesk_session_read`)",
	),
	rule(
		"transcript-glob",
		ANY,
		/Do not glob across `~\/\.cursor\/projects\/\*\/`\./g,
		"Do not glob across other workspaces' folders under `~/.omp/agent/sessions/`.",
	),
	rule(
		"transcript-glob2",
		ANY,
		/Don't glob across `~\/\.cursor\/projects\/\*\/`\./g,
		"Don't glob across other workspaces' folders under `~/.omp/agent/sessions/`.",
	),
	rule(
		"transcript-recall",
		/^recall\/SKILL\.md$/,
		/Transcripts live at `~\/\.cursor\/projects\/<slug>\/agent-transcripts\/<uuid>\/<uuid>\.jsonl`, where `<slug>` is the workspace path with the leading slash dropped and each "\/" turned into "-" \(so `\/Users\/you\/proj` becomes `Users-you-proj`\)\. Every line is one chat message\./,
		"Transcripts live at `~/.omp/agent/sessions/<cwd-slug>/<timestamp>_<id>.jsonl`, where `<cwd-slug>` is the workspace path encoded as a folder name (list `~/.omp/agent/sessions/` to see them). Every line is one JSON entry of the session (messages, tool calls, custom entries). In OMPdesk, `ompdesk_sessions` and `ompdesk_session_read` read them without touching files.",
	),
	// ── skills authoring and discovery paths ─────────────────────────────────────────────────────
	rule(
		"authoring-create-skill",
		/^poteto-mode\/playbooks\/authoring-a-skill\.md$/,
		"1. Use the **create-skill** skill (Cursor's built-in for authoring SKILL.md files).",
		"1. Use the user's skill-writing skill (`writing-great-skills`) when it is installed, else the `manage_skill` tool.",
	),
	rule(
		"automate-create-skill",
		/^automate-me\/SKILL\.md$/,
		"Cursor's built-in `create-skill` (authoring)",
		"the user's skill-writing skill (`writing-great-skills`, else `manage_skill`) for authoring",
	),
	rule(
		"automate-create-skill2",
		/^automate-me\/SKILL\.md$/,
		"Use Cursor's built-in `create-skill` skill to author the skill.",
		"Use the user's skill-writing skill (`writing-great-skills`, else the `manage_skill` tool) to author the skill.",
	),
	rule(
		"automate-find",
		/^automate-me\/SKILL\.md$/,
		/Look recursively for `\.cursor\/skills\/\*\*\/\*-mode\/SKILL\.md` and `~\/\.cursor\/skills\/\*-mode\/SKILL\.md`/,
		"Look recursively for `.omp/skills/**/*-mode/SKILL.md`, `.agents/skills/**/*-mode/SKILL.md`, `~/.omp/agent/skills/*-mode/SKILL.md` and `~/.agents/skills/*-mode/SKILL.md`",
	),
	rule(
		"automate-category",
		/^automate-me\/SKILL\.md$/,
		/\(`\.cursor\/skills\/<handle>\/`\)/,
		"(`.agents/skills/<handle>/`)",
	),
	rule(
		"automate-path",
		/^automate-me\/SKILL\.md$/,
		/`\.cursor\/skills\/<handle>\/<handle>-mode\/SKILL\.md`/g,
		"`.agents/skills/<handle>/<handle>-mode/SKILL.md`",
	),
	rule("verify-path", /^(create|maintain)-verification-skill\/SKILL\.md$/, /`\.cursor\/skills\//g, "`.agents/skills/"),
	rule(
		"bugfix-loop",
		/^poteto-mode\/playbooks\/bug-fix\.md$/,
		"Drive a long or stubborn hunt with Cursor's `/loop` command.",
		"Drive a long or stubborn hunt with a repeating check (Goal mode keeps the session going; `/loop` exists in the omp TUI).",
	),
	rule(
		"control-such-as",
		ANY,
		/\(such as `control-ui` or `control-cli` from `cursor-team-kit`\)/g,
		"(the `ego-browser` skill or the OMPdesk preview for a UI, `bash` or `debug` for a CLI)",
	),
	rule(
		"ship-verifier",
		/^poteto-mode\/playbooks\/shipping\.md$/,
		"each a Cursor cloud agent,",
		"each a `task` subagent (or an OMPdesk worktree session),",
	),
	rule(
		"pickup-trail",
		/^poteto-mode\/playbooks\/session-pickup\.md$/,
		/under the active workspace's `agent-transcripts\/` directory \(the system prompt names the path\. Do not glob across `~\/\.cursor\/projects\/\*\/`, that crosses workspace boundaries and reads private chats from unrelated projects\), a cloud-agent URL/,
		"under the active workspace's folder in `~/.omp/agent/sessions/` (or `ompdesk_session_read`; do not glob across other workspaces' folders, that crosses workspace boundaries and reads private chats from unrelated projects), a hosted agent's URL",
	),
	rule(
		"cleanup-wt",
		/^poteto-mode\/playbooks\/worktree-cleanup\.md$/,
		"`.cursor/worktrees/myrepo/x`",
		"`~/.omp/wt/gui-myrepo-1a2b3c4`",
	),
	rule(
		"cleanup-support",
		/^poteto-mode\/playbooks\/worktree-cleanup\.md$/,
		/`~\/Library\/Application Support\/Cursor` \(`state\.vscdb\.backup`, and `snapshots\/roots\/<root>` where a `<root>` named for a folder you opened as a workspace balloons\), /,
		"`~/.omp/agent/sessions` (old session logs, only the ones the user agrees to drop), ",
	),
	rule(
		"autofull-owner",
		/^poteto-mode\/playbooks\/autopilot-full\.md$/,
		"Each owner is a Cursor cloud agent that builds,",
		"Each owner is an OMPdesk worktree session (`ompdesk_session_open` with `worktree: true`) that builds,",
	),
	rule(
		"autofull-session",
		/^poteto-mode\/playbooks\/autopilot-full\.md$/,
		"Assume the VM dies.",
		"Plan for the owner's session to end.",
	),
	rule(
		"automate-transcripts",
		/^automate-me\/SKILL\.md$/,
		"The system prompt names the workspace's `agent-transcripts/` directory. Use only that path.",
		"Use only this workspace's folder in `~/.omp/agent/sessions/`.",
	),
	rule("automate-cursor-dir", /^automate-me\/SKILL\.md$/, /\.cursor\/skills\//g, ".agents/skills/"),
	rule(
		"audit-transcripts",
		/^poteto-mode\/scripts\/worktree-audit\.sh$/,
		"# Transcripts dir: ~/.cursor/projects/<slugified-repo-path>/agent-transcripts.\nslug=$(printf '%s' \"$main_wt\" | sed 's#^/##; s#/#-#g')\ntranscripts=\"$HOME/.cursor/projects/$slug/agent-transcripts\"",
		'# Transcripts dir: every omp session folder (the worktree path is searched for inside them).\ntranscripts="$HOME/.omp/agent/sessions"',
	),
	// ── generic ──────────────────────────────────────────────────────────────────────────────────
	rule(
		"pick-level",
		ANY,
		/ Pick each subagent's reasoning level(?: for the job,)? per the Subagents section( of the \*\*poteto-mode\*\* skill)?\./g,
		" Pick each subagent's model role per the Subagents section$1.",
	),
	rule("askquestion", ANY, /`AskQuestion`/g, "`ask`"),
	rule("todolist", ANY, /todolist/g, "`todo` list"),
	rule(
		"internal-swarm",
		/^swarm\/SKILL\.md$/,
		"Open a `todo` list with one entry per phase before launching anything.",
		"Plan the phases below before launching anything.",
	),
	rule(
		"internal-arena",
		/^arena\/SKILL\.md$/,
		"Open a `todo` list with one entry per phase (Frame, Fan out, Cross-judge, Pick, Graft, Verify) before launching anything.",
		"Plan the phases below before launching anything.",
	),
	rule(
		"internal-figure-it-out",
		/^figure-it-out\/SKILL\.md$/,
		"Open a `todo` list whose first item is to read the Principles section of the **poteto-mode** skill. Then add the phases below as todos.",
		"Read the Principles section of the **poteto-mode** skill. Use the phases below internally.",
	),
	rule(
		"internal-poteto-mode",
		/^poteto-mode\/playbooks\/feature\.md$/,
		"Write the throughput checkpoint as four todo items. A dimension that genuinely does not apply (single file, no fan-out) keeps its item with `n/a: <reason>` rather than being dropped:",
		"Use these four questions to plan the work. Record non-applicable dimensions in the checkpoint, not the user’s task list:",
	),
	rule(
		"internal-design-steps",
		/^figure-it-out\/SKILL\.md$/,
		"Add its steps to the `todo` list as concrete items between the Phase C and Phase D entries.",
		"Track execution against the requested outcomes.",
	),
	rule("bugbot-generic", ANY, /\bBugbot\b/g, "review bots"),
];

interface Counted {
	rule: Rule;
	hits: number;
}

function applyRules(relPath: string, text: string, counted: Counted[]): string {
	let out = text;
	for (const entry of counted) {
		if (!entry.rule.files.test(relPath)) continue;
		const before = out;
		out =
			typeof entry.rule.from === "string"
				? out.split(entry.rule.from).join(entry.rule.to)
				: out.replace(entry.rule.from, entry.rule.to);
		if (out !== before) entry.hits++;
	}
	return out;
}

function sha256(buffer: Buffer | string): string {
	return createHash("sha256").update(buffer).digest("hex");
}

function walk(dir: string, base = dir): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full, base));
		else out.push(path.relative(base, full).split(path.sep).join("/"));
	}
	return out.sort();
}

function upstreamSource(): { dir: string; cleanup: () => void } {
	const override = process.env.PSTACK_SRC;
	if (override) {
		const head = execFileSync("git", ["-C", override, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		if (head !== config.commit) throw new Error(`PSTACK_SRC is at ${head}, the pin is ${config.commit}`);
		return { dir: override, cleanup: () => {} };
	}
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pstack-src-"));
	execFileSync("git", ["clone", "--filter=blob:none", "--no-checkout", `https://github.com/${config.repo}`, tmp], {
		stdio: "inherit",
	});
	execFileSync("git", ["-C", tmp, "checkout", config.commit], { stdio: "inherit" });
	return { dir: tmp, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

function main(): void {
	if (process.argv.includes("--check")) {
		execFileSync("bun", [path.join(import.meta.dir, "skill-packs.ts"), "check", "pstack"], { stdio: "inherit" });
		return;
	}
	const source = upstreamSource();
	try {
		const upstream = path.join(source.dir, config.path);
		const counted: Counted[] = RULES.map(rule => ({ rule, hits: 0 }));

		// Skills.
		const skillsOut = path.join(PACK, "skills");
		for (const skill of OWNED_SKILLS) fs.accessSync(path.join(skillsOut, skill, "SKILL.md"));
		for (const skill of fs.readdirSync(skillsOut)) {
			if (!OWNED_SKILLS.includes(skill)) fs.rmSync(path.join(skillsOut, skill), { recursive: true, force: true });
		}
		const upstreamSkills = path.join(upstream, "skills");
		for (const rel of walk(upstreamSkills)) {
			const [skill] = rel.split("/");
			if (
				OWNED_SKILLS.includes(skill) ||
				SKIPPED_SKILLS.has(skill) ||
				SKIPPED_PATHS.some(pattern => pattern.test(rel))
			)
				continue;
			const renamed = RENAMED_SKILLS[skill];
			const destRel = renamed ? `${renamed}${rel.slice(skill.length)}` : rel;
			const dest = path.join(skillsOut, destRel);
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			const buffer = fs.readFileSync(path.join(upstreamSkills, rel));
			if (!rel.endsWith(".md") && rel !== "poteto-mode/scripts/worktree-audit.sh") {
				fs.writeFileSync(dest, buffer);
				fs.chmodSync(dest, fs.statSync(path.join(upstreamSkills, rel)).mode & 0o777);
				continue;
			}
			let text = applyRules(rel, buffer.toString("utf8"), counted);
			if (renamed && destRel.endsWith("/SKILL.md")) {
				text = text.replace(new RegExp(`^name: ${skill}$`, "m"), `name: ${renamed}`);
			}
			if (destRel.endsWith("/SKILL.md")) text = insertNote(text);
			else if (/^poteto-mode\/playbooks\/(?!opening-a-pr)[a-z-]+\.md$/.test(destRel))
				text = insertPlaybookNote(text);
			fs.writeFileSync(dest, text);
			fs.chmodSync(dest, fs.statSync(path.join(upstreamSkills, rel)).mode & 0o777);
		}

		// Agents: the wrapper is OMPdesk's own (pstack-agent.md); comment-sicko is translated.
		const agentsOut = path.join(PACK, "agents");
		fs.mkdirSync(agentsOut, { recursive: true });
		const sicko = applyRules(
			"comment-sicko.md",
			fs.readFileSync(path.join(upstream, "agents/comment-sicko.md"), "utf8"),
			counted,
		);
		fs.writeFileSync(path.join(agentsOut, "comment-sicko.md"), withAgentTools(sicko));

		// pstack-adapter skill: the adapter text as a readable skill (subagents have no `<pstack>` section).
		const adapter = fs.readFileSync(path.join(PACK, "adapter.md"), "utf8");
		const adapterDir = path.join(skillsOut, "pstack-adapter");
		fs.mkdirSync(adapterDir, { recursive: true });
		fs.writeFileSync(
			path.join(adapterDir, "SKILL.md"),
			`---\nname: pstack-adapter\ndescription: How the pstack playbooks' tool, agent and model names map to omp and OMPdesk. Read by subagents that have no pstack section in their prompt.\ndisable-model-invocation: true\n---\n\n${adapter}`,
		);

		// License.
		const license = fs.readFileSync(path.join(upstream, "LICENSE"));
		fs.writeFileSync(path.join(PACK, "UPSTREAM-LICENSE"), license);
		fs.mkdirSync(path.dirname(LICENSE_COPY), { recursive: true });
		fs.writeFileSync(LICENSE_COPY, license);

		const unmatched = counted.filter(entry => entry.hits === 0).map(entry => entry.rule.id);
		if (unmatched.length)
			throw new Error(`pstack translation rules matched nothing (upstream reworded?): ${unmatched.join(", ")}`);

		// Generated bridge text.
		fs.writeFileSync(TEXT_MODULE, renderTextModule(assemblePstackSections(PACK)));

		// Manifest of every pack file (OMPdesk-owned ones included).
		const files = walk(PACK).filter(rel => rel !== "pstack-manifest.json");
		const manifest = Object.fromEntries(files.map(rel => [rel, sha256(fs.readFileSync(path.join(PACK, rel)))]));
		fs.writeFileSync(
			MANIFEST,
			`${JSON.stringify({ commit: config.commit, version: config.version, files: manifest }, null, "\t")}\n`,
		);
		console.log(
			`Vendored pstack ${config.version} (${config.commit.slice(0, 7)}): ${files.length} files, ${RULES.length} rules; owned: ${OWNED.join(", ")}`,
		);
	} finally {
		source.cleanup();
	}
}

/** One line under the H1 of every skill (under the frontmatter when it has none): where the adapter lives. */
function insertNote(text: string): string {
	const note =
		"> OMPdesk built-in pack. Tool, agent and model names here are the omp and OMPdesk ones; the adapter is in the `<pstack>` section of your prompt, or `skill://pstack-adapter`.";
	const match = /^# .+\n/m.exec(text) ?? /^---\n[\s\S]*?\n---\n/.exec(text);
	if (!match) throw new Error("a pack skill has no H1 heading or frontmatter");
	const at = match.index + match[0].length;
	return `${text.slice(0, at)}\n${note}\n${text.slice(at)}`;
}

/** Under the title of a playbook: the `todo` instruction, where the model is looking when it has just read the steps. */
function insertPlaybookNote(text: string): string {
	const note = `> OMPdesk: before step 1, update the plan. ${PLAYBOOK_TODOS} Keep earlier work going unless the user explicitly cancels or replaces it.`;
	const newline = text.indexOf("\n");
	if (!text.startsWith("### ") || newline < 0) throw new Error("a playbook does not start with its ### title");
	return `${text.slice(0, newline + 1)}\n${note}\n${text.slice(newline + 1)}`;
}

/** comment-sicko only reads: restrict its tools (omp agent frontmatter) and give it model roles. */
function withAgentTools(text: string): string {
	return text.replace(
		/^---\n([\s\S]*?)\n---\n/,
		(_all, head: string) => `---\n${head}\ntools: [read, grep, glob, find]\nmodel: ["@slow", "@task"]\n---\n`,
	);
}

main();
