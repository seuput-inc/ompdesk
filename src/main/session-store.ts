import { z } from "zod";
import type { SessionInfo } from "../shared/ipc-types";
import type { AgentMessage } from "../shared/rpc-types";
import { core } from "./core/process";
import { configureStockHelper, stockHelperHost, stockHelperRequest, stopStockHelper } from "./stock-helper";

const sessionRows = z.array(
	z.object({
		path: z.string(),
		id: z.string(),
		title: z
			.string()
			.nullish()
			.transform(value => value ?? null),
		cwd: z.string(),
		created: z.string(),
		modified: z.string(),
		messageCount: z.number(),
		size: z.number(),
		status: z.enum(["complete", "interrupted", "aborted", "error", "pending", "unknown"]).default("unknown"),
		firstMessage: z.string(),
		parentSessionPath: z.string().optional(),
		promptOriginDevice: z.string().optional(),
	}),
);

const patches = z.array(z.object({ row: z.number(), at: z.number().optional(), autoTitle: z.string().optional() }));

const movedSession = z.object({ sessionPath: z.string() });

/** Session wire adaptation only. Listing/deletion share the app's stock helper. */
export class StockSessionStore {
	readonly #sessionsRoot: string;
	readonly #index: string;

	constructor(sessionsRoot: string, bridgeDir: string, index: string) {
		this.#sessionsRoot = sessionsRoot;
		this.#index = index;
		configureStockHelper(bridgeDir);
	}

	list(): Promise<SessionInfo[]> {
		return this.#read("sessions.list");
	}

	listDirectory(sessionPath: string): Promise<SessionInfo[]> {
		return this.#read("sessions.list_directory", sessionPath);
	}

	/** Only a global read may evict journals not listed. */
	async #read(method: "sessions.list" | "sessions.list_directory", sessionPath?: string): Promise<SessionInfo[]> {
		const rows: SessionInfo[] = sessionRows.parse(
			await stockHelperRequest(method, { sessionsRoot: this.#sessionsRoot, sessionPath }),
		);
		const { result } = await core().call("sessions.enrich", {
			index: this.#index,
			host: stockHelperHost(),
			root: this.#sessionsRoot,
			full: method === "sessions.list",
			rows: rows.map(({ path, id, size, modified }) => ({ path, id, size, modified })),
		});
		for (const { row, at, autoTitle } of patches.parse(result)) {
			const info = rows[row]!;
			if (at !== undefined) info.modified = new Date(at).toISOString();
			if (autoTitle !== undefined) info.autoTitle = autoTitle;
		}
		return rows;
	}

	async delete(sessionPath: string): Promise<void> {
		await stockHelperRequest("sessions.delete", { sessionsRoot: this.#sessionsRoot, sessionPath });
	}

	/** Stock `SessionManager.moveTo` in the helper; returns the session's new path. */
	async move(sessionPath: string, cwd: string): Promise<string> {
		const result = movedSession.parse(
			await stockHelperRequest("sessions.move", { sessionsRoot: this.#sessionsRoot, sessionPath, cwd }),
		);
		return result.sessionPath;
	}

	/** A stored session's transcript (stock `loadSessionMessagesReadOnly` in the helper). */
	async messages(sessionPath: string): Promise<AgentMessage[]> {
		const result = await stockHelperRequest("sessions.messages", { sessionsRoot: this.#sessionsRoot, sessionPath });
		return Array.isArray(result) ? (result as AgentMessage[]) : [];
	}

	/** Whether another live omp process owns the session's file (stock's ownership lease); false when unknown. */
	async owned(sessionPath: string): Promise<boolean> {
		const result = await stockHelperRequest("sessions.owned", { sessionsRoot: this.#sessionsRoot, sessionPath });
		return result === true;
	}

	stop(): void {
		stopStockHelper();
	}
}
