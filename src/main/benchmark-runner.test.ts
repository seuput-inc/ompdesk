import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { IpcBenchmarkRunOptions } from "../shared/ipc-types";
import { BENCHMARK_TIMEOUT_MS, BenchmarkRunner, benchmarkArgs, parseBenchmarkSummary } from "./benchmark-runner";
import { RM_TEMP, writeFakeOmp } from "./test-fake-omp";

const OPTIONS: IpcBenchmarkRunOptions = {
	models: ["anthropic/opus", "openai/gpt-5.6"],
	profile: "mix",
	runs: 3,
	parallel: 2,
};

async function withLauncher(
	source: string,
	run: (runner: BenchmarkRunner, bin: string, cwd: string, env: NodeJS.ProcessEnv) => Promise<void>,
) {
	const cwd = await mkdtemp(join(tmpdir(), "omp-benchmark-"));
	const runner = new BenchmarkRunner();
	try {
		await run(runner, await writeFakeOmp(cwd, source), cwd, {
			PATH: process.env.PATH,
			SystemRoot: process.env.SystemRoot,
			HOME: cwd,
			USERPROFILE: cwd,
			TEMP: cwd,
			TMP: cwd,
			BENCHMARK_TEST: "fixture",
		});
	} finally {
		runner.abort();
		await rm(cwd, RM_TEMP);
	}
}

describe("benchmark runner contract", { timeout: 30_000 }, () => {
	it("builds a bounded argv-only bench invocation", () => {
		expect(
			benchmarkArgs({ models: ["anthropic/opus", "openai/gpt-5.6"], profile: "mix", runs: 3, parallel: 2 }),
		).toEqual([
			"bench",
			"anthropic/opus",
			"openai/gpt-5.6",
			"--profile",
			"mix",
			"--runs",
			"3",
			"--par",
			"2",
			"--json",
		]);
		expect(() => benchmarkArgs({ models: ["--help"], profile: "chat", runs: 1, parallel: 1 })).toThrow(
			"Invalid model selector",
		);
	});

	it("runs the selected launcher in the host workspace and accepts its JSON on a nonzero exit", async () => {
		const model = "local/한 글";
		await withLauncher(
			`import { writeFileSync } from "node:fs";
			writeFileSync("args.json", JSON.stringify([process.argv.slice(2), process.env.BENCHMARK_TEST, process.env.OTEL_SDK_DISABLED]));
			console.error("fixture warning");
			console.log('{"runs":3,"models":[],"failures":1}'); process.exitCode = 7;`,
			async (runner, bin, cwd, env) => {
				// A .cmd is the launcher itself, even beside a file matching Rust Command's appended .exe candidate.
				if (process.platform === "win32") await writeFile(`${bin}.exe`, "not an executable");
				const answer = await runner.run(
					bin,
					cwd,
					{ ...OPTIONS, models: [...OPTIONS.models, model, ` ${model} `], maxTokens: 17 },
					env,
				);
				expect(answer).toEqual({
					success: true,
					exitCode: 7,
					summary: { runs: 3, models: [], failures: 1 },
					stderr: "fixture warning",
				});
				expect(JSON.parse(await readFile(join(cwd, "args.json"), "utf8"))).toEqual([
					[
						"bench",
						...OPTIONS.models,
						model,
						"--profile",
						"mix",
						"--runs",
						"3",
						"--par",
						"2",
						"--json",
						"--max-tokens",
						"17",
					],
					"fixture",
					"true",
				]);
				await expect(runner.run(bin, cwd, { ...OPTIONS, models: ["--help"] }, env)).resolves.toMatchObject({
					success: false,
					code: "benchmark_invalid_model",
					error: "[benchmark_invalid_model] Invalid model selector",
				});
				const missing = join(cwd, "missing-omp.exe");
				await expect(runner.run(missing, cwd, OPTIONS, env)).resolves.toMatchObject({
					success: false,
					error: `spawn ${missing} ENOENT`,
				});
			},
		);
	});

	it.skipIf(process.platform === "win32")("keeps a signal exit distinct from exit code 1", async () => {
		await withLauncher(
			`process.stdout.write('{"runs":1,"models":[],"failures":0}', () => process.kill(process.pid, "SIGKILL"));`,
			async (runner, bin, cwd, env) => {
				await expect(runner.run(bin, cwd, OPTIONS, env)).resolves.toMatchObject({ success: true, exitCode: null });
			},
		);
	});

	it("registers and cancels a run in the same tick without opening a second slot", async () => {
		await withLauncher('console.log(\'{"runs":1,"models":[],"failures":0}\');', async (runner, bin, cwd, env) => {
			const run = runner.run(bin, cwd, OPTIONS, env);
			const second = runner.run(bin, cwd, OPTIONS, env);
			expect(runner.running).toBe(true);
			expect(runner.abort()).toBe(true);
			await expect(second).resolves.toMatchObject({ code: "benchmark_running" });
			await expect(run).resolves.toMatchObject({ success: false, error: "Benchmark cancelled" });
			expect(runner.abort()).toBe(false);
		});
	});

	it("stops the launcher on the 15-minute deadline", async () => {
		await withLauncher('console.log(\'{"runs":1,"models":[],"failures":0}\');', async (runner, bin, cwd, env) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				const run = runner.run(bin, cwd, OPTIONS, env);
				vi.advanceTimersByTime(BENCHMARK_TIMEOUT_MS);
				await expect(run).resolves.toMatchObject({ success: false, error: "Benchmark timed out after 15 minutes" });
			} finally {
				vi.useRealTimers();
			}
		});
	});

	it("counts stderr and stdout against the same 8 MiB limit", async () => {
		await withLauncher(
			`await Bun.write(Bun.stderr, "e".repeat(4 * 1024 * 1024));
			await Bun.write(Bun.stdout, "o".repeat(4 * 1024 * 1024 + 1));`,
			async (runner, bin, cwd, env) => {
				const answer = await runner.run(bin, cwd, OPTIONS, env);
				expect(answer.success ? undefined : answer.error).toBe("Benchmark output exceeded 8 MiB");
				expect(answer.stderr?.length).toBeGreaterThan(3 * 1024 * 1024);
			},
		);
	});

	it("accepts the summary shape consumed by the GUI", () => {
		expect(parseBenchmarkSummary('{"runs":1,"models":[],"failures":0}')).toEqual({
			runs: 1,
			models: [],
			failures: 0,
		});
	});
	it("rejects malformed nested reports before the results table can crash", () => {
		expect(() =>
			parseBenchmarkSummary(JSON.stringify({ runs: 1, models: [{ model: "one", results: null }], failures: 0 })),
		).toThrow("malformed JSON");
		expect(() => parseBenchmarkSummary("null")).toThrow("malformed JSON");
	});
});
