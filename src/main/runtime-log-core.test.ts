import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

	it("writes main's structured details as JSON, bounded, while a renderer report stays flat", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-runtime-log-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "gui-runtime.jsonl");
		const context = { appVersion: "1", platform: "darwin", pid: 1 };
		appendRuntimeLogAtPath(
			filePath,
			{
				source: "bridge-health",
				message: "probed",
				details: { ok: false, unavailable: [{ feature: "jobs", missing: ["a#b"] }], huge: ["x".repeat(10_000)] },
			},
			context,
		);
		const renderer = normalizeRuntimeErrorReport({
			source: "react-render",
			message: "m",
			details: { list: [1], n: 2 },
		});
		appendRuntimeLogAtPath(filePath, renderer, context);
		const [main, page] = (await fs.readFile(filePath, "utf8"))
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as { details: Record<string, unknown> });
		expect(main?.details.ok).toBe(false);
		expect(main?.details.unavailable).toEqual([{ feature: "jobs", missing: ["a#b"] }]);
		expect(typeof main?.details.huge).toBe("string");
		expect(String(main?.details.huge).length).toBeLessThan(4_200);
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
