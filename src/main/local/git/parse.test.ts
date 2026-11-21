import { describe, expect, it } from "vitest";
import { extractDraftJson, isInside, renderPrompt, worktreeSlug } from "./parse";

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

describe("pr draft helpers", () => {
	it("renders vars and conditional blocks", () => {
		expect(renderPrompt("{{a}}{{#if b}}[{{b}}]{{/if}}", { a: "x", b: "" })).toBe("x");
		expect(renderPrompt("{{a}}{{#if b}}[{{b}}]{{/if}}", { a: "x", b: "y" })).toBe("x[y]");
	});
	it("extracts the draft JSON around noise", () => {
		expect(extractDraftJson('Working...\n```json\n{"title":"t {x}","body":"## S\\n- a"}\n```')).toEqual({
			title: "t {x}",
			body: "## S\n- a",
		});
		expect(extractDraftJson("{bad} nothing")).toBeNull();
	});
});
