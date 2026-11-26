import { createHash } from "node:crypto";
import { JUDGE_ASSIST_NEEDS_USER, type NeedsUserResult } from "../../resources/gui-bridge/modes/judge-assist-contracts";
import { type BotQuietKind, isQuietResult } from "../shared/bots";
import type { IpcNotifyPayload } from "../shared/ipc-types";
import { botOfFolder } from "./bots";
import type { ClientWindow } from "./web/client-window";

export type AdmitNotification = (report: {
	digest: string;
	now: number;
	completion: boolean;
	hasTabWindow: boolean;
}) => Promise<"drop" | "deliver" | { judgeTimeoutMs: number }>;

/** A direct request to a tab's own bridge: no RPC dispatch, so no quota and no driver. */
export type BridgeAsk = (method: string, params: unknown, timeoutMs: number) => Promise<unknown>;

export interface NotifyTriageDeps {
	admit: AdmitNotification;
	now(): number;
	/** A tab several windows show is one event, whichever of them reports it. */
	isShared(tabId: string): boolean;
	/** The pref `judgeAssist` (default on). */
	judgeEnabled(): boolean;
	/** The bridge of `tabId` when it is a local tab of this machine owned by `win`; undefined for any other. */
	bridgeFor(win: ClientWindow, tabId: string): BridgeAsk | undefined;
	/** The title of a needs-you notice, in the app's language. */
	needsYouTitle(title: string): string;
	/** Hand the notice on (window bookkeeping and the batcher). */
	deliver(win: ClientWindow | null, winId: number, notice: IpcNotifyPayload): void;
	/** The tab's folder and the start of its last finished reply (the pool's last `idle` outcome). */
	lastTurn(tabId: string): LastTurn | undefined;
}

export interface LastTurn {
	cwd?: string;
	reply?: string;
}

/**
 * A bot chat's turn that ended in `NO_REPLY` (src/shared/bots.ts): nothing for the owner, so nothing notifies.
 * shortcut: `reply` is the reply's first 4000 characters (`IpcTabRunOutcome.reply`), so a longer quiet reply still
 * notifies; keep its tail in the outcome if that shows up.
 */
export function quietBotTurn(turn: LastTurn | undefined): boolean {
	return Boolean(turn?.reply && botOfFolder(turn.cwd) && isQuietResult(turn.reply));
}

/** The notice kind each per-bot notification switch (`Bot.quiet`, Settings › Bots › Notifications) silences. */
const BOT_QUIET_KIND: Record<"ask" | "completion" | "error", BotQuietKind> = {
	ask: "permission",
	completion: "done",
	error: "failed",
};

/**
 * The owner turned this kind off for the bot whose chat the tab is (Orca's per-bot notification toggles).
 * shortcut: the chat's folder is its last finished turn's, so an ask in a chat's very first turn still notifies; read
 * the tab's own folder if that shows up.
 */
function mutedForBot(kind: "ask" | "completion" | "error", turn: LastTurn | undefined): boolean {
	return Boolean(turn && botOfFolder(turn.cwd)?.quiet?.includes(BOT_QUIET_KIND[kind]));
}

export interface NotifyCaller {
	readonly win: ClientWindow | null;
	/** The Electron window of a desktop caller; null for a web caller (its page already checked its own focus). */
	readonly browserWindow: { isFocused(): boolean } | null;
}

async function asksTheUser(ask: BridgeAsk, timeoutMs: number): Promise<boolean> {
	const expired = Promise.withResolvers<null>();
	const timer = setTimeout(expired.resolve, timeoutMs, null);
	try {
		const result = (await Promise.race([
			ask(JUDGE_ASSIST_NEEDS_USER, {}, timeoutMs),
			expired.promise,
		])) as NeedsUserResult | null;
		return result?.needsUser === true;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/** Resolves whether the notice went on to the batcher: false for a quiet bot turn, a repeat, or a malformed one. */
export function createNotifyHandler(
	deps: NotifyTriageDeps,
): (caller: NotifyCaller, payload: IpcNotifyPayload) => Promise<boolean> {
	return async (caller, payload) => {
		if (typeof payload?.title !== "string") return false;
		let title = payload.title;
		let kind = payload.kind;
		if (kind !== "completion" && kind !== "error" && kind !== "ask") kind = undefined;
		const body = typeof payload.body === "string" ? payload.body : undefined;
		const tabId = typeof payload.tabId === "string" ? payload.tabId : undefined;
		// Before the dedupe: a quiet turn takes no slot from a real notice.
		if (kind === "completion" && tabId && quietBotTurn(deps.lastTurn(tabId))) return false;
		if (kind && tabId && mutedForBot(kind, deps.lastTurn(tabId))) return false;
		const win = caller.win;
		const winId = win?.webContents.id ?? 0;
		const scope = tabId && deps.isShared(tabId) ? `tab:${tabId}` : String(winId);
		// Hash the original JS key as UTF-16 units. Admission never receives the title, body or tab identifier.
		const digest = createHash("sha256")
			.update(scope, "utf16le")
			.update(title, "utf16le")
			.update(`${payload.body ?? ""}`, "utf16le")
			.digest("hex");
		const plan = await deps.admit({
			digest,
			now: deps.now(),
			completion: kind === "completion",
			hasTabWindow: Boolean(win && tabId),
		});
		if (plan === "drop") return false;

		if (plan !== "deliver" && win && tabId && !win.isDestroyed() && deps.judgeEnabled()) {
			const ask = deps.bridgeFor(win, tabId);
			// Re-read the window after the stock answer, with no await between focus and delivery.
			if (ask && (await asksTheUser(ask, plan.judgeTimeoutMs)) && !caller.browserWindow?.isFocused()) {
				title = deps.needsYouTitle(title);
				kind = "ask";
			}
		}
		deps.deliver(win, winId, { title, body, tabId, kind });
		return true;
	};
}
