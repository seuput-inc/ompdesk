import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IPC_COMMANDS } from "../shared/ipc-types";
import { DRAFT_PICTURE_MAX_BYTES, DraftPictures, registerDraftPicturesIpc } from "./draft-pictures";
import type { IpcCaller } from "./web/ipc-registry";
import { WebClientWindow } from "./web/web-client-window";

const ID = "0b5c1e2a-7d4f-4c8e-9a1b-3f6e2d9c8a71";
const OTHER = "9f3e2d1c-0b4a-4e5f-8a7b-6c5d4e3f2a10";
const png = (text: string) => ({ type: "image", mimeType: "image/png", data: Buffer.from(text).toString("base64") });
const b64 = (text: string) => Buffer.from(text).toString("base64");

let root: string;
let pictures: DraftPictures;

beforeEach(() => {
	root = join(mkdtempSync(join(tmpdir(), "draft-pictures-")), "draft-pictures");
	pictures = new DraftPictures(root);
});
afterEach(() => rmSync(join(root, ".."), { recursive: true, force: true }));

describe("draft pictures", () => {
	it("keeps a picture's bytes owner-only, reads it back as base64 and forgets it on remove", async () => {
		await pictures.put(null, ID, png("PNG bytes"));
		await expect(pictures.read(null, ID)).resolves.toBe(b64("PNG bytes"));
		if (process.platform !== "win32") {
			expect(statSync(root).mode & 0o777).toBe(0o700);
			expect(statSync(join(root, "desktop")).mode & 0o777).toBe(0o700);
			expect(statSync(join(root, "desktop", ID)).mode & 0o777).toBe(0o600);
		}
		await pictures.remove(null, ID);
		await expect(pictures.read(null, ID)).resolves.toBeNull();
		// Removing what is not kept is no error.
		await expect(pictures.remove(null, ID)).resolves.toBeUndefined();
	});

	it("keeps each paired device's pictures apart from this computer's and from each other's", async () => {
		await pictures.put("phone-a", ID, png("A"));
		await expect(pictures.read(null, ID)).resolves.toBeNull();
		await expect(pictures.read("phone-b", ID)).resolves.toBeNull();
		await expect(pictures.read("phone-a", ID)).resolves.toBe(b64("A"));
		// A device's folder is a hash of its id, never the id as a path.
		await pictures.put("../escape", OTHER, png("E"));
		expect(readdirSync(root).every(name => name === "desktop" || /^device-[0-9a-f]{32}$/.test(name))).toBe(true);
		await pictures.removeDevice("phone-a");
		await expect(pictures.read("phone-a", ID)).resolves.toBeNull();
		await expect(pictures.read("../escape", OTHER)).resolves.toBe(b64("E"));
	});

	it("lets the call made last win: a remove or read made while a put is writing waits for it", async () => {
		const put = pictures.put(null, ID, png("first"));
		const removed = pictures.remove(null, ID);
		const afterRemove = pictures.read(null, ID);
		const again = pictures.put(null, ID, png("second"));
		const afterPut = pictures.read(null, ID);
		await Promise.all([put, removed, again]);
		await expect(afterRemove).resolves.toBeNull();
		await expect(afterPut).resolves.toBe(b64("second"));
	});

	it("goes on after a call that failed in its turn, and says a damaged picture is no missing one", async () => {
		// A folder where the picture's file belongs: the read fails (it is not "not kept").
		mkdirSync(join(root, "desktop", ID), { recursive: true });
		const failed = pictures.read(null, ID);
		const kept = pictures.put(null, OTHER, png("ok"));
		await expect(failed).rejects.toThrow();
		await kept;
		await expect(pictures.read(null, OTHER)).resolves.toBe(b64("ok"));
	});

	it("refuses an id that is not a UUID, content that is no picture, and a picture past the limit", async () => {
		for (const id of ["../x", "", "0B5C1E2A-7D4F-4C8E-9A1B-3F6E2D9C8A71", 5])
			await expect(pictures.put(null, id, png("x"))).rejects.toThrow("[invalid_name]");
		await expect(pictures.read(null, "../../etc/passwd")).rejects.toThrow("[invalid_name]");
		const text = { type: "text", data: b64("x"), mimeType: "image/png" };
		await expect(pictures.put(null, ID, text)).rejects.toThrow("[invalid_content]");
		await expect(pictures.put(null, ID, null)).rejects.toThrow("[invalid_content]");
		const tooLong = "A".repeat(Math.ceil(DRAFT_PICTURE_MAX_BYTES / 3) * 4 + 4);
		const huge = { type: "image", mimeType: "image/png", data: tooLong };
		await expect(pictures.put(null, ID, huge)).rejects.toThrow("[file_too_large]");
		await expect(pictures.read(null, ID)).resolves.toBeNull();
	});

	it("answers a desktop window from this computer's pictures and a paired page from its device's", async () => {
		const handlers = new Map<string, (caller: IpcCaller, ...args: unknown[]) => unknown>();
		registerDraftPicturesIpc(
			{ handle: (channel, handler) => void handlers.set(channel, handler as never) },
			pictures,
		);
		const page = new WebClientWindow("phone-a", -1, () => {});
		const pageCaller = { win: page, browserWindow: null, sender: page.webContents } as IpcCaller;
		const desktopCaller = { win: null, browserWindow: null, sender: { id: 1, once: () => {} } } as IpcCaller;
		await handlers.get(IPC_COMMANDS.DRAFT_PICTURES_PUT)?.(pageCaller, ID, png("phone"));
		await expect(handlers.get(IPC_COMMANDS.DRAFT_PICTURES_READ)?.(desktopCaller, ID)).resolves.toBeNull();
		await expect(handlers.get(IPC_COMMANDS.DRAFT_PICTURES_READ)?.(pageCaller, ID)).resolves.toBe(b64("phone"));
		await handlers.get(IPC_COMMANDS.DRAFT_PICTURES_REMOVE)?.(pageCaller, ID);
		await expect(pictures.read("phone-a", ID)).resolves.toBeNull();
	});
});
