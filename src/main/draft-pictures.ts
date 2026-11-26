/**
 * A composer draft's pictures, kept beside the draft the renderer saves in `localStorage`, so they outlive a relaunch
 * of the app or of a phone's page. One file of raw bytes per picture, `<userData>/draft-pictures/<owner>/<id>` (folders
 * 0700, files 0600): the owner is this computer's own windows or one paired web device (a hash of its id), never a path
 * a caller names, and the id is the UUID the renderer gave the picture. A file lives until the renderer removes it
 * (the picture left the draft, or the draft was sent or cleared) or its device is revoked.
 *
 * Each owner's calls run one after another in the order they arrived, so a remove or read made after a put never
 * overtakes it. A web page's put reaches main only after its picture went up by `POST /upload` (ws-router.ts lands
 * it), so the page's shim keeps each picture's calls in order up to here (renderer/web/shim.ts).
 */
import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { codedError } from "../shared/ipc-error-codes";
import { IPC_COMMANDS } from "../shared/ipc-types";
import { writeFileAtomic } from "./atomic-file";
import type { IpcCaller, IpcRegistry } from "./web/ipc-registry";
import { WebClientWindow } from "./web/web-client-window";

/** One picture's bytes at most: a phone's upload limit (web/uploads.ts), so any picture a page can send it can keep. */
export const DRAFT_PICTURE_MAX_BYTES = 25 * 1024 * 1024;
/** One owner's pictures together at most: a renderer that lost its drafts (and with them the ids) cannot fill the disk. */
export const DRAFT_PICTURES_OWNER_MAX_BYTES = 256 * 1024 * 1024;

/** `crypto.randomUUID()`'s form: the only names a picture's file can have. */
const PICTURE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64_MAX_CHARS = Math.ceil(DRAFT_PICTURE_MAX_BYTES / 3) * 4;

/** Whose pictures a call reaches: null is this computer's own windows, else a paired web device's id. */
export type DraftPictureOwner = string | null;

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

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

export class DraftPictures {
	readonly #root: string;
	/** The tail of each owner folder's calls: the next one starts when it settled. */
	readonly #queues = new Map<string, Promise<unknown>>();

	constructor(root: string) {
		this.#root = root;
	}

	async put(owner: DraftPictureOwner, id: unknown, content: unknown): Promise<void> {
		const { dir, name } = this.#where(owner, id);
		const bytes = pictureBytes(content);
		return this.#queued(dir, async () => {
			if ((await this.#heldBesides(dir, name)) + bytes.length > DRAFT_PICTURES_OWNER_MAX_BYTES)
				throw codedError("file_too_large", "This device keeps too many draft pictures already");
			await writeFileAtomic(join(dir, name), bytes, { mode: 0o600, dirMode: 0o700 });
		});
	}

	/** The picture's bytes as base64; null only when it is not kept (never put, removed, or its device revoked). */
	async read(owner: DraftPictureOwner, id: unknown): Promise<string | null> {
		const { dir, name } = this.#where(owner, id);
		return this.#queued(dir, () =>
			readFile(join(dir, name)).then(
				bytes => bytes.toString("base64"),
				error => {
					if (isMissing(error)) return null;
					throw error;
				},
			),
		);
	}

	async remove(owner: DraftPictureOwner, id: unknown): Promise<void> {
		const { dir, name } = this.#where(owner, id);
		return this.#queued(dir, () => rm(join(dir, name), { force: true }));
	}

	/** Every picture a revoked device kept. */
	removeDevice(deviceId: string): Promise<void> {
		const dir = this.#dir(deviceId);
		return this.#queued(dir, () => rm(dir, { recursive: true, force: true }));
	}

	#dir(owner: DraftPictureOwner): string {
		// A device id is the core's, but it never becomes a path as it is.
		const folder =
			owner === null ? "desktop" : `device-${createHash("sha256").update(owner).digest("hex").slice(0, 32)}`;
		return join(this.#root, folder);
	}

	#where(owner: DraftPictureOwner, id: unknown): { dir: string; name: string } {
		if (typeof id !== "string" || !PICTURE_ID.test(id)) throw codedError("invalid_name", "Not a draft picture's id");
		return { dir: this.#dir(owner), name: id };
	}

	/** The bytes the folder's other pictures hold (a write's temp file is no picture). */
	async #heldBesides(dir: string, name: string): Promise<number> {
		const names = await readdir(dir).catch((error: unknown) => {
			if (isMissing(error)) return [] as string[];
			throw error;
		});
		let total = 0;
		for (const other of names) {
			if (other === name || !PICTURE_ID.test(other)) continue;
			total += (await stat(join(dir, other)).catch(() => null))?.size ?? 0;
		}
		return total;
	}

	#queued<T>(dir: string, work: () => Promise<T>): Promise<T> {
		const running = (this.#queues.get(dir) ?? Promise.resolve()).then(work);
		const tail = running.then(
			() => undefined,
			() => undefined,
		);
		this.#queues.set(dir, tail);
		void tail.then(() => {
			if (this.#queues.get(dir) === tail) this.#queues.delete(dir);
		});
		return running;
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
