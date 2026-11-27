import type { StoreApi } from "zustand/vanilla";
import { CREDIT_SPEND_OFF_WORDING } from "../../shared/credit-spend";
import { anthropicSpendRefusal, isBillingCap } from "../../shared/quota-reset";
import type {
	AgentMessage,
	ImageContent,
	RpcAbortAndRestoreQueueResult,
	RpcForkFromResult,
	RpcResponse,
	RpcRestoredQueuedMessage,
	RpcSessionTreeNode,
	RpcSessionTreeResult,
	StopSurface,
} from "../../shared/rpc-types";
import { draftKeys, saveDraft } from "../components/layout/composer/draft-persistence";
import { hydrateSession, resetRetryPending } from "../hooks/use-rpc-events";
import { type ComposerImage, type ComposerStore, DOUBLE_ESC_MS, useComposerStore } from "../stores/composer";
import { useMessagesStore } from "../stores/messages";
import { type SessionStore, useSessionStore } from "../stores/session";
import { focusedRuntimeTabId, sessionRuntimeStore, withSessionRuntime } from "../stores/session-runtime-context";
import { ensureTabRuntime } from "../stores/tab-runtime";
import { useTabsStore } from "../stores/tabs";
import { toast, toastError } from "../stores/toast";
import { endAutoGoal } from "./auto-mode-client";
import { withCompactionRun } from "./compaction-action";
import { translate } from "./i18n";
import { promptDisplayText } from "./prompt-text";
import { IMAGE_ONLY_CHIP } from "./queue-chip";
import type { TabRpc } from "./tab-rpc";

/**
 * Message-level actions shared between the command palette and the global
 * keyboard shortcuts (App.tsx), so both ride the same retry semantics.
 */

/**
 * Display-worthy model text. Punctuation/whitespace-only fragments (".",
 * "…", "---") are provider/model filler between tool calls, while letters,
 * numbers, and emoji are user-visible content in any script.
 */
const MESSAGE_TEXT_CONTENT_CHAR = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;
export function isRenderableMessageText(text: string): boolean {
	return MESSAGE_TEXT_CONTENT_CHAR.test(text);
}

const REACTION_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const REACTION_GRAPHEME_RE = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3)/u;
const NEXT_REACTION_WHITESPACE_RE = /^[ \t]*\r?\n|^[ \t]+/;

/** Match the TUI contract: an opening emoji reacts to the preceding user bubble. */
export function splitReaction(text: string): { emoji?: string; body: string } {
	const head = text.trimStart();
	const emoji = REACTION_SEGMENTER.segment(head)[Symbol.iterator]().next().value?.segment;
	if (!emoji || !REACTION_GRAPHEME_RE.test(emoji)) return { body: text };
	const rest = head.slice(emoji.length);
	const whitespace = rest.match(NEXT_REACTION_WHITESPACE_RE)?.[0].length ?? 0;
	return { emoji, body: rest.slice(whitespace) };
}
/** Plain-text content of a message (user text lives in text blocks). */
export function messageText(message: AgentMessage): string {
	if (typeof message.content === "string") return message.content.trim();
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter(part => part.type === "text")
		.map(part => (part.type === "text" ? part.text : ""))
		.join("\n")
		.trim();
}

/** `messageText` for a person: a user message's agent-message wrapper is replaced by its body. */
export function messageDisplayText(message: AgentMessage): string {
	const text = messageText(message);
	return message.role === "user" ? promptDisplayText(text) : text;
}

function messagePreview(message: AgentMessage): string {
	const text = messageText(message).replace(/\s+/g, " ").trim();
	return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/**
 * Retry the last turn: re-send the most recent user message, interrupting the
 * active turn when streaming (TUI app.retry parity). `onEmpty` fires when the
 * session has no user message to retry; RPC failures throw for the caller to
 * surface. Pass the pane's `rpc` and `tabId` (an inline error card in a split
 * view) so the retry reads and targets that session, not the focused one.
 */
export async function retryLastTurn(
	onEmpty: () => void,
	rpc: Pick<TabRpc, "prompt" | "abortAndPrompt"> = window.omp.rpc,
	tabId?: string | null,
): Promise<void> {
	const snapshot = () => ({
		messages: useMessagesStore.getState().messages,
		streaming: useSessionStore.getState().isStreaming,
	});
	const { messages, streaming } = tabId ? withSessionRuntime(tabId, snapshot) : snapshot();
	const lastUser = [...messages].reverse().find(message => message.role === "user");
	const text = lastUser ? messageText(lastUser) : "";
	if (!text) {
		onEmpty();
		return;
	}
	const response = streaming ? await rpc.abortAndPrompt(text, { surface: "retry" }) : await rpc.prompt(text);
	if (!response.success) throw new Error(response.error);
}

export type TurnErrorKind =
	| "aborted"
	| "certificate"
	| "timeout"
	| "connection"
	| "contextOverflow"
	| "auth"
	| "creditsOff"
	| "modelUnavailable"
	| "rateLimit"
	| "billing"
	| "lowCredit"
	| "spendLimit"
	| "overloaded"
	| "compaction"
	| "unknown";

/** Recovery offered next to a failed turn, fixing action first. */
export type TurnErrorAction = "retry" | "changeModel" | "openProviders" | "compact";

export interface TurnErrorDescription {
	kind: TurnErrorKind;
	/** i18n key of the ≤4-word title. */
	titleKey: string;
	/** i18n key of the one-sentence guidance (what happened + what to do). */
	guidanceKey: string;
	actions: readonly TurnErrorAction[];
	/** Raw provider text, kept for a collapsible detail; "" when there is none. */
	detail: string;
}

const TURN_ERROR_ACTIONS: Record<TurnErrorKind, readonly TurnErrorAction[]> = {
	aborted: [],
	certificate: ["retry", "openProviders"],
	timeout: ["retry", "changeModel"],
	connection: ["retry", "openProviders"],
	contextOverflow: ["compact", "changeModel"],
	auth: ["openProviders", "changeModel"],
	// Trying again only meets the same refusal: the ways on are the switch (Models & accounts) or another model.
	creditsOff: ["openProviders", "changeModel"],
	modelUnavailable: ["changeModel", "openProviders"],
	rateLimit: ["retry", "changeModel"],
	billing: ["openProviders", "changeModel"],
	lowCredit: ["openProviders", "changeModel"],
	spendLimit: ["openProviders", "changeModel"],
	overloaded: ["retry", "changeModel"],
	compaction: ["changeModel", "retry"],
	unknown: ["retry", "changeModel"],
};

/** An HTTP status only counts at the start or right after a status/code/HTTP/error word — never inside "8,403 tokens". */
function statusPattern(codes: string): RegExp {
	return new RegExp(String.raw`(?:^|\b(?:status|code|http|error)\b\W{0,3}|\()(?:${codes})\b`, "i");
}

/**
 * First match wins, so the order resolves overlaps: a compaction failure
 * mentions "context", and a 429 can mention tokens per minute.
 */
const TURN_ERROR_PATTERNS: ReadonlyArray<readonly [Exclude<TurnErrorKind, "unknown">, readonly RegExp[]]> = [
	["aborted", [/request was aborted|operation was aborted|aborted by (?:the )?user|\babort ?error\b/i]],
	["compaction", [/compaction freed too little|compaction failed|failed to compact|could not compact/i]],
	// Before `rateLimit`: the bridge's refusal is worded as a usage limit too (the limit wait reads that).
	["creditsOff", [CREDIT_SPEND_OFF_WORDING]],
	["rateLimit", [statusPattern("429"), /rate[ _-]?limit|too many requests|quota|usage limit|insufficient_quota/i]],
	[
		"contextOverflow",
		[
			/prompt is too long|context[ _-](?:length|window)|maximum context|too many tokens|context_length_exceeded/i,
			/input is too long|exceeds? the (?:model'?s? )?(?:context|maximum)/i,
		],
	],
	[
		"auth",
		[
			statusPattern("401|403"),
			/invalid[ _-]?(?:x-)?api[ _-]?key|unauthori[sz]ed|authentication|\bforbidden\b/i,
			/no api key|api key (?:is )?(?:missing|not found|invalid)/i,
			/no models available|no (?:default )?model selected|not logged in|log ?in required|token (?:has )?expired/i,
		],
	],
	[
		"overloaded",
		[statusPattern("502|503|529"), /overloaded|service unavailable|temporarily unavailable|over capacity/i],
	],
	// The provider does not serve the model asked for (renamed, retired, not on this plan or region).
	[
		"modelUnavailable",
		[
			statusPattern("404"),
			/model_not_found|not_found_error|unknown model|invalid model/i,
			/\bmodels?\b[^.\n]{0,80}\b(?:not found|does not exist|doesn't exist|is not available|unavailable|not supported)\b/i,
		],
	],
	[
		"certificate",
		[
			/certificate|self[- ]signed|unable to verify the first|unable_to_(?:verify|get)_issuer|ssl|\btls\b|err_tls/i,
			/cert_has_expired|depth_zero_self_signed|err_cert/i,
		],
	],
	// A request that reached the provider and then ran out of time (a refused or
	// unresolved host is `connection`, below).
	["timeout", [/timed? ?out|timeout|etimedout|deadline exceeded/i]],
	[
		"connection",
		[
			/unable to connect|econnrefused|econnreset|enotfound|eai_again|getaddrinfo|fetch failed/i,
			/network ?error|socket hang up|connection (?:refused|reset|closed|error|failed)/i,
		],
	],
];

/**
 * Humanize a failed or stopped turn: what kind of failure it was, a localized
 * title + one-sentence guidance (as i18n keys), and the recovery actions that
 * apply. Pure — the transcript error card, the turn-failed toast and the
 * compaction notice all read the same answer. A user abort is `aborted`
 * (rendered as a neutral "Stopped", never as an error).
 */
export function describeTurnError(errorMessage: string | undefined, stopReason?: string): TurnErrorDescription {
	const detail = (errorMessage ?? "").trim();
	let kind: TurnErrorKind = stopReason === "aborted" ? "aborted" : "unknown";
	if (kind === "unknown" && detail) {
		kind = TURN_ERROR_PATTERNS.find(([, patterns]) => patterns.some(pattern => pattern.test(detail)))?.[0] ?? kind;
		if (kind === "rateLimit" || kind === "unknown") {
			kind = anthropicSpendRefusal(detail) ?? (isBillingCap(detail) ? "billing" : kind);
		}
	}
	return {
		kind,
		titleKey: `turnError.${kind}.title`,
		guidanceKey: `turnError.${kind}.guidance`,
		actions: TURN_ERROR_ACTIONS[kind],
		detail,
	};
}

/** Toast copy for a failed turn or compaction: humanized title + guidance, never raw provider English alone. */
export function turnErrorToast(
	errorMessage: string | undefined,
	stopReason?: string,
): { title: string; message: string; kind: TurnErrorKind } {
	const description = describeTurnError(errorMessage, stopReason);
	return {
		kind: description.kind,
		title: translate(description.titleKey),
		message: translate(description.guidanceKey),
	};
}

function isRestoredEntry(value: unknown): value is RpcRestoredQueuedMessage {
	if (typeof value !== "object" || value === null || !("text" in value) || typeof value.text !== "string")
		return false;
	return !("images" in value) || value.images === undefined || Array.isArray(value.images);
}

function isRestoreResult(value: unknown): value is RpcAbortAndRestoreQueueResult {
	return (
		typeof value === "object" &&
		value !== null &&
		"steering" in value &&
		"followUp" in value &&
		Array.isArray(value.steering) &&
		Array.isArray(value.followUp) &&
		value.steering.every(isRestoredEntry) &&
		value.followUp.every(isRestoredEntry)
	);
}

/**
 * Put the input `abort_and_restore_queue` withdrew back where the user can see it. With a tray that shows
 * `composer.restoredQueue` mounted (ComposerRestoredQueue) each message stays its own held item, apart from the
 * draft: nothing runs until the user resumes it, edits it or removes it (the queue is paused, never auto-released).
 * Without one it comes back the way the TUI's Esc does: steers then follow-ups, oldest first, joined by blank
 * lines, ahead of any draft (kept after a blank line); images join the strip; one toast says so. `kept`: the messages
 * come from an omp that ended (`takeHeldQueue`), not from a Stop.
 */
export function restoreAbortedQueue(
	composer: ComposerStore,
	restored: RpcAbortAndRestoreQueueResult,
	kept = false,
): void {
	const entries = [
		...restored.steering.map(entry => ({ lane: "steering" as const, entry })),
		...restored.followUp.map(entry => ({ lane: "followUp" as const, entry })),
	];
	if (entries.length === 0) return;
	const toImages = (contents: ImageContent[] | undefined): ComposerImage[] =>
		(contents ?? []).map(content => ({ content, preview: `data:${content.mimeType};base64,${content.data}` }));
	const items = entries.map(({ lane, entry }) => ({
		lane,
		text: entry.text === IMAGE_ONLY_CHIP && entry.images?.length ? "" : entry.text,
		images: toImages(entry.images),
		...(kept ? { kept } : {}),
	}));
	if (composer.restoredTrayMounted > 0) {
		composer.holdRestored(items);
	} else {
		const queuedText = items
			.map(item => item.text)
			.filter(text => text.trim())
			.join("\n\n");
		if (queuedText) composer.setDraft(current => [queuedText, current].filter(text => text.trim()).join("\n\n"));
		const images = items.flatMap(item => item.images);
		if (images.length > 0) composer.setImages(current => [...current, ...images]);
	}
	if (restored.truncated) toast({ variant: "warning", message: translate("input.queueRestore.truncated") });
	else if (restored.imagesDropped) {
		toast({ variant: "warning", message: translate("input.queueRestore.imagesDropped") });
	} else if (composer.restoredTrayMounted === 0) {
		toast({
			variant: "info",
			message: translate("input.queueRestore.merged", {
				count: items.length,
			}),
		});
	}
}

/**
 * The tab's queued messages the core kept when the omp holding them went (a crash, a restart, a quit, a closed tab:
 * core `sidecar/held_queue.rs`), taken once into this tray: the core hands each kept queue to the first taker only, so
 * another window or device, a late exit or the next relaunch never offers it again. Nothing is sent by itself.
 */
export async function takeHeldQueue(
	rpc: Pick<TabRpc, "command">,
	composer: Pick<StoreApi<ComposerStore>, "getState">,
): Promise<void> {
	const response = await rpc.command({ type: "queue_take_held" });
	if (response.success && isRestoreResult(response.data))
		restoreAbortedQueue(composer.getState(), response.data, true);
}

/** The composers whose held messages are being resumed: a second Resume (the tray's, ⌘↵) meanwhile sends nothing. */
const resumingQueues = new WeakSet<object>();

/**
 * Resume what a Stop held: the first message starts the turn again (a follow-up behaviour, so it queues instead
 * when another device's turn already runs), the rest queue behind it as follow-ups, in order. Each leaves the held
 * list once omp accepted it; a refusal keeps it and the ones after it held and says why. One resume runs per tab at a
 * time: a held message leaves the list only once omp took it, so a second one meanwhile would send it again.
 */
export async function resumeRestoredQueue(
	rpc: Pick<TabRpc, "prompt" | "followUp"> = window.omp.rpc,
	tabId?: string | null,
): Promise<void> {
	const composer = (tabId ? sessionRuntimeStore<ComposerStore>(tabId, "composer") : null) ?? useComposerStore;
	if (resumingQueues.has(composer)) return;
	resumingQueues.add(composer);
	try {
		const held = composer.getState().restoredQueue;
		for (const [index, item] of held.entries()) {
			const images = item.images.length > 0 ? item.images.map(image => image.content) : undefined;
			try {
				const response =
					index === 0 ? await rpc.prompt(item.text, images, "followUp") : await rpc.followUp(item.text, images);
				if (!response.success) {
					toastError({ title: translate("input.sendFailed"), error: response });
					return;
				}
			} catch (error) {
				toastError({ title: translate("input.sendFailed"), error });
				return;
			}
			composer.getState().dropRestored(item.id);
		}
	} finally {
		resumingQueues.delete(composer);
	}
}

/**
 * Stock's no-op answers to a manual compaction (`ManualCompactionNoOpError` in pi-coding-agent
 * `session/session-maintenance.ts`: too small, already compacted, the session is switching). The RPC answer carries
 * only the message, so it is read from there; Orca reads the same reply (`src/main/pi/rpc/rpc-compaction.ts:68`).
 */
const COMPACTION_NO_OP = /^(?:Nothing to compact\b|Already compacted\b|Conversation is changing; cannot compact\b)/;

/** True when a failed `compact` answer is stock's "nothing to compact", which is no failure. */
export function isCompactionNoOp(response: RpcResponse): boolean {
	return !response.success && COMPACTION_NO_OP.test(response.error ?? "");
}

/**
 * Manual `/compact` and handoff started here: the tab's status row (Esc, Cancel) stands here for as long as the
 * request runs (`local`, so stock's `manual_compaction_*` events, which every window hears, leave it to this one). The
 * tab's store is bound before the await, so a tab switch meanwhile leaves every other tab's row alone. `cancelled`
 * says the reader stopped it (Esc or Cancel), so its failure is no error; `skipped` that there was nothing to compact,
 * already said here as a notice, so it is no failure either.
 */
export async function runManualMaintenance(
	action: "compact" | "handoff",
	request: () => Promise<RpcResponse>,
	tabId?: string | null,
): Promise<{ response: RpcResponse; cancelled: boolean; skipped: boolean }> {
	const session = sessionRuntimeStore<SessionStore>(tabId ?? focusedRuntimeTabId(), "session") ?? useSessionStore;
	session.setState({
		isCompacting: true,
		compactionInfo: { reason: "manual", action, startedAt: Date.now(), local: true },
	});
	try {
		const response = await request();
		const info = session.getState().compactionInfo;
		const cancelled = info?.cancelling === true;
		const skipped = !cancelled && action === "compact" && isCompactionNoOp(response);
		if (skipped && !response.success)
			toast({ variant: "info", message: translate("command.compactNothing"), detail: response.error });
		// A handoff leaves no compaction card and is no measure of the next compaction.
		if (action === "compact" && response.success && !cancelled)
			session.setState({ compactionRuns: withCompactionRun(session.getState().compactionRuns, info) });
		return { response, cancelled, skipped };
	} finally {
		if (session.getState().compactionInfo?.reason === "manual")
			session.setState({ isCompacting: false, compactionInfo: null });
	}
}

/** A Stop's guard against a second Stop never outlives this: a lost `agent_end` must not leave the button dead. */
const STOP_SETTLE_MS = 10_000;

/**
 * Hold `stopping` until the stopped turn has ended (or the cap), so a second click or Esc for it sends nothing. A turn
 * still running at the cap is said out loud: omp confirmed the Stop, but the run has not ended on screen.
 */
function releaseStoppingWhenTurnEnds(composer: ComposerStore, session: StoreApi<SessionStore>): void {
	if (!session.getState().isStreaming) {
		composer.setStopping(false);
		return;
	}
	let unsubscribe = () => {};
	const done = (ended: boolean) => {
		unsubscribe();
		clearTimeout(cap);
		composer.setStopping(false);
		if (!ended) toast({ variant: "warning", message: translate("input.stopNotEnded") });
	};
	const cap = setTimeout(() => done(!session.getState().isStreaming), STOP_SETTLE_MS);
	unsubscribe = session.subscribe(state => {
		if (!state.isStreaming) done(true);
	});
}

/**
 * Stop the active turn the way the TUI's Esc does: stock withdraws the queued
 * user input before aborting (`abort_and_restore_queue`), so nothing queued
 * runs afterwards, and it comes back into this tab's composer (`restoreAbortedQueue`:
 * held apart for a tray that shows it, else merged into the draft). Any live retry
 * UI retires synchronously first. A manual /compact or handoff is cancelled
 * through `abort_maintenance` instead: stock's serial queue would hold a plain
 * abort until it finished on its own. A goal the automatic choice started ends
 * with the stopped turn (lib/auto-mode-client.ts). One Stop is in flight per turn
 * (`composer.stopping`, until the turn ends): a double click or a double Esc sends one command.
 *
 * What became of the Stop is said, never left to a click that did nothing (Orca's separate stop target and outcome,
 * MapGapB N70): omp refusing it is an error toast, and a Stop whose answer never came (a dropped link, a timeout) is
 * a warning that it may not have stopped; neither throws, so every `void` caller is covered. The turn stays shown as
 * running either way and Stop works again at once.
 */
export async function abortActiveTurn(
	rpc: Pick<TabRpc, "abortAndRestoreQueue" | "abortRetry" | "abortMaintenance"> &
		Partial<Pick<TabRpc, "autoModeEnd">> = window.omp.rpc,
	tabId?: string | null,
	/** The control the user stopped with; main logs it (src/main/turn-stop-log.ts). */
	surface?: StopSurface,
): Promise<RpcResponse> {
	// Bind the composer before any await: the user may switch tabs meanwhile.
	const composer =
		(tabId ? sessionRuntimeStore<ComposerStore>(tabId, "composer")?.getState() : undefined) ??
		useComposerStore.getState();
	const session = sessionRuntimeStore<SessionStore>(tabId ?? focusedRuntimeTabId(), "session") ?? useSessionStore;
	// A prompt still waiting on the automatic mode choice has not reached omp: it is withdrawn (its
	// draft comes back, use-composer-submit.ts) and nothing runs that could be stopped.
	if (composer.cancelSubmit?.()) return { type: "response", command: "abort", success: true };
	const maintenance = session.getState().compactionInfo;
	if (maintenance?.reason === "manual") {
		session.setState({ compactionInfo: { ...maintenance, cancelling: true } });
		return rpc.abortMaintenance();
	}
	if (composer.stopping) return { type: "response", command: "abort", success: true };
	composer.setStopping(true);
	try {
		const retrying = session.getState().retryInfo !== null;
		if (retrying) {
			resetRetryPending(tabId ?? undefined);
			session.setState({ retryInfo: null, awaitingModelSince: null });
			try {
				await rpc.abortRetry();
			} catch {
				// Generic abort below also cancels retry server-side.
			}
		}
		let response: RpcResponse;
		try {
			response = await rpc.abortAndRestoreQueue({ surface });
		} catch (error) {
			composer.setStopping(false);
			toastError({ title: translate("input.stopUnconfirmed"), error, variant: "warning" });
			return { type: "response", command: "abort_and_restore_queue", success: false, error: String(error) };
		}
		if (!response.success) {
			composer.setStopping(false);
			toastError({ title: translate("input.stopRefused"), error: response });
			return response;
		}
		if (isRestoreResult(response.data)) restoreAbortedQueue(composer, response.data);
		// A goal the automatic choice started for one request ends when the user stops it.
		if (rpc.autoModeEnd) await endAutoGoal(session, { autoModeEnd: rpc.autoModeEnd });
		releaseStoppingWhenTurnEnds(composer, session);
		return response;
	} catch (error) {
		composer.setStopping(false);
		throw error;
	}
}

/**
 * Esc, as the window-level handler reads it. While a turn runs and the field holds a draft (text or pictures) the
 * first Esc only arms ("Press Esc again to stop", `composer.stopArmedAt`, `DOUBLE_ESC_MS`): a stray Esc never
 * kills a turn with an unsent draft. With an empty field, no running turn, or a second Esc inside the window, it
 * stops the turn (`abortActiveTurn`). The Stop button never asks twice: clicking it is deliberate.
 */
export function stopFromEscape(now = Date.now()): "armed" | "stopping" {
	const composer = useComposerStore.getState();
	const running = (sessionRuntimeStore<SessionStore>(focusedRuntimeTabId(), "session") ?? useSessionStore).getState()
		.isStreaming;
	const holdsDraft = composer.draft.trim() !== "" || composer.pictureSlots.length > 0;
	const armed = composer.stopArmedAt !== null && now - composer.stopArmedAt < DOUBLE_ESC_MS;
	if (running && holdsDraft && !armed) {
		composer.armStop(now);
		return "armed";
	}
	composer.disarmStop();
	void abortActiveTurn(undefined, undefined, "esc");
	return "stopping";
}

/** Branch from a user entry, restoring its draft and refreshing the session. */
export async function branchSessionFromEntry(entryId: string): Promise<"branched" | "cancelled"> {
	const response = await window.omp.rpc.branch(entryId);
	if (!response.success) throw new Error(response.error);
	const data = response.data as { cancelled?: boolean; text?: string } | undefined;
	if (data?.cancelled) return "cancelled";
	if (data?.text !== undefined) {
		window.dispatchEvent(new CustomEvent("omp:fill-composer", { detail: { text: data.text } }));
	}
	await hydrateSession();
	return "branched";
}

/**
 * File a branch's prompt (fork_from's `draft`: a branch from a prompt ends before it) as the new session's saved
 * draft (draft-persistence.ts), so its composer shows it whenever and in whichever window that session opens.
 * Only its text is filed here.
 */
export function fileBranchDraft(result: RpcForkFromResult, device: string | undefined): void {
	const keys = draftKeys({ device, sessionFile: result.sessionPath, empty: false });
	if (!keys || !result.draft?.text.trim()) return;
	try {
		if (typeof localStorage !== "undefined") saveDraft(localStorage, keys, result.draft.text);
	} catch {
		// A page without storage: the prompt is still in the session it was branched from.
	}
}

/** Copy the tree path through one message into an independent session and open it in a new tab. */
export async function forkSessionFromEntryInNewTab(
	entryId: string,
	sourceTabId = useTabsStore.getState().activeTabId,
	rpc: Pick<TabRpc, "forkFrom"> = window.omp.rpc,
): Promise<"opened" | "saved"> {
	const tabs = useTabsStore.getState();
	if (!sourceTabId || tabs.activeTabId !== sourceTabId || useSessionStore.getState().switchPending !== null) {
		throw new Error("The active session changed while preparing the branch");
	}
	const sourceTab = tabs.tabs.find(tab => tab.id === sourceTabId);
	if (!sourceTab) throw new Error("The source session is no longer open");
	const response = await rpc.forkFrom(entryId);
	if (!response.success) throw new Error(response.error);
	const data = response.data as RpcForkFromResult | undefined;
	if (!data?.sessionPath) throw new Error("fork_from did not return a session path");
	fileBranchDraft(data, sourceTab.device);
	if (useTabsStore.getState().activeTabId !== sourceTabId || useSessionStore.getState().switchPending !== null) {
		return "saved";
	}
	const tabId = await useTabsStore.getState().openTab({
		cwd: sourceTab.cwd,
		sessionPath: data.sessionPath,
		kind: sourceTab.kind,
	});
	if (!tabId) return "saved";
	// The new tab's composer takes the prompt at once, with its pictures (a saved draft keeps only text).
	if (data.draft) {
		ensureTabRuntime(tabId);
		const composer = sessionRuntimeStore<ComposerStore>(tabId, "composer")?.getState();
		composer?.setDraft(data.draft.text);
		composer?.setImages(
			data.draft.images.map(content => ({ content, preview: `data:${content.mimeType};base64,${content.data}` })),
		);
	}
	return "opened";
}

/** Resolve legacy transcript messages through the active OMP session tree, then fork them. */
export async function forkSessionFromMessageInNewTab(
	message: AgentMessage,
	rpc: Pick<TabRpc, "forkFrom" | "getSessionTree"> = window.omp.rpc,
	sourceTabId = useTabsStore.getState().activeTabId,
): Promise<"opened" | "saved"> {
	if (!sourceTabId || useSessionStore.getState().switchPending !== null) {
		throw new Error("The active session changed while preparing the branch");
	}
	let entryId = message.entryId;
	if (!entryId) {
		const response = await rpc.getSessionTree();
		if (!response.success) throw new Error(response.error);
		const data = response.data as RpcSessionTreeResult | undefined;
		const timestamp =
			typeof message.timestamp === "number" ? message.timestamp : Date.parse(message.timestamp ?? "") || 0;
		const candidates = (data?.tree ?? []).filter(
			(node: RpcSessionTreeNode) => node.onActiveBranch && node.role === message.role,
		);
		const timestampMatches = timestamp === 0 ? [] : candidates.filter(node => node.timestamp === timestamp);
		if (timestampMatches.length === 1) entryId = timestampMatches[0]?.entryId;
		const preview = messagePreview(message);
		const previewMatches = candidates.filter(node => node.textPreview === preview);
		if (!entryId && previewMatches.length === 1) entryId = previewMatches[0]?.entryId;
		if (!entryId && previewMatches.length > 1) {
			const transcript = useMessagesStore.getState().messages;
			const targetIndex = transcript.indexOf(message);
			if (targetIndex >= 0) {
				let occurrence = 0;
				for (let index = 0; index < targetIndex; index++) {
					const candidate = transcript[index];
					if (candidate?.role === message.role && messagePreview(candidate) === preview) occurrence++;
				}
				entryId = previewMatches[occurrence]?.entryId;
			}
		}
	}
	if (!entryId) throw new Error("Could not locate this message in the active session tree");
	return forkSessionFromEntryInNewTab(entryId, sourceTabId, rpc);
}

/** The queued steer/follow-up message pulled back by the dequeue RPC. */
interface DequeuedMessage {
	text: string;
	images?: ImageContent[];
}

/**
 * Restore a queued message into the composer (TUI app.message.dequeue / Alt+Up
 * parity): the RPC pops the last queued steer (else follow-up) with its
 * attachments and leaves the rest queued; it goes back into the composer for
 * editing — text prepended ahead of any draft, images appended to the image
 * strip. `onEmpty` fires when nothing was queued; RPC failures throw for the
 * caller to surface.
 */
export async function restoreQueuedMessages(onEmpty: () => void): Promise<void> {
	// The tab that asked, taken now: focus can move while the RPC runs, and on a shared tab the popped
	// message may be another device's — it still goes back into the composer of the window that asked.
	const askedTabId = focusedRuntimeTabId() ?? useTabsStore.getState().activeTabId;
	const response = await window.omp.rpc.dequeue();
	if (!response.success) throw new Error(response.error);
	const data = response.data as { messages?: DequeuedMessage[] } | undefined;
	const restored = data?.messages?.[0];
	if (!restored) {
		onEmpty();
		return;
	}
	// InputArea owns the "omp:fill-composer" listener.
	window.dispatchEvent(
		new CustomEvent("omp:fill-composer", {
			detail: {
				text: restored.text,
				images: restored.images,
				prepend: true,
				...(askedTabId ? { tabId: askedTabId } : {}),
			},
		}),
	);
}

/**
 * Clear the conversation context in place (TUI /clear parity via the
 * clear_context RPC): drops the context, keeps the session id and transcript
 * file. Refused with a warning while streaming / a foreground execution runs
 * (server code "busy"); on success rehydrates the transcript + context bar
 * and reports the dropped count. Returns whether the context was cleared.
 */
export async function clearSessionContext(
	rpc: Pick<TabRpc, "clearContext"> = window.omp.rpc,
	hydrate: () => Promise<void> = hydrateSession,
): Promise<boolean> {
	const response = await rpc.clearContext();
	if (!response.success) {
		toastError({ title: translate("cmd.clear"), error: response, variant: "warning" });
		return false;
	}
	const data = response.data as { droppedCount?: number } | undefined;
	toast({ variant: "success", message: translate("input.clear.done", { count: data?.droppedCount ?? 0 }) });
	await hydrate();
	return true;
}
