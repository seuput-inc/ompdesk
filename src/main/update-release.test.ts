import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { stopCore } from "./core/process";
import { ReleaseFeedError, resolvePlatformRelease, UPDATE_ASSETS, type UpdatePlatform } from "./update-release";
import * as frozen from "./update-release.fixtures/v0.131.0/update-release";

afterAll(stopCore);

const sha512 = (bytes: string) => createHash("sha512").update(bytes).digest("base64");

const METADATA = {
	version: "0.18.0",
	releaseDate: "2026-10-09T12:00:00.000Z",
	files: {
		mac: { name: UPDATE_ASSETS.mac, size: 120, sha512: sha512("mac") },
		windows: { name: UPDATE_ASSETS.windows, size: 90, sha512: sha512("windows") },
	},
};

/** The comment exactly as the publish job's jq writes it. */
const comment = (metadata: unknown) => `<!-- ompdesk-update ${JSON.stringify(metadata)} -->`;
const NOTES = "### Changes\n\n- Two assets.\n\n---\n\nRequires omp **18.7.0** or newer (`omp update`).";

const release = (overrides: Partial<frozen.GitHubRelease> = {}): frozen.GitHubRelease => ({
	tag_name: "v0.18.0",
	name: "v0.18.0",
	body: `${NOTES}\n\n${comment(METADATA)}\n`,
	draft: false,
	prerelease: false,
	assets: [
		{ id: 1, name: UPDATE_ASSETS.mac, size: 120, url: "https://api.github.com/repos/o/r/releases/assets/1" },
		{ id: 2, name: UPDATE_ASSETS.windows, size: 90, url: "https://api.github.com/repos/o/r/releases/assets/2" },
	],
	...overrides,
});

// v0.131 has the same feed contract except for the Mac floor. Reuse the pinned consumer
// rather than keeping a second copy of the parser as a test oracle.
const stable = release();
const pre = release({
	tag_name: "v0.19.0-beta",
	name: null,
	body: comment({ ...METADATA, version: "0.19.0-beta" }),
	prerelease: true,
});
const draft = { ...pre, draft: true };

describe("release resolution through the core", () => {
	it.each([
		["one stable release", stable, false],
		["the newest non-draft prerelease", [draft, stable, pre], true],
		["the newest stable without a prerelease", [draft, stable], true],
	] as const)("selects %s with the same notes, hash, size and asset URL", async (_name, payload, prereleases) => {
		const selected = frozen.pickRelease(payload, prereleases);
		for (const platform of ["windows", "mac"] as const) {
			const expected = frozen.resolvePlatformRelease(selected, platform);
			expect(await resolvePlatformRelease(JSON.stringify(payload), platform, prereleases)).toEqual(
				platform === "mac"
					? {
							...expected,
							macDownloadName: `ompdesk-${expected.version}-arm64.dmg`,
							minimumSystemVersion: "23.0.0",
						}
					: expected,
			);
		}
	});

	const malformedFile = (patch: Record<string, unknown>) =>
		release({
			body: comment({ ...METADATA, files: { ...METADATA.files, mac: { ...METADATA.files.mac, ...patch } } }),
		});
	it.each([
		["missing body", release({ body: null }), false],
		["missing comment", release({ body: NOTES }), false],
		["duplicate comment", release({ body: `${comment(METADATA)}\n${comment(METADATA)}` }), false],
		["invalid JSON", release({ body: "<!-- ompdesk-update {not json} -->" }), false],
		["invalid JSON in an unknown field", release({ body: '<!-- ompdesk-update {"unused":[1,]} -->' }), false],
		["invalid metadata shape", release({ body: comment({}) }), false],
		["invalid semver", release({ body: comment({ ...METADATA, version: "latest" }) }), false],
		["renamed installer", malformedFile({ name: "renamed.dmg" }), false],
		["invalid digest", malformedFile({ sha512: createHash("sha512").update("mac").digest("hex") }), false],
		["multiple invalid fields", malformedFile({ name: false, size: -0.5, sha512: "bad" }), false],
		["wrong tag", release({ tag_name: "v0.18.1" }), false],
		["missing asset", release({ assets: [] }), false],
		["wrong size", release({ assets: stable.assets.map(a => ({ ...a, size: a.size + 1 })) }), false],
		[
			"no Mac installer",
			release({ body: comment({ ...METADATA, files: { windows: METADATA.files.windows } }) }),
			false,
		],
		["only drafts", [draft], true],
		["unexpected release", { message: "Bad credentials" }, false],
		["unexpected release list", stable, true],
		["invalid unselected list member", [pre, { ...draft, assets: [null] }], true],
	] as const)("preserves the exact refusal for %s", async (_name, payload, prereleases) => {
		let refusal: frozen.ReleaseFeedError | undefined;
		try {
			frozen.resolvePlatformRelease(frozen.pickRelease(payload, prereleases), "mac");
		} catch (error) {
			if (!(error instanceof frozen.ReleaseFeedError)) throw error;
			refusal = error;
		}
		expect(refusal).toBeDefined();
		const result = resolvePlatformRelease(JSON.stringify(payload), "mac", prereleases);
		await expect(result).rejects.toBeInstanceOf(ReleaseFeedError);
		await expect(result).rejects.toMatchObject({ code: refusal?.code, message: refusal?.message });
	});
});

interface ReleaseWorkflow {
	jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
}

// The publish job's own script on fake installers, parsed back: the workflow
// and the updater agree on the format (bash, jq and openssl as on its runner).
describe.runIf(process.platform !== "win32")("release workflow metadata step", () => {
	it("writes a comment the updater resolves, with each file's real size and SHA-512", async () => {
		const workflow = parse(
			fs.readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "release.yml"), "utf8"),
		) as ReleaseWorkflow;
		const script = workflow.jobs.publish?.steps.find(step => step.name === "Append update metadata")?.run;
		expect(script).toBeDefined();

		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-release-notes-"));
		try {
			fs.mkdirSync(path.join(dir, "dist"));
			fs.mkdirSync(path.join(dir, "notes"));
			fs.writeFileSync(path.join(dir, "dist", UPDATE_ASSETS.mac), "fake dmg bytes");
			fs.writeFileSync(path.join(dir, "dist", UPDATE_ASSETS.windows), "fake setup bytes, longer");
			fs.writeFileSync(path.join(dir, "notes", "notes.md"), `${NOTES}\n`);
			// The publish job runs in the checkout and reads the release's real compatibility floor.
			const compatibility = path.join(__dirname, "..", "shared", "app-compatibility.json");
			fs.mkdirSync(path.join(dir, "src", "shared"), { recursive: true });
			fs.copyFileSync(compatibility, path.join(dir, "src", "shared", "app-compatibility.json"));
			const { minimumDarwin } = JSON.parse(fs.readFileSync(compatibility, "utf8")) as { minimumDarwin: string };

			const result = spawnSync("bash", ["-c", script ?? ""], {
				cwd: dir,
				env: { HOME: dir, PATH: process.env.PATH, VERSION: "0.18.0" },
				encoding: "utf8",
			});
			expect(result.stderr).toBe("");
			expect(result.status).toBe(0);

			const notes = fs.readFileSync(path.join(dir, "notes", "notes.md"), "utf8");
			const payload = release({
				body: notes,
				assets: stable.assets.map(asset => ({
					...asset,
					size: fs.statSync(path.join(dir, "dist", asset.name)).size,
				})),
			});
			for (const platform of ["mac", "windows"] satisfies UpdatePlatform[]) {
				const update = await resolvePlatformRelease(JSON.stringify(payload), platform, false);
				expect(update.notes).toBe(NOTES);
				expect(update.version).toBe(METADATA.version);
				expect(update.releaseDate).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/);
				expect(update.file).toEqual(
					platform === "mac"
						? {
								name: UPDATE_ASSETS.mac,
								size: 14,
								sha512: sha512("fake dmg bytes"),
								minimumSystemVersion: minimumDarwin,
							}
						: { name: UPDATE_ASSETS.windows, size: 24, sha512: sha512("fake setup bytes, longer") },
				);
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
