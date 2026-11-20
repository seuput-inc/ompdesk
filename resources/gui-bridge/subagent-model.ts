/**
 * What model a subagent ran on (models-accounts.md › Subagent models). Rules: subagent-model-core.ts.
 *
 * Stock moves any session to the next model of `retry.fallbackChains` (a `provider/*` key outranks every role chain)
 * once its model fails, a usage limit included, and records it only as an ephemeral `fallback` model change in the
 * subagent's own journal; the `<task-result>` its parent reads names no model (seen 20 Nov 2026: seven `reviewer`
 * subagents on openai-codex ran on Claude after their first answer, and their parent counted a cross-family review).
 *
 * - **A review subagent keeps its model.** A review is worth what its model is: the review role exists to read a
 *   change with another family's model. Stock keeps a per-call `model` subagent on its model (`disableModelFallback`:
 *   no retry fallback, no usage-aware fallback, no context promotion) but offers no setting for an agent or a role, so
 *   the same three settings are turned off on the review subagent's own settings overlay, as stock's security
 *   coordinator does for its scan sessions (`security/coordinator.ts` `createDefaultSecuritySession`). It then fails
 *   with its model's limit, which its task result quotes. A review subagent: its spawn resolved its model through the
 *   `review` role (`session_init.modelRole`), or it is one of stock's review agents, whatever its model.
 * - **Any other subagent's fallback is named to its parent** in the tool result that carries its `<task-result>` (the
 *   `task` call when it ran in the foreground, `wait` for a background one), read from the subagent's journal: the
 *   models its answers came from and the chosen model's last failure. Known gap: a background result stock delivers by
 *   itself (an `async-result` follow-up, no tool call) passes no hook OMPdesk has short of a `context` handler, which
 *   makes stock clone the whole context on every request; that delivery is not annotated.
 *
 * Nothing is written to config.yml.
 */
import * as fs from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { annotateTaskResults, fallbackNote, holdsModel, type JournalEntry } from "./subagent-model-core";

export const methods = {};

/** The settings stock's `disableModelFallback` stands for, each turned off on a held session. */
const FALLBACK_SETTINGS = ["retry.modelFallback", "retry.usageAwareFallback", "contextPromotion.enabled"] as const;

/** Settings overlays already held (one per subagent session; a revived one gets a new overlay). */
const held = new WeakSet<object>();

/** A subagent's journal, from its session file; empty when it has none or it cannot be read. */
function journal(file: string | null | undefined): JournalEntry[] {
	if (!file) return [];
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const entries: JournalEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// A line still being written.
		}
	}
	return entries;
}

export function install(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (_event, ctx) => {
		if (ctx.agent.kind !== "sub") return undefined;
		const init = ctx.sessionManager.getEntries().findLast(entry => entry.type === "session_init");
		if (!holdsModel(init)) return undefined;
		const settings = pi.pi.AgentRegistry.global().get(ctx.agent.id)?.session?.settings;
		if (!settings || held.has(settings)) return undefined;
		// Loaded on use, like ompdesk-roles.ts: a static import would tie this area's link to stock's settings registry.
		const { lookup } = await import("./omp/pi-coding-agent/config/registry");
		for (const id of FALLBACK_SETTINGS) {
			const setting = lookup(id) as { override(scope: object, value: boolean): void } | undefined;
			if (!setting) {
				pi.logger.error("gui-bridge: review hold found no setting", { id });
				continue;
			}
			setting.override(settings, false);
		}
		held.add(settings);
		pi.logger.info("gui-bridge: review agent held on its model", { agent: ctx.agent.id });
		return undefined;
	});

	pi.on("tool_result", event => {
		if (!event.content.some(part => part.type === "text" && part.text.includes("<task-result id="))) return undefined;
		const registry = pi.pi.AgentRegistry.global();
		const noteFor = (id: string) => fallbackNote(id, journal(registry.get(id)?.sessionFile));
		let changed = false;
		const content = event.content.map(part => {
			if (part.type !== "text") return part;
			const text = annotateTaskResults(part.text, noteFor);
			if (text === part.text) return part;
			changed = true;
			return { ...part, text };
		});
		return changed ? { content } : undefined;
	});
}
