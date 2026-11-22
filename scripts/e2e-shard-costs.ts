/**
 * Rewrites `scripts/e2e-shard-costs.json` from a full nightly's logs (`scripts/e2e-shard.ts` deals the shards by it):
 *
 *   bun scripts/e2e-shard-costs.ts <run-id>
 *
 * Sums test times per --test-list selector. Includes failed tests and records files that only skipped at zero seconds.
 * A selector the run did not reach keeps its previous cost while the file still exists.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { shardSelector } from "./e2e-shard";
import { gh as ghRun } from "./gh-run";

const FILE = path.join(import.meta.dirname, "e2e-shard-costs.json");
const UNIT_SECONDS: Readonly<Record<string, number>> = { ms: 0.001, s: 1, m: 60 };

/**
 * Each spec file's summed test seconds in a shard's log, whose list reporter prints one line per test that ran:
 * `  ✓  12 e2e/smoke.e2e.ts:59:1 › title (13.4s)`, a failed one with `✘`, with colour codes between the parts. On a
 * Windows runner (the suite's only one) the reporter writes `ok` and `x` for the marks and `e2e\smoke.e2e.ts` for the
 * path.
 */
export function parseSpecSeconds(log: string): Map<string, number> {
	const seconds = new Map<string, number>();
	// gh prints the escape character of a colour code either raw or as the two characters `^[`.
	const plain = log.replace(/(?:\x1b|\^\[)\[[0-9;]*m/g, "");
	for (const match of plain.matchAll(/(✓|✘|\bok\b|\bx\b|-)\s+\d+ e2e[\\/](\S+\.e2e\.ts):\d+:\d+ › (.+)$/gm)) {
		const [, mark, path, summary] = match;
		if (!path || !summary) continue;
		const duration = mark === "-" ? null : / \((\d+(?:\.\d+)?)(ms|s|m)\)\s*$/.exec(summary);
		if (mark !== "-" && !duration) throw new Error(`Missing test duration: ${summary}`);
		const title = summary.slice(0, duration?.index ?? summary.length).trimEnd();
		const key = shardSelector(path.replaceAll("\\", "/"), title.split(" › ", 1)[0] ?? title);
		const elapsed = duration ? Number(duration[1]) * (UNIT_SECONDS[duration[2] ?? "s"] ?? 1) : 0;
		seconds.set(key, (seconds.get(key) ?? 0) + elapsed);
	}
	return seconds;
}

if (import.meta.main) {
	const run = process.argv[2] ?? "";
	if (!/^\d+$/.test(run)) {
		console.error("usage: bun scripts/e2e-shard-costs.ts <run-id>");
		process.exit(2);
	}
	const gh = (...args: string[]) => {
		const result = ghRun(args, { maxBuffer: 512 << 20 });
		if (!result.ok) throw new Error(`gh ${args.join(" ")} failed: ${result.err}`);
		return result.out;
	};
	const jobs: Array<{ name: string; databaseId: number }> = JSON.parse(gh("run", "view", run, "--json", "jobs")).jobs;
	const measured = new Map<string, number>();
	for (const job of jobs.filter(entry => /\be2e \(shard /.test(entry.name))) {
		const found = parseSpecSeconds(gh("run", "view", run, "--job", String(job.databaseId), "--log"));
		console.log(`[e2e-shard-costs] ${job.name}: ${found.size} selectors`);
		for (const [file, seconds] of found) measured.set(file, (measured.get(file) ?? 0) + seconds);
	}
	if (measured.size === 0) {
		console.error(`[e2e-shard-costs] run ${run} has no e2e shard job with test lines`);
		process.exit(1);
	}
	const kept: Record<string, number> = JSON.parse(readFileSync(FILE, "utf8"));
	const costs = new Map(
		Object.entries(kept).filter(([key]) => existsSync(path.join("e2e", key.split(" › ")[0] ?? key))),
	);
	for (const [key, seconds] of measured) costs.set(key, Math.round(seconds));
	writeFileSync(
		FILE,
		`${JSON.stringify(Object.fromEntries([...costs].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))), null, "\t")}\n`,
	);
	console.log(`[e2e-shard-costs] ${costs.size} selectors`);
}
