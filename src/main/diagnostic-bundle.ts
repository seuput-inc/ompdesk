/**
 * "Save diagnostic bundle": stock's `/dump all|anon` zip of one open session, every member redacted, with OMPdesk's
 * own redacted diagnostics text (the report Settings › Updates & about › Copy diagnostics copies) added as
 * `ompdesk-diagnostics.txt`, saved where the person chose.
 *
 * The tab's own omp writes stock's archive (`dump_session_archive`, local handler `src/main/local/session-dump.ts`
 * over the bridge's `session_dump`), so a tab on a paired host dumps on the host through the ordinary tab RPC path
 * and its bytes come back over `host.fs.readBinary`, the route a remote tab's file viewer reads with. That handler
 * redacts every member on the machine that wrote it; an archive not marked `redacted` (an older host) is refused,
 * never saved. The archive is deleted on the machine that wrote it (`discard_session_archive`) whether the save
 * worked or not. The core opens the local file (or the paired host's byte frame), adds the report and saves it.
 *
 * Electron-free: the dialog, the Downloads folder, the pool and the host link come in as `DiagnosticBundleDeps`.
 */
import path from "node:path";
import { z } from "zod";
import {
	bundleFileName,
	DIAGNOSTICS_MEMBER,
	type DiagnosticBundleRequest,
	type DiagnosticBundleResult,
} from "../shared/diagnostic-bundle";
import { codedError, type IpcErrorCode, ipcErrorCode, isIpcErrorCode } from "../shared/ipc-error-codes";
import { IPC_COMMANDS, type IpcFsReadBinaryResult } from "../shared/ipc-types";
import { timeoutForCommand } from "../shared/rpc-client";
import type { RpcCommand } from "../shared/rpc-types";
import { core } from "./core/process";
import type { SidecarPool } from "./sidecar-pool";
import type { SidecarLike } from "./sidecar-types";
import type { IpcCaller, IpcRegistry } from "./web/ipc-registry";

export interface BundleTab {
	tabId: string;
	sidecar: Pick<SidecarLike, "cwd" | "rpcClient" | "device">;
}

export interface DiagnosticBundleDeps {
	/** The tab a request names: its `tabId` among the caller's window's tabs, else the tab running `sessionPath`. */
	tabFor(caller: IpcCaller, request: DiagnosticBundleRequest): BundleTab | null;
	/** Session files the person hid from agents. */
	agentHidden(): ReadonlySet<string>;
	/** The redacted report Copy diagnostics copies. */
	diagnosticsText(): Promise<string>;
	/** A file on the paired host `device` (`host.fs.readBinary`: the host's cap applies). */
	readHostFile(tab: BundleTab & { device: string }, file: string): Promise<IpcFsReadBinaryResult>;
	/** The native save dialog; null when the person cancelled. */
	chooseFile(caller: IpcCaller, defaultPath: string): Promise<string | null>;
	downloadsDir(): string;
	now?(): Date;
}

const Request = z
	.object({
		tabId: z.string().min(1).max(256).optional(),
		sessionPath: z.string().min(1).max(4096).optional(),
		device: z.string().min(1).max(256).optional(),
		anonymized: z.boolean(),
		title: z.string().max(1000).optional(),
		destination: z
			.discriminatedUnion("kind", [
				z.object({ kind: z.literal("dialog") }),
				z.object({ kind: z.literal("downloads") }),
				z.object({ kind: z.literal("path"), path: z.string().min(1).max(4096) }),
			])
			.optional(),
		forAgent: z.literal(true).optional(),
	})
	.refine(request => request.tabId !== undefined || request.sessionPath !== undefined);

/** What a tab's omp answered; a host newer or older than this build is checked, not trusted. */
const Archive = z.object({
	path: z.string().min(1),
	files: z.array(z.string()),
	subagentCount: z.number().int().nonnegative(),
	anonymized: z.boolean(),
	redacted: z.literal(true),
	dropped: z.array(z.string()).optional(),
	subagentError: z.string().optional(),
});

function failure(code: IpcErrorCode | undefined, error: string): DiagnosticBundleResult {
	return { ok: false, error, ...(code ? { code } : {}) };
}

/** Where the zip goes, or the result that ends the call (cancelled, no window, a path that is not absolute). */
async function destinationFile(
	deps: DiagnosticBundleDeps,
	caller: IpcCaller,
	request: z.infer<typeof Request>,
	name: string,
): Promise<{ file: string; unique?: true } | { result: DiagnosticBundleResult }> {
	const destination = request.destination ?? { kind: "dialog" };
	if (destination.kind === "downloads") return { file: path.join(deps.downloadsDir(), name), unique: true };
	if (destination.kind === "path") {
		if (!path.isAbsolute(destination.path)) {
			return { result: failure("not_absolute_path", "The bundle's path must be absolute") };
		}
		const file = /\.zip$/i.test(destination.path) ? destination.path : `${destination.path}.zip`;
		return { file: path.normalize(file) };
	}
	if (!caller.browserWindow) return { result: failure("no_window", "No window to show the save dialog in") };
	const chosen = await deps.chooseFile(caller, path.join(deps.downloadsDir(), name));
	return chosen === null ? { result: { ok: false, cancelled: true } } : { file: chosen };
}

async function saveArchive(
	deps: DiagnosticBundleDeps,
	tab: BundleTab,
	anonymized: boolean,
	target: { file: string; unique?: true },
): Promise<DiagnosticBundleResult> {
	const client = tab.sidecar.rpcClient;
	if (!client) return failure("sidecar_not_connected", "The session's omp is not connected");
	const dump: RpcCommand = { type: "dump_session_archive", anonymized };
	const response = await client.command(dump, timeoutForCommand(dump));
	if (!response.success) return failure(isIpcErrorCode(response.code) ? response.code : undefined, response.error);
	const archive = Archive.safeParse(response.data);
	const written = z.object({ path: z.string().min(1) }).safeParse(response.data);
	try {
		// An older host answers its raw, unredacted archive: refused unread (and still deleted below).
		if (!archive.success)
			return failure("remote_protocol", "The omp answered the dump in a form this app does not know");
		const { device } = tab.sidecar;
		let bin: Uint8Array | undefined;
		if (device !== undefined) {
			const read = await deps.readHostFile({ ...tab, device }, archive.data.path);
			if (!read.ok) return failure(read.code, read.error ?? "The host's archive could not be read");
			if (read.truncated) return failure("file_too_large", "The host's archive was truncated");
			bin = read.data;
		}
		const { result: file } = await core().call<string>(
			"diagnosticBundle.save",
			{
				...target,
				source: device === undefined ? archive.data.path : undefined,
				diagnostics: await deps.diagnosticsText(),
			},
			{ bin, timeoutMs: timeoutForCommand(dump) },
		);
		const { files, subagentCount, anonymized: anon, subagentError, dropped } = archive.data;
		return {
			ok: true,
			path: file,
			files: [...files, DIAGNOSTICS_MEMBER],
			subagentCount,
			anonymized: anon,
			...(subagentError ? { subagentError } : {}),
			...(dropped?.length ? { dropped } : {}),
		};
	} finally {
		// Best effort: a link that dropped meanwhile leaves the host's temp file to its own cleanup.
		if (written.success) {
			const discard: RpcCommand = { type: "discard_session_archive", path: written.data.path };
			await client.command(discard).catch(() => undefined);
		}
	}
}

/** Save one open session's diagnostic bundle (see the module comment). Failures come back as results; a malformed request throws. */
export async function saveDiagnosticBundle(
	deps: DiagnosticBundleDeps,
	caller: IpcCaller,
	raw: unknown,
): Promise<DiagnosticBundleResult> {
	const parsed = Request.safeParse(raw);
	if (!parsed.success) throw codedError("invalid_content", "Invalid diagnostic bundle request");
	const request = parsed.data;
	if (request.forAgent && request.sessionPath && !request.device && deps.agentHidden().has(request.sessionPath)) {
		return failure("session_hidden", "The user hid that session from agents.");
	}
	const tab = deps.tabFor(caller, request);
	if (!tab) {
		return request.tabId
			? failure("unknown_tab", "That tab is not open")
			: failure("session_not_open", "That session is not open in a tab");
	}
	try {
		const name = bundleFileName(request.title, (deps.now ?? (() => new Date()))(), request.anonymized);
		const target = await destinationFile(deps, caller, request, name);
		if ("result" in target) return target.result;
		return await saveArchive(deps, tab, request.anonymized, target);
	} catch (error) {
		return failure(ipcErrorCode(error), error instanceof Error ? error.message : String(error));
	}
}

/** `DiagnosticBundleDeps.tabFor` over the pool: a tab id means this window's tab, a session file means whichever tab runs it. */
export function poolTabFor(
	pool: Pick<SidecarPool, "tabTarget" | "sessionOwner" | "sidecarOf">,
): DiagnosticBundleDeps["tabFor"] {
	return (caller, request) => {
		if (request.tabId !== undefined) {
			return caller.win ? pool.tabTarget(caller.win, request.tabId) : null;
		}
		const owner = request.sessionPath ? pool.sessionOwner(request.sessionPath, request.device) : null;
		const sidecar = owner ? pool.sidecarOf(owner.tabId) : null;
		return owner && sidecar ? { tabId: owner.tabId, sidecar } : null;
	};
}

export function registerDiagnosticBundleIpc(ipc: Pick<IpcRegistry, "handle">, deps: DiagnosticBundleDeps): void {
	ipc.handle(IPC_COMMANDS.SESSIONS_DUMP_BUNDLE, (caller, request: unknown) =>
		saveDiagnosticBundle(deps, caller, request),
	);
}
