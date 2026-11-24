/** Archive lifecycle through the real edge. A new host represents an app relaunch on the same profile. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { core } from "../core/process";

let root: string;
let renderer: string;
let archiveDir: string;
let clock: number;
let nextHost = 1;

/** Put build `name` in the renderer folder: its own web.html and one hashed chunk named after it. */
function build(name: string): void {
	rmSync(renderer, { recursive: true, force: true });
	mkdirSync(join(renderer, "assets"), { recursive: true });
	writeFileSync(join(renderer, "web.html"), `<!doctype html><script src="./assets/web-${name}.js"></script>`);
	writeFileSync(join(renderer, "assets", `chunk-${name}.js`), `chunk ${name}`);
}

async function start(staticRoot: string): Promise<number> {
	const host = nextHost++;
	await core().call("web.start", {
		host,
		port: 0,
		userData: root,
		staticRoot,
		archiveNow: clock,
		buildMeta: "omp-build",
		router: {
			channels: {
				batch: "batch",
				diskFull: "disk-full",
				streams: [],
				heavy: [],
				prefsSet: "prefs",
				fileEditReport: "file-edit-report",
			},
			protocol: 1,
			features: {},
			policy: {},
		},
	});
	return host;
}

async function stop(host: number): Promise<void> {
	await core().call("web.stop", { host });
}

async function relaunch(): Promise<void> {
	await stop(await start(renderer));
}

const buildId = (folder: string) =>
	createHash("sha256")
		.update(readFileSync(join(folder, "web.html")))
		.digest("hex")
		.slice(0, 12);

function previous(): string[] {
	const index: { builds: { build: string; replacedAt: number | null }[] } = JSON.parse(
		readFileSync(join(archiveDir, "builds.json"), "utf8"),
	);
	return index.builds.filter(entry => entry.replacedAt !== null).map(entry => join(archiveDir, entry.build));
}

const kept = (file: string) =>
	previous()
		.map(dir => join(dir, "assets", file))
		.filter(existsSync)
		.map(path => readFileSync(path, "utf8"));

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "asset-archive-"));
	renderer = join(root, "renderer");
	archiveDir = join(root, "web-assets");
	clock = 1_000_000;
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("AssetArchive (the previous builds' assets, served for a while after an update)", () => {
	it("keeps each build once and serves only the replaced ones", async () => {
		build("a");
		await relaunch();
		// The current build is the renderer folder's own: nothing older to serve yet.
		expect(previous()).toEqual([]);
		clock += 1000;
		build("b");
		await relaunch();
		expect(kept("chunk-a.js")).toEqual(["chunk a"]);
		expect(kept("chunk-b.js")).toEqual([]);
		// A relaunch on the same build changes nothing and copies nothing again.
		const before = readdirSync(archiveDir).sort();
		writeFileSync(join(renderer, "assets", "chunk-b.js"), "changed in place");
		await relaunch();
		expect(readdirSync(archiveDir).sort()).toEqual(before);
		expect(readFileSync(join(archiveDir, buildId(renderer), "assets", "chunk-b.js"), "utf8")).toBe("chunk b");
		expect(kept("chunk-a.js")).toEqual(["chunk a"]);
	});

	it("drops a build once it was replaced longer than the window ago, and keeps the newest few", async () => {
		for (const name of ["a", "b", "c", "d"]) {
			build(name);
			await relaunch();
			clock += 1000;
		}
		// d is current; c and b replaced most recently; a is past the count.
		expect(kept("chunk-c.js")).toEqual(["chunk c"]);
		expect(kept("chunk-b.js")).toEqual(["chunk b"]);
		expect(kept("chunk-a.js")).toEqual([]);
		clock += 7 * 24 * 60 * 60_000;
		await relaunch();
		expect(previous()).toEqual([]);
		const currentBuild = buildId(renderer);
		expect(readdirSync(archiveDir).sort()).toEqual(["builds.json", currentBuild].sort());
	});

	it("does nothing without a built renderer (a dev run) and survives a corrupt index", async () => {
		await relaunch();
		expect(existsSync(archiveDir)).toBe(false);
		build("a");
		mkdirSync(archiveDir, { recursive: true });
		writeFileSync(join(archiveDir, "builds.json"), "{not json");
		await relaunch();
		expect(previous()).toEqual([]);
		expect(JSON.parse(readFileSync(join(archiveDir, "builds.json"), "utf8")).builds).toHaveLength(1);
	});

	it("runs two calls one after the other, so the first call's cleanup never sweeps the second call's copy", async () => {
		build("a");
		const first = renderer;
		renderer = join(root, "renderer-next");
		build("b");
		const second = renderer;
		const older = await start(first);
		try {
			await stop(await start(second));
		} finally {
			await stop(older);
		}
		expect(kept("chunk-a.js")).toEqual(["chunk a"]);
		expect(existsSync(join(archiveDir, buildId(second), "assets", "chunk-b.js"))).toBe(true);
	});
});
