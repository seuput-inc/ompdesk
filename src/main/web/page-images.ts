/** A full `get_transcript` joins arbitrarily many bridge pages (local/sessions.ts). Lift its pictures before
 * `JSON.stringify`: the aggregate can exceed V8's string length limit even though each picture fits in a blob.
 * A native lift needs that reply to carry bounded transcript pieces on the same ordered send, not one JSON string.
 * The core registers the tab on the ordered byte push and drops its pictures when the device no longer lists it.
 */
import { mapImagePayloads } from "../../../resources/gui-bridge/stock-helper/image-payloads";
import type { BlobStore } from "./blobs";

/** Base64 characters of a picture from which it goes behind a blob (about 190 KB of image). */
export const PAGE_IMAGE_MIN_CHARS = 256 * 1024;
const IMAGE_MIME = /^image\/[\w.+-]+$/i;

export class PageImages {
	readonly #blobs: Pick<BlobStore, "addBytes">;

	constructor(blobs: Pick<BlobStore, "addBytes">) {
		this.#blobs = blobs;
	}

	lift<T>(deviceId: string, tabId: string | undefined, value: T): T {
		return mapImagePayloads(
			value,
			(record, data) => {
				if (data.length < PAGE_IMAGE_MIN_CHARS) return null;
				const mime = typeof record.mimeType === "string" ? record.mimeType : "image/png";
				if (!IMAGE_MIME.test(mime)) return null;
				const url = this.#blobs.addBytes(deviceId, Buffer.from(data, "base64"), mime, "picture", tabId);
				return { ...record, data: "", blobUrl: url };
			},
			// The composer takes queued pictures back for editing, so their bytes must reach the page.
			record => record.type === "queue_update",
		);
	}
}
