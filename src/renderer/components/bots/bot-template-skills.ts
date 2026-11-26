/**
 * The small skills the bot templates come with (Orca ships its own thirteen, `bot-template-view.ts:12-32`; these are
 * written anew for omp): each becomes `.omp/skills/<id>/SKILL.md` in the new bot's folder, which omp loads as a project
 * skill. Agent-facing, so English.
 */

const skill = (name: string, description: string, body: string) =>
	`---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`;

export const BOT_TEMPLATE_SKILLS = {
	"pr-review-checklist": skill(
		"pr-review-checklist",
		"Review a pull request for risk: what to read first and what to report.",
		`
1. Read the description, then the diff file by file; open the surrounding code where a change touches shared state.
2. Look for: behavior changes without a test, error paths that swallow failures, data that can be lost, security
   (input reaching a shell, a query or HTML), concurrency, migrations and anything irreversible.
3. Report the risky changes first, each with file:line, what can go wrong and a concrete fix. Skip style nits.
4. End with one line: safe to merge, merge after fixes, or needs a rethink.`,
	),
	"bug-reproduction": skill(
		"bug-reproduction",
		"Reproduce a reported bug and find where it starts.",
		`
1. Restate the report as steps, expected and actual result. Ask once for what is missing.
2. Reproduce it with the smallest input: a test, a script or the app. Keep the command that shows it.
3. Bisect the cause: read the code path, add logging if needed, find the first place the state goes wrong.
4. Report the steps, the cause with file:line and the smallest fix. Never ship the fix unasked.`,
	),
	"dependency-upgrade": skill(
		"dependency-upgrade",
		"Find outdated and vulnerable dependencies and propose safe upgrades.",
		`
1. List outdated packages with the project's own tool (bun outdated, npm outdated, cargo outdated, pip list -o).
2. Check advisories (bun audit, npm audit, cargo audit) and read the changelog of each major bump.
3. Group the upgrades: safe patches, minors to test, majors with breaking changes.
4. Propose one branch per group with the commands to run; open sessions to do it only when the owner says so.`,
	),
	"workspace-hygiene": skill(
		"workspace-hygiene",
		"Find finished or abandoned worktrees and branches that can be removed.",
		`
1. List worktrees (git worktree list) and local branches with their last commit date.
2. A worktree is finished when its branch is merged; abandoned when untouched for 14 days with no open pull request.
3. Never remove anything yourself: list what can go, with the command, and wait for the owner.
4. Keep anything with uncommitted changes off the list and say so.`,
	),
	"security-checklist": skill(
		"security-checklist",
		"Check merged changes for leaked secrets and risky code.",
		`
1. Scan the new commits for secrets: keys, tokens, passwords, private URLs, .env files.
2. Look for input reaching a shell, SQL, eval or HTML without escaping; disabled checks; widened permissions.
3. Rate each finding (critical, high, medium) with file:line and the fix.
4. A leaked secret is critical: say to rotate it first, then remove it from history.`,
	),
	"release-readiness": skill(
		"release-readiness",
		"Track what blocks the next release.",
		`
1. Find the last release tag and what merged since.
2. Collect blockers: failing checks on the main branch, open pull requests marked for the release, open bugs marked blocking.
3. Report: ready, or each blocker with its owner and link. Keep it to a few lines.`,
	),
	"release-notes-style": skill(
		"release-notes-style",
		"Draft release notes from merged pull requests in the project's style.",
		`
1. Read the last two releases' notes and copy their structure and tone.
2. List merged pull requests since the last tag; group them by what users notice (features, fixes, changes).
3. One line per change in the user's words, not the commit's. Leave out internal refactors and test-only changes.`,
	),
	"ci-failure-triage": skill(
		"ci-failure-triage",
		"Explain a failed CI check and decide whether it is flaky or real.",
		`
1. Read the failed job's log; find the first error, not the last.
2. Flaky when the same test passed on a rerun or fails on unrelated changes; keep a list in memory/flaky-tests.md.
3. Real when the failure follows the change: name the commit and the line.
4. Report one line per failure: flaky or real, why, and what to do.`,
	),
	"issue-triage": skill(
		"issue-triage",
		"Triage new issues and questions: labels, duplicates, missing details.",
		`
1. Read the issue; search for duplicates by title and error text.
2. Propose labels from the repository's own set; name the likely area and owner.
3. List what is missing to act on it (version, steps, logs) as a reply the owner can post.
4. Never post or label yourself unless the owner turned that on.`,
	),
	"feedback-themes": skill(
		"feedback-themes",
		"Group feedback into themes with examples.",
		`
1. Gather the week's feedback.
2. Group it into at most seven themes; each with a count, two short quotes and the people who raised it.
3. Mark what is new since last week and what grew.`,
	),
	"status-brief": skill(
		"status-brief",
		"Write a short status brief or standup notes.",
		`
1. Read what happened: merged pull requests, finished sessions, open items, failing checks.
2. Three parts, a few bullets each: done, next, blocked.
3. Link every bullet. No filler.`,
	),
	"spec-format": skill(
		"spec-format",
		"Turn a discussion into a short spec.",
		`
1. Sections: Problem, Goal, Non-goals, Proposal, Open questions.
2. One page at most. Quote the decisions the discussion made and who made them.
3. List what is still undecided as questions for the owner.`,
	),
	"incident-timeline": skill(
		"incident-timeline",
		"Keep an incident timeline and draft the write-up.",
		`
1. Keep memory/incident-<date>.md: one line per event with the time, what happened and who.
2. When it is over, draft the write-up: summary, impact, timeline, cause, what went well, follow-ups with owners.
3. Blameless: describe systems and decisions, not people.`,
	),
} as const;

export type BotTemplateSkillId = keyof typeof BOT_TEMPLATE_SKILLS;
