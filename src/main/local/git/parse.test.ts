import { describe, expect, it } from "vitest";
import { isInside, worktreeSlug } from "./parse";

// parseStatusV2 and newFileDiff moved to the core process with their cases (native/ompdesk/crates/core/src/git/parse.rs),
// parsePrUnifiedDiff, rollupChecks and rollupCounts with theirs (native/ompdesk/crates/core/src/gh/pr.rs), parseGitStatus
// with the shared checkout's reading of it (native/ompdesk/crates/core/src/git/checkout.rs).

describe("path guards", () => {
	it("isInside is strict", () => {
		expect(isInside("/r", "/r/a")).toBe(true);
		expect(isInside("/r", "/r")).toBe(false);
		expect(isInside("/r", "/rx/a")).toBe(false);
	});
});

describe("worktree naming", () => {
	it("slugifies and rejects disallowed characters", () => {
		expect(worktreeSlug("  My Feature  ")).toBe("my-feature");
		expect(worktreeSlug("fix_bug")).toBeNull();
		expect(worktreeSlug("---")).toBeNull();
		expect(worktreeSlug("a".repeat(42))).toBeNull();
	});
});
