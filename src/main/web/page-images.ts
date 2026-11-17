/**
 * The pictures of a transcript a paired page is sent. A frame carries them as base64 inside the JSON, so one phone
 * photo (a 12 MB JPEG is 16 MB of text) made a single message past what the host queues for a page, and every resync
 * of the same transcript did it again. A picture of `PAGE_IMAGE_MIN_CHARS` or more goes behind this device's `/blob`
 * URL instead (`BlobStore.addBytes`: the token belongs to the device and is served only to its cookie, Range, 30 minutes
 * idle, the core's rules in `crates/core/src/web/blobs.rs`), and the page's image block carries `ImageContent.blobUrl`
 * with empty `data`. Smaller pictures stay inline: they cost a blob slot (64 a device) and a request for nothing.
 *
 * A tab's blobs are released when the device's tab list no longer holds the tab (`tabsChanged`, from the
 * `TAB_LIST_CHANGED` push every close and detach ends in) and with the device (`forgetDevice`); the core's idle
 * lifetime and per-device bound end the rest. Only the web router calls this: a desktop window and a paired computer's
 * link keep their pictures inline.
 */
import { mapImagePayloads } from "../local/image-blobs";
import type { BlobStore } from "./blobs";

/** Base64 characters of a picture from which it goes behind a blob (about 190 KB of image). */
export const PAGE_IMAGE_MIN_CHARS = 256 * 1024;

/** The core keeps 64 blobs a device (`MAX_PER_DEVICE`); more of them tracked here could not still exist. */
const TRACKED_PER_TAB = 64;
/** The pictures no tab owns (a stored session's read, a subagent's frames): released only with the device. */
const NO_TAB = "";
/** A media type that can only name a picture: it becomes the blob's `content-type` header. */
const IMAGE_MIME = /^image\/[\w.+-]+$/i;

type Blobs = Pick<BlobStore, "addBytes" | "release">;

/** The composer takes a queued message's pictures back to edit, so its bytes must reach the page. */
function isQueueUpdate(record: Record<string, unknown>): boolean {
	return record.type === "queue_update";
}

export class PageImages {
	readonly #blobs: Blobs;
	/** Device → tab → the `/blob` URLs minted for its pictures, oldest first. */
	readonly #urls = new Map<string, Map<string, string[]>>();

	constructor(blobs: Blobs) {
		this.#blobs = blobs;
	}

	/**
	 * `value` as the device's page gets it: each large picture of a transcript behind a blob URL of this device, on
	 * copies; `value` itself when it holds none. `tabId` is the tab the picture belongs to, when one does.
	 */
	lift<T>(deviceId: string, tabId: string | undefined, value: T): T {
		return mapImagePayloads(
			value,
			(record, data) => {
				if (data.length < PAGE_IMAGE_MIN_CHARS) return null;
				const mime = typeof record.mimeType === "string" ? record.mimeType : "image/png";
				if (!IMAGE_MIME.test(mime)) return null;
				const url = this.#blobs.addBytes(deviceId, Buffer.from(data, "base64"), mime, "picture");
				this.#track(deviceId, tabId ?? NO_TAB, url);
				return { ...record, data: "", blobUrl: url };
			},
			isQueueUpdate,
		);
	}

	/** The device's tab list now names `open`: the pictures of every other tab it had are released. */
	tabsChanged(deviceId: string, open: ReadonlySet<string>): void {
		const tabs = this.#urls.get(deviceId);
		if (!tabs) return;
		for (const [tabId, urls] of tabs) {
			if (tabId === NO_TAB || open.has(tabId)) continue;
			tabs.delete(tabId);
			for (const url of urls) this.#blobs.release(deviceId, url).catch(() => false);
		}
	}

	/** The device is gone; the store drops its blobs itself (`BlobStore.releaseDevice`). */
	forgetDevice(deviceId: string): void {
		this.#urls.delete(deviceId);
	}

	#track(deviceId: string, tabId: string, url: string): void {
		const tabs = this.#urls.get(deviceId) ?? new Map<string, string[]>();
		this.#urls.set(deviceId, tabs);
		const urls = tabs.get(tabId) ?? [];
		tabs.set(tabId, urls);
		urls.push(url);
		if (urls.length > TRACKED_PER_TAB) urls.shift();
	}
}
