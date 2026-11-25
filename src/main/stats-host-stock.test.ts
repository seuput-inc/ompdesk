/**
 * resources/gui-bridge/stats-host.ts on the real omp: the GUI's stats server keeps stock's stats database current
 * by itself. Stock omp-stats ingests sessions only once a dashboard page subscribes to its live events
 * (`/api/events` starts `statsLive()`); `omp stats` always opens that page, the GUI never does, so the database
 * stopped at whatever the last browser dashboard or `omp stats` run left (seen: 5 days stale).
 */
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { StatsServerManager } from "./stats-server";

const realRoot = path.join(os.homedir(), ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent");

const tempDirs: string[] = [];
const hosts: StatsServerManager[] = [];
afterEach(async () => {
	// Wait for each host to exit: on Windows its open stats.db keeps the home folder from being removed.
	await Promise.all(hosts.splice(0).map(host => host.kill()));
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

/** One stock assistant reply with usage, as the session journal records it. */
function reply(id: string, parentId: string, at: number): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: new Date(at).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
			},
			stopReason: "stop",
			timestamp: at,
		},
	});
}

/**
 * The stats host with its home at `home` (HOME, and USERPROFILE, which Windows reads instead), so stock reads
 * `<home>/.omp/agent/sessions` and writes `<home>/.omp/stats.db`.
 */
async function startHost(home: string): Promise<StatsServerManager> {
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		OMP_PACKAGE_ROOT: realRoot,
	};
	for (const key of ["PI_CODING_AGENT_DIR", "PI_CONFIG_DIR", "OMP_PROFILE", "PI_PROFILE", "XDG_DATA_HOME"])
		env[key] = undefined;
	const host = new StatsServerManager({
		command: "bun",
		args: [path.resolve("resources/gui-bridge/stats-host.ts")],
		env,
	});
	hosts.push(host);
	await host.start();
	return host;
}

async function requestCount(host: StatsServerManager): Promise<number | undefined> {
	const result = await host.fetch("/api/stats/requests", { range: "all" });
	const body = result.ready ? result.data : undefined;
	return body && typeof body === "object" && "total" in body && typeof body.total === "number"
		? body.total
		: undefined;
}

describe.skipIf(!existsSync(path.join(realRoot, "package.json")))("the stats host on the real omp", () => {
	it("ingests the sessions on disk and every reply written after it started, with no dashboard page open", async () => {
		const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-stats-host-")));
		tempDirs.push(home);
		const sessions = path.join(home, ".omp", "agent", "sessions", "-tmp-project");
		await fs.mkdir(sessions, { recursive: true });
		const file = path.join(sessions, "2026-10-20T00-00-00-000Z_0199a000-0000-7000-8000-000000000001.jsonl");
		const start = Date.now() - 60_000;
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: "0199a000-0000-7000-8000-000000000001",
			timestamp: new Date(start).toISOString(),
			cwd: "/tmp/project",
		});
		await fs.writeFile(file, `${header}\n${reply("a0000001", "", start)}\n`);

		const host = await startHost(home);
		await expect.poll(() => requestCount(host), { timeout: 20_000, interval: 250 }).toBe(1);

		await fs.appendFile(file, `${reply("a0000002", "a0000001", Date.now())}\n`);
		await expect.poll(() => requestCount(host), { timeout: 20_000, interval: 250 }).toBe(2);
		const first = await host.fetch("/api/stats/requests", { range: "all", limit: "1" });
		expect(first).toMatchObject({ ready: true, data: { total: 2, nextCursor: expect.any(String) } });
		if (!first.ready) throw new Error("host lost its listener");
		const page = z.object({
			rows: z.array(z.object({ id: z.number() })).length(1),
			nextCursor: z.string().nullable(),
			snapshotAt: z.number(),
		});
		const { rows, nextCursor, snapshotAt } = page.parse(first.data);
		if (!nextCursor) throw new Error("first page has no cursor");
		// Inserted after the snapshot but inside its time window: maxId must exclude it.
		await fs.appendFile(file, `${reply("a0000003", "a0000002", start + 1000)}\n`);
		await expect.poll(() => requestCount(host), { timeout: 20_000, interval: 250 }).toBe(3);
		const next = await host.fetch("/api/stats/requests", { range: "all", limit: "1", cursor: nextCursor });
		expect(next).toMatchObject({ ready: true, data: { total: 2, nextCursor: null, snapshotAt } });
		if (!next.ready) throw new Error("host lost its listener");
		expect(page.parse(next.data).rows[0].id).not.toBe(rows[0].id);
	}, 60_000);
});
