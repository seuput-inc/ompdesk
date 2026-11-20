/**
 * Rules of subagent-model.ts, pure: which subagent keeps its model, and the line a parent reads when a subagent's
 * answers came from another model than the one its spawn resolved (stock's retry fallback moved it).
 */

/** Stock's review agents: held on any model. */
const REVIEW_AGENTS: Record<string, true> = { reviewer: true, "security-reviewer": true };

/** Whether a subagent's `session_init` (its agent and the role its model came from) keeps it on its model. */
export function holdsModel(init: { agent?: unknown; modelRole?: unknown } | undefined): boolean {
	if (!init) return false;
	return init.modelRole === "review" || (typeof init.agent === "string" && Object.hasOwn(REVIEW_AGENTS, init.agent));
}

/** The parts of a subagent's journal entries this reads (`session_init`, assistant `message`s). */
export interface JournalEntry {
	type?: unknown;
	resolvedModel?: unknown;
	message?: { role?: unknown; provider?: unknown; model?: unknown; stopReason?: unknown; errorMessage?: unknown };
}

/** Longest failure text quoted from the chosen model's last error. */
const REASON_CHARS = 160;

/**
 * The line for a subagent whose answers came from another model than its `session_init.resolvedModel`, or undefined.
 * `resolvedModel` is stock's selector (`provider/id`, a `:level` suffix when the level was set), an answer's model is
 * `provider/id`. Failed answers (`stopReason: "error"`) do not count as answers; the chosen model's last one is the
 * reason quoted.
 */
export function fallbackNote(name: string, entries: readonly JournalEntry[]): string | undefined {
	const chosen = entries.findLast(entry => entry.type === "session_init")?.resolvedModel;
	if (typeof chosen !== "string" || !chosen) return undefined;
	const onChosen = (model: string) => chosen === model || chosen.startsWith(`${model}:`);
	const ran = new Map<string, number>();
	let answers = 0;
	let reason: string | undefined;
	for (const entry of entries) {
		const message = entry.message;
		if (entry.type !== "message" || message?.role !== "assistant") continue;
		if (typeof message.provider !== "string" || typeof message.model !== "string") continue;
		const model = `${message.provider}/${message.model}`;
		if (message.stopReason === "error") {
			if (onChosen(model) && typeof message.errorMessage === "string") reason = message.errorMessage;
			continue;
		}
		answers++;
		if (!onChosen(model)) ran.set(model, (ran.get(model) ?? 0) + 1);
	}
	if (ran.size === 0) return undefined;
	const elsewhere = [...ran.values()].reduce((sum, count) => sum + count, 0);
	const why = reason?.split("\n")[0]?.trim().slice(0, REASON_CHARS);
	return `[OMPdesk] ${name} ran on ${[...ran.keys()].join(", ")} for ${elsewhere} of its ${answers} answers, not on its chosen model ${chosen}${why ? `, which failed: ${why}` : ""}. Stock's retry fallback (retry.fallbackChains) moved it.`;
}

/** Every `<task-result id="…">` envelope in `text`, each followed by its subagent's line when `noteFor` gives one. */
export function annotateTaskResults(text: string, noteFor: (id: string) => string | undefined): string {
	return text.replace(/<task-result id="([^"]+)"[^>]*>[\s\S]*?<\/task-result>/g, (envelope, id: string) => {
		const note = noteFor(id);
		return note ? `${envelope}\n${note}` : envelope;
	});
}
