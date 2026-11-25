import { createHash } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { stopCore } from "./core/process";
import { type FeedServer, serveFeed } from "./update-feed-test-rig";
import {
	lookupRelease,
	NO_RELEASE_ERROR,
	RELEASE_LOOKUP_ERROR,
	UPDATE_ASSETS,
	UPDATE_METADATA_ERROR,
	type UpdatePlatform,
} from "./update-release";

afterAll(stopCore);

const API = "https://api.github.com/repos/SeuPut0705/ompdesk";
const sha512 = (bytes: string) => createHash("sha512").update(bytes).digest("base64");

const metadata = {
	version: "0.18.0",
	releaseDate: "2026-10-09T12:00:00.000Z",
	files: {
		mac: { name: UPDATE_ASSETS.mac, size: 120, sha512: sha512("mac") },
		windows: { name: UPDATE_ASSETS.windows, size: 90, sha512: sha512("windows") },
	},
};

const releasePayload = (tag = "v0.18.0", body = `Notes.\n\n<!-- ompdesk-update ${JSON.stringify(metadata)} -->`) => ({
	tag_name: tag,
	name: tag,
	body,
	draft: false,
	prerelease: tag.includes("-"),
	html_url: `https://github.com/SeuPut0705/ompdesk/releases/tag/${tag}`,
	assets: [
		{ id: 11, name: UPDATE_ASSETS.mac, size: 120, url: `${API}/releases/assets/11` },
		{ id: 12, name: UPDATE_ASSETS.windows, size: 90, url: `${API}/releases/assets/12` },
	],
});

let feed: FeedServer | undefined;
afterEach(async () => {
	await feed?.close();
	feed = undefined;
});

async function lookup(
	answer: Parameters<typeof serveFeed>[0],
	options: { platform?: UpdatePlatform; allowPrerelease?: boolean; token?: string; timeoutMs?: number } = {},
) {
	feed = await serveFeed(answer);
	return lookupRelease({
		apiRepo: API,
		platform: options.platform ?? "windows",
		allowPrerelease: options.allowPrerelease ?? false,
		systemVersion: "23.0.0",
		...(options.token === undefined ? { token: "t" } : options.token ? { token: options.token } : {}),
		...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
	});
}

const ok = (payload: unknown, status = 200) => ({ status, body: JSON.stringify(payload) });

describe("the release lookup through the core", () => {
	it("gives up on a lookup GitHub never answers, so a check settles instead of reading Checking… forever", async () => {
		await expect(lookup("silent", { timeoutMs: 300 })).rejects.toMatchObject({ code: RELEASE_LOOKUP_ERROR });
	});

	it("gives up on a body that stalls after the headers came, too", async () => {
		await expect(lookup("stall", { timeoutMs: 300 })).rejects.toMatchObject({ code: RELEASE_LOOKUP_ERROR });
	});

	it("answers the release from the metadata comment, asking GitHub's API with the token", async () => {
		const release = await lookup(ok(releasePayload()));
		expect(feed?.requests.map(request => request.url)).toEqual([`${API}/releases/latest`]);
		const headers = feed?.requests[0]?.headers;
		expect(headers).toMatchObject({
			accept: "application/vnd.github+json",
			"x-github-api-version": "2022-11-28",
			authorization: "Bearer t",
		});
		expect(release).toMatchObject({
			version: "0.18.0",
			releaseDate: "2026-10-09T12:00:00.000Z",
			releaseName: "v0.18.0",
			// The banner shows these; the comment never reaches it.
			notes: "Notes.",
			file: { name: UPDATE_ASSETS.windows, sha512: sha512("windows"), size: 90 },
			// The installer download asks the API's asset endpoint.
			assetUrl: `${API}/releases/assets/12`,
		});
	});

	it("gives macOS the DMG of the same release", async () => {
		const release = await lookup(ok(releasePayload()), { platform: "mac" });
		expect(release.file).toEqual({ name: UPDATE_ASSETS.mac, sha512: sha512("mac"), size: 120 });
		expect(release.minimumSystemVersion).toBe("23.0.0");
		expect(release.assetUrl).toBe(`${API}/releases/assets/11`);
	});

	it("lists releases and takes the newest pre-release only when pre-releases are allowed", async () => {
		const pre = releasePayload(
			"v99.0.0-test.1",
			`<!-- ompdesk-update ${JSON.stringify({ ...metadata, version: "99.0.0-test.1" })} -->`,
		);
		expect((await lookup(ok([pre, releasePayload()]), { allowPrerelease: true })).version).toBe("99.0.0-test.1");
		expect(feed?.requests[0]?.url).toBe(`${API}/releases?per_page=30`);
	});

	it("keeps the released prerelease preference even when a newer stable appears first", async () => {
		const stable = releasePayload(
			"v100.0.0",
			`<!-- ompdesk-update ${JSON.stringify({ ...metadata, version: "100.0.0" })} -->`,
		);
		const pre = releasePayload(
			"v99.0.0-test.1",
			`<!-- ompdesk-update ${JSON.stringify({ ...metadata, version: "99.0.0-test.1" })} -->`,
		);
		expect((await lookup(ok([stable, pre]), { allowPrerelease: true })).version).toBe("99.0.0-test.1");
	});

	it("fails a release without metadata instead of offering an update", async () => {
		await expect(lookup(ok(releasePayload("v0.18.0", "Notes only.")))).rejects.toMatchObject({
			code: UPDATE_METADATA_ERROR,
		});
	});

	it("maps GitHub's answers to the codes the check classifies", async () => {
		await expect(lookup(ok({ message: "Not Found" }, 404))).rejects.toMatchObject({ code: NO_RELEASE_ERROR });
		await feed?.close();
		await expect(lookup(ok({ message: "oops" }, 502))).rejects.toMatchObject({ code: RELEASE_LOOKUP_ERROR });
	});

	describe("without a token (the repo is public)", () => {
		it("looks the release up without an Authorization header", async () => {
			const release = await lookup(ok(releasePayload()), { token: "" });
			expect(feed?.requests).toHaveLength(1);
			expect(feed?.requests[0]?.headers.authorization).toBeUndefined();
			expect(release.assetUrl).toBe(`${API}/releases/assets/12`);
		});

		it("still refuses a release whose metadata is missing or contradicts the release", async () => {
			await expect(lookup(ok(releasePayload("v0.18.0", "Notes only.")), { token: "" })).rejects.toMatchObject({
				code: UPDATE_METADATA_ERROR,
			});
			await feed?.close();
			const wrongSize = {
				...metadata,
				files: { ...metadata.files, windows: { ...metadata.files.windows, size: 91 } },
			};
			await expect(
				lookup(ok(releasePayload("v0.18.0", `<!-- ompdesk-update ${JSON.stringify(wrongSize)} -->`)), {
					token: "",
				}),
			).rejects.toMatchObject({ code: UPDATE_METADATA_ERROR });
		});
	});
});
