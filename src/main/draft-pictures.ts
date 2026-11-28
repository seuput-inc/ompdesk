/**
 * Thin client for the draft-pictures store in `ompdesk-core` (`crates/core/src/draft_pictures.rs`).
 *
 * Page IPC (`draft-pictures:put`, `draft-pictures:read`, `draft-pictures:remove`) routes directly from
 * `tauri-shell` to `ompdesk-core` via H(c) without touching Node main for desktop pages; paired web pages
 * still land uploaded image tokens in `ws-router.ts` and delegate through the shell to the same core store.
 * Main calls `removeDevice` here when a paired device is revoked.
 */
import { core } from "./core/process";

/** One picture's bytes at most: a phone's upload limit (web/uploads.ts), so any picture a page can send it can keep. */
export const DRAFT_PICTURE_MAX_BYTES = 25 * 1024 * 1024;
/** One owner's pictures together at most: a renderer that lost its drafts (and with them the ids) cannot fill the disk. */
export const DRAFT_PICTURES_OWNER_MAX_BYTES = 256 * 1024 * 1024;

/** Whose pictures a call reaches: null is this computer's own windows, else a paired web device's id. */
export type DraftPictureOwner = string | null;

export class DraftPictures {
	readonly #root: string;

	constructor(root: string) {
		this.#root = root;
	}

	async put(owner: DraftPictureOwner, id: unknown, content: unknown): Promise<void> {
		await core().call("draftPictures.put", { root: this.#root, owner, id, content });
	}

	/** The picture's bytes as base64; null only when it is not kept (never put, removed, or its device revoked). */
	async read(owner: DraftPictureOwner, id: unknown): Promise<string | null> {
		const { result } = await core().call<{ data: string | null }>("draftPictures.read", {
			root: this.#root,
			owner,
			id,
		});
		return result.data;
	}

	async remove(owner: DraftPictureOwner, id: unknown): Promise<void> {
		await core().call("draftPictures.remove", { root: this.#root, owner, id });
	}

	/** Every picture a revoked device kept. */
	async removeDevice(deviceId: string): Promise<void> {
		await core().call("draftPictures.removeDevice", { root: this.#root, deviceId });
	}
}
