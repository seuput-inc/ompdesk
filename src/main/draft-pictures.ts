/**
 * A composer draft's pictures, kept beside the draft the renderer saves in `localStorage`, so they outlive a relaunch
 * of the app or of a phone's page. The core owns the files, owner-folder hashing, UUID checks, per-owner serial lanes,
 * size budgets and 0600/0700 atomic writes (`crates/core/src/web/draft_pictures.rs`). This module decodes the IPC
 * base64 payload into raw wire bytes and registers the IPC channels.
 */
import { codedError, isIpcErrorCode } from "../shared/ipc-error-codes";
import { IPC_COMMANDS } from "../shared/ipc-types";
import { type CoreAnswer, CoreError, core } from "./core/process";
import type { IpcCaller, IpcRegistry } from "./web/ipc-registry";
import { WebClientWindow } from "./web/web-client-window";

/** One picture's bytes at most: a phone's upload limit (web/uploads.ts), so any picture a page can send it can keep. */
export const DRAFT_PICTURE_MAX_BYTES = 25 * 1024 * 1024;
/** One owner's pictures together at most: a renderer that lost its drafts (and with them the ids) cannot fill the disk. */
export const DRAFT_PICTURES_OWNER_MAX_BYTES = 256 * 1024 * 1024;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64_MAX_CHARS = Math.ceil(DRAFT_PICTURE_MAX_BYTES / 3) * 4;

/** Whose pictures a call reaches: null is this computer's own windows, else a paired web device's id. */
export type DraftPictureOwner = string | null;

/** The bytes of an `ImageContent` a caller sent; throws on anything else or past the size limit. */
function pictureBytes(content: unknown): Buffer {
	if (typeof content !== "object" || content === null) throw codedError("invalid_content", "No picture to keep");
	const { type, data, mimeType } = content as Record<string, unknown>;
	if (type !== "image" || typeof data !== "string" || typeof mimeType !== "string" || data === "")
		throw codedError("invalid_content", "No picture to keep");
	if (data.length > BASE64_MAX_CHARS) throw codedError("file_too_large", "This picture is too large to keep");
	if (data.length % 4 !== 0 || !BASE64.test(data))
		throw codedError("invalid_content", "The picture's data is damaged");
	return Buffer.from(data, "base64");
}

async function call<T>(method: string, params: Record<string, unknown>, bin?: Uint8Array): Promise<CoreAnswer<T>> {
	try {
		return await core().call<T>(method, params, bin ? { bin } : undefined);
	} catch (error) {
		if (!(error instanceof CoreError)) throw error;
		throw isIpcErrorCode(error.code) ? codedError(error.code, error.message) : new Error(error.message);
	}
}

export class DraftPictures {
	readonly #root: string;

	constructor(root: string) {
		this.#root = root;
	}

	async put(owner: DraftPictureOwner, id: unknown, content: unknown): Promise<void> {
		const bytes = pictureBytes(content);
		await call("web.draftPicturesPut", { root: this.#root, owner, id }, bytes);
	}

	/** The picture's bytes as base64; null only when it is not kept (never put, removed, or its device revoked). */
	async read(owner: DraftPictureOwner, id: unknown): Promise<string | null> {
		const { result, bin } = await call<{ found: boolean }>("web.draftPicturesRead", {
			root: this.#root,
			owner,
			id,
		});
		return result.found && bin ? Buffer.from(bin).toString("base64") : null;
	}

	async remove(owner: DraftPictureOwner, id: unknown): Promise<void> {
		await call("web.draftPicturesRemove", { root: this.#root, owner, id });
	}

	/** Every picture a revoked device kept. */
	async removeDevice(deviceId: string): Promise<void> {
		await call("web.draftPicturesRemoveDevice", { root: this.#root, deviceId });
	}
}

/** A paired web page's calls reach its device's pictures; every desktop window shares this computer's. */
function ownerOf(caller: IpcCaller): DraftPictureOwner {
	return caller.win instanceof WebClientWindow ? caller.win.deviceId : null;
}

export function registerDraftPicturesIpc(ipc: Pick<IpcRegistry, "handle">, pictures: DraftPictures): void {
	ipc.handle(IPC_COMMANDS.DRAFT_PICTURES_PUT, (caller, id: unknown, content: unknown) =>
		pictures.put(ownerOf(caller), id, content),
	);
	ipc.handle(IPC_COMMANDS.DRAFT_PICTURES_READ, (caller, id: unknown) => pictures.read(ownerOf(caller), id));
	ipc.handle(IPC_COMMANDS.DRAFT_PICTURES_REMOVE, (caller, id: unknown) => pictures.remove(ownerOf(caller), id));
}
