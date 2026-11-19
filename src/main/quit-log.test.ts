import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exitReport, quitAskedReport, uncleanEndReport } from "./quit-log";
import { appendRuntimeLogAtPath, type RuntimeLogReport, tailLogLines } from "./runtime-log-core";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

/** A log as runs leave it: each run's lines under its own pid, read back as the next start reads it. */
async function logOf(runs: Array<[pid: number, reports: RuntimeLogReport[]]>): Promise<string[]> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quit-log-"));
	dirs.push(dir);
	const file = path.join(dir, "gui-runtime.jsonl");
	for (const [pid, reports] of runs) {
		for (const report of reports) {
			appendRuntimeLogAtPath(file, report, { appVersion: "1.2.3", platform: "darwin", pid });
		}
	}
	return tailLogLines(file, 400);
}

const busy: RuntimeLogReport = { source: "turn-resume", message: "markers saved" };

describe("app-quit lines", () => {
	it("name who asked, and whether the app comes back", () => {
		expect(quitAskedReport("tray")).toMatchObject({
			source: "app-quit",
			message: "Quit asked by the tray menu's Quit",
			details: { asker: "tray", relaunch: false },
		});
		expect(quitAskedReport("update", { relaunch: true, detail: "auto" })).toMatchObject({
			message: "Relaunch asked by the update's restart (auto)",
			details: { asker: "update", relaunch: true, detail: "auto" },
		});
		expect(quitAskedReport("shell").message).toBe("Quit asked by the shell (Dock Quit, logout or the system)");
		expect(exitReport(1, "the shell's stdin ended")).toMatchObject({
			message: "Exiting with code 1: the shell's stdin ended",
			details: { end: true, code: 1, reason: "the shell's stdin ended" },
		});
	});

	it("at start, say that the previous run ended without a reason when it left no end line", async () => {
		const lines = await logOf([
			[100, [quitAskedReport("tray"), exitReport(0)]],
			[200, [busy, busy]],
			[300, [busy]],
		]);
		const report = uncleanEndReport(lines, 300);
		const last = JSON.parse(lines.at(-2) ?? "{}") as { timestamp: string };
		expect(report).toMatchObject({
			source: "app-quit",
			details: { previousPid: 200, lastLineAt: last.timestamp, previousVersion: "1.2.3" },
		});
		expect(report?.message).toContain("The previous run (pid 200) ended without a reason");
	});

	it("say nothing after a run that ended through its exit, even with lines after the end line", async () => {
		const lines = await logOf([
			[100, [quitAskedReport("tray"), exitReport(0)]],
			[200, [quitAskedReport("app-menu"), exitReport(0), busy]],
		]);
		expect(uncleanEndReport(lines, 300)).toBeNull();
	});

	it("count the shell's going away as an end with its reason", async () => {
		const lines = await logOf([[200, [busy, exitReport(1, "the shell's stdin ended")]]]);
		expect(uncleanEndReport(lines, 300)).toBeNull();
	});

	it("judge no log a version without these lines wrote, and no first run", async () => {
		expect(uncleanEndReport(await logOf([[200, [busy, busy]]]), 300)).toBeNull();
		expect(uncleanEndReport([], 300)).toBeNull();
	});
});
