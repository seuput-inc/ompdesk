import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSidebarPrefs, type SidebarChange, sidebarPatch } from "./sidebar-prefs";

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
