/**
 * This computer's saved sessions: the list (stock storage under omp's Bun, without a live tab), a session's GUI chat
 * label, deletion, moves, content search, and the change reports that keep the sidebar current.
 *
 * What reads the sessions tree by OMPdesk's own rules is in the core process (`native/ompdesk/crates/core/src/sessions`):
 * the one recursive watch of the tree with its settle, the legacy chat flag read from a session file's head once per
 * session id, which rows are kept, and search text and excerpts. Main asks stock for the list and applies tombstones
 * and the window's folder filter. The shared numbered copy uses the same order and diff as the page.
 */
import { stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import { codedError } from "../shared/ipc-error-codes";
import type { SessionContentMatch, SessionInfo, SessionKind } from "../shared/ipc-types";
import type { AgentMessage } from "../shared/rpc-types";
import { compareSessionRows, type SessionListDelta, type VersionedSessionList } from "../shared/session-list-delta";
import { agentDir } from "./agent-paths";
import { core } from "./core/process";
import { deletedSessions } from "./deleted-sessions";
import { OmpUnavailableError } from "./omp-availability";
import { SessionListShare } from "./session-list-share";
import { type Pace, readPace } from "./session-pace";
import { StockSessionStore } from "./session-store";

/**
 * The OS starts delivering a moment after the watch is made: a file written in that moment is never reported, so the
 * shared list (read once per change) is read once more this long after the watch starts.
 */
const WATCH_WARMUP_MS = 2000;

/** The core's events and answers for an index (`sessions/mod.rs`). */
const watchingEvent = z.object({ index: z.string(), watching: z.boolean(), missed: z.boolean() });
const changedEvent = z.object({ index: z.string(), names: z.array(z.string()).nullable() });
const listedAnswer = z.object({ listed: z.array(z.object({ row: z.number(), chat: z.boolean() })) });
const kindAnswer = z.object({ chat: z.boolean().nullable() });

let indexes = 0;

export class SessionIndex {
	/** This index's name in the core, which holds its watch and the chat flags it read. */
	readonly #id = `${process.pid}.${++indexes}`;
	/** Between `start()` and `stop()`. */
	#started = false;
	/** The core's events this index listens to while started. */
	#subscriptions: Array<() => void> = [];
	/** Whether the core says the tree is watched now. */
	#watching = false;
	/** The core process the watch was asked of (a core that ends takes its watches with it); null: none, or the ask failed. */
	#watchCore: number | null = null;
	/** Whether a watch was asked for since `start()`: a second ask means an earlier watch was lost. */
	#asked = false;
	/** Changes may have gone unseen between two watches: reported as "anything" once the tree is watched again. */
	#missed = false;
	/** Whether the core may hold anything of this index. */
	#inCore = false;
	/** A core that restarted needs stock's list again before it can search those rows. */
	#listedGeneration: number | null = null;
	#sessionsDir: string;
	#cwd: string;
	/** GUI-side chat labels for sessions whose header carries no kind (stock omp writes none). */
	#isChat: (sessionId: string) => boolean;
	#store: StockSessionStore;
	/** The global list, read once per change while the tree is watched and shared by every asker. */
	readonly #share = new SessionListShare(() => this.#readAll());
	#warmup: NodeJS.Timeout | undefined;

	/**
	 * The watch reported a session file, or a project or session directory, that appeared, changed or vanished, once its
	 * writes settled; without a path, anything may have changed.
	 */
	onChange: ((path?: string) => void) | null = null;

	/**
	 * The global list changed: `delta` turns the last version into the new one; null when there was no list to compare
	 * with, and whoever shows it asks (`SessionListShare.onChange`).
	 */
	onListChange: ((delta: SessionListDelta | null) => void) | null = null;

	constructor(
		sessionsDir: string | undefined,
		cwd: string,
		isChat: (sessionId: string) => boolean = () => false,
		bridgeDir = resolve("resources/gui-bridge"),
	) {
		this.#sessionsDir = sessionsDir ?? join(agentDir(), "sessions");
		this.#cwd = resolve(cwd);
		this.#isChat = isChat;
		this.#store = new StockSessionStore(this.#sessionsDir, bridgeDir);
		this.#share.onChange = delta => this.onListChange?.(delta);
	}

	/** Sessions root watched by this index (plan files live in per-session artifact dirs beneath it). */
	get sessionsDir(): string {
		return this.#sessionsDir;
	}

	/**
	 * Starts watching: the core's one recursive OS watch of the whole tree (FSEvents on macOS, ReadDirectoryChangesW
	 * on Windows; why never a watch per directory: `sessions/source.rs`). A root that is not there yet (omp has saved
	 * no session) is looked for every second and watched once it is made. The OS starts delivering a moment after
	 * the watch is made: every reader lists the sessions when it opens, and the shared list is read once more after
	 * {@link WATCH_WARMUP_MS} for a file written in that moment.
	 */
	start(): void {
		if (this.#started) return;
		this.#started = true;
		const events = core();
		this.#subscriptions = [
			events.on("sessions.watching", data => this.#onWatching(data)),
			events.on("sessions.changed", data => this.#onChanged(data)),
			// A core that started after the one the watch was asked of holds no watch.
			events.on("ready", () => this.#watched()),
		];
		this.#watch();
	}

	/** Asks the core to watch the tree; it says when the watch began (`sessions.watching`). */
	#watch(): void {
		// Not the first ask: the watch before it ended with its core or never began, and what changed meanwhile is only
		// seen by a fresh list.
		this.#missed ||= this.#asked;
		this.#asked = true;
		this.#watching = false;
		this.#inCore = true;
		const asked = core().call("sessions.watch", { index: this.#id, root: resolve(this.#sessionsDir) });
		const pid = core().pid;
		this.#watchCore = pid;
		asked.catch((error: unknown) => {
			console.warn(
				`[session-index] not watching ${this.#sessionsDir}: ${error instanceof Error ? error.message : String(error)}`,
			);
			// Unwatched, so every ask reads; the next ask (or the next core) asks for the watch again.
			if (this.#watchCore === pid) this.#watchCore = null;
		});
	}

	/**
	 * Whether the tree is watched now. The core that held the watch may be gone (a core restarts on its next request,
	 * without its watches), or the ask may have failed: the watch is asked for again.
	 */
	#watched(): boolean {
		if (!this.#started) return false;
		if (this.#watchCore === null || core().pid !== this.#watchCore) {
			this.#watch();
			return false;
		}
		return this.#watching;
	}

	/** The core's watch of this index began (`watching`), or ended by itself and is being tried again. */
	#onWatching(data: unknown): void {
		const event = watchingEvent.safeParse(data);
		if (!event.success || event.data.index !== this.#id || !this.#started) return;
		this.#watching = event.data.watching;
		clearTimeout(this.#warmup);
		if (!event.data.watching) {
			// What had not settled yet is never reported, and nothing is until the tree is watched again.
			this.#notifyChange();
			return;
		}
		// A list nobody read yet is read whole by its first reader, after this moment anyway.
		this.#warmup = setTimeout(() => this.#share.held() && this.#share.changed(), WATCH_WARMUP_MS);
		this.#warmup.unref?.();
		// What was written while nothing watched (before the root was made, between two watches) is only seen by a
		// fresh list.
		if (event.data.missed || this.#missed) {
			this.#missed = false;
			this.#notifyChange();
		}
	}

	/**
	 * The core's report: session files, or project or session directories, that appeared, changed or vanished, once
	 * their writes settled (every path due at the same moment in one report); no names when the OS dropped changes
	 * (a Windows buffer overflow, FSEvents asking for a rescan), so anything may have changed.
	 */
	#onChanged(data: unknown): void {
		const event = changedEvent.safeParse(data);
		if (!event.success || event.data.index !== this.#id || !this.#started) return;
		const { names } = event.data;
		if (names === null) {
			this.#notifyChange();
			return;
		}
		for (const name of names) this.onChange?.(join(this.#sessionsDir, name));
		this.#share.changed();
	}

	stop(): void {
		this.#started = false;
		for (const unsubscribe of this.#subscriptions.splice(0)) unsubscribe();
		clearTimeout(this.#warmup);
		this.#watching = false;
		this.#watchCore = null;
		this.#asked = false;
		this.#missed = false;
		// Only a running core holds anything of this index: none is started to forget nothing.
		if (this.#inCore && core().pid !== null) {
			core()
				.call("sessions.close", { index: this.#id })
				.catch(() => {
					// A core that ended has forgotten it already.
				});
		}
		this.#inCore = false;
		this.#store.stop();
		this.#listedGeneration = null;
	}

	/**
	 * @param scope "local" filters to sessions whose cwd matches `cwd`.
	 * @param cwd The calling window's cwd for "local" filtering. Defaults to the
	 *   index's own cwd (single-window behavior); multi-window callers pass their
	 *   own so each window sees only its project's sessions.
	 */
	async list(scope: "local" | "global", cwd?: string): Promise<SessionInfo[]> {
		return this.#shown((await this.listShared()).sessions, scope, cwd);
	}

	/** Every session, or null while none can be read (no usable omp yet): for a reader that drops what is absent. */
	async listKnown(): Promise<SessionInfo[] | null> {
		const { version, sessions } = await this.listShared();
		return version ? this.#shown(sessions, "global") : null;
	}

	#shown(sessions: readonly SessionInfo[], scope: "local" | "global", cwd?: string): SessionInfo[] {
		const localCwd = cwd !== undefined ? resolve(cwd) : this.#cwd;
		const deleted = deletedSessions();
		// A file a stray writer put back after its session was deleted is not that session coming back.
		return sessions.filter(
			info =>
				!deleted.has(info.path) && (scope === "global" || (info.cwd != null && resolve(info.cwd) === localCwd)),
		);
	}

	/**
	 * The global list and its version, read once per change and shared (the rows are the copy every asker gets: never
	 * changed in place). Unwatched (no root yet, a watch that ended, a core that could not start, an index never
	 * started) nothing says when a file changes, so every ask reads.
	 */
	async listShared(): Promise<VersionedSessionList> {
		if (!this.#watched()) this.#share.stale();
		try {
			return await this.#share.current();
		} catch (error) {
			// No usable omp yet (machine setup is on it): nothing to list, and nothing failed. Main signals a change once
			// omp is usable (`relist`), and the readers list again; a version no change names makes them ask then.
			if (error instanceof OmpUnavailableError) return { version: "", sessions: [] };
			throw error;
		}
	}

	/** Something listed may have changed with no file event (omp became usable, a rename went through stock): read again. */
	relist(): void {
		this.#share.changed();
	}

	/**
	 * Every session file once (deleted ones never), chat-labelled, newest first, one row per session id: stock moves
	 * sessions between its old and new directory names for a cwd (`-AiProject-x` → `home-x-<hash>`), and meanwhile one
	 * id is a file in both; the core keeps the first, which in this order is the newest copy, and reads each kept
	 * file's legacy chat flag.
	 */
	async #readAll(): Promise<SessionInfo[]> {
		const deleted = deletedSessions();
		const infos = (await this.#store.list()).filter(info => !deleted.has(info.path));
		if (infos.length === 0 && (this.#listedGeneration === null || core().pid === null)) {
			this.#listedGeneration = null;
			return infos;
		}
		infos.sort(compareSessionRows);
		this.#inCore = true;
		const { result, generation } = await core().call("sessions.listed", {
			index: this.#id,
			root: resolve(this.#sessionsDir),
			rows: infos.map(info => ({ path: info.path, id: info.id })),
		});
		this.#listedGeneration = generation;
		return listedAnswer.parse(result).listed.flatMap(({ row, chat }) => {
			const info = infos[row];
			if (!info) return [];
			if (chat || this.#isChat(info.id)) info.kind = "chat";
			return [info];
		});
	}

	/**
	 * GUI chat labels are an overlay: stock sessions have no chat-kind concept. The legacy one is a flag in the file's
	 * header that stock's listing deliberately does not expose; the core reads it. Only this presentation overlay is
	 * read there, never stock metadata or lifecycle.
	 */
	async kindFor(sessionPath: string): Promise<SessionKind> {
		try {
			const infos = await this.#store.listDirectory(sessionPath);
			const info = infos.find(row => resolve(row.path) === resolve(sessionPath));
			if (!info) return "agent";
			if (this.#isChat(info.id)) return "chat";
			const { result } = await core().call("sessions.kind", { path: resolve(sessionPath) });
			return kindAnswer.parse(result).chat === true ? "chat" : "agent";
		} catch {
			return "agent";
		}
	}

	/**
	 * The folder a stored session belongs in: the cwd its file records (stock's header), or null when the file records
	 * none. A failed read throws: an opener that took it for "none" would fall back to another folder (the main
	 * checkout), the one thing a reopen must never do.
	 */
	async recordedCwd(sessionPath: string): Promise<string | null> {
		const infos = await this.#store.listDirectory(sessionPath);
		return infos.find(row => resolve(row.path) === resolve(sessionPath))?.cwd || null;
	}

	async deleteSession(sessionPath: string): Promise<void> {
		const target = resolve(sessionPath);
		const root = `${resolve(this.#sessionsDir)}${sep}`;
		if (!target.startsWith(root) || !target.endsWith(".jsonl")) {
			throw codedError("invalid_session_path", "Invalid session path");
		}
		await this.#store.delete(target);
		this.#forgetText([target]);
		this.#notifyChange();
	}

	/** A stored session's transcript, read-only (the control tools' `ompdesk_session_read` of a session no tab holds). */
	/** Whether another live omp process owns this computer's stored session (stock's ownership lease). */
	async ownedElsewhere(sessionPath: string): Promise<boolean> {
		const target = resolve(sessionPath);
		const root = `${resolve(this.#sessionsDir)}${sep}`;
		if (!target.startsWith(root) || !target.endsWith(".jsonl")) return false;
		return this.#store.owned(target);
	}

	async readMessages(sessionPath: string): Promise<AgentMessage[]> {
		const target = resolve(sessionPath);
		const root = `${resolve(this.#sessionsDir)}${sep}`;
		if (!target.startsWith(root) || !target.endsWith(".jsonl")) {
			throw codedError("invalid_session_path", "Invalid session path");
		}
		return this.#store.messages(target);
	}

	/** The pace of a stored session's journal (session-pace.ts); undefined when it cannot be read. */
	async pace(sessionPath: string): Promise<Pace | undefined> {
		const target = resolve(sessionPath);
		const root = `${resolve(this.#sessionsDir)}${sep}`;
		if (!target.startsWith(root) || !target.endsWith(".jsonl")) {
			throw codedError("invalid_session_path", "Invalid session path");
		}
		return readPace(target);
	}

	/** Move a stored session to another project folder (stock `SessionManager.moveTo`); returns its new path. */
	async moveSession(sessionPath: string, cwd: string): Promise<string> {
		const source = resolve(sessionPath);
		const root = `${resolve(this.#sessionsDir)}${sep}`;
		if (!source.startsWith(root) || !source.endsWith(".jsonl")) {
			throw codedError("invalid_session_path", "Invalid session path");
		}
		const target = resolve(cwd);
		const info = await stat(target).catch(() => null);
		if (!info?.isDirectory()) throw codedError("not_a_directory", `Not a directory: ${target}`);
		const moved = await this.#store.move(source, target);
		this.#forgetText([source, moved]);
		this.#notifyChange();
		return moved;
	}

	#forgetText(paths: string[]): void {
		if (this.#listedGeneration !== null)
			core().push("sessions.forgetText", { index: this.#id, paths }, undefined, this.#listedGeneration);
	}

	/** Search only the caller's subset of stock's listed rows; file text stays in the core. */
	async searchContent(query: string, candidatePaths: string[]): Promise<SessionContentMatch[]> {
		if (!query.trim() || !candidatePaths.length) return [];
		if (this.#listedGeneration !== core().generation) {
			this.#share.stale();
			if (!(await this.listShared()).version) return [];
		}
		if (this.#listedGeneration === null) return [];
		// The normal core JSON encoder replaces lone surrogates. A JS substring can match either half of a pair.
		const wireQuery = query.isWellFormed()
			? query
			: Array.from({ length: query.length }, (_, i) => query.charCodeAt(i));
		return (
			await core().call<SessionContentMatch[]>(
				"sessions.search",
				{ index: this.#id, query: wireQuery, paths: candidatePaths },
				// A search reads its batches to completion even on a large tree, not just until the usual RPC deadline.
				{ generation: this.#listedGeneration, timeoutMs: 0x7fff_ffff },
			)
		).result;
	}

	/** Anything may have changed. */
	#notifyChange(): void {
		this.onChange?.();
		this.#share.changed();
	}
}
