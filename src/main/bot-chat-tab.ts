import { z } from "zod";
import type { IpcSpawnTabResult } from "../shared/ipc-types";
import type { AgentControlRuntime } from "./agent-control/host";
import type { SidecarPool } from "./sidecar-pool";
import { nextSnowflake } from "./snowflake";
import { type ClientWindow, isWebWindow } from "./web/client-window";

type Result = IpcSpawnTabResult | null;
const occupied: IpcSpawnTabResult = { tabId: null, refusal: "bot-chat-occupied" };
const request = z.object({ botId: z.string().min(1), sessionPath: z.string().min(1).nullable() }).strict();

interface BotChatTabs {
	resolve: AgentControlRuntime["botChatLaunch"];
	pool: Pick<SidecarPool, "sessionOwner" | "sidecarOf" | "attachViewer" | "pendingBotChat" | "acquireBotChat">;
	hosted(path: string): boolean;
	ownedElsewhere(path: string): Promise<boolean>;
	legacy(win: ClientWindow, cwd: string, sessionPath: string): Promise<Result>;
}

/** Only this computer's Bots UI has this entry point. The resolver, not the page, chooses the folder and launch. */
export function localBotChatOpener({ resolve, pool, hosted, ownedElsewhere, legacy }: BotChatTabs) {
	const creating = new Map<string, Promise<Result>>();
	function show(win: ClientWindow, tabId: string, cwd?: string): Result {
		return !win.isDestroyed() && pool.attachViewer(win, tabId) ? { tabId, cwd, attached: true } : null;
	}

	async function open(win: ClientWindow, id: string, path: string | null): Promise<Result> {
		const { botId, cwd, sessionPath, botChatPort } = await resolve(id, path);
		if (win.isDestroyed()) return null;
		if (botId === null) return sessionPath ? legacy(win, cwd, sessionPath) : null;
		if (sessionPath) {
			const held = () => pool.sessionOwner(sessionPath)?.tabId;
			const first = held();
			// A tab acquired during the lease probe also wins. No await between the last owner check and acquire.
			const external = !first && (await ownedElsewhere(sessionPath).catch(() => true));
			const tab = held();
			if (tab) {
				const sidecar = pool.sidecarOf(tab);
				const live = await sidecar?.currentBotChatId?.();
				return live === botId && pool.sidecarOf(tab) === sidecar && held() === tab && !hosted(sessionPath)
					? show(win, tab, cwd)
					: occupied;
			}
			if (external || first || hosted(sessionPath)) return occupied;
		} else {
			const tab = pool.pendingBotChat(botId, botChatPort);
			if (tab) {
				const sidecar = pool.sidecarOf(tab);
				if ((await sidecar?.currentBotChatId?.()) === botId && pool.sidecarOf(tab) === sidecar)
					return show(win, tab, cwd);
				if (sidecar?.status === "starting") return occupied;
			}
		}
		if (win.isDestroyed()) return null;
		const tabId = nextSnowflake();
		const sidecar = pool.acquireBotChat(win, tabId, cwd, {
			botChatId: botId,
			botChatPort,
			...(sessionPath ? { botChatSessionPath: sessionPath } : {}),
		});
		return sidecar ? { tabId, cwd } : null;
	}

	return async (win: ClientWindow | null, payload: unknown): Promise<Result> => {
		if (!win || win.isDestroyed() || isWebWindow(win.webContents.id)) return null;
		const parsed = request.safeParse(payload);
		if (!parsed.success) return null;
		const { botId, sessionPath } = parsed.data;
		if (sessionPath !== null) return open(win, botId, sessionPath);
		const existing = creating.get(botId);
		if (existing) {
			const result = await existing;
			if (!result?.tabId) return result;
			const sidecar = pool.sidecarOf(result.tabId);
			return (await sidecar?.currentBotChatId?.()) === botId && pool.sidecarOf(result.tabId) === sidecar
				? show(win, result.tabId, result.cwd)
				: occupied;
		}
		const launch = open(win, botId, null);
		creating.set(botId, launch);
		try {
			return await launch;
		} finally {
			creating.delete(botId);
		}
	};
}
