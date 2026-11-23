import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, test } from "vitest";
import { stopCore } from "./core/process";
import { StatsServerManager } from "./stats-server";

const hosts: StatsServerManager[] = [];
const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(hosts.splice(0).map(host => host.kill()));
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function host() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stats-"));
	dirs.push(dir);
	const script = path.join(dir, "server.ts");
	const gate = path.join(dir, "bind");
	const started = path.join(dir, "pid");
	await fs.writeFile(
		script,
		`
import { existsSync, watch } from "node:fs";
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
await Bun.write(${JSON.stringify(started)}, String(process.pid));
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
	const url = new URL(req.url);
	if (url.searchParams.has("exit")) setImmediate(() => process.exit(1));
	if (url.pathname === "/api/sync" && req.method !== "POST") return new Response(null, {status: 405});
	if (url.searchParams.has("redirect")) return Response.redirect("https://example.invalid/");
	return Response.json({ pid: process.pid, method: req.method, q: url.searchParams.get("q") });
}});
const gate = ${JSON.stringify(gate)};
const bound = Promise.withResolvers<void>();
const watcher = watch(${JSON.stringify(dir)}, ready);
function ready() { if (existsSync(gate)) { watcher.close(); bound.resolve(); } }
ready();
await bound.promise;
const port = String(server.port);
const split = Promise.withResolvers<void>();
process.stdout.write("\\x1b[32mompdesk-stats-ready http://127.0.0.1:" + port.slice(0, -1), split.resolve);
await split.promise;
process.stdout.write(port.slice(-1) + "\\x1b[39m\\n");
`,
	);
	const manager = new StatsServerManager({ command: "bun", args: [script] });
	hosts.push(manager);
	await manager.start();
	const readPid = () => fs.readFile(started, "utf8").then(Number, () => 0);
	return { manager, readPid, bind: () => fs.writeFile(gate, ""), unbind: () => fs.unlink(gate) };
}

async function pid(manager: StatsServerManager) {
	const reply = await manager.fetch("/api/status");
	const data = reply.ready ? reply.data : null;
	return data && typeof data === "object" && "pid" in data && typeof data.pid === "number" ? data.pid : null;
}

test("a late, split loopback announcement enables reads without starting a second listener", async () => {
	const { manager, bind } = await host();
	await expect(manager.fetch("/api/status")).resolves.toEqual({ ready: false, exhausted: false });
	await bind();
	await expect.poll(() => pid(manager), { timeout: 5000 }).toBeTypeOf("number");
	const first = await pid(manager);
	await manager.start();
	expect(await Promise.all([pid(manager), pid(manager)])).toEqual([first, first]);
	await expect(manager.fetch("/api/request/123", { q: "a & + b" })).resolves.toMatchObject({
		ready: true,
		data: { method: "GET", q: "a & + b" },
	});
	await expect(manager.fetch("/api/sync")).resolves.toMatchObject({ ready: true, data: { method: "POST" } });
	await expect(manager.fetch("//example.invalid/")).rejects.toThrow("[invalid_stats_path]");
	await expect(manager.fetch("/api/status", { redirect: "1" })).rejects.toThrow("[stats_api_error]");
});

test("a crash clears readiness and a later read reopens a host whose core ended", async () => {
	const { manager, readPid, bind, unbind } = await host();
	await bind();
	await expect.poll(() => pid(manager), { timeout: 5000 }).toBeTypeOf("number");
	const first = await pid(manager);
	await unbind();
	await manager.fetch("/api/status", { exit: "1" }).catch(() => {});
	await expect.poll(readPid, { timeout: 5000 }).toSatisfy(next => next > 0 && next !== first);
	const second = await readPid();
	await expect(manager.fetch("/api/status")).resolves.toEqual({ ready: false, exhausted: false });
	await bind();
	await expect.poll(() => pid(manager), { timeout: 5000 }).toBe(second);
	await stopCore();
	await expect.poll(() => pid(manager), { timeout: 5000 }).toBeTypeOf("number");
	expect(await pid(manager)).not.toBe(second);
});

test("stopping during startup cannot leave a listener or restart it on a later read", async () => {
	const { manager, readPid, bind } = await host();
	await expect.poll(readPid, { timeout: 5000 }).toBeGreaterThan(0);
	const child = await readPid();
	await manager.kill();
	expect(() => process.kill(child, 0)).toThrow();
	await bind();
	await expect(manager.fetch("/api/status")).resolves.toEqual({ ready: false, exhausted: true });
});
