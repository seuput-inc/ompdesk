import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type LaunchProfile, profileToFlags } from "./launch-profile";

describe("the page's launch-command preview", () => {
	it("maps every captured profile to the flags the core's spawn adds", () => {
		/** The rows the core's mapping is held to (`crates/core/src/prefs/launch_profile.rs`). */
		const rows: { profile: LaunchProfile; flags: string[] }[] = JSON.parse(
			readFileSync(join(__dirname, "../../native/ompdesk/crates/core/src/prefs/launch-captured.json"), "utf8"),
		);
		expect(rows.length).toBeGreaterThan(30);
		for (const row of rows) expect(profileToFlags(row.profile), JSON.stringify(row.profile)).toEqual(row.flags);
	});
});
