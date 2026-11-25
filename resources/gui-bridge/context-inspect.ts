/**
 * Context inspector (Insights › This session): what the live session's
 * context holds, entry by entry. Stock's `/context` (`getContextBreakdown`)
 * gives the category totals; this lists every tool, skill, instruction file,
 * system prompt block and message the provider gets, each counted with the
 * session's own tokenizer as stock counts it (`session/context-usage.ts`
 * `estimateToolSchemaTokens` per tool; instruction files and skills located by
 * stock's prompt sources through `claimPromptSources`; `Tokenizer.countMessage`),
 * and splits the tools by source (built-in, MCP, extension) the way
 * `composer.tool_extras` does. Category totals stay stock's provider-anchored
 * figures; per-entry counts are estimates. Rules in context-inspect-core.ts.
 */

import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	type ContextCategory,
	capPreview,
	llmMessagesText,
	type Preview,
	SOURCE_CATEGORY,
	snippet,
	splitBlock,
	TOOL_CATEGORY,
	type ToolSource,
} from "./context-inspect-core";
import { guard } from "./health";
import { sectionContext, withTurnSections } from "./prompt-sections";
import { mountedToolEntries } from "./tool-presentation";
import type { BridgeMethods } from "./types";

interface Entry {
	/** Stable within one read: `prompt:<i>`, `source:<stock source id>:<label>`, `tool:<name>`, `deferred:<name>`, `msg:<i>:<timestamp>`. */
	id: string;
	category: ContextCategory;
	label: string;
	/** Message role for `msg:` entries. */
	role?: string;
	tokens: number;
	/** A mounted tool listed without a top-level schema. */
	deferred?: true;
}

function toolSource(session: AgentSession, name: string): ToolSource {
	return name.startsWith("mcp__") ? "mcp" : session.hasBuiltInTool(name) ? "builtin" : "extension";
}

function messageTimestamp(message: object): number {
	return "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : 0;
}

/**
 * The system prompt of the next turn. Stock keeps only what it built in `session.systemPrompt` between turns;
 * OMPdesk's own sections join as a turn starts, so they are applied here as a prompt's hook applies them, with the
 * session's own extension context (its folder: the ECC section reads it). Sections only append blocks, so stock's
 * prompt sources still claim the blocks it built.
 */
async function turnPrompt(session: AgentSession) {
	const { claimPromptSources } = await import("./omp/pi-coding-agent/session/context-usage");
	const stock = session.systemPrompt;
	const parts = withTurnSections(stock, sectionContext(session));
	return { parts, stockBlocks: stock.length, claims: claimPromptSources(parts, session.systemPromptSources).byBlock };
}

function sourceEntryId(source: { id: string; label: string }): string {
	return `source:${source.id}:${source.label}`;
}

/** `withEntries` false: the category totals only (Insights' breakdown card), without walking the messages. */
async function inspect(session: AgentSession, withEntries: boolean) {
	const tokenizer = session.agent.tokenizer;
	const breakdown = session.getContextBreakdown();
	const tools = session.agent.state.tools;
	const entries: Entry[] = [];
	const totals: Record<ContextCategory, number> = {
		systemPrompt: breakdown?.systemPromptTokens ?? 0,
		systemContext: breakdown?.systemContextTokens ?? 0,
		memoryFiles: breakdown?.instructionFilesTokens ?? 0,
		builtinTools: 0,
		mcpTools: 0,
		extensionTools: 0,
		skills: breakdown?.skillsTokens ?? 0,
		messages: breakdown?.messagesTokens ?? 0,
	};

	const { parts, stockBlocks, claims } = await turnPrompt(session);
	parts.forEach((part, index) => {
		const { sources, rest } = splitBlock(part, claims.get(index) ?? []);
		for (const { source, text } of sources) {
			entries.push({
				id: sourceEntryId(source),
				category: SOURCE_CATEGORY[source.kind],
				label: source.label,
				tokens: tokenizer.countTokens(text),
			});
		}
		const tokens = tokenizer.countTokens(rest);
		// OMPdesk's own sections are not in stock's figure.
		if (index >= stockBlocks) totals.systemContext += tokens;
		entries.push({
			id: `prompt:${index}`,
			category: index === 0 ? "systemPrompt" : "systemContext",
			label: snippet(part),
			tokens,
		});
	});

	// A one-tool roster is summed by the same estimator stock uses for the whole set.
	const { estimateToolSchemaTokens } = await import("./omp/pi-coding-agent/session/context-usage");
	const revision = session.settings.revision;
	for (const tool of tools) {
		const category = TOOL_CATEGORY[toolSource(session, tool.name)];
		const tokens = estimateToolSchemaTokens([tool], tokenizer, revision);
		totals[category] += tokens;
		entries.push({ id: `tool:${tool.name}`, category, label: tool.name, tokens });
	}
	for (const mounted of mountedToolEntries(session)) {
		entries.push({
			id: `deferred:${mounted.name}`,
			category: TOOL_CATEGORY[toolSource(session, mounted.name)],
			label: mounted.name,
			tokens: 0,
			deferred: true,
		});
	}

	if (withEntries) {
		const { convertToLlm } = await import("./omp/pi-coding-agent/session/messages");
		session.agent.state.messages.forEach((message, index) => {
			entries.push({
				id: `msg:${index}:${messageTimestamp(message)}`,
				category: "messages",
				label: snippet(llmMessagesText(convertToLlm([message]))),
				role: message.role,
				tokens: tokenizer.countMessage(message),
			});
		});
	}

	return {
		model: session.model?.id ?? "",
		contextWindow: breakdown?.contextWindow ?? session.model?.contextWindow ?? 0,
		usedTokens: breakdown?.usedTokens ?? 0,
		anchored: breakdown?.anchored ?? false,
		categories: totals,
		entries: withEntries ? entries : [],
	};
}

async function preview(session: AgentSession, id: string): Promise<Preview> {
	const colon = id.indexOf(":");
	const kind = id.slice(0, colon);
	const key = id.slice(colon + 1);
	const { parts, claims } = await turnPrompt(session);
	switch (kind) {
		case "prompt": {
			const part = parts[Number(key)];
			if (part !== undefined) return capPreview(part);
			break;
		}
		case "source": {
			for (const [index, sources] of claims) {
				const source = sources.find(candidate => sourceEntryId(candidate) === id);
				if (source) return capPreview(parts[index]?.slice(source.start, source.end) ?? "");
			}
			break;
		}
		case "tool": {
			const tool = session.agent.state.tools.find(candidate => candidate.name === key);
			// The schema as stock serializes it for the provider (Ark/legacy schemas do not stringify as is).
			if (!tool) break;
			const { toolWireSchema } = await import("./omp/pi-ai/utils/schema");
			return capPreview(`${tool.description ?? ""}\n\n${JSON.stringify(toolWireSchema(tool), null, 2)}`);
		}
		case "deferred": {
			const mounted = mountedToolEntries(session).find(candidate => candidate.name === key);
			if (mounted) return capPreview(mounted.summary ?? "");
			break;
		}
		case "msg": {
			const [index, timestamp] = key.split(":");
			const message = session.agent.state.messages[Number(index)];
			if (!message || String(messageTimestamp(message)) !== timestamp) break;
			const { convertToLlm } = await import("./omp/pi-coding-agent/session/messages");
			return capPreview(llmMessagesText(convertToLlm([message])));
		}
	}
	throw new Error(`context_entry: ${id} is no longer in the context`);
}

// One guard per action (capabilities.ts): a missing internal refuses only the methods that use it.
export const methods: BridgeMethods = {
	...guard("contextInspector", {
		/** `{entries?: boolean}` (default true): every entry of the live context with its estimated tokens, plus stock's anchored totals. */
		"context.inspect": async (params, env) =>
			inspect(
				env.session(),
				!(typeof params === "object" && params !== null && "entries" in params && params.entries === false),
			),
	}),
	...guard("contextEntry", {
		/** `{id}` from `context.inspect` → the entry's text as the provider gets it, capped at 32k characters. */
		"context.entry": async (params, env) => {
			const id = typeof params === "object" && params !== null && "id" in params ? params.id : undefined;
			if (typeof id !== "string" || !id.includes(":")) throw new Error("context.entry needs {id: string}");
			return preview(env.session(), id);
		},
	}),
};
