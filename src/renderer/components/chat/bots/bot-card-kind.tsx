/**
 * Which transcript entries draw as a bot card (`BotCards.tsx`, its own chunk so the phone's first screen stays in its
 * budget), and the lazy entries ToolCard and MessageBubble render.
 */
import { Suspense, useEffect } from "react";
import { AGENT_CONTROL_TOOLS } from "../../../../shared/agent-control";
import type { AgentMessage } from "../../../../shared/rpc-types";
import { lazyChunk } from "../../../lib/chunk-load";
import { resultDetails } from "../../../lib/format";
import { botOfFolder, useBotsStore } from "../../../stores/bots";
import { useTabsStore } from "../../../stores/tabs";
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

/** The owner's item changes the core mailed into a bot chat (`item-<id>-v<version>`). */
export function isItemMail(message: AgentMessage): boolean {
	const details = resultDetails(message);
	return text(details?.from) === "ompdesk" && text(details?.id).startsWith("item-");
}

export function useCardHidden(kind: BotCardKind | null): boolean {
	const card = kind !== null;
	useEffect(() => {
		if (card) void ensureHiddenCards().catch(() => {});
	}, [card]);
	return useHiddenCards(s => kind !== null && s.hidden.includes(kind));
}

/** Whether the tab runs in a bot's folder: its NO_REPLY turns fold (`QuietReply`). */
export function useBotChat(tabId: string | null): boolean {
	const cwd = useTabsStore(s => (tabId ? s.tabs.find(tab => tab.id === tabId)?.cwd : undefined));
	return useBotsStore(s => botOfFolder(s.state.bots, cwd) !== undefined);
}

const LazyBotToolCard = lazyChunk(() => import("./BotCards").then(module => ({ default: module.BotToolCard })));
const LazyItemNote = lazyChunk(() => import("./BotCards").then(module => ({ default: module.ItemNote })));
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

export function ItemNote({ message }: { message: AgentMessage }) {
	const hidden = useCardHidden("itemNotes");
	if (hidden) return null;
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
