/**
 * A file attached to a prompt of a paired host's tab, sent to that host (ipc.ts `FS_UPLOAD_TO_HOST`): up to one link
 * frame in one `host.files.upload`, which every host takes; a larger file in `host.files.uploadPart` parts, in order,
 * the last answering the path. A host from before 0.69.0 refuses parts as `unsupported`.
 */
import { randomUUID } from "node:crypto";
import { ipcErrorCode } from "../../shared/ipc-error-codes";
import {
	HOST_UPLOAD_FRAME_BYTES,
	HOST_UPLOAD_MAX_BYTES,
	HOST_UPLOAD_PART_BYTES,
	type IpcFsUploadToHostResult,
} from "../../shared/ipc-types";
import { HOST_UPLOAD_TIMEOUT_MS, HostUploadPartReply, HostUploadReply } from "./app-protocol";

/** One request to the host (RemoteDevices.request with the tab's device, rtab and cwd filled in). */
export type HostRequest = (method: string, params: object, timeoutMs: number) => Promise<unknown>;

/**
 * Files sent to paired hosts at once, from every window (Orca's bounded drop admission, 25 Nov 2026): each is held in
 * memory whole and as base64, so a drop of many large files waits its turn instead of all of them at once.
 */
export const HOST_UPLOADS_AT_ONCE = 2;
let sending = 0;
const waiting: (() => void)[] = [];

/** A slot among {@link HOST_UPLOADS_AT_ONCE}, waited for; false when `signal` ended the wait first. */
async function admit(signal: AbortSignal | undefined): Promise<boolean> {
	if (signal?.aborted) return false;
	if (sending < HOST_UPLOADS_AT_ONCE) {
		sending++;
		return true;
	}
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const turn = () => {
		signal?.removeEventListener("abort", leave);
		resolve(true);
	};
	const leave = () => {
		waiting.splice(waiting.indexOf(turn), 1);
		resolve(false);
	};
	waiting.push(turn);
	signal?.addEventListener("abort", leave, { once: true });
	return promise;
}

function release(): void {
	const next = waiting.shift();
	// The slot passes straight to the next waiter, so `sending` stays as it is.
	if (next) next();
	else sending--;
}

/**
 * `signal`: the window that attached the file closed. A file still waiting for its slot is never sent; one being sent
 * in parts stops before its next part (the host drops an unfinished upload).
 */
export async function uploadToHost(
	request: HostRequest,
	name: string,
	data: Uint8Array,
	signal?: AbortSignal,
): Promise<IpcFsUploadToHostResult> {
	if (data.byteLength > HOST_UPLOAD_MAX_BYTES)
		return { ok: false, error: "File too large to send", code: "file_too_large" };
	if (!(await admit(signal))) return { ok: false, error: "The window closed before the file was sent" };
	try {
		if (data.byteLength <= HOST_UPLOAD_FRAME_BYTES) {
			const raw = await request(
				"host.files.upload",
				{ name, dataBase64: Buffer.from(data).toString("base64") },
				HOST_UPLOAD_TIMEOUT_MS,
			);
			return { ok: true, path: HostUploadReply.parse(raw).path };
		}
		const upload = randomUUID();
		for (let start = 0, index = 0; ; start += HOST_UPLOAD_PART_BYTES, index++) {
			if (signal?.aborted) return { ok: false, error: "The window closed before the file was sent" };
			const end = Math.min(start + HOST_UPLOAD_PART_BYTES, data.byteLength);
			const last = end === data.byteLength;
			const dataBase64 = Buffer.from(data.subarray(start, end)).toString("base64");
			const reply = HostUploadPartReply.parse(
				await request("host.files.uploadPart", { upload, index, last, name, dataBase64 }, HOST_UPLOAD_TIMEOUT_MS),
			);
			if (last) {
				if (!("path" in reply)) throw new Error("The host answered the last part without the file's path");
				return { ok: true, path: reply.path };
			}
		}
	} catch (error) {
		const code = ipcErrorCode(error);
		return { ok: false, error: error instanceof Error ? error.message : String(error), ...(code ? { code } : {}) };
	} finally {
		release();
	}
}
