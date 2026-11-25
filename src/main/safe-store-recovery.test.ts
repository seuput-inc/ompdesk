import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SafeStore, takeRecoveredStores } from "./safe-store";

// The real electron-store on a real folder: conf parses the file in its constructor, so a damaged file used to throw
// out of `new SafeStore` and the app never started.
describe("a settings file that no longer parses", () => {
	let dir: string;
	const open = () => new SafeStore<Record<string, unknown>>({ name: "prefs", cwd: dir });
	const prefs = () => join(dir, "prefs.json");

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ompdesk-prefs-"));
		takeRecoveredStores();
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("is moved aside and the last good copy comes back", () => {
		writeFileSync(prefs(), JSON.stringify({ themeName: "dark", language: "ko" }));
		open(); // a good read keeps the copy
		writeFileSync(prefs(), '{"themeName": "da');

		const store = open();

		expect(store.get("themeName")).toBe("dark");
		expect(store.get("language")).toBe("ko");
		const aside = readdirSync(dir).find(name => name.startsWith("prefs.json.corrupt-"));
		expect(aside && readFileSync(join(dir, aside), "utf8")).toBe('{"themeName": "da');
		expect(takeRecoveredStores()).toEqual([
			expect.objectContaining({ file: "prefs.json", quarantined: aside, restored: true }),
		]);
		store.set("language", "en");
		expect(open().get("language")).toBe("en");
	});

	it("with no good copy starts empty and says so", () => {
		writeFileSync(prefs(), "");

		const store = open();

		expect(store.store).toEqual({});
		expect(takeRecoveredStores()).toEqual([expect.objectContaining({ file: "prefs.json", restored: false })]);
		expect(takeRecoveredStores()).toEqual([]);
	});
});
