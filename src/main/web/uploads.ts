/**
 * `POST /upload`: a file from the phone (a photo, an attachment) lands on the host so an agent can read it.
 * The store lives in the core (`crates/core/src/web/uploads.rs`), shared with the web server there: it keeps the
 * file at `<userData>/web-uploads/<deviceId>/<uuid>/<name>` (dirs 0700, files 0600), at most 25 MiB each and
 * 200 MiB per device in any 24 hours, and deletes it 24 hours after arriving. This is the typed client the rest of
 * main calls: a paired computer's attachment (`store`), a picture a call names (`take`, read and deleted at
 * once), a revoked device's folder (`removeDevice`), the daily sweep.
 */
import { CoreError, core } from "../core/process";

export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

type LocalAttachment =
	| { ok: true; path: string }
	| { ok: false; error: string; code?: "file_too_large" | "upload_refused" };

export class UploadError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "UploadError";
		this.status = status;
	}
}

export interface StoredUpload {
	path: string;
	name: string;
	size: number;
}

export class UploadStore {
	readonly #userData: string;
	readonly #now: () => number;
	readonly #limits: { fileMaxBytes?: number; dailyMaxBytes?: number; ttlMs?: number };

	constructor(opts: {
		userData: string;
		now?: () => number;
		fileMaxBytes?: number;
		dailyMaxBytes?: number;
		ttlMs?: number;
	}) {
		this.#userData = opts.userData;
		this.#now = opts.now ?? Date.now;
		this.#limits = { fileMaxBytes: opts.fileMaxBytes, dailyMaxBytes: opts.dailyMaxBytes, ttlMs: opts.ttlMs };
	}

	/** A paired transfer finishes in this same store, with the same clock and limits. */
	writeOptions() {
		return { userData: this.#userData, now: this.#now(), limits: this.#limits };
	}

	/**
	 * A file a paired computer attached to a prompt of a tab it runs here (`host.files.upload`): the same folder,
	 * limits and lifetime as a phone's upload, so the agent reads it by its path here.
	 */
	async store(deviceId: string, name: string, bytes: Uint8Array): Promise<StoredUpload> {
		return (await this.#call<StoredUpload>("web.uploads.store", { deviceId, name, ...this.writeOptions() }, bytes))
			.result;
	}

	async attachHere(name: string, bytes: Uint8Array): Promise<LocalAttachment> {
		try {
			return (await this.#call<LocalAttachment>("web.uploads.attachHere", { name, ...this.writeOptions() }, bytes))
				.result;
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	/**
	 * The bytes of `file`, an upload of this device that a call names (a prompt's photo: web-protocol.ts
	 * `WebUploadedImage`), and the upload is gone, its bytes now ride the call. 404 when it is not this device's or
	 * no longer there.
	 */
	async take(deviceId: string, file: string): Promise<Buffer> {
		const { bin } = await this.#call("web.uploads.take", { deviceId, file });
		return bin ? Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength) : Buffer.alloc(0);
	}

	/** Delete uploads older than the TTL; returns how many went. */
	async sweep(): Promise<number> {
		return (await this.#call<{ removed: number }>("web.uploads.sweep", { now: this.#now(), limits: this.#limits }))
			.result.removed;
	}

	/** Delete everything a device uploaded (it was revoked). */
	async removeDevice(deviceId: string): Promise<void> {
		await this.#call("web.uploads.removeDevice", { deviceId });
	}

	/** A refusal of the core's store (`upload_<status>`) is an `UploadError`, as the page and the composer read it. */
	async #call<T>(method: string, params: object, bin?: Uint8Array) {
		try {
			return await core().call<T>(method, { userData: this.#userData, ...params }, bin ? { bin } : {});
		} catch (error) {
			if (error instanceof CoreError) {
				const status = /^upload_(\d+)$/.exec(error.code)?.[1];
				if (status !== undefined) throw new UploadError(Number(status), error.message);
			}
			throw error;
		}
	}
}
