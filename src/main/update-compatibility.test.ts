import { createHash } from "node:crypto";
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor";
import { describe, expect, it } from "vitest";
import { type ReleaseFeed, releaseUpdateProvider } from "./update-provider";
import { UPDATE_COMPATIBILITY_ERROR, UPDATE_METADATA_ERROR } from "./update-release";
import { releaseUpdateProvider as frozenProvider } from "./update-release.fixtures/v0.131.0/update-provider";
import { parseUpdateMetadata as parseFrozenMetadata } from "./update-release.fixtures/v0.131.0/update-release";

const API = "https://api.github.com/repos/seuput-inc/ompdesk";
const digest = (value: string) => createHash("sha512").update(value).digest("base64");
const mac = { name: "ompdesk-mac-arm64.dmg", size: 120, sha512: digest("mac"), minimumSystemVersion: "23.0.0" };
const windows = { name: "ompdesk-windows-setup.exe", size: 90, sha512: digest("windows") };
const metadata = { version: "0.132.0", releaseDate: "2026-11-16T12:00:00.000Z", files: { mac, windows } };
const headers = { accept: "application/vnd.github+json", authorization: "Bearer test-token" };
const downloadHeaders = { accept: "application/octet-stream", authorization: "Bearer test-token" };

function payload(data: unknown = metadata) {
	return {
		tag_name: "v0.132.0",
		name: "v0.132.0",
		body: `Notes.\n\n<!-- ompdesk-update ${JSON.stringify(data)} -->`,
		draft: false,
		prerelease: false,
		assets: [
			{ id: 11, name: mac.name, size: mac.size, url: `${API}/releases/assets/11` },
			{ id: 12, name: windows.name, size: windows.size, url: `${API}/releases/assets/12` },
		],
	};
}

function makeFeed(platform: "mac" | "windows", systemVersion: string, data: unknown = metadata) {
	const requests: { url: string; headers: Record<string, string> }[] = [];
	const resolved: unknown[] = [];
	const feed: ReleaseFeed = {
		apiRepo: API,
		platform,
		systemVersion,
		allowPrerelease: false,
		apiHeaders: headers,
		downloadHeaders,
		fetch: async (url, init) => {
			requests.push({ url, headers: init.headers });
			return new Response(JSON.stringify(payload(data)));
		},
		onResolved: release => resolved.push(release),
	};
	return { feed, requests, resolved };
}

function providerFor(factory: typeof releaseUpdateProvider | typeof frozenProvider, feed: ReleaseFeed) {
	const Provider = factory(feed);
	return new Provider({ provider: "custom" }, undefined, {
		isUseMultipleRangeRequest: false,
		platform: feed.platform === "mac" ? "darwin" : "win32",
		executor: new ElectronHttpExecutor(),
	});
}

describe("released and current updater compatibility", () => {
	it.each([
		["mac", mac, 11],
		["windows", windows, 12],
	] as const)(
		"the frozen v0.131 consumer admits the v1 %s asset without enforcing the optional minimum",
		async (platform, file, assetId) => {
			const { feed, requests, resolved } = makeFeed(platform, "23.0.0");
			const provider = providerFor(frozenProvider, feed);
			const info = await provider.getLatestVersion();
			expect(info.minimumSystemVersion).toBeUndefined();
			expect(info.files).toEqual([{ url: file.name, sha512: file.sha512, size: file.size }]);
			expect(provider.resolveFiles(info)).toEqual([
				{ url: new URL(`${API}/releases/assets/${assetId}`), info: info.files[0] },
			]);
			expect(provider.fileExtraDownloadHeaders).toEqual(downloadHeaders);
			expect(requests).toEqual([{ url: `${API}/releases/latest`, headers }]);
			expect(resolved).toHaveLength(1);
		},
	);

	it("documents the legacy limitation: the frozen parser strips the Mac minimum", () => {
		const parsed = parseFrozenMetadata(payload().body);
		expect(parsed.files.mac).toEqual({ name: mac.name, size: mac.size, sha512: mac.sha512 });
		expect(parsed.files.mac).not.toHaveProperty("minimumSystemVersion");
	});

	it.each(["21.0.0", "22.0.0", "invalid", "23.0.0-beta", ""])(
		"rejects Darwin %s before exposing a resolved release or an admitted file",
		async systemVersion => {
			const { feed, resolved } = makeFeed("mac", systemVersion);
			const provider = providerFor(releaseUpdateProvider, feed);
			await expect(provider.getLatestVersion()).rejects.toMatchObject({ code: UPDATE_COMPATIBILITY_ERROR });
			expect(resolved).toEqual([]);
			expect(() =>
				provider.resolveFiles({
					version: metadata.version,
					releaseDate: metadata.releaseDate,
					files: [],
					path: mac.name,
					sha512: mac.sha512,
				}),
			).toThrow();
		},
	);

	it.each(["23.0.0", "24.1.0"])("admits Darwin %s with the minimum in UpdateInfo", async systemVersion => {
		const { feed, resolved } = makeFeed("mac", systemVersion);
		const provider = providerFor(releaseUpdateProvider, feed);
		const info = await provider.getLatestVersion();
		expect(info.minimumSystemVersion).toBe("23.0.0");
		expect(info.files).toEqual([{ url: mac.name, sha512: mac.sha512, size: mac.size }]);
		expect(provider.resolveFiles(info)).toEqual([{ url: new URL(`${API}/releases/assets/11`), info: info.files[0] }]);
		expect(resolved).toHaveLength(1);
	});

	it("uses the Darwin 23 floor when the optional minimum is absent", async () => {
		const file = { name: mac.name, size: mac.size, sha512: mac.sha512 };
		const data = { ...metadata, files: { mac: file, windows } };
		const supported = providerFor(releaseUpdateProvider, makeFeed("mac", "23.0.0", data).feed);
		expect((await supported.getLatestVersion()).minimumSystemVersion).toBe("23.0.0");
		const unsupported = providerFor(releaseUpdateProvider, makeFeed("mac", "22.0.0", data).feed);
		await expect(unsupported.getLatestVersion()).rejects.toMatchObject({ code: UPDATE_COMPATIBILITY_ERROR });
	});

	it("honors a release minimum above the Darwin 23 floor", async () => {
		const data = { ...metadata, files: { mac: { ...mac, minimumSystemVersion: "24.0.0" }, windows } };
		const { feed, resolved } = makeFeed("mac", "23.0.0", data);
		const provider = providerFor(releaseUpdateProvider, feed);
		await expect(provider.getLatestVersion()).rejects.toMatchObject({ code: UPDATE_COMPATIBILITY_ERROR });
		expect(resolved).toEqual([]);
		const supported = providerFor(releaseUpdateProvider, makeFeed("mac", "24.0.0", data).feed);
		expect((await supported.getLatestVersion()).minimumSystemVersion).toBe("24.0.0");
	});

	it("does not reuse a prior admission after the system version becomes incompatible", async () => {
		const { feed, resolved } = makeFeed("mac", "23.0.0");
		const provider = providerFor(releaseUpdateProvider, feed);
		const info = await provider.getLatestVersion();
		expect(provider.resolveFiles(info)).toHaveLength(1);
		feed.systemVersion = "22.0.0";
		expect(() => provider.resolveFiles(info)).toThrow();
		await expect(provider.getLatestVersion()).rejects.toMatchObject({ code: UPDATE_COMPATIBILITY_ERROR });
		expect(resolved).toHaveLength(1);
		expect(() => provider.resolveFiles(info)).toThrow();
	});

	it.each(["", "23.x.0", "23.0.0-beta", " 23.0.0", "14.0.0"])(
		"rejects invalid metadata minimum %s",
		async minimumSystemVersion => {
			const data = { ...metadata, files: { mac: { ...mac, minimumSystemVersion }, windows } };
			const { feed, resolved } = makeFeed("mac", "23.0.0", data);
			const provider = providerFor(releaseUpdateProvider, feed);
			await expect(provider.getLatestVersion()).rejects.toMatchObject({ code: UPDATE_METADATA_ERROR });
			expect(resolved).toEqual([]);
		},
	);

	it("leaves Windows admission, integrity metadata and authorization unchanged", async () => {
		const { feed, requests, resolved } = makeFeed("windows", "invalid");
		const provider = providerFor(releaseUpdateProvider, feed);
		const info = await provider.getLatestVersion();
		expect(info.minimumSystemVersion).toBeUndefined();
		expect(info.files).toEqual([{ url: windows.name, sha512: windows.sha512, size: windows.size }]);
		expect(provider.resolveFiles(info)).toEqual([{ url: new URL(`${API}/releases/assets/12`), info: info.files[0] }]);
		expect(provider.fileExtraDownloadHeaders).toEqual(downloadHeaders);
		expect(requests).toEqual([{ url: `${API}/releases/latest`, headers }]);
		expect(resolved).toHaveLength(1);
	});
});
