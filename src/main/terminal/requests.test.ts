import { describe, expect, it } from "vitest";
import { validPageOperation } from "./requests";

describe("validPageOperation", () => {
	it("never lets a page or a paired device name the program a terminal runs", () => {
		expect(validPageOperation({ action: "create", cols: 80, rows: 24 })).toBe(true);
		expect(
			validPageOperation({ action: "create", cols: 80, rows: 24, program: { path: "/bin/sh", args: ["-c", "id"] } }),
		).toBe(false);
	});
});
