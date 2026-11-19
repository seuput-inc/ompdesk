import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { tableMismatches } from "./check-captured-tables";

const META = "native/ompdesk/crates/core/src/agentctl/app/captured/meta.json";

describe("ompdesk_app's Rust tables against captured/meta.json", () => {
	it("agree in this checkout", () => {
		expect(tableMismatches(file => fs.readFileSync(file, "utf8"))).toEqual([]);
	});

	it("name the table and the first row that a merge put in another order", () => {
		const meta = JSON.parse(fs.readFileSync(META, "utf8")) as { channels: Record<string, unknown> };
		const [first, second, ...rest] = Object.entries(meta.channels);
		if (!first || !second) throw new Error("no channels captured");
		const swapped = { ...meta, channels: Object.fromEntries([second, first, ...rest]) };
		const problems = tableMismatches(file =>
			file === META ? JSON.stringify(swapped) : fs.readFileSync(file, "utf8"),
		);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain(`CHANNELS: Rust has ${rest.length + 2}`);
		expect(problems[0]).toContain(`first difference at #0: Rust ${JSON.stringify(first[0])}`);
	});
});
