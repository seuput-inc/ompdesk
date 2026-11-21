/**
 * `ompdesk check` against a real Playwright run (native/ompdesk/crates/checks; control-tools › Heavy slots and
 * `ompdesk check`): what it runs again and what it reuses, by the results the run's own reporter recorded.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { binaryFile, ensureNative, stagedDir } from "../../scripts/build-native";

const REPO = resolve(import.meta.dirname, "../..");
const PLAYWRIGHT = join(REPO, "node_modules", ".bin", "playwright");
let dir: string;
let project: string;

beforeAll(() => {
	ensureNative();
}, 900_000);
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompdesk-check-"));
	project = join(dir, "project");
	mkdirSync(join(project, "tests"), { recursive: true });
	symlinkSync(join(REPO, "node_modules"), join(project, "node_modules"));
	writeFileSync(join(project, "playwright.config.cjs"), 'module.exports = { testDir: "tests", reporter: "list" };\n');
	writeFileSync(join(project, "helper.cjs"), "module.exports = { answer: 42 };\n");
	writeFileSync(
		join(project, "tests", "a.spec.cjs"),
		'const { test, expect } = require("@playwright/test");\ntest("steady", () => expect(require("../helper.cjs").answer).toBe(42));\ntest.describe("group", () => { test("inner", () => expect(1).toBe(1)); });\n',
	);
	writeFileSync(
		join(project, "tests", "b.spec.cjs"),
		'const { test, expect } = require("@playwright/test");\ntest("breaks", () => expect(1).toBe(2));\n',
	);
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function ompdesk(...args: string[]) {
	return spawnSync(join(stagedDir(), binaryFile("ompdesk")), args, {
		cwd: project,
		encoding: "utf8",
		timeout: 120_000,
		env: {
			...process.env,
			OMPDESK_CHECKS_DIR: join(dir, "store"),
			OMPDESK_HEAVY_DIR: join(dir, "heavy"),
			OMPDESK_HEAVY_HELD: "",
			OMPDESK_CHECK_RUN: "",
		},
	});
}

function check(...flags: string[]) {
	const result = ompdesk("check", "--light", ...flags, "--", PLAYWRIGHT, "test", "--config", "playwright.config.cjs");
	const output = `${result.stdout}${result.stderr}`;
	const verdict = /verdict (\S+verdict\.txt)/.exec(output)?.[1];
	return { status: result.status, output, verdict: verdict ? readFileSync(verdict, "utf8") : "" };
}

// Windows starts node_modules/.bin/playwright as playwright.cmd through cmd.exe, which this spawn does not resolve; the
// rules under test are the same there (the Rust tests of the crate run on every OS).
describe.skipIf(process.platform === "win32")("ompdesk check with Playwright", () => {
	it("reruns only what failed while nothing changed, and every reused pass names its run", () => {
		const first = check();
		expect(first.status).toBe(1);
		expect(first.output).toContain("full: no earlier run of this check to reuse");
		expect(first.verdict).toMatch(/failed +b\.spec\.cjs › breaks — run now/);

		const again = check();
		expect(again.status).toBe(1);
		expect(again.output).toMatch(/narrowed: the inputs are the same as run \S+ .*: 2 passes reused/);
		// Playwright itself ran one test: the two passes were left out by name.
		expect(again.output).toMatch(/1 failed\b/);
		expect(again.output).not.toMatch(/\b[1-9] passed\b/);
		expect(again.verdict).toMatch(
			/passed +a\.spec\.cjs › steady — reused from run \S+ \(no commit, .*\), log \S+\/log/,
		);
		expect(again.verdict).toMatch(/passed +a\.spec\.cjs › group › inner — reused from run/);
		expect(again.verdict).toMatch(/failed +b\.spec\.cjs › breaks — run now/);
	}, 300_000);

	it("`checks wait` answers with the judgment: the failed test, its first error and what to do next", () => {
		expect(check().status).toBe(1);
		const waited = ompdesk("checks", "wait");
		expect(waited.status).toBe(1);
		const answer = JSON.parse(waited.stdout);
		expect(answer).toMatchObject({
			verdict: "red",
			counts: { passed: 2, failed: 1 },
			next: "fix",
			blocksRelease: false,
		});
		expect(answer.failed).toHaveLength(1);
		expect(answer.failed[0].test).toContain("breaks");
		expect(answer.failed[0].firstError).toContain("expect(");
		expect(answer.failed[0].knownFlaky).toBe(false);

		// The same inputs again: the test fails again, nothing flaked, so the answer is still to fix it.
		expect(check().status).toBe(1);
		expect(JSON.parse(ompdesk("checks", "wait").stdout).next).toBe("fix");
	}, 300_000);

	it.each(["reporter", "stdout"])(
		"keeps Playwright diagnostics from a Node wrapper (%s)",
		channel => {
			writeFileSync(
				join(project, "tests", "wrapper.spec.cjs"),
				`const {test, expect} = require("@playwright/test");
test.describe.configure({mode: "serial"});
test.skip("explicit skip", () => {});
test("passes", () => {});
test("${channel === "stdout" ? "synthetic-private-title" : "asserts"}", () => expect("synthetic-private-received").toBe("synthetic-private-expected"));
test("not reached", () => {});`,
			);
			writeFileSync(
				join(project, "wrapper.cjs"),
				`const {spawnSync} = require("node:child_process");
if (process.argv[2] === "stdout") delete process.env.PW_TEST_REPORTER;
process.exitCode = spawnSync(process.execPath, ["node_modules/playwright/cli.js", "test", "wrapper.spec.cjs", "--workers=1"], {stdio: "inherit"}).status ?? 2;`,
			);
			const result = ompdesk("check", "--light", "--", "node", "wrapper.cjs", channel);
			expect(result.status).toBe(1);
			const waited = ompdesk("checks", "wait");
			expect(waited.status).toBe(1);
			const answer = JSON.parse(waited.stdout);
			expect(answer.verdict).toBe("red");
			expect(answer.failed).toHaveLength(1);
			expect(waited.stdout).not.toContain("synthetic-private");
			if (channel === "reporter") {
				expect(answer.counts).toEqual({ passed: 1, failed: 1, skipped: 1, unrun: 1 });
				expect(answer.failed[0].test).toContain("asserts");
				expect(answer.failed[0].firstError).toMatch(/expect\(\.\.\.\)\.toBe.*5:/);
			} else {
				expect(answer.counts.passed).toBe(0);
				expect(answer.failed[0].firstError).toMatch(
					/assertion failed at .*5:\d+; 1 failed; 1 passed; 1 did not run/,
				);
			}
		},
		300_000,
	);

	it("keeps the Node wrapper's own failure after its Playwright child passed", () => {
		writeFileSync(
			join(project, "wrapper.cjs"),
			`const {spawnSync} = require("node:child_process");
const child = spawnSync(process.execPath, ["node_modules/playwright/cli.js", "test", "a.spec.cjs"], {stdio: "inherit"});
process.exitCode = child.status === 0 ? 7 : 2;`,
		);
		expect(ompdesk("check", "--light", "--", "node", "wrapper.cjs").status).not.toBe(0);
		const waited = ompdesk("checks", "wait");
		expect(waited.status).toBe(1);
		const answer = JSON.parse(waited.stdout);
		expect(answer.counts).toEqual({ passed: 2, failed: 1, skipped: 0, unrun: 0 });
		expect(answer.failed[0].test).toBe("command");
	}, 300_000);

	it("retains an ordinary wrapper's nonzero exit without exposing its arguments or output", () => {
		const args = ["node", "-e", 'console.error("synthetic-private; 9 passed"); process.exit(7)'];
		expect(ompdesk("check", "--light", "--", ...args).status).not.toBe(0);
		const waited = ompdesk("checks", "wait");
		expect(waited.status).toBe(1);
		const answer = JSON.parse(waited.stdout);
		expect(answer.counts).toEqual({ passed: 0, failed: 1, skipped: 0, unrun: 0 });
		expect(answer.failed[0].firstError).toBe("");
		expect(waited.stdout).not.toContain("synthetic-private");
	}, 300_000);

	it("runs only a changed test file, and everything once anything else changed", () => {
		expect(check().status).toBe(1);
		writeFileSync(
			join(project, "tests", "b.spec.cjs"),
			'const { test, expect } = require("@playwright/test");\ntest("breaks", () => expect(2).toBe(2));\n',
		);
		const testEdited = check();
		expect(testEdited.status).toBe(0);
		expect(testEdited.output).toContain("only test files changed: tests/b.spec.cjs run in full");
		expect(testEdited.output).toMatch(/\b1 passed\b/);
		expect(testEdited.verdict).toMatch(/passed +a\.spec\.cjs › steady — reused from run/);

		appendFileSync(join(project, "helper.cjs"), "// a change no test file shows\n");
		const helperEdited = check();
		expect(helperEdited.status).toBe(0);
		expect(helperEdited.output).toContain("full: files other than tests changed");
		expect(helperEdited.output).toMatch(/\b3 passed\b/);

		const unchanged = check();
		expect(unchanged.status).toBe(0);
		expect(unchanged.output).toMatch(/reused: .*which passed: nothing runs/);
	}, 300_000);
});
