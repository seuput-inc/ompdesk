import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JSONReport, JSONReportSuite } from "@playwright/test/reporter";
import { expect, it } from "vitest";
import { planShards } from "./e2e-shard";

function testIds(suite: JSONReportSuite): string[] {
	return [...suite.specs.map(spec => spec.id), ...(suite.suites ?? []).flatMap(testIds)];
}

it("partitions Playwright test IDs exactly once, including skipped and same-line tests", () => {
	const require = createRequire(import.meta.url);
	const cli = require.resolve("@playwright/test/cli");
	const load = `const { test } = require(${JSON.stringify(require.resolve("@playwright/test"))});\n`;
	const dir = mkdtempSync(path.join(tmpdir(), "e2e-shards-"));
	function list(...args: string[]): JSONReport {
		const stdout = execFileSync(process.execPath, [cli, "test", "--list", "--reporter=json", ...args], {
			cwd: dir,
			encoding: "utf8",
		});
		return JSON.parse(stdout);
	}
	try {
		const config = 'module.exports = { testDir: "./e2e", testMatch: "**/*.e2e.ts" };';
		writeFileSync(path.join(dir, "playwright.config.cjs"), config);
		const specs = path.join(dir, "e2e");
		mkdirSync(path.join(specs, "nested"), { recursive: true });
		const rows = "for (const row of [1, 2, 3]) test('row ' + row, () => {});";
		writeFileSync(path.join(specs, "deep-audit.e2e.ts"), load + rows);
		const serial = "test.describe.serial('flow', () => { test('start', () => {}); test.skip('finish', () => {}); });";
		writeFileSync(path.join(specs, "nested", "other.e2e.ts"), load + serial);
		const full = list().suites;
		const expected = full.flatMap(testIds).sort();
		expect(expected).toHaveLength(5);
		const shards = planShards(full, 2);
		expect(shards.every(shard => shard.some(selector => selector.startsWith("deep-audit.e2e.ts › ")))).toBe(true);
		expect(shards.flat()).toContain("nested/other.e2e.ts");
		const actual = shards.flatMap(shard => {
			const manifest = path.join(dir, "shard.txt");
			writeFileSync(manifest, shard.join("\n"));
			return list("--test-list", manifest).suites.flatMap(testIds);
		});
		expect(actual.sort()).toEqual(expected);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 60_000);
