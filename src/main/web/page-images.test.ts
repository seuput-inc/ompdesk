import { describe, expect, it, vi } from "vitest";
import { PAGE_IMAGE_MIN_CHARS, PageImages } from "./page-images";

function fakeBlobs() {
	let minted = 0;
	const added: { deviceId: string; bytes: Buffer; mime: string; url: string }[] = [];
	const released: { deviceId: string; url: string }[] = [];
	return {
		added,
		released,
		addBytes: vi.fn((deviceId: string, bytes: Uint8Array, mime: string) => {
			const url = `/blob/tok${++minted}`;
			added.push({ deviceId, bytes: Buffer.from(bytes), mime, url });
			return url;
		}),
		release: vi.fn(async (deviceId: string, url: string) => {
			released.push({ deviceId, url });
			return true;
		}),
	};
}

/** Base64 of `bytes` zero bytes, as long as the picture the page is not sent inline. */
const large = Buffer.alloc((PAGE_IMAGE_MIN_CHARS * 3) / 4).toString("base64");
const small = Buffer.alloc(1024).toString("base64");

const userMessage = (...pictures: object[]) => ({
	role: "user",
	content: [{ type: "text", text: "look" }, ...pictures],
});

describe("PageImages.lift", () => {
	it("keeps a picture below the size threshold inline and hands back the very value", () => {
		const blobs = fakeBlobs();
		const message = userMessage({ type: "image", mimeType: "image/png", data: small });
		const lifted = new PageImages(blobs).lift("dev1", "tab-a", message);
		expect(lifted).toBe(message);
		expect(blobs.addBytes).not.toHaveBeenCalled();
	});

	it("puts a picture at the threshold behind a blob URL and leaves the original untouched", () => {
		expect(large.length).toBeGreaterThanOrEqual(PAGE_IMAGE_MIN_CHARS);
		const justUnder = Buffer.alloc((PAGE_IMAGE_MIN_CHARS * 3) / 4 - 3).toString("base64");
		expect(justUnder.length).toBeLessThan(PAGE_IMAGE_MIN_CHARS);
		const blobs = fakeBlobs();
		const picture = { type: "image", mimeType: "image/jpeg", data: large };
		const stays = { type: "image", mimeType: "image/jpeg", data: justUnder };
		const message = userMessage(picture, stays);
		const lifted = new PageImages(blobs).lift("dev1", "tab-a", message);
		expect(lifted.content[1]).toEqual({ type: "image", mimeType: "image/jpeg", data: "", blobUrl: "/blob/tok1" });
		expect(lifted.content[2]).toBe(stays);
		expect(lifted.content[0]).toBe(message.content[0]);
		expect(picture.data).toBe(large);
		expect(blobs.added).toHaveLength(1);
		expect(blobs.added[0]?.bytes.length).toBe((PAGE_IMAGE_MIN_CHARS * 3) / 4);
		expect(blobs.added[0]?.mime).toBe("image/jpeg");
	});

	it("registers each blob under the device the page belongs to, never one for another", () => {
		const blobs = fakeBlobs();
		const pages = new PageImages(blobs);
		const message = userMessage({ type: "image", mimeType: "image/png", data: large });
		const first = pages.lift("dev1", "tab-a", message);
		const second = pages.lift("dev2", "tab-a", message);
		expect(blobs.added.map(blob => blob.deviceId)).toEqual(["dev1", "dev2"]);
		expect(first.content[1]).not.toEqual(second.content[1]);
	});

	it("lifts the positions stock keeps pictures in and nothing else", () => {
		const blobs = fakeBlobs();
		const pages = new PageImages(blobs);
		const result = {
			content: [{ type: "image", mimeType: "image/png", data: large }],
			details: { images: [{ data: large, mimeType: "image/webp" }] },
			notes: [{ type: "text", data: large }],
		};
		const lifted = pages.lift("dev1", "tab-a", result);
		expect(lifted.content[0]).toMatchObject({ data: "", blobUrl: "/blob/tok1" });
		expect(lifted.details.images[0]).toEqual({ data: "", mimeType: "image/webp", blobUrl: "/blob/tok2" });
		expect(lifted.notes).toBe(result.notes);
	});

	it("never lifts what is not an image, or a queued message's pictures the composer takes back", () => {
		const blobs = fakeBlobs();
		const pages = new PageImages(blobs);
		const html = { type: "image", mimeType: "text/html", data: large };
		const queue = {
			type: "queue_update",
			steering: [{ text: "x", images: [{ type: "image", mimeType: "image/png", data: large }] }],
			followUp: [],
		};
		expect(pages.lift("dev1", "tab-a", userMessage(html))).toEqual(userMessage(html));
		expect(pages.lift("dev1", "tab-a", { payload: [queue] }).payload[0]).toBe(queue);
		expect(blobs.addBytes).not.toHaveBeenCalled();
	});
});

describe("PageImages.tabsChanged", () => {
	const message = userMessage({ type: "image", mimeType: "image/png", data: large });

	it("releases the pictures of a tab that left the device's tab list, once", () => {
		const blobs = fakeBlobs();
		const pages = new PageImages(blobs);
		pages.lift("dev1", "tab-a", message);
		pages.lift("dev1", "tab-a", message);
		pages.lift("dev1", "tab-b", message);
		pages.tabsChanged("dev1", new Set(["tab-b"]));
		expect(blobs.released).toEqual([
			{ deviceId: "dev1", url: "/blob/tok1" },
			{ deviceId: "dev1", url: "/blob/tok2" },
		]);
		pages.tabsChanged("dev1", new Set(["tab-b"]));
		expect(blobs.released).toHaveLength(2);
		pages.tabsChanged("dev1", new Set());
		expect(blobs.released.at(-1)).toEqual({ deviceId: "dev1", url: "/blob/tok3" });
	});

	it("leaves another device's tab of the same id alone", () => {
		const blobs = fakeBlobs();
		const pages = new PageImages(blobs);
		pages.lift("dev1", "tab-a", message);
		pages.lift("dev2", "tab-a", message);
		pages.tabsChanged("dev1", new Set());
		expect(blobs.released).toEqual([{ deviceId: "dev1", url: "/blob/tok1" }]);
	});

	it("keeps the pictures no tab owns until the device goes", () => {
		const blobs = fakeBlobs();
		const pages = new PageImages(blobs);
		pages.lift("dev1", undefined, message);
		pages.tabsChanged("dev1", new Set());
		expect(blobs.released).toEqual([]);
	});

	it("forgets a device's pictures, so a later tab list releases nothing for it", () => {
		const blobs = fakeBlobs();
		const pages = new PageImages(blobs);
		pages.lift("dev1", "tab-a", message);
		pages.forgetDevice("dev1");
		pages.tabsChanged("dev1", new Set());
		expect(blobs.released).toEqual([]);
	});

	it("does not fail when the store has already dropped a blob", async () => {
		const blobs = fakeBlobs();
		blobs.release.mockRejectedValueOnce(new Error("core gone"));
		const pages = new PageImages(blobs);
		pages.lift("dev1", "tab-a", message);
		expect(() => pages.tabsChanged("dev1", new Set())).not.toThrow();
		await Promise.resolve();
	});
});
