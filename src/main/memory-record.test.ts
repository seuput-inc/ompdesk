import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { memoryRecord, RECORD_EVERY_MS, RecordClock, type RecordTab } from "./memory-record";
import { SESSION_TAG_ENV } from "./omp-launch";
import type { TagOwner } from "./session-processes";

describe("who uses the memory", () => {
	it("uses the live tag owners and tabs after the core scans a real tagged child", async () => {
		const tag = randomUUID().replaceAll("-", "");
		const child = spawn(process.execPath, ["-e", 'process.stdin.resume(); process.stdout.write("ready")'], {
			env: { SystemRoot: process.env.SystemRoot, [SESSION_TAG_ENV]: tag },
			stdio: ["pipe", "pipe", "ignore"],
			windowsHide: true,
		});
		const closed = once(child, "close");
		try {
			await Promise.race([
				once(child.stdout, "data"),
				closed.then(() => {
					throw new Error("the test child exited before it was ready");
				}),
			]);
			const pid = child.pid;
			if (pid === undefined) throw new Error("the test child has no pid");
			let owners: TagOwner[] = [];
			let tabs: RecordTab[] = [];
			let reads = 0;
			const pending = memoryRecord(() => {
				reads++;
				return { owners, tabs };
			});
			expect(reads).toBe(0);
			owners = [{ tag, pid, cwd: "/test-project" }];
			tabs = [{ pid, label: "current test tab" }];
			const record = await pending;
			const session = record?.sessions.find(item => item.session === "current test tab");
			expect(record?.top.length).toBeGreaterThan(0);
			expect(record?.top.length).toBeLessThanOrEqual(8);
			expect(record?.sessions.length).toBeLessThanOrEqual(6);
			expect(reads).toBe(1);
			expect(session?.folder).toBe("/test-project");
			expect(session?.processes).toBeGreaterThanOrEqual(1);
			expect(session?.mb).toBeGreaterThan(0);
			expect(JSON.stringify(record).includes(tag)).toBe(false);
		} finally {
			child.stdin.end();
			await closed;
		}
	});
});

describe("when the record is written", () => {
	it("writes as memory turns short, then every five minutes while it stays short", () => {
		const clock = new RecordClock();
		expect(clock.due(0, false)).toBe(false);
		expect(clock.due(5_000, true)).toBe(true);
		expect(clock.due(10_000, true)).toBe(false);
		expect(clock.due(5_000 + RECORD_EVERY_MS - 1, true)).toBe(false);
		expect(clock.due(5_000 + RECORD_EVERY_MS, true)).toBe(true);
		// Fine again, then short again: a new spell is recorded at once.
		expect(clock.due(5_000 + RECORD_EVERY_MS + 5_000, false)).toBe(false);
		expect(clock.due(5_000 + RECORD_EVERY_MS + 10_000, true)).toBe(true);
	});
});
