import { describe, expect, it } from "vitest";
import { IPC_COMMANDS } from "../shared/ipc-types";
import type { SetupItemState, SetupState } from "../shared/setup";
import {
	buildDiagnosticsReport,
	currentDiagnosticsReport,
	DIAGNOSTICS_LOG_LINES,
	DIAGNOSTICS_PROBE_LINES,
	type DiagnosticsDeps,
	type DiagnosticsInput,
	type DiagnosticsSystem,
	readDiagnosticsLog,
	registerDiagnosticsIpc,
} from "./diagnostics";
import type { IpcRegistry } from "./web/ipc-registry";

const SYSTEM: DiagnosticsSystem = {
	appVersion: "0.35.1",
	packaged: true,
	electron: "36.4.0",
	chrome: "136.0.7103.113",
	node: "22.16.0",
	platform: "darwin",
	arch: "arm64",
	osRelease: "25.0.0",
	osVersion: "26.0.1",
	language: "ko",
};

function item(patch: Partial<SetupItemState> & Pick<SetupItemState, "id">): SetupItemState {
	return {
		required: false,
		phase: "present",
		presence: null,
		method: null,
		command: null,
		location: null,
		prompt: null,
		progress: null,
		output: "",
		failure: null,
		manualCommands: [],
		manualUrl: "",
		...patch,
	};
}

const SETUP: SetupState = {
	platform: "darwin",
	automatic: true,
	ompReady: true,
	requiredRunning: false,
	items: [
		item({
			id: "bun",
			required: true,
			presence: { kind: "present", version: "1.2.19", path: "/Users/seuput/.bun/bin/bun" },
		}),
		item({
			id: "omp",
			required: true,
			presence: { kind: "present", version: "18.11.1", path: "/Users/seuput/.bun/bin/omp" },
		}),
		item({ id: "gh", phase: "failed", presence: { kind: "missing" }, failure: { reason: "network", exitCode: 6 } }),
	],
};

const INPUT: DiagnosticsInput = {
	generatedAt: new Date("2026-10-18T05:00:00.000Z"),
	system: SYSTEM,
	setup: SETUP,
	logLines: [],
};

function logReader(current: string[], archive: string[] = [], probes: string[] = []): DiagnosticsDeps["readLog"] {
	return async selection => ({ current, archive, probes })[selection];
}

describe("buildDiagnosticsReport", () => {
	it("lists the versions, the machine setup and an empty log", () => {
		const report = buildDiagnosticsReport(INPUT);
		expect(report).toContain("OMPdesk: 0.35.1");
		expect(report).toContain("omp: 18.11.1");
		expect(report).toContain("Shell: 36.4.0, Chrome 136.0.7103.113, Node 22.16.0");
		expect(report).toContain("OS: darwin 26.0.1 (kernel 25.0.0), arm64");
		expect(report).toContain("- bun (required): present; present 1.2.19 (~/.bun/bin/bun)");
		expect(report).toContain("- gh: failed; missing; failed: network exit 6");
		expect(report).toContain("(empty)");
	});

	it("says so when setup has not started and omp is not detected", () => {
		const report = buildDiagnosticsReport({ ...INPUT, setup: null });
		expect(report).toContain("omp: not detected");
		expect(report).toContain("Machine setup: not started");
	});

	it("names the connected paired computers' versions, never their names", () => {
		const report = buildDiagnosticsReport({
			...INPUT,
			paired: { hosts: ["0.52.7", "0.50.0"], devices: [] },
		});
		expect(report).toContain("## Paired computers");
		expect(report).toContain("Hosts this computer uses: 2 connected (0.52.7, 0.50.0)");
		expect(report).toContain("Devices using this computer: none connected");
		expect(buildDiagnosticsReport(INPUT)).not.toContain("## Paired computers");
	});

	it("says how the window draws: software rendering and Reduce motion change what a person sees", () => {
		const report = buildDiagnosticsReport({ ...INPUT, display: { rendering: "software", reducedMotion: true } });
		expect(report).toContain("Display: software rendering, Reduce motion on");
		expect(buildDiagnosticsReport({ ...INPUT, display: { rendering: "hardware", reducedMotion: false } })).toContain(
			"Display: hardware rendering, Reduce motion off",
		);
		expect(buildDiagnosticsReport(INPUT)).not.toContain("Display:");
	});

	it("redacts the whole report, the setup paths and every log line", () => {
		const secret = `ghp_${"a1B2".repeat(9)}`;
		const report = buildDiagnosticsReport({
			...INPUT,
			logLines: [
				JSON.stringify({
					cwd: "/Users/seuput/proj",
					message: `login ${secret} for seuput@example.com at 100.100.1.2`,
				}),
			],
		});
		expect(report).not.toContain("seuput");
		expect(report).not.toContain(secret);
		expect(report).not.toContain("100.100.1.2");
		expect(report).toContain("<email>");
		expect(report).toContain("<tailnet-ip>");
	});

	it("cuts a very long log line", () => {
		const report = buildDiagnosticsReport({ ...INPUT, logLines: [`x ${"word ".repeat(2_000)}`] });
		expect(report).toContain("…");
		expect(report.length).toBeLessThan(4_000);
	});
});

describe("readDiagnosticsLog", () => {
	it("tops the current log up from its archive, oldest first", async () => {
		expect(await readDiagnosticsLog(logReader(["new1", "new2"], ["old1", "old2"]))).toEqual([
			"old1",
			"old2",
			"new1",
			"new2",
		]);
	});

	it("keeps only the newest lines of a long log", async () => {
		const lines = Array.from({ length: DIAGNOSTICS_LOG_LINES + 20 }, (_, index) => `line-${index}`);
		const read = await readDiagnosticsLog(logReader(lines));
		expect(read).toHaveLength(DIAGNOSTICS_LOG_LINES);
		expect(read.at(-1)).toBe(`line-${DIAGNOSTICS_LOG_LINES + 19}`);
		expect(read[0]).toBe("line-20");
	});

	it("folds a run of the same line (time aside) into its newest, so repeats never push real events out", async () => {
		const check = (minute: number) =>
			JSON.stringify({
				timestamp: `2026-10-21T10:${String(minute).padStart(2, "0")}:00.000Z`,
				source: "app-update",
				message: "check",
				details: { event: "no-update" },
			});
		const event = JSON.stringify({ timestamp: "2026-10-21T09:00:00.000Z", source: "turn-resume", message: "launch" });
		const repeats = Array.from({ length: DIAGNOSTICS_LOG_LINES * 2 }, (_, index) => check(index % 60));
		const read = await readDiagnosticsLog(logReader([...repeats, "plain"], [event]));
		expect(read).toEqual([
			event,
			check(199 % 60),
			`… the line above ${DIAGNOSTICS_LOG_LINES * 2} times, the first at 2026-10-21T10:00:00.000Z`,
			"plain",
		]);
	});

	it("folds a line repeated between other lines into its newest, where the others stay in order", async () => {
		// On one Mac the 5-minute update check sat between the link's traffic lines, so no two were adjacent and the
		// last 100 entries still held 25 of them.
		const at = (minute: number) => `2026-10-21T10:${String(minute).padStart(2, "0")}:00.000Z`;
		const check = (minute: number) =>
			JSON.stringify({
				timestamp: at(minute),
				source: "app-update",
				message: "check",
				details: { event: "no-update" },
			});
		const traffic = (minute: number) =>
			JSON.stringify({ timestamp: at(minute), source: "remote-link", message: "traffic", details: { tx: minute } });
		const lines = [check(0), traffic(1), check(5), traffic(6), check(10), traffic(11)];
		expect(await readDiagnosticsLog(logReader(lines))).toEqual([
			traffic(1),
			traffic(6),
			check(10),
			`… the line above 3 times, the first at ${at(0)}`,
			traffic(11),
		]);
	});

	it("keeps every step of a sequence that came back to an earlier state: only a periodic check folds across lines", async () => {
		const phase = (minute: number, value: string) =>
			JSON.stringify({
				timestamp: `2026-10-21T10:0${minute}:00.000Z`,
				source: "ai-memory",
				message: "phase",
				details: { phase: value },
			});
		const lines = [phase(0, "ready"), phase(1, "failed"), phase(2, "ready")];
		expect(await readDiagnosticsLog(logReader(lines))).toEqual(lines);
	});

	it("is empty when there is no log", async () => {
		expect(await readDiagnosticsLog(logReader([]))).toEqual([]);
	});
});

describe("currentDiagnosticsReport", () => {
	it("redacts old probe lines before showing them separately from recent entries", async () => {
		const report = await currentDiagnosticsReport({
			system: () => SYSTEM,
			setupState: () => null,
			readLog: logReader(["latest"], [], ['{"source":"turn-wait","message":"check user@example.invalid"}']),
		});
		const [, tail] = report.split(
			`## Probes (console windows, slow steps, long waits, stalls; last ${DIAGNOSTICS_PROBE_LINES})`,
		);
		const [probes, recent] = tail.split("## Runtime log");
		expect(probes).toContain('{"source":"turn-wait","message":"check <email>"}');
		expect(recent).toContain("latest");
		expect(recent).not.toContain("turn-wait");
		expect(report).not.toContain("user@example.invalid");
		expect(buildDiagnosticsReport(INPUT)).not.toContain("## Probes");
	});
});

describe("registerDiagnosticsIpc", () => {
	it("serves the report on its one channel", async () => {
		const handlers = new Map<string, (...args: never[]) => unknown>();
		const ipc: Pick<IpcRegistry, "handle"> = {
			handle: (channel, handler) => void handlers.set(channel, handler),
		};
		registerDiagnosticsIpc(ipc, {
			system: () => SYSTEM,
			setupState: () => SETUP,
			readLog: logReader([]),
			now: () => INPUT.generatedAt,
		});
		expect([...handlers.keys()]).toEqual([IPC_COMMANDS.DIAGNOSTICS_BUILD]);
		expect(await handlers.get(IPC_COMMANDS.DIAGNOSTICS_BUILD)?.()).toBe(buildDiagnosticsReport(INPUT));
	});
});
