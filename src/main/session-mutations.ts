/**
 * Deleting, renaming and moving a stored session, the same for this machine's
 * own sidebar (ipc.ts) and for a paired device using it as host
 * (remote/host-services.ts). A delete closes the tab holding the session, as
 * closing a tab does (the window drops it), waits for that omp to exit and
 * removes the stored file with stock: no replacement session is started. A
 * rename goes to a live owner's process in memory, else to the file. A move
 * needs the session closed: an open tab moves its own session with stock
 * `/move`. Callers keep their own path validation, device routing and peer
 * ownership checks.
 */
import { codedError, ipcErrorCode } from "../shared/ipc-error-codes";
import type { RpcCommand, RpcResponse } from "../shared/rpc-types";
import { deletedSessions, type PendingHandoff } from "./deleted-sessions";
import type { RpcClient } from "./rpc-client";
import type { SidecarPool } from "./sidecar-pool";

export type SessionTabs = Pick<
	SidecarPool,
	| "sessionOwner"
	| "sessionOwnerIsLive"
	| "sessionRunning"
	| "commandForSession"
	| "closeSessionTab"
	| "noteSessionName"
>;

/** The tabs this computer runs for paired devices (LocalHostServices), as this computer's own delete closes them. */
export interface DeviceSessionTabs {
	/** Close them; resolves, once their omps exited, to the notice that the file is gone (run only after it is). */
	closeSessionTabs(sessionPath: string): Promise<() => void>;
}

const deleting = new Map<string, number>();

/** A transient refusal for opens; unlike a tombstone, a failed delete releases it. */
export function sessionDeleteInProgress(sessionPath: string, device?: string): boolean {
	return deleting.has(JSON.stringify([device ?? null, sessionPath]));
}

/**
 * `deviceTabs`: this computer's own delete of its own session. The paired devices' tabs on it here close first,
 * idle ones only, as another window's tab would; nothing closes while this computer's own tab runs it. The devices
 * hear the session was deleted (and record it) only once the stored file is gone.
 */
export async function deleteSession(
	tabs: SessionTabs,
	sessionPath: string,
	device: string | undefined,
	deleteStored: () => Promise<unknown>,
	deviceTabs?: DeviceSessionTabs,
): Promise<void> {
	const key = JSON.stringify([device ?? null, sessionPath]);
	deleting.set(key, (deleting.get(key) ?? 0) + 1);
	try {
		let tellDevices: (() => void) | undefined;
		if (deviceTabs) {
			if (tabs.sessionRunning(sessionPath, device))
				throw codedError("session_running", "Session is currently running");
			tellDevices = await deviceTabs.closeSessionTabs(sessionPath);
		}
		if (!(await tabs.closeSessionTab(sessionPath, device)))
			throw codedError("session_running", "Session is currently running");
		await deleteStored();
		deletedSessions().add(sessionPath, device);
		for (const listener of deletedListeners) listener(sessionPath, device);
		tellDevices?.();
	} finally {
		const remaining = (deleting.get(key) ?? 1) - 1;
		if (remaining === 0) deleting.delete(key);
		else deleting.set(key, remaining);
	}
}

type SessionDeletedListener = (sessionPath: string, device: string | undefined) => void;
const deletedListeners = new Set<SessionDeletedListener>();

/**
 * What else holds a deleted session and must let it go once its file is gone (ipc.ts: the closed-children record that
 * kept it in its opener's family; index.ts: its scratch folder). `device`: the paired host the file was on, absent
 * for a file of this computer. Returns the call that stops it.
 */
export function onSessionDeleted(listener: SessionDeletedListener): () => void {
	deletedListeners.add(listener);
	return () => void deletedListeners.delete(listener);
}

type SessionDeleteLog = (outcome: "deleted" | "refused" | "failed", details: Record<string, string>) => void;
let deleteLog: SessionDeleteLog | null = null;

/** Where `recordSessionDelete` writes (index.ts: the runtime log, source `session-delete`); null stops it. */
export function setSessionDeleteLog(log: SessionDeleteLog | null): void {
	deleteLog = log;
}

/**
 * Run one session delete and leave one line for it: the machine the file is on (`device`, `local` for this one), the
 * paired device that asked (`by`), the file's name only, and the outcome, a refusal's code or a failure's message.
 */
export async function recordSessionDelete(
	target: { sessionPath: string; device?: string; by?: string },
	run: () => Promise<unknown>,
): Promise<void> {
	const details: Record<string, string> = {
		device: target.device ?? "local",
		...(target.by ? { by: target.by } : {}),
		session: target.sessionPath.split(/[\\/]/).at(-1) ?? "",
	};
	try {
		await run();
	} catch (error) {
		const code = ipcErrorCode(error);
		if (code) deleteLog?.("refused", { ...details, reason: code });
		else deleteLog?.("failed", { ...details, reason: error instanceof Error ? error.message : String(error) });
		throw error;
	}
	deleteLog?.("deleted", details);
}

export interface RenameSessionOptions {
	device?: string;
	renameStored: (name: string) => Promise<unknown>;
	/**
	 * A live owner outside `tabs` (a host's tabs for paired devices): its
	 * client, null while it is still starting, undefined when there is none.
	 */
	otherOwner?: () => Pick<RpcClient, "command"> | null | undefined;
}

/** Stock renames mid-run (a user title also locks out the pending auto-title), so this never waits for idle. */
export async function renameSession(
	tabs: SessionTabs,
	sessionPath: string,
	rawName: unknown,
	options: RenameSessionOptions,
): Promise<void> {
	const name = typeof rawName === "string" ? rawName.trim() : "";
	if (!name) throw codedError("session_name_empty", "Session name cannot be empty");
	const { device } = options;
	const command: RpcCommand = { type: "set_session_name", name, sessionPath };
	const other = options.otherOwner?.();
	let response: RpcResponse | null | undefined;
	if (other !== undefined) response = other ? await other.command(command) : null;
	else if (tabs.sessionOwner(sessionPath, device) && tabs.sessionOwnerIsLive(sessionPath, device))
		response = await tabs.commandForSession(sessionPath, command, device);
	if (response === null) throw codedError("session_starting", "Session is still starting");
	if (response !== undefined) {
		if (!response.success) throw new Error(response.error);
		return;
	}
	await options.renameStored(name);
	// A tab holding the file with no live omp (asleep) shows the name it had; a live one reports its own (`Sidecar`).
	const owner = tabs.sessionOwner(sessionPath, device);
	if (owner) tabs.noteSessionName(owner.tabId, name);
}

/** Move a stored session no tab holds; returns its new path. */
export async function moveSession(
	tabs: Pick<SessionTabs, "sessionOwner">,
	sessionPath: string,
	device: string | undefined,
	moveStored: () => Promise<string>,
): Promise<string> {
	if (tabs.sessionOwner(sessionPath, device)) throw codedError("session_open_in_tab", "Session is open in a tab");
	return moveStored();
}

// ---- handing a session to a paired computer ------------------------------------------------------------------------

/** One file of a session as it crosses: the journal, a file of its artifacts folder, a picture blob it names. */
export interface HandOffPart {
	/** `session.jsonl`, `artifacts/<path with />` or `blobs/<sha256>`: where the receiver stages it. */
	rel: string;
	size: number;
	read(offset: number, length: number): Promise<Uint8Array>;
}

export interface HandOffDeps {
	/** One request to the paired computer `host` over its link (`RemoteDevices.request`). */
	request<T>(host: string, method: string, params: unknown, timeoutMs?: number): Promise<T>;
	/** The folder the session works in (its header's `cwd`). */
	recordedCwd(sessionPath: string): Promise<string | null>;
	/** That folder's `origin` (`remote.handoff.origin`): the project's identity on the other computer. */
	origin(cwd: string): Promise<string | null>;
	/** What crosses (`session-handoff-parts.ts`). */
	parts(sessionPath: string): Promise<HandOffPart[]>;
	/** Stock's delete of this computer's copy once the other computer took it (the index's `deleteSession`). */
	removeStored(sessionPath: string): Promise<void>;
	/** The session list reads again: a pending session leaves it, one given back returns. */
	relist(): void;
	/** One line per hand-over in the runtime log (source `session-handoff`). */
	log?(outcome: "moved" | "refused" | "pending" | "failed", details: Record<string, string>): void;
}

/** One part's bytes at most: 4 MiB, a 5.6 MB base64 frame, well under the link's 16 MiB cap. */
export const HANDOFF_PART_BYTES = 4 * 1024 * 1024;
/** One request of a hand-over, as long as an upload's (`HOST_UPLOAD_TIMEOUT_MS`). */
export const HANDOFF_TIMEOUT_MS = 2 * 60_000;
/**
 * How long a pending transfer waits before it asks again when the other computer is connected but did not answer (its
 * one lock held by a long copy, say): a link that comes up asks at once (`reconcileHandOffs`), one that stayed up would
 * never ask again.
 */
export const HANDOFF_RETRY_MS = 60_000;

/** Transfers this process is settling now: a link coming up does not ask about them meanwhile. */
const settling = new Set<string>();
/** The transfers that ask again after `HANDOFF_RETRY_MS`, by id. */
const retries = new Map<string, ReturnType<typeof setTimeout>>();

type Settled = { state: "moved"; sessionPath: string } | { state: "aborted" } | { state: "pending" };

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function fileName(sessionPath: string): string {
	return sessionPath.split(/[\\/]/).at(-1) ?? sessionPath;
}

/** The other computer took the session: the tombstone names where, then this computer's copy goes. */
async function finishHandOff(pending: PendingHandoff, to: string, deps: HandOffDeps): Promise<void> {
	deletedSessions().settleHandoff(pending.path, pending.id, to);
	try {
		await deps.removeStored(pending.path);
	} catch (error) {
		// The tombstone already keeps the file from running here; only the disk space stays.
		deps.log?.("failed", { session: fileName(pending.path), reason: `left its copy: ${reasonOf(error)}` });
	}
	for (const listener of deletedListeners) listener(pending.path, undefined);
	deps.log?.("moved", { device: pending.device, session: fileName(pending.path) });
}

/**
 * Who owns a pending transfer: the other computer answers `moved` when it committed it, and otherwise records it
 * aborted before it answers, so no part or commit of it lands afterwards. Only that answer gives the session back
 * here; an unreachable computer leaves it pending (the file kept, nothing running it) until the next ask.
 */
async function settleHandOff(pending: PendingHandoff, deps: HandOffDeps): Promise<Settled> {
	let answer: unknown;
	try {
		answer = await deps.request(pending.device, "sessions.handoff.abort", { id: pending.id }, HANDOFF_TIMEOUT_MS);
	} catch (error) {
		deps.log?.("pending", { device: pending.device, session: fileName(pending.path), reason: reasonOf(error) });
		const code = ipcErrorCode(error);
		if (code !== "remote_offline" && code !== "remote_unknown_device" && !retries.has(pending.id)) {
			const timer = setTimeout(() => {
				retries.delete(pending.id);
				void reconcileHandOffs(pending.device, deps).catch(() => {});
			}, HANDOFF_RETRY_MS);
			timer.unref?.();
			retries.set(pending.id, timer);
		}
		return { state: "pending" };
	}
	const reply = (answer ?? {}) as { state?: unknown; sessionPath?: unknown };
	if (reply.state === "moved" && typeof reply.sessionPath === "string" && reply.sessionPath.length > 0) {
		await finishHandOff(pending, reply.sessionPath, deps);
		return { state: "moved", sessionPath: reply.sessionPath };
	}
	if (reply.state !== "aborted") return { state: "pending" };
	deletedSessions().settleHandoff(pending.path, pending.id);
	deps.relist();
	return { state: "aborted" };
}

/**
 * Hand this computer's stored session to the paired computer `host`; resolves to its path and folder there. Refused, with
 * nothing changed, while it runs or when `host` has no folder of its project. Then the tabs holding it close, the
 * transfer is recorded pending (from here on the session reads as deleted to every revival path, and its file stays),
 * its files cross and `host` commits them. Any failure asks `host` to call the transfer off: the session is this
 * computer's again only once `host` confirms it, it is `host`'s when `host` had committed it, and it stays pending
 * when `host` cannot be reached (`handoff_pending`; `reconcileHandOffs` asks again when its link is back).
 */
export async function handOffSession(
	tabs: SessionTabs,
	sessionPath: string,
	host: string,
	deps: HandOffDeps,
	deviceTabs?: DeviceSessionTabs,
): Promise<{ sessionPath: string; cwd: string }> {
	const key = JSON.stringify([null, sessionPath]);
	deleting.set(key, (deleting.get(key) ?? 0) + 1);
	const session = fileName(sessionPath);
	try {
		if (deletedSessions().has(sessionPath))
			throw codedError("session_deleted", "The session was deleted or handed to another computer");
		const cwd = await deps.recordedCwd(sessionPath);
		if (!cwd) throw codedError("invalid_session_path", "Invalid session path");
		const origin = await deps.origin(cwd);
		const { folder } = await deps.request<{ folder: string | null }>(host, "sessions.handoff.folder", {
			cwd,
			origin,
		});
		if (!folder) throw codedError("handoff_project_missing", `That computer has no folder for ${fileName(cwd)}`);
		if (tabs.sessionRunning(sessionPath, undefined))
			throw codedError("session_running", "Session is currently running");
		const tellDevices = deviceTabs ? await deviceTabs.closeSessionTabs(sessionPath) : undefined;
		if (!(await tabs.closeSessionTab(sessionPath, undefined)))
			throw codedError("session_running", "Session is currently running");
		const pending: PendingHandoff = { path: sessionPath, id: crypto.randomUUID(), device: host };
		deletedSessions().beginHandoff(pending.path, pending.id, host);
		settling.add(pending.id);
		deps.relist();
		try {
			let to: string;
			try {
				for (const part of await deps.parts(sessionPath)) {
					let offset = 0;
					do {
						const bytes = await part.read(offset, Math.min(HANDOFF_PART_BYTES, part.size - offset));
						if (bytes.length === 0 && offset < part.size)
							throw new Error(`The session file changed while it was being transferred: ${part.rel}`);
						await deps.request(
							host,
							"sessions.handoff.put",
							{ id: pending.id, rel: part.rel, offset, dataBase64: Buffer.from(bytes).toString("base64") },
							HANDOFF_TIMEOUT_MS,
						);
						offset += bytes.length;
						if (bytes.length === 0) break;
					} while (offset < part.size);
				}
				({ sessionPath: to } = await deps.request<{ sessionPath: string }>(
					host,
					"sessions.handoff.commit",
					{ id: pending.id, fileName: session, cwd: folder },
					HANDOFF_TIMEOUT_MS,
				));
				if (typeof to !== "string" || to.length === 0) throw new Error("The host did not confirm a session path");
			} catch (error) {
				const settled = await settleHandOff(pending, deps);
				if (settled.state === "moved") {
					tellDevices?.();
					return { sessionPath: settled.sessionPath, cwd: folder };
				}
				deps.log?.("failed", { device: host, session, reason: reasonOf(error) });
				if (settled.state === "pending")
					throw codedError(
						"handoff_pending",
						`The other computer stopped answering; the session waits until it does (${reasonOf(error)})`,
					);
				throw codedError("handoff_failed", reasonOf(error));
			}
			await finishHandOff(pending, to, deps);
			tellDevices?.();
			return { sessionPath: to, cwd: folder };
		} finally {
			settling.delete(pending.id);
		}
	} catch (error) {
		const code = ipcErrorCode(error);
		if (code && code !== "handoff_failed" && code !== "handoff_pending")
			deps.log?.("refused", { device: host, session, reason: code });
		throw error;
	} finally {
		const remaining = (deleting.get(key) ?? 1) - 1;
		if (remaining === 0) deleting.delete(key);
		else deleting.set(key, remaining);
	}
}

/**
 * Settle every transfer to `host` still pending (its link came up, or this computer restarted mid-transfer): taken,
 * given back, or still pending when `host` does not answer.
 */
export async function reconcileHandOffs(host: string, deps: HandOffDeps): Promise<void> {
	for (const pending of deletedSessions().pendingHandoffs()) {
		if (pending.device !== host || settling.has(pending.id)) continue;
		settling.add(pending.id);
		try {
			await settleHandOff(pending, deps);
		} finally {
			settling.delete(pending.id);
		}
	}
}
