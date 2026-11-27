/**
 * Which transcript entries draw as a bot card (`BotCards.tsx`, its own chunk so the phone's first screen stays in its
 * budget), and the lazy entries ToolCard and MessageBubble render.
 */
import { createContext, Suspense, useEffect } from "react";
import { AGENT_CONTROL_TOOLS } from "../../../../shared/agent-control";
import type { AgentMessage } from "../../../../shared/rpc-types";
import { lazyChunk } from "../../../lib/chunk-load";
import { resultDetails } from "../../../lib/format";
import { botOfFolder, botOfSession, useBotsStore } from "../../../stores/bots";
import { useTabsStore } from "../../../stores/tabs";
import { selectToolEntry, toolEntryKey, useToolsStore } from "../../../stores/tools";
import { type ChatCardKind, ensureHiddenCards, useHiddenCards } from "./hidden-cards";

export type BotCardKind = ChatCardKind;

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** `bot:<name>[@device]` a send or a report names, else null. */
export function botTarget(toolName: string, args: Record<string, unknown>): { name: string; device?: string } | null {
	const named =
		toolName === AGENT_CONTROL_TOOLS.report
			? [text(args.to)]
			: toolName === AGENT_CONTROL_TOOLS.send
				? [text(args.session), ...(Array.isArray(args.sessions) ? args.sessions.map(text) : [])]
				: [];
	const match = named.map(each => /^bot:([^@]+)(?:@(.+))?$/.exec(each)).find(Boolean);
	if (!match) return null;
	return { name: match[1].trim(), ...(match[2] ? { device: match[2].trim() } : {}) };
}

/** The card kind a tool call draws as, or null for an ordinary tool row. */
export function botCardOf(toolName: string, args: Record<string, unknown>): BotCardKind | null {
	switch (toolName) {
		case AGENT_CONTROL_TOOLS.item:
			return ["add", "set", "comment", "done", "cancel", "link"].includes(text(args.action)) ? "itemNotes" : null;
		case AGENT_CONTROL_TOOLS.bot:
			return args.action === "offer" ? "botOffers" : null;
		case AGENT_CONTROL_TOOLS.send:
		case AGENT_CONTROL_TOOLS.report:
			return botTarget(toolName, args) ? "botRequests" : null;
		case AGENT_CONTROL_TOOLS.app:
			return args.action === "extensions.install_mcp" ? "toolsAdded" : null;
		default:
			return null;
	}
}

/**
 * Mail the cards' chunk draws: the owner's item changes the core mailed into a bot chat (`item-<id>-v<version>`), and
 * whatever a bot's chat sent (`fromBot`).
 */
export function isBotMail(message: AgentMessage): boolean {
	const details = resultDetails(message);
	return (text(details?.from) === "ompdesk" && text(details?.id).startsWith("item-")) || !!text(details?.fromBot);
}

export function useCardHidden(kind: BotCardKind | null): boolean {
	const card = kind !== null;
	useEffect(() => {
		if (card) void ensureHiddenCards().catch(() => {});
	}, [card]);
	return useHiddenCards(s => kind !== null && s.hidden.includes(kind));
}

/** A recorded chat remains the bot's after a folder rename. */
export function useBotChat(tabId: string | null): boolean {
	const tab = useTabsStore(s => s.tabs.find(entry => entry.id === tabId));
	return useBotsStore(
		s =>
			!!tab &&
			!!(
				botOfSession(s.state.bots, tab.sessionPath ?? tab.pendingSessionPath, tab.device) ??
				botOfFolder(s.state.bots, tab.cwd, tab.device)
			),
	);
}

const LazyBotToolCard = lazyChunk(() => import("./BotCards").then(module => ({ default: module.BotToolCard })));
const LazyItemNote = lazyChunk(() => import("./BotCards").then(module => ({ default: module.BotNote })));
const LazyQuietReply = lazyChunk(() => import("./BotCards").then(module => ({ default: module.QuietReply })));

export function BotToolCard(props: {
	kind: BotCardKind;
	toolName: string;
	args: Record<string, unknown>;
	result: unknown;
	failed: boolean;
}) {
	return (
		<Suspense fallback={null}>
			<LazyBotToolCard {...props} />
		</Suspense>
	);
}

/**
 * Set inside a work run: its tool rows stay rows there, since the run's bot cards show under it (`RunBotCards`), where
 * Create bot or Sign in is seen without opening the run.
 */
export const BotCardsInRun = createContext(false);

/** A finished run's bot cards, in call order, under the run. */
export function RunBotCards({ messages }: { messages: readonly AgentMessage[] }) {
	const calls = messages.flatMap(message =>
		message.role === "assistant" && Array.isArray(message.content)
			? message.content.flatMap(block =>
					block.type === "toolCall" && botCardOf(block.name, block.arguments ?? {}) ? [block] : [],
				)
			: [],
	);
	if (calls.length === 0) return null;
	return (
		<div className="flex flex-col" data-run-bot-cards>
			{calls.map(call => (
				<RunBotCard args={call.arguments ?? {}} entryKey={toolEntryKey(call)} key={call.id} toolName={call.name} />
			))}
		</div>
	);
}

function RunBotCard({
	entryKey,
	toolName,
	args,
}: {
	entryKey: string;
	toolName: string;
	args: Record<string, unknown>;
}) {
	const entry = useToolsStore(s => selectToolEntry(s, entryKey));
	const kind = botCardOf(toolName, args);
	const hidden = useCardHidden(kind);
	if (!kind || hidden || !entry || (entry.status !== "done" && entry.status !== "error")) return null;
	const failed = entry.status === "error" || Boolean(entry.isError);
	if (failed && kind !== "botRequests") return null;
	return <BotToolCard args={args} failed={failed} kind={kind} result={entry.result} toolName={toolName} />;
}

/**
 * A note the app mailed into a bot's chat, drawn in the cards' own chunk (the phone's first screen stays in budget):
 * the owner's item changes, a run result (Orca's `bot-automation-result-note.ts`), or else the plain mail note. Each
 * kind's Hide is read there.
 */
export function ItemNote({ message }: { message: AgentMessage }) {
	return (
		<Suspense fallback={null}>
			<LazyItemNote message={message} />
		</Suspense>
	);
}

export function QuietReply({ text: words }: { text: string }) {
	const hidden = useCardHidden("quietRuns");
	if (hidden) return null;
	return (
		<Suspense fallback={null}>
			<LazyQuietReply text={words} />
		</Suspense>
	);
}
