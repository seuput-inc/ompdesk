import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Release pruning (`scripts/release-prune.sh`, release.yml's `prune` job) keeps the newest `latest` releases and every
 * tag `.github/release-keep.json` names. A check or script that downloads an older release by its tag fails once that
 * release is gone, so every tag one names must be on the list, and the list names nothing no check downloads.
 */

const ROOT = join(import.meta.dirname, "..");
const TAG = String.raw`v\d+\.\d+\.\d+`;

/** Where a workflow or script takes an OMPdesk release by its tag. */
const DOWNLOAD_SITES: readonly RegExp[] = [
	new RegExp(`ompdesk/releases/download/(${TAG})/`, "g"),
	new RegExp(String.raw`ompdesk/releases/tags/(${TAG})\b`, "g"),
	new RegExp(String.raw`gh release download "?(${TAG})\b`, "g"),
	new RegExp(String.raw`OMP_MOVE_RELEASED_TAG(?:=|:-|\s*\?\?\s*")(${TAG})\b`, "g"),
	// A workflow input whose default is a release (`tag`), and the move matrix's released tags.
	new RegExp(String.raw`^\s+default: "?(${TAG})"?\s*$`, "gm"),
	/released-tag:.*/g,
];

function files(dir: string, keep: (name: string) => boolean): string[] {
	return readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
		.filter(keep)
		.map(name => join(ROOT, dir, name));
}

/** Each downloaded tag with the files that name it. */
function downloadedTags(): Map<string, string[]> {
	const sources = [
		...files(".github", name => /\.ya?ml$/.test(name)),
		...files("scripts", name => /\.(sh|ts|ps1|ya?ml|nsh)$/.test(name) && !name.endsWith(".test.ts")),
	];
	const found = new Map<string, string[]>();
	const note = (tag: string, file: string) => found.set(tag, [...(found.get(tag) ?? []), file]);
	for (const file of sources) {
		const text = readFileSync(file, "utf8");
		for (const site of DOWNLOAD_SITES)
			for (const match of text.matchAll(site))
				for (const tag of match[0].match(new RegExp(TAG, "g")) ?? []) note(tag, relative(ROOT, file));
	}
	const lastElectron = "native/ompdesk/crates/shell/last-electron.json";
	note((JSON.parse(readFileSync(join(ROOT, lastElectron), "utf8")) as { tag: string }).tag, lastElectron);
	return found;
}

const keepList = JSON.parse(readFileSync(join(ROOT, ".github/release-keep.json"), "utf8")) as {
	latest: number;
	keep: Record<string, string>;
};

describe("release keep list", () => {
	it("keeps every release a check or script downloads by its tag", () => {
		const missing = [...downloadedTags()].filter(([tag]) => !(tag in keepList.keep));
		expect(missing, "add these to .github/release-keep.json with the reason").toEqual([]);
	});

	it("names no release that nothing downloads", () => {
		const downloaded = downloadedTags();
		expect(Object.keys(keepList.keep).filter(tag => !downloaded.has(tag))).toEqual([]);
	});
});
