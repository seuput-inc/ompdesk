import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkTauri, RECORD_NAME, sourceSha256, type TauriBuildRecord, TEST_AUTOMATION } from "./build-tauri";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A staged folder for this platform whose record fits this checkout's sources and holds exactly the runtime files. */
function stage(patch: Partial<TauriBuildRecord> = {}): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tauri-stage-"));
	dirs.push(dir);
	const names = [process.platform === "win32" ? "ompdesk-shell.exe" : "ompdesk-shell"];
	if (process.platform === "darwin") names.push("ompdesk-launcher");
	const files: Record<string, string> = {};
	for (const name of names) {
		fs.writeFileSync(path.join(dir, name), `bytes of ${name}`);
		files[name] = createHash("sha256").update(`bytes of ${name}`).digest("hex");
	}
	const record: TauriBuildRecord = {
		engine: "tauri",
		platform: process.platform,
		arch: process.arch,
		binary: names[0],
		files,
		sourceSha256: sourceSha256(),
		rustc: "rustc 1.95.0",
		features: [],
		...patch,
	};
	fs.writeFileSync(path.join(dir, RECORD_NAME), JSON.stringify(record));
	return dir;
}

describe("the staged Tauri host's features", () => {
	it("accepts a release build with no feature, and a test build only when the test feature is asked for", () => {
		expect(checkTauri(stage()).features).toEqual([]);
		expect(checkTauri(stage({ features: [TEST_AUTOMATION] }), true).features).toEqual([TEST_AUTOMATION]);
	});

	it("refuses a staged host built with the other feature set", () => {
		expect(() => checkTauri(stage({ features: [TEST_AUTOMATION] }))).toThrow(
			/built with features \[test-automation\]/,
		);
		expect(() => checkTauri(stage(), true)).toThrow(/built with features \[\], not \[test-automation\]/);
	});

	it("refuses a record that does not name its features", () => {
		const dir = stage();
		const record = JSON.parse(fs.readFileSync(path.join(dir, RECORD_NAME), "utf8"));
		delete record.features;
		fs.writeFileSync(path.join(dir, RECORD_NAME), JSON.stringify(record));
		expect(() => checkTauri(dir)).toThrow(/unrecorded/);
	});
});
