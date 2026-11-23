import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendRuntimeLogAtPath, type RuntimeLogReport } from "./runtime-log-core";
import { type ShellPolicyFixture, shellPolicyFixture } from "./shell-policy-test-rig";

let dir: string;
let fixture: ShellPolicyFixture;

beforeAll(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-hang-report-"));
	fixture = await shellPolicyFixture();
}, 180_000);

afterAll(async () => {
	await fixture?.close();
	if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

async function reportPreviousHang(marker: object): Promise<void> {
	const file = path.join(dir, "main-thread-hang.json");
	fs.writeFileSync(file, JSON.stringify(marker));
	const reports = await fixture.call<RuntimeLogReport[]>("hang.consume", { path: file });
	for (const report of reports)
		appendRuntimeLogAtPath(path.join(dir, "gui-runtime.jsonl"), report, {
			appVersion: "0.44.0",
			platform: "win32",
			pid: 52076,
		});
	expect(fs.existsSync(file)).toBe(false);
}

describe("reportPreviousHang", () => {
	it("writes the phase and the steps main stalled in, oldest first, to the log", async () => {
		await reportPreviousHang({
			detectedAt: Date.parse("2026-10-20T01:38:33.839Z"),
			pid: 29292,
			unresponsiveMs: 5628,
			selfRecovered: true,
			phase: "update",
			steps: ["update:quit-and-install", "quit:teardown:sidecars"],
		});

		const lines = fs.readFileSync(path.join(dir, "gui-runtime.jsonl"), "utf8").trim().split("\n");
		expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({
			source: "main-thread-hang",
			message: "Main thread stalled for 6s and recovered",
			details: { unresponsiveMs: 5628, phase: "update", steps: "update:quit-and-install > quit:teardown:sidecars" },
		});
	});

	it("writes how the computer stood during the stall as a line of its own, with when that was", async () => {
		await reportPreviousHang({
			detectedAt: Date.parse("2026-10-20T01:38:33.839Z"),
			pid: 29292,
			unresponsiveMs: 5628,
			selfRecovered: false,
			machine: { availMB: 512, totalMB: 16_384, cpus: 8, cpuBusyPct: 99.5, mainCpuPct: 0.1 },
		});

		const lines = fs.readFileSync(path.join(dir, "gui-runtime.jsonl"), "utf8").trim().split("\n");
		expect(lines.slice(-2).map(line => JSON.parse(line))).toMatchObject([
			{ source: "main-thread-hang", details: { unresponsiveMs: 5628, selfRecovered: false } },
			{
				source: "machine-state",
				message: "hang during",
				details: {
					trigger: "hang",
					when: "during",
					at: "2026-10-20T01:38:33.839Z",
					availMB: 512,
					totalMB: 16_384,
					cpus: 8,
					cpuBusyPct: 99.5,
					mainCpuPct: 0.1,
				},
			},
		]);
	});
});
