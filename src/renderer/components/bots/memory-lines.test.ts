import { describe, expect, it } from "vitest";
import { memoryLineChanges, undoMemoryLine } from "./memory-lines";

const before = "# Memory\n- likes tea\n- repo is o/r\n- standup at 9\n";
const after = "# Memory\n- likes tea\n- standup at 10\n- uses pnpm\n";

describe("memoryLineChanges", () => {
	it("lists what the upkeep took out and put in", () => {
		expect(memoryLineChanges(before, after)).toEqual([
			{ kind: "removed", line: "- repo is o/r" },
			{ kind: "removed", line: "- standup at 9" },
			{ kind: "added", line: "- standup at 10" },
			{ kind: "added", line: "- uses pnpm" },
		]);
	});
});

describe("undoMemoryLine", () => {
	it("puts a taken-out line back under the line it followed and leaves the rest as it is now", () => {
		expect(undoMemoryLine(after, before, { kind: "removed", line: "- repo is o/r" })).toBe(
			"# Memory\n- likes tea\n- repo is o/r\n- standup at 10\n- uses pnpm\n",
		);
	});

	it("takes out a line the upkeep put in, once", () => {
		expect(undoMemoryLine(after, before, { kind: "added", line: "- uses pnpm" })).toBe(
			"# Memory\n- likes tea\n- standup at 10\n",
		);
	});

	it("changes nothing when the change is already undone", () => {
		const restored = undoMemoryLine(after, before, { kind: "removed", line: "- repo is o/r" });
		expect(undoMemoryLine(restored, before, { kind: "removed", line: "- repo is o/r" })).toBe(restored);
	});

	it("puts a line back first when nothing above it is left", () => {
		expect(undoMemoryLine("- b\n", "- a\n- b\n", { kind: "removed", line: "- a" })).toBe("- a\n- b\n");
	});
});
