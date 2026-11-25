import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { stopCore } from "./core/process";
import { ompLogTail } from "./omp-log-tail";

const entry = (time: string, level: string, message: string, fields: Record<string, unknown> = {}) =>
	JSON.stringify({ timestamp: `2026-11-09T${time}.000+09:00`, level, pid: 4242, message, ...fields });

describe("ompLogTail", () => {
	let logsDir: string;
	afterAll(stopCore);
	beforeEach(async () => {
		logsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-log-tail-"));
	});
	afterEach(async () => {
		await fs.rm(logsDir, { recursive: true, force: true });
	});

	it("reads that pid's log under the local day, last lines in order, each one line a person can read", async () => {
		const lines = Array.from({ length: 12 }, (_, i) =>
			entry(`04:31:${String(i).padStart(2, "0")}`, "debug", `step ${i}`),
		);
		lines.push(
			entry("04:31:40", "warn", "model discovery failed for provider", {
				provider: "llama.cpp",
				url: "http://127.0.0.1:8080/",
				error: "ECONNREFUSED",
			}),
		);
		await fs.writeFile(path.join(logsDir, "omp.2026-11-09.4242.log"), `${lines.join("\n")}\n`);
		await fs.writeFile(
			path.join(logsDir, "omp.2026-11-09.4243.log"),
			`${entry("04:31:00", "warn", "another omp")}\n`,
		);
		// 00:30 local: east of UTC that is still the 8th in UTC, and the log is named by the local day.
		const now = new Date(2026, 10, 9, 0, 30);
		const tail = await ompLogTail(4242, now, { logsDir, now });
		expect(tail).toHaveLength(8);
		expect(tail[0]).toBe("04:31:05 debug step 5");
		expect(tail.at(-1)).toBe(
			"04:31:40 warn model discovery failed for provider provider=llama.cpp url=http://127.0.0.1:8080/ error=ECONNREFUSED",
		);
	});

	it("drops a partial first line, keeps unstructured lines, and budgets structured text in UTF-16 units", async () => {
		const now = new Date(2026, 10, 9);
		const file = path.join(logsDir, "omp.2026-11-09.4242.log");
		const message = `${"😀".repeat(119)}abcd`;
		await fs.writeFile(file, `${"x".repeat(17_000)}\nplain line\n\ufeff \t\n${JSON.stringify({ message })}\n`);
		expect(await ompLogTail(4242, now, { logsDir, now })).toEqual(["plain line", `${"😀".repeat(119)}a…`]);
	});

	it("a start that crossed midnight reads the log of the day it started when today's has none", async () => {
		await fs.writeFile(path.join(logsDir, "omp.2026-11-08.4242.log"), `${entry("23:59:50", "info", "started")}\n`);
		const tail = await ompLogTail(4242, new Date(2026, 10, 8, 23, 59, 50), {
			logsDir,
			now: new Date(2026, 10, 9, 0, 0, 20),
		});
		expect(tail).toEqual(["23:59:50 info started"]);
	});

	it("an omp that logged nothing yet gives no lines", async () => {
		expect(await ompLogTail(4242, new Date(), { logsDir })).toEqual([]);
	});
});
