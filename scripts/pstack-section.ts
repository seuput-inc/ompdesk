/**
 * Builds the text of OMPdesk's always-on `<pstack>` prompt section from the built-in pack
 * (`resources/omp-builtin/pstack/`): the hand-written `adapter.md` plus blocks of the translated
 * `skills/poteto-mode/SKILL.md`. Pure (strings in, strings out) so `scripts/sync-pstack.ts` writes the result into
 * `resources/gui-bridge/modes/pstack-text.ts` and `src/main/pstack/pack-drift.test.ts` rebuilds it to prove the
 * generated file is current. The section is static text on purpose: byte-identical for a whole session keeps the
 * provider's prompt cache.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface PstackSections {
	/** Main agent, delegation allowed. */
	full: string;
	/** Main agent when delegation is off (`task` absent): the delegation paragraph says "do it yourself". */
	solo: string;
	/** Autopilot parent and children: principle index plus the playbooks that suit an unattended cycle. */
	autopilot: string;
	/** Principle skill names (`principle-*`), in index order. */
	principles: string[];
}

/** `## Heading` blocks of a markdown file, by heading text; the body excludes the heading line and trailing blank lines. */
export function markdownSections(markdown: string): Map<string, string> {
	const out = new Map<string, string>();
	let name: string | undefined;
	let lines: string[] = [];
	const flush = () => {
		if (name !== undefined) out.set(name, lines.join("\n").trim());
	};
	for (const line of markdown.split("\n")) {
		const heading = /^## (.+)$/.exec(line);
		if (heading) {
			flush();
			name = heading[1].trim();
			lines = [];
		} else lines.push(line);
	}
	flush();
	return out;
}

function required(map: Map<string, string>, name: string, where: string): string {
	const value = map.get(name);
	if (!value) throw new Error(`${where} has no "## ${name}" section`);
	return value;
}

/** Upstream shortened three titles in its compact list. The adapter keeps their shipped descriptions and labels. */
const compactTitles: Record<string, string> = {
	"Authoring or modifying a skill": "Authoring a skill",
	"Multi-phase or multi-PR plan": "Multi-phase plan",
	"Worktree and simulator cleanup": "Worktree cleanup",
};

export function playbookSection(body: string, routes: string, playbookFiles: readonly string[]): string {
	const files = new Set(playbookFiles);
	const titles = routes.split("\n").map(line => {
		const row = /^- \*\*(.+?)\.\*\* \S.* → skill:\/\/poteto-mode\/playbooks\/([a-z0-9-]+\.md)$/.exec(line);
		if (!row) throw new Error(`Invalid playbook route in adapter.md: ${line}`);
		const title = compactTitles[row[1]] ?? row[1];
		const file = `${title.toLowerCase().replaceAll(" ", "-")}.md`;
		if (file !== row[2] || !files.delete(file)) {
			throw new Error(`Expected one route to playbooks/${file} for "${title}": ${line}`);
		}
		return title;
	});
	if (files.size) throw new Error(`Playbooks without adapter routes: ${[...files].join(", ")}`);
	const listStart = body.lastIndexOf("\n\n");
	if (listStart < 0 || body.slice(listStart + 2) !== `${titles.join(", ")}.`) {
		throw new Error("poteto-mode's compact Playbooks list no longer matches the routes in adapter.md");
	}
	return body.slice(0, listStart + 2) + routes;
}

/** Principle leaf names in the index order of poteto-mode's Principles section. */
function principleNames(skillsDir: string): string[] {
	return fs
		.readdirSync(skillsDir)
		.filter(name => name.startsWith("principle-"))
		.sort();
}

export function assemblePstackSections(packDir: string): PstackSections {
	const adapter = markdownSections(fs.readFileSync(path.join(packDir, "adapter.md"), "utf8"));
	const skillsDir = path.join(packDir, "skills");
	const mode = markdownSections(fs.readFileSync(path.join(skillsDir, "poteto-mode/SKILL.md"), "utf8"));
	const principles = principleNames(skillsDir);

	const precedence = required(adapter, "Precedence", "adapter.md");
	const translation = required(adapter, "Adapter", "adapter.md");
	const gate = required(adapter, "Routing gate", "adapter.md");
	const delegation = required(adapter, "Delegation", "adapter.md");
	const delegationSolo = required(adapter, "Delegation when solo", "adapter.md");
	const reply = required(adapter, "Writing the reply", "adapter.md");
	const autopilotText = required(adapter, "Autopilot", "adapter.md");

	const nonNegotiables = required(mode, "Non-negotiables", "poteto-mode SKILL.md");
	const principleIndex = required(mode, "Principles", "poteto-mode SKILL.md");
	const autonomy = required(mode, "Autonomy", "poteto-mode SKILL.md");
	const playbooks = playbookSection(
		required(mode, "Playbooks", "poteto-mode SKILL.md"),
		required(adapter, "Playbooks", "adapter.md"),
		fs
			.readdirSync(path.join(skillsDir, "poteto-mode/playbooks"), { withFileTypes: true })
			.filter(entry => entry.isFile() && entry.name.endsWith(".md"))
			.map(entry => entry.name),
	);

	const compose = (delegationBody: string): string =>
		[
			"<pstack>",
			precedence,
			"",
			"## Routing gate",
			gate,
			"",
			"## Adapter",
			translation,
			"",
			"## Non-negotiables",
			nonNegotiables,
			"",
			"## Principles",
			principleIndex,
			"",
			"## Autonomy",
			autonomy,
			"",
			"## Delegation",
			delegationBody,
			"",
			"## Writing the reply",
			reply,
			"",
			"## Playbooks",
			playbooks,
			"</pstack>",
		].join("\n");

	const autopilot = [
		"<pstack-autopilot>",
		autopilotText,
		"",
		"Principle skills (read the leaf with skill://<name> before you apply it):",
		...principles.map(name => `- ${name}`),
		"</pstack-autopilot>",
	].join("\n");

	const skillPaths = (text: string): string =>
		text.replace(/`(playbooks|references)\/([a-z0-9-]+\.md)`/g, "`skill://poteto-mode/$1/$2`");
	return {
		full: skillPaths(compose(delegation)),
		solo: skillPaths(compose(delegationSolo)),
		autopilot,
		principles,
	};
}

/** The generated bridge module: `resources/gui-bridge/modes/pstack-text.ts`. */
export function renderTextModule(sections: PstackSections): string {
	return `/**
 * GENERATED by scripts/sync-pstack.ts from resources/omp-builtin/pstack/ (adapter.md and the translated poteto-mode
 * skill). Do not edit by hand: \`src/main/pstack/pack-drift.test.ts\` fails when this file is not what the pack yields.
 * Static text: the prompt cache needs it byte-identical for a whole session. No imports.
 */

/** The full always-on section: main agent, delegation allowed. */
export const PSTACK_SECTION = ${JSON.stringify(sections.full)};

/** The same section for a session without delegation (the \`task\` tool is off). */
export const PSTACK_SECTION_SOLO = ${JSON.stringify(sections.solo)};

/** The condensed section an Autopilot session gets instead (its protocol and HARD LIMITS outrank the playbooks). */
export const PSTACK_AUTOPILOT_SECTION = ${JSON.stringify(sections.autopilot)};
`;
}
