import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LEGACY_THEME_NAMES } from "./theme-names";

describe("retired theme ids", () => {
	it("map to the same successors in the core's migration of prefs.json", () => {
		/** What `crates/core/src/prefs/retired.rs` rewrites a stored theme pref with. */
		const core = JSON.parse(
			readFileSync(join(__dirname, "../../native/ompdesk/crates/core/src/prefs/legacy-themes.json"), "utf8"),
		);
		expect(core).toEqual(LEGACY_THEME_NAMES);
	});
});
