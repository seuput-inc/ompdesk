import { createHash } from "node:crypto";
// The frozen v0.131.0 client is electron-updater's; it stays a dev dependency for this comparison only.
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { stopCore } from "./core/process";
import { type FeedServer, serveFeed } from "./update-feed-test-rig";
import {
	lookupRelease,
	macosForDarwin,
	RELEASE_LOOKUP_ERROR,
	ReleaseFeedError,
	UPDATE_COMPATIBILITY_ERROR,
	UPDATE_METADATA_ERROR,
	type UpdatePlatform,
} from "./update-release";
import {
	releaseUpdateProvider as frozenProvider,
	type ReleaseFeed,
} from "./update-release.fixtures/v0.131.0/update-provider";
import { parseUpdateMetadata as parseFrozenMetadata } from "./update-release.fixtures/v0.131.0/update-release";

afterAll(stopCore);

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

/** The released v0.131.0 client: its electron-updater provider over an in-memory GitHub. */
function frozenFeed(platform: UpdatePlatform, responseBody = JSON.stringify(payload())) {
	const requests: { url: string; headers: Record<string, string> }[] = [];
	const resolved: unknown[] = [];
	const feed: ReleaseFeed = {
		apiRepo: API,
		platform,
		allowPrerelease: false,
		apiHeaders: headers,
		downloadHeaders,
		fetch: async (url, init) => {
			requests.push({ url, headers: init.headers });
			return new Response(responseBody);
		},
		onResolved: release => resolved.push(release),
	};
	const Provider = frozenProvider(feed);
	const provider = new Provider({ provider: "custom" }, undefined, {
		isUseMultipleRangeRequest: false,
		platform: platform === "mac" ? "darwin" : "win32",
		executor: new ElectronHttpExecutor(),
	});
	return { feed, provider, requests, resolved };
}

let feed: FeedServer | undefined;
afterEach(async () => {
	await feed?.close();
	feed = undefined;
});

/** The current client: the core's lookup of a stand-in GitHub answering `body`. */
async function current(platform: UpdatePlatform, systemVersion: string, body = JSON.stringify(payload())) {
	await feed?.close();
	feed = await serveFeed({ body });
	return lookupRelease({ apiRepo: API, platform, allowPrerelease: false, token: "test-token", systemVersion });
}

describe("released and current updater compatibility", () => {
	it.each([
		["mac", mac, 11],
		["windows", windows, 12],
	] as const)(
		"the frozen v0.131 consumer admits the v1 %s asset without enforcing the optional minimum",
		async (platform, file, assetId) => {
			const { provider, requests, resolved } = frozenFeed(platform);
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

	describe("with 20,000 nested arrays in the answer", () => {
		const deepField = "<deep array>";
		const nestedArray = `${"[".repeat(20_000)}0${"]".repeat(20_000)}`;
		function responseWithDeepFields(value: unknown) {
			return JSON.stringify(value).replaceAll(JSON.stringify(deepField), nestedArray);
		}
		const release = payload();
		const unknownFields = responseWithDeepFields([
			{ ...release, extra: deepField, assets: release.assets.map(asset => ({ ...asset, extra: deepField })) },
		]);
		const deepSize = responseWithDeepFields({ ...release, assets: [{ ...release.assets[0], size: deepField }] });
		const refusal = {
			code: RELEASE_LOOKUP_ERROR,
			message: "Unexpected release payload: assets.0.size: Invalid input: expected number, received array",
		};

		it("both clients admit a release list with them in unknown release and asset fields", async () => {
			const frozen = frozenFeed("windows", unknownFields);
			frozen.feed.allowPrerelease = true;
			const info = await frozen.provider.getLatestVersion();
			expect(info.files).toEqual([{ url: windows.name, sha512: windows.sha512, size: windows.size }]);
			feed = await serveFeed({ body: unknownFields });
			const now = await lookupRelease({
				apiRepo: API,
				platform: "windows",
				allowPrerelease: true,
				token: "test-token",
			});
			expect(now.file).toEqual({ name: windows.name, sha512: windows.sha512, size: windows.size });
			expect(now.assetUrl).toBe(`${API}/releases/assets/12`);
			expect(feed.requests.map(request => request.url)).toEqual([`${API}/releases?per_page=30`]);
		});

		it("both clients refuse them in a known asset size", async () => {
			const frozen = frozenFeed("mac", deepSize);
			await expect(frozen.provider.getLatestVersion()).rejects.toMatchObject(refusal);
			expect(frozen.resolved).toEqual([]);
			await expect(current("mac", "23.0.0", deepSize)).rejects.toMatchObject(refusal);
		});
	});

	it("documents the legacy limitation: the frozen parser strips the Mac minimum", () => {
		const parsed = parseFrozenMetadata(payload().body);
		expect(parsed.files.mac).toEqual({ name: mac.name, size: mac.size, sha512: mac.sha512 });
		expect(parsed.files.mac).not.toHaveProperty("minimumSystemVersion");
	});

	it.each(["21.0.0", "22.0.0", "invalid", "23.0.0-beta", ""])(
		"rejects Darwin %s before answering a release",
		async systemVersion => {
			await expect(current("mac", systemVersion)).rejects.toMatchObject({
				code: UPDATE_COMPATIBILITY_ERROR,
				message: `Update ${metadata.version} requires Darwin 23.0.0; this system reports ${systemVersion}`,
			});
			expect(feed?.requests.map(request => request.url)).toEqual([`${API}/releases/latest`]);
		},
	);

	it("names the macOS a refused release needs, only when this system's version is known", async () => {
		await expect(current("mac", "22.0.0")).rejects.toMatchObject({
			unsupportedSystem: { version: metadata.version, minimumMacOS: "14" },
		});
		await expect(current("mac", "invalid")).rejects.toBeInstanceOf(ReleaseFeedError);
		await expect(current("mac", "invalid")).rejects.toMatchObject({ unsupportedSystem: undefined });
	});

	it.each([
		["23.0.0", "14"],
		["24.4.0", "15"],
		["25.0.0", "26"],
		["19.6.0", null],
	])("maps Darwin %s to macOS %s", (darwin, macos) => {
		expect(macosForDarwin(darwin)).toBe(macos);
	});

	it.each(["23.0.0", "24.1.0"])("admits Darwin %s with the minimum in the release", async systemVersion => {
		const release = await current("mac", systemVersion);
		expect(release.minimumSystemVersion).toBe("23.0.0");
		expect(release.file).toEqual({
			name: mac.name,
			sha512: mac.sha512,
			size: mac.size,
			minimumSystemVersion: "23.0.0",
		});
		expect(release.assetUrl).toBe(`${API}/releases/assets/11`);
	});

	it("uses the Darwin 23 floor when the optional minimum is absent", async () => {
		const file = { name: mac.name, size: mac.size, sha512: mac.sha512 };
		const body = JSON.stringify(payload({ ...metadata, files: { mac: file, windows } }));
		expect((await current("mac", "23.0.0", body)).minimumSystemVersion).toBe("23.0.0");
		await expect(current("mac", "22.0.0", body)).rejects.toMatchObject({ code: UPDATE_COMPATIBILITY_ERROR });
	});

	it("honors a release minimum above the Darwin 23 floor", async () => {
		const body = JSON.stringify(
			payload({ ...metadata, files: { mac: { ...mac, minimumSystemVersion: "24.0.0" }, windows } }),
		);
		await expect(current("mac", "23.0.0", body)).rejects.toMatchObject({ code: UPDATE_COMPATIBILITY_ERROR });
		expect((await current("mac", "24.0.0", body)).minimumSystemVersion).toBe("24.0.0");
	});

	it("admits by this system's version at each lookup, never by an earlier one", async () => {
		expect((await current("mac", "23.0.0")).version).toBe("0.132.0");
		await expect(current("mac", "22.0.0")).rejects.toMatchObject({ code: UPDATE_COMPATIBILITY_ERROR });
	});

	it.each(["", "23.x.0", "23.0.0-beta", " 23.0.0", "14.0.0"])(
		"rejects invalid metadata minimum %s",
		async minimumSystemVersion => {
			const data = { ...metadata, files: { mac: { ...mac, minimumSystemVersion }, windows } };
			await expect(current("mac", "23.0.0", JSON.stringify(payload(data)))).rejects.toMatchObject({
				code: UPDATE_METADATA_ERROR,
			});
		},
	);

	it("leaves Windows admission, integrity metadata and authorization unchanged", async () => {
		const release = await current("windows", "invalid");
		expect(release.minimumSystemVersion).toBeUndefined();
		expect(release.file).toEqual({ name: windows.name, sha512: windows.sha512, size: windows.size });
		expect(release.assetUrl).toBe(`${API}/releases/assets/12`);
		expect(feed?.requests.map(request => request.url)).toEqual([`${API}/releases/latest`]);
		expect(feed?.requests[0]?.headers).toMatchObject(headers);
	});
});
