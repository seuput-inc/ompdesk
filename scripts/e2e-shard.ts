/**
 * Print one shard as a Playwright --test-list (paths relative to testDir, one selector per line).
 * Run 44964976326 spent 1,181 s in deep-audit alone. Its parallel tests each launch their own app,
 * so those tests can move independently. All other files keep their hooks and serial groups together.
 * `bun scripts/e2e-shard-costs.ts <run-id>` refreshes the scheduling weights from Windows job logs.
 */
import { spawnSync } from "node:child_process";
import type { JSONReport, JSONReportSuite } from "@playwright/test/reporter";
import costs from "./e2e-shard-costs.json";
import { deal } from "./shard-deal";

const TEST_SECONDS = 3;
const CAPTURE_WEIGHT = 0.1;
const MEASURED_SECONDS: Readonly<Record<string, number>> = costs;

function listSuites(): JSONReportSuite[] {
	const result = spawnSync("bunx", ["playwright", "test", "--list", "--reporter=json"], {
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
		stdio: ["ignore", "pipe", "inherit"],
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		let detail = result.stdout.trim();
		try {
			const report: JSONReport = JSON.parse(detail);
			detail = report.errors.map(error => error.stack ?? error.message ?? error.value).join("\n");
		} catch {
			// A failure before the JSON reporter starts may print plain text instead.
		}
		throw new Error(`playwright --list failed (${result.signal ?? `exit ${result.status}`})\n${detail}`);
	}
	const report: JSONReport = JSON.parse(result.stdout);
	return report.suites;
}

// --test-list matches a title path by prefix. A top-level describe and everything below it stay together.
export function shardSelector(file: string, title: string): string {
	return file === "deep-audit.e2e.ts" ? `${file} › ${title}` : file;
}

export function planShards(suites: JSONReportSuite[], total: number): string[][] {
	const estimates = new Map<string, number>();
	function visit(suite: JSONReportSuite, file: string, group?: string): void {
		for (const spec of suite.specs) {
			const title = group ?? spec.title;
			const selector = shardSelector(file, title);
			if (selector !== file && (!title.trim() || title !== title.trim() || /[›\r\n]/.test(title))) {
				throw new Error(`Cannot select test title in ${file}: ${JSON.stringify(title)}`);
			}
			const active = spec.tests.filter(test => !test.annotations.some(a => a.type === "skip")).length;
			const weight = /^captures?\b/i.test(spec.title) ? CAPTURE_WEIGHT : 1;
			estimates.set(selector, (estimates.get(selector) ?? 0) + active * TEST_SECONDS * weight);
		}
		for (const child of suite.suites ?? []) visit(child, file, group ?? (child.title || undefined));
	}
	for (const suite of suites) {
		if (!suite.file) throw new Error(`Missing file for Playwright suite ${suite.title}`);
		visit(suite, suite.file);
	}
	// Even an entirely skipped file costs discovery time. Zero weights would all land on the same shard.
	return deal(
		Array.from(estimates, ([file, estimate]) => ({ file, seconds: Math.max(1, MEASURED_SECONDS[file] ?? estimate) })),
		total,
	);
}

if (import.meta.main) {
	const match = /^(\d+)\/(\d+)$/.exec(process.argv[2] ?? "");
	const current = Number(match?.[1]);
	const total = Number(match?.[2]);
	if (!match || current < 1 || current > total) {
		console.error("usage: bun scripts/e2e-shard.ts <shard>/<total>   (e.g. 2/4)");
		process.exit(2);
	}
	const mine = planShards(listSuites(), total)[current - 1] ?? [];
	if (mine.length === 0) {
		console.error(`shard ${current}/${total} has no tests`);
		process.exit(1);
	}
	console.log(mine.join("\n"));
}
