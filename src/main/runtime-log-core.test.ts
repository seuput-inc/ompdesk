import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeErrorSource } from "../shared/ipc-types";
import { appendRuntimeLogAtPath, normalizeRuntimeErrorReport, tailLogLines } from "./runtime-log-core";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("runtime crash log", () => {
	it("persists a renderer failure as one parseable JSONL record with process context", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-runtime-log-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "nested", "gui-runtime.jsonl");

		appendRuntimeLogAtPath(
			filePath,
			{
				source: "react-render",
				message: "render exploded",
				stack: "Error: render exploded\n at Broken",
				details: { phase: "commit", retryable: true },
			},
			{ appVersion: "0.6.0", platform: "darwin", pid: 42, windowId: 7, cwd: "/project" },
		);

		const lines = (await fs.readFile(filePath, "utf8")).trim().split("\n");
		expect(lines).toHaveLength(1);
		const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
		expect(entry).toMatchObject({
			appVersion: "0.6.0",
			platform: "darwin",
			pid: 42,
			windowId: 7,
			cwd: "/project",
			source: "react-render",
			message: "render exploded",
		});
		expect(entry.timestamp).toEqual(expect.any(String));
	});

	it("bounds untrusted IPC fields and discards unsupported detail values", () => {
		const report = normalizeRuntimeErrorReport({
			source: "invented-source",
			message: "x".repeat(20_000),
			details: { kept: 3, nested: { secret: true }, fn: () => "ignored" },
		});

		expect(report.source).toBe("unknown");
		expect(report.message.length).toBeLessThan(8_200);
		expect(report.details).toEqual({ kept: 3 });
	});

	it("keeps only bridge-health's unavailable list structured; every other nested detail is dropped", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-runtime-log-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "gui-runtime.jsonl");
		const context = { appVersion: "1", platform: "darwin", pid: 1 };
		appendRuntimeLogAtPath(
			filePath,
			{
				source: "bridge-health",
				message: "probed",
				details: { ok: false, unavailable: [{ feature: "jobs", missing: ["a#b"] }], other: [1] },
			},
			context,
		);
		appendRuntimeLogAtPath(
			filePath,
			{
				source: "bridge-health",
				message: "probed",
				details: { ok: false, unavailable: ["x".repeat(10_000)] },
			},
			context,
		);
		appendRuntimeLogAtPath(filePath, { source: "turn-stages", message: "m", details: { list: [1], n: 2 } }, context);
		const renderer = normalizeRuntimeErrorReport({
			source: "react-render",
			message: "m",
			details: { list: [1], n: 2 },
		});
		appendRuntimeLogAtPath(filePath, renderer, context);
		const [main, oversized, other, page] = (await fs.readFile(filePath, "utf8"))
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as { details: Record<string, unknown> });
		expect(main?.details).toEqual({ ok: false, unavailable: [{ feature: "jobs", missing: ["a#b"] }] });
		expect(oversized?.details).toEqual({ ok: false });
		expect(other?.details).toEqual({ n: 2 });
		expect(page?.details).toEqual({ n: 2 });
	});

	it("preserves packaged resource replacement reports", () => {
		const report = normalizeRuntimeErrorReport({
			source: "application-resources",
			message: "resource archive changed",
			details: { launchInode: 100, currentInode: 101 },
		});

		expect(report).toMatchObject({
			source: "application-resources",
			message: "resource archive changed",
			details: { launchInode: 100, currentInode: 101 },
		});
	});

	it("keeps a host link's line under its own source, not unknown", () => {
		const report = normalizeRuntimeErrorReport({
			source: "remote-link",
			message: "down",
			details: { deviceId: "d1", reason: "dead", wasOnlineMs: 8000 },
		});

		expect(report).toMatchObject({ source: "remote-link", message: "down", details: { reason: "dead" } });
	});

	it.each<RuntimeErrorSource>([
		"setup",
		"keep-awake",
		"remote",
		"memory-sync",
		"settle-watch",
		"sidecar-restart",
		"process-priority",
		"goal-time-limit",
		"chain-stall",
		"console-window",
		"slow-step",
		"turn-wait",
		"sidebar",
	])("writes a main-side line under its own source %s, not unknown", async source => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-runtime-log-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "gui-runtime.jsonl");

		appendRuntimeLogAtPath(filePath, { source, message: "m" }, { appVersion: "1", platform: "win32", pid: 1 });

		const entry = JSON.parse((await fs.readFile(filePath, "utf8")).trim()) as { source: string };
		expect(entry.source).toBe(source);
	});
});

describe("a line that repeats", () => {
	const context = { appVersion: "0.134.0", platform: "darwin", pid: 90451 };
	const storm = {
		source: "main-unhandled-rejection",
		message: "ompdesk-core is shutting down",
		stack: "CoreError: ompdesk-core is shutting down\n    at #start (out/main/index.js:8:41)",
	} as const;

	afterEach(() => {
		vi.useRealTimers();
	});

	async function logFile(): Promise<string> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-runtime-log-"));
		tempDirs.push(dir);
		return path.join(dir, "gui-runtime.jsonl");
	}

	async function entries(filePath: string): Promise<Array<Record<string, unknown>>> {
		const text = await fs.readFile(filePath, "utf8");
		return text
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as Record<string, unknown>);
	}

	// The 0.134.0 quit: 6,175 of one rejection in 0.23 s pushed every earlier line out of both files.
	it("is written once and folded into one count line, so what came before it stays", async () => {
		vi.useFakeTimers({ now: Date.parse("2026-11-19T14:12:18.590Z") });
		const filePath = await logFile();
		appendRuntimeLogAtPath(filePath, { source: "turn-stop", message: "what led to the quit" }, context);
		for (let i = 0; i < 6175; i++) {
			appendRuntimeLogAtPath(filePath, storm, context);
			if (i % 27 === 26) vi.advanceTimersByTime(1);
		}
		appendRuntimeLogAtPath(filePath, { source: "main-uncaught", message: "the end" }, context);

		const lines = await entries(filePath);
		expect(lines.map(line => [line.source, line.message])).toEqual([
			["turn-stop", "what led to the quit"],
			["main-unhandled-rejection", "ompdesk-core is shutting down"],
			["main-unhandled-rejection", "repeated 6174 times in 228 ms"],
			["main-uncaught", "the end"],
		]);
		expect(lines[1]?.stack).toBe(storm.stack);
		expect(lines[2]?.details).toMatchObject({ count: 6174, spanMs: 228, repeatOf: "ompdesk-core is shutting down" });
	});

	it("writes its count once the repeats stop, with no other line after them", async () => {
		vi.useFakeTimers({ now: Date.parse("2026-11-19T14:12:18.590Z") });
		const filePath = await logFile();
		for (let i = 0; i < 3; i++) {
			appendRuntimeLogAtPath(filePath, storm, context);
			vi.advanceTimersByTime(100);
		}
		await vi.runAllTimersAsync();

		expect((await entries(filePath)).map(line => line.message)).toEqual([
			"ompdesk-core is shutting down",
			"repeated 2 times in 200 ms",
		]);
	});

	it("writes the count of an endless storm every minute instead of holding it back", async () => {
		vi.useFakeTimers({ now: Date.parse("2026-11-19T14:12:18.590Z") });
		const filePath = await logFile();
		for (let i = 0; i <= 130; i++) {
			appendRuntimeLogAtPath(filePath, storm, context);
			vi.advanceTimersByTime(1_000);
		}

		const counts = (await entries(filePath)).slice(1).map(line => line.message);
		expect(counts).toEqual(["repeated 60 times in 60000 ms", "repeated 60 times in 60000 ms"]);
	});

	it("is written again after a quiet moment, and lines that differ only in details are each written", async () => {
		vi.useFakeTimers({ now: Date.parse("2026-11-19T14:12:18.590Z") });
		const filePath = await logFile();
		appendRuntimeLogAtPath(filePath, storm, context);
		vi.advanceTimersByTime(30_000);
		appendRuntimeLogAtPath(filePath, storm, context);
		for (const tab of ["a", "b", "c"])
			appendRuntimeLogAtPath(filePath, { source: "turn-resume", message: "marker", details: { tab } }, context);

		const lines = await entries(filePath);
		expect(lines.map(line => line.message)).toEqual([
			"ompdesk-core is shutting down",
			"ompdesk-core is shutting down",
			"marker",
			"marker",
			"marker",
		]);
		expect(lines.slice(2)).toMatchObject([
			{ details: { tab: "a" } },
			{ details: { tab: "b" } },
			{ details: { tab: "c" } },
		]);
	});
});

describe("tailLogLines", () => {
	async function logWith(content: string): Promise<string> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-log-tail-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "gui-runtime.jsonl");
		await fs.writeFile(filePath, content);
		return filePath;
	}

	it("returns the last lines in order and skips blanks", async () => {
		const file = await logWith("a\nb\n\nc\nd\n");
		expect(await tailLogLines(file, 3)).toEqual(["b", "c", "d"]);
		expect(await tailLogLines(file, 50)).toEqual(["a", "b", "c", "d"]);
	});

	it("drops the fragment a byte-limited read starts in", async () => {
		const file = await logWith("first-line\nsecond\nthird\n");
		expect(await tailLogLines(file, 10, 14)).toEqual(["second", "third"]);
	});

	it("is empty for a missing file", async () => {
		expect(await tailLogLines(path.join(os.tmpdir(), "omp-gui-no-such-log.jsonl"), 5)).toEqual([]);
	});
});
