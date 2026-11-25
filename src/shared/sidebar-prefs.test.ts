import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isMutedFolder, mutedGroupsOf, readSidebarPrefs, type SidebarChange, sidebarPatch } from "./sidebar-prefs";

/** The rows the core's owner of the blob is held to (`crates/core/src/prefs/sidebar.rs`), captured from these. */
interface Captured {
	now: number;
	states: unknown[];
	payloads: unknown[];
	reads: { state: number; read: unknown }[];
	updates: { state: number; payload: number; written?: unknown; error?: string }[];
}

const table: Captured = JSON.parse(
	readFileSync(join(__dirname, "../../native/ompdesk/crates/core/src/prefs/sidebar-captured.json"), "utf8"),
);
/** `undefined` was captured as `{"absent": true}`. */
const given = (value: unknown) => (JSON.stringify(value) === JSON.stringify({ absent: true }) ? undefined : value);

describe("the page's sidebar rules", () => {
	it("read every captured blob as the core reads it", () => {
		for (const row of table.reads) expect(readSidebarPrefs(given(table.states[row.state]))).toEqual(row.read);
	});

	it("leave every blob the core stores for each change it takes", () => {
		const taken = table.updates.filter(row => row.error === undefined);
		expect(taken.length).toBeGreaterThan(400);
		for (const row of taken) {
			const state = readSidebarPrefs(given(table.states[row.state]));
			const patch = sidebarPatch(state, table.payloads[row.payload] as SidebarChange, table.now);
			const written = Object.keys(patch).length ? { ...state, ...patch } : null;
			expect(JSON.stringify(written), `state ${row.state} payload ${row.payload}`).toBe(JSON.stringify(row.written));
		}
	});
});


describe("isMutedFolder", () => {
	it("mutes the project itself and any folder under it", () => {
		expect(isMutedFolder(["/a/b"], {}, "/a/b")).toBe(true);
		expect(isMutedFolder(["/a/b"], {}, "/a/b/src")).toBe(true);
		expect(isMutedFolder(["/a/b/"], {}, "/a/b/src")).toBe(true);
		expect(isMutedFolder([], {}, "/a/b")).toBe(false);
	});

	it("does not mute a sibling that only shares the prefix", () => {
		expect(isMutedFolder(["/a/b"], {}, "/a/bc")).toBe(false);
		expect(isMutedFolder(["/a/b"], {}, "/a")).toBe(false);
	});

	it("mutes a linked worktree of a muted project", () => {
		expect(isMutedFolder(["/a/b"], { "/wt/b-x": "/a/b" }, "/wt/b-x")).toBe(true);
		expect(isMutedFolder(["/a/b"], { "/wt/c-x": "/a/c" }, "/wt/c-x")).toBe(false);
	});

	it("reads Windows separators", () => {
		expect(isMutedFolder(["C:\\work\\app"], {}, "C:\\work\\app\\src")).toBe(true);
		expect(isMutedFolder(["C:\\work\\app"], {}, "C:\\work\\apple")).toBe(false);
	});
});

describe("mutedGroupsOf", () => {
	it("reads the muted list of a raw blob and nothing from a malformed one", () => {
		expect(mutedGroupsOf({ mutedGroups: ["/a", 3, ""], pinnedGroups: ["/p"] })).toEqual(["/a"]);
		expect(mutedGroupsOf(null)).toEqual([]);
		expect(mutedGroupsOf({ mutedGroups: "/a" })).toEqual([]);
	});
});
