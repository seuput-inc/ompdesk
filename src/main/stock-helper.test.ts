import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDispatcher } from "../../resources/gui-bridge/stock-helper/dispatch";
import type { TerminalOperation, TerminalShell, TerminalSnapshot } from "../shared/terminal-types";
import { core } from "./core/process";
import { ompInstallStampFiles, StockHelper, type StockHelperOptions } from "./stock-helper";
import { terminalTestHelper } from "./terminal/test-helper";

let dir: string;
const helpers: StockHelper[] = [];

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "stock-helper-"));
});
afterEach(async () => {
	await Promise.all(helpers.splice(0).map(helper => helper.stop()));
	await fs.rm(dir, { recursive: true, force: true });
});

/** A worker speaking the helper's protocol through the real dispatcher, with methods a test can steer. */
async function workerScript(): Promise<string> {
	const script = path.join(dir, "worker.ts");
	const dispatch = path.resolve("resources/gui-bridge/stock-helper/dispatch.ts");
	await fs.writeFile(
		script,
		`import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createDispatcher } from ${JSON.stringify(dispatch)};
// Each worker process the core starts, in order: the core holds the process, a test sees it by its pid.
appendFileSync(process.env.WORKER_PIDS, process.pid + "\\n");
// slow takes real time; gated runs until the test writes "release", so a helper timeout cuts it short
// whatever the machine's load does to either side's timers.
const releaseOnCancel = Promise.withResolvers();
const methods = {
	fast: () => "ok",
	untilCancel: () => releaseOnCancel.promise,
	slow: async () => {
		await new Promise(done => setTimeout(done, 300));
		writeFileSync(${JSON.stringify(path.join(dir, "slow-done"))}, "");
		return "slow";
	},
	gated: async () => {
		appendFileSync(${JSON.stringify(path.join(dir, "gated-started"))}, "gated\\n");
		while (!existsSync(${JSON.stringify(path.join(dir, "release"))})) await new Promise(done => setTimeout(done, 10));
		return "gated";
	},
	mutate: params => { appendFileSync(${JSON.stringify(path.join(dir, "mutations"))}, params + "\\n"); return "mutated"; },
	record: params => { appendFileSync(${JSON.stringify(path.join(dir, "order"))}, params + "\\n"); return params; },
	// Loads a module of the omp under test, by its path, as the stock helper loads omp's own.
	omp: async params => (await import(params)).version,
	hang: () => new Promise(() => {}),
};
const input = createInterface({ input: process.stdin });
input.on("close", () => process.exit(0));
const dispatch = createDispatcher(methods, line => process.stdout.write(line + "\\n"), false);
// Release the head inside the worker, only after the dispatcher registered the queued request's cancellation.
input.on("line", line => {
	const canceled = line.includes('"cancel"');
	if (!canceled) appendFileSync(${JSON.stringify(path.join(dir, "handed"))}, JSON.parse(line).method + "\\n");
	dispatch(line);
	if (canceled) releaseOnCancel.resolve("released");
});
`,
	);
	return script;
}

/** `ompRoot`: a fake omp package in a fake install, stamped as production stamps one; else one file stands for it. */
async function helperOnWorker(
	requestTimeoutMs: number,
	options: Omit<StockHelperOptions, "launch"> = {},
	ompRoot?: string,
) {
	const script = await workerScript();
	const pids = path.join(dir, `pids-${helpers.length}`);
	// What stands for omp's package.json: its time and size are what identifies the installed omp.
	const stampFile = ompRoot ? path.join(ompRoot, "package.json") : path.join(dir, "omp-package.json");
	let installs = 0;
	const install = (version: string) => fs.writeFile(stampFile, version + " ".repeat(++installs));
	await install("18.18.9");
	const helper = new StockHelper(dir, {
		requestTimeoutMs,
		...options,
		launch: async () => ({
			bin: "bun",
			args: [script],
			env: { ...process.env, WORKER_PIDS: pids },
			stampFiles: ompRoot ? await ompInstallStampFiles(ompRoot) : [stampFile],
		}),
	});
	helpers.push(helper);
	// Started before a test's timed part: a request's timeout runs through its worker's start, and a cold
	// `bun` on a busy machine takes longer than the 100-250 ms these tests time out on.
	await helper.request("fast", {}, { timeoutMs: 30_000 });
	/** The pid of every worker process started for this helper so far. */
	const workers = () => readFileSync(pids, "utf8").trim().split("\n").map(Number);
	return { helper, workers, install };
}

function gone(pid: number | undefined): boolean {
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return false;
	} catch {
		return true;
	}
}

describe("StockHelper request timeout", () => {
	it("fails only the slow request and keeps a worker whose late answer comes within the grace", async () => {
		const { helper, workers } = await helperOnWorker(200, { recycleGraceMs: 30_000 });
		await expect(helper.request("gated", {})).rejects.toThrow("timed out");
		expect(workers()).toHaveLength(1);
		expect(gone(workers()[0])).toBe(false);
		// The gated request keeps running in the worker; the next one queues behind it.
		await fs.writeFile(path.join(dir, "release"), "");
		await expect(helper.request("fast", {}, { timeoutMs: 30_000 })).resolves.toBe("ok");
		expect(workers()).toHaveLength(1);
	});

	it("hands a burst of requests to its serial lane in the order they were made", async () => {
		const { helper } = await helperOnWorker(30_000);
		// Sent in one synchronous run, as a caller that starts a scan and then a mutation does: the core must place
		// each in the lane as its frame is read, not as a task of its own happens to start (run 43357570260 ran
		// "late" before the "gated" request it was sent after).
		const sent = Array.from({ length: 60 }, (_, index) => index);
		await Promise.all(sent.map(index => helper.request("record", index)));
		const order = (await fs.readFile(path.join(dir, "order"), "utf8")).trim().split("\n").map(Number);
		expect(order).toEqual(sent);
	});

	it("never runs a queued mutation whose caller already timed out, and its acknowledged withdrawal keeps the worker", async () => {
		const { helper, workers } = await helperOnWorker(30_000, { recycleGraceMs: 2000 });
		const gated = helper.request("untilCancel", {});
		const mutate = helper.request("mutate", "late", { timeoutMs: 250 });
		await expect(mutate).rejects.toThrow("timed out");
		await expect(gated).resolves.toBe("released");
		await expect(helper.request("mutate", "fresh")).resolves.toBe("mutated");
		expect(await fs.readFile(path.join(dir, "mutations"), "utf8")).toBe("fresh\n");
		// The real core's grace expires even if its test client is descheduled after receiving the timeout.
		await sleep(2100);
		expect(workers()).toHaveLength(1);
		expect(gone(workers()[0])).toBe(false);
	});

	it("recycles the stock worker when a request hangs past its timeout plus the grace, and starts afresh lazily", async () => {
		const { helper, workers } = await helperOnWorker(150, { recycleGraceMs: 150 });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await expect(helper.request("hang", {})).rejects.toThrow("timed out");
			// Queued behind the hung request: fails with the restart instead of waiting out its own timeout.
			const queued = helper.request("fast", {});
			await expect(queued).rejects.toThrow(/timed out|restarted/);
			await vi.waitFor(() => expect(gone(workers()[0])).toBe(true));
			// The core says so on its stderr, which main logs as it arrives.
			await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("hung")));
			// A fresh worker starts here, and a request's timeout runs through its start: a cold `bun` on a
			// Windows runner takes longer than the 150 ms this helper's hang detection runs on.
			await expect(helper.request("fast", {}, { timeoutMs: 10_000 })).resolves.toBe("ok");
			expect(workers()).toHaveLength(2);
		} finally {
			warn.mockRestore();
		}
	});

	it("never recycles the terminals worker: its PTYs outlive a timed-out request", async () => {
		const { helper, workers } = await helperOnWorker(100, { recycleGraceMs: 100, worker: "terminals" });
		await expect(helper.request("hang", {})).rejects.toThrow("timed out");
		await sleep(250);
		expect(gone(workers()[0])).toBe(false);
		expect(workers()).toHaveLength(1);
	});

	it("never recycles the extensions worker: a plugin upgrade may run past any request timeout", async () => {
		const { helper, workers } = await helperOnWorker(100, { recycleGraceMs: 100, worker: "extensions" });
		await expect(helper.request("hang", {})).rejects.toThrow("timed out");
		await sleep(250);
		expect(gone(workers()[0])).toBe(false);
		expect(workers()).toHaveLength(1);
	});

	it("lets one request carry its own timeout, longer or shorter than the helper's default", async () => {
		const { helper } = await helperOnWorker(100);
		// slow takes 300 ms: the default 100 ms would cut it, an explicit 5 s does not.
		await expect(helper.request("slow", {}, { timeoutMs: 5000 })).resolves.toBe("slow");
		const shortened = await helperOnWorker(5000);
		await expect(shortened.helper.request("hang", {}, { timeoutMs: 100 })).rejects.toThrow("timed out");
	});

	it("times a request out even while its worker never finishes starting", async () => {
		const helper = new StockHelper(dir, {
			requestTimeoutMs: 100,
			launch: () => new Promise<never>(() => {}),
		});
		helpers.push(helper);
		await expect(helper.request("fast", {})).rejects.toThrow("timed out");
	});

	it("rejects pending requests on stop()", async () => {
		const { helper } = await helperOnWorker(5000);
		await helper.request("fast", {});
		const slow = helper.request("slow", {});
		await sleep(50);
		const rejected = expect(slow).rejects.toThrow("stopped");
		await helper.stop();
		await rejected;
	});

	it("ends an idle worker once every request it was sent is answered, and starts a fresh one on the next", async () => {
		const { helper, workers } = await helperOnWorker(5000, { worker: "extensions", idleExitMs: 150 });
		await vi.waitFor(() => expect(gone(workers()[0])).toBe(true), { timeout: 10_000 });
		await expect(helper.request("fast", {}, { timeoutMs: 30_000 })).resolves.toBe("ok");
		expect(workers()).toHaveLength(2);
	});

	it("keeps an idle-exit worker up while a request it was sent still runs, even one whose caller timed out", async () => {
		const { helper, workers } = await helperOnWorker(100, { worker: "extensions", idleExitMs: 150 });
		await expect(helper.request("gated", {})).rejects.toThrow("timed out");
		// A plugin upgrade past its timeout: the worker is still at it, so it stays.
		await sleep(500);
		expect(gone(workers()[0])).toBe(false);
		// Its late answer leaves the lane empty: now it ends.
		await fs.writeFile(path.join(dir, "release"), "");
		await vi.waitFor(() => expect(gone(workers()[0])).toBe(true), { timeout: 10_000 });
		expect(workers()).toHaveLength(1);
	});

	it("starts a fresh stock worker once the installed omp changed under an idle one, and keeps it while it is busy", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { helper, workers, install } = await helperOnWorker(30_000);
			// omp was reinstalled under the running worker: its module registry holds the old files, and a module it
			// imports later comes from the new ones (12 Nov 2026: "Export named … not found" on every worktree create).
			await install("18.19.0");
			await expect(helper.request("fast", {})).resolves.toBe("ok");
			expect(workers()).toHaveLength(2);
			await vi.waitFor(() => expect(gone(workers()[0])).toBe(true), { timeout: 10_000 });
			// Unchanged: the same worker answers.
			await expect(helper.request("fast", {})).resolves.toBe("ok");
			expect(workers()).toHaveLength(2);
			// A change while a request still runs on the worker waits for it: nothing in flight is cut.
			const gated = helper.request("gated", {});
			// The core reads the stamp when the request reaches it: the change comes once the worker runs the request.
			await vi.waitFor(() => expect(readFileSync(path.join(dir, "gated-started"), "utf8")).toBe("gated\n"));
			expect(workers()).toHaveLength(2);
			await install("18.19.1");
			const queued = helper.request("fast", {});
			// The core judges the change when the request reaches it: released before that, the gated answer can reach
			// the core first, the queued request then finds the worker idle and starts a fresh one (run 43487785919).
			// It reached the core once the worker it holds was handed it.
			await vi.waitFor(() =>
				expect(readFileSync(path.join(dir, "handed"), "utf8").trim().split("\n").slice(-2)).toEqual([
					"gated",
					"fast",
				]),
			);
			await fs.writeFile(path.join(dir, "release"), "");
			await expect(gated).resolves.toBe("gated");
			await expect(queued).resolves.toBe("ok");
			expect(workers()).toHaveLength(2);
			await expect(helper.request("fast", {})).resolves.toBe("ok");
			expect(workers()).toHaveLength(3);
		} finally {
			warn.mockRestore();
		}
	});

	it("starts a fresh worker once an omp install it started in the middle of has finished", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// bun install -g wrote omp's own package first, then its dependencies, then the install's lockfile
			// (18 Nov 2026, 06:59:53-56: a worker started at 54.5 failed every session open after).
			const install = path.join(dir, "install");
			const scope = path.join(install, "node_modules", "@oh-my-pi");
			const root = path.join(scope, "pi-coding-agent");
			await fs.mkdir(root, { recursive: true });
			await fs.writeFile(path.join(install, "package.json"), "{}");
			await fs.writeFile(path.join(install, "bun.lock"), "old");
			await fs.writeFile(
				path.join(root, "index.ts"),
				'import { version as ai } from "@oh-my-pi/pi-ai";\nexport const version = "agent+" + ai;\n',
			);
			const { helper, workers } = await helperOnWorker(30_000, {}, root);
			const entry = path.join(root, "index.ts");
			await expect(helper.request("omp", entry)).rejects.toThrow("Cannot find package '@oh-my-pi/pi-ai'");
			// The install finishes: Bun remembers the failed resolution for the life of the process, so only a
			// fresh worker sees the package.
			await fs.mkdir(path.join(scope, "pi-ai"));
			await fs.writeFile(path.join(scope, "pi-ai", "package.json"), '{"name":"@oh-my-pi/pi-ai","main":"index.ts"}');
			await fs.writeFile(path.join(scope, "pi-ai", "index.ts"), 'export const version = "18.22.1";\n');
			await fs.writeFile(path.join(install, "bun.lock"), "new lock");
			await expect(helper.request("omp", entry)).resolves.toBe("agent+18.22.1");
			expect(workers()).toHaveLength(2);
			// Nothing moved since: the fresh worker stays.
			await expect(helper.request("fast", {})).resolves.toBe("ok");
			expect(workers()).toHaveLength(2);
		} finally {
			warn.mockRestore();
		}
	});

	it("never retires the terminals worker for a changed omp: its live shells would go with it", async () => {
		const { helper, workers, install } = await helperOnWorker(30_000, { worker: "terminals" });
		await install("18.19.0");
		await expect(helper.request("fast", {})).resolves.toBe("ok");
		expect(workers()).toHaveLength(1);
	});

	it("ends its workers with the core, however the core ends", async () => {
		const { helper, workers } = await helperOnWorker(30_000, { worker: "terminals" });
		const hung = helper.request("hang", {});
		const failed = expect(hung).rejects.toThrow("ompdesk-core exited");
		// A crash of the app's core: nothing closes the worker's stdin in an orderly way and no stop is sent.
		process.kill(core().pid as number, "SIGKILL");
		await failed;
		await vi.waitFor(() => expect(gone(workers()[0])).toBe(true), { timeout: 10_000 });
		// The next request starts a core and a worker again.
		const next = await helperOnWorker(30_000, { worker: "terminals" });
		expect(gone(next.workers()[0])).toBe(false);
	});
});

describe("helperWorker", () => {
	it("sends terminals and PTYs to their own worker, extension calls to the extensions lane, everything else to the stock lane", async () => {
		const routed = [
			["terminal.request", "terminals"],
			["terminal.dispose", "terminals"],
			["pty.request", "terminals"],
			["extensions.inventory", "extensions"],
			["extensions.plugin.upgrade", "extensions"],
			["sessions.list", "stock"],
			["models.validate", "stock"],
			["accounts.providers", "stock"],
		] as const;
		// A worker that answers every method with the worker it was started as.
		const script = path.join(dir, "which-worker.ts");
		const dispatch = path.resolve("resources/gui-bridge/stock-helper/dispatch.ts");
		await fs.writeFile(
			script,
			`import { createInterface } from "node:readline";
import { createDispatcher } from ${JSON.stringify(dispatch)};
const methods = Object.fromEntries(${JSON.stringify(routed.map(([method]) => method))}.map(method => [method, () => process.argv[2]]));
const input = createInterface({ input: process.stdin });
input.on("close", () => process.exit(0));
input.on("line", createDispatcher(methods, line => process.stdout.write(line + "\\n"), true));
`,
		);
		const helper = new StockHelper(dir, {
			launch: async worker => ({ bin: "bun", args: [script, worker], env: process.env }),
		});
		helpers.push(helper);
		for (const [method, worker] of routed) expect(await helper.request(method, {})).toBe(worker);
	});
});

describe("createDispatcher", () => {
	it("withdraws a queued request that has not started, acknowledges it in its turn, and answers the rest in order", async () => {
		const out: string[] = [];
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		const ran: string[] = [];
		const dispatch = createDispatcher(
			{
				first: async () => {
					await gate;
					ran.push("first");
					return 1;
				},
				second: () => {
					ran.push("second");
					return 2;
				},
				third: () => {
					ran.push("third");
					return 3;
				},
			},
			line => out.push(line),
			false,
		);
		dispatch(JSON.stringify({ id: 1, method: "first" }));
		dispatch(JSON.stringify({ id: 2, method: "second" }));
		dispatch(JSON.stringify({ id: 3, method: "third" }));
		dispatch(JSON.stringify({ cancel: 2 }));
		release();
		await vi.waitFor(() => expect(out).toHaveLength(3));
		expect(ran).toEqual(["first", "third"]);
		expect(out.map(line => JSON.parse(line))).toEqual([
			{ id: 1, result: 1 },
			{ id: 2, error: "withdrawn" },
			{ id: 3, result: 3 },
		]);
	});

	it("answers an unqueued probe at once while a scan holds the serial lane", async () => {
		const out: string[] = [];
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		const dispatch = createDispatcher(
			{
				"sessions.list": async () => {
					await gate;
					return [];
				},
				"sessions.owned": () => false,
				"sessions.delete": () => true,
			},
			line => out.push(line),
			{ "sessions.owned": true },
		);
		dispatch(JSON.stringify({ id: 1, method: "sessions.list" }));
		dispatch(JSON.stringify({ id: 2, method: "sessions.delete" }));
		dispatch(JSON.stringify({ id: 3, method: "sessions.owned" }));
		await vi.waitFor(() => expect(out).toHaveLength(1));
		expect(JSON.parse(out[0] as string)).toEqual({ id: 3, result: false });
		release();
		await vi.waitFor(() => expect(out).toHaveLength(3));
		expect(out.slice(1).map(line => JSON.parse(line))).toEqual([
			{ id: 1, result: [] },
			{ id: 2, result: true },
		]);
	});

	it("reports unknown methods and malformed requests without stopping", async () => {
		const out: string[] = [];
		const dispatch = createDispatcher({}, line => out.push(line), false);
		dispatch(JSON.stringify({ id: 7, method: "constructor" }));
		dispatch("not json");
		await vi.waitFor(() => expect(out).toHaveLength(2));
	});
});

describe("stock helper terminals", () => {
	let helper: StockHelper;
	beforeEach(async () => {
		helper = await terminalTestHelper(dir);
		helpers.push(helper);
	});
	const request = (operation: TerminalOperation, owner = "a") =>
		helper.request<TerminalSnapshot[]>("terminal.request", { owner, cwd: dir, operation });

	it("builds one terminal service for overlapping first requests, so dispose reaches every PTY", async () => {
		await Promise.all(["a", "b"].map(owner => request({ action: "create", cols: 80, rows: 24 }, owner)));
		await helper.stop();
		expect(await fs.readFile(path.join(dir, "kills"), "utf8")).toBe("xx");
	});

	it("closes a paired tab's first PTY when it is disposed during worker startup", async () => {
		const owner = "peer:fixture:tab";
		await Promise.all([
			request({ action: "create", cols: 80, rows: 24 }, owner),
			helper.request("terminal.dispose", { owner }),
		]);
		expect(await request({ action: "list" }, owner)).toEqual([]);
		expect(await fs.readFile(path.join(dir, "kills"), "utf8")).toBe("x");
	});

	it("orders named peer creates around disposal and selects only an exact listed shell path", async () => {
		const { result: shells } = await core().call<TerminalShell[]>("terminal.shells");
		const shell = shells[shells.length - 1];
		expect(shell).toBeDefined();
		const nearMatch = shell.path === shell.path.toUpperCase() ? shell.path.toLowerCase() : shell.path.toUpperCase();
		expect(shells.map(entry => entry.path)).not.toContain(nearMatch);
		const owner = { deviceId: "first", rtab: "shared-tab" };
		const other = { ...owner, deviceId: "second" };
		const launchLog = path.join(dir, "launches");
		const create = (peer: typeof owner, shellPath: string, cols: number) =>
			helper.request<TerminalSnapshot[]>("terminal.create", {
				owner: peer,
				operation: { action: "create", shell: shellPath, cols, rows: 31 },
				cwd: dir,
				env: { STOCK_TEST_LAUNCH_LOG: launchLog },
			});
		const peerRequest = (peer: typeof owner, operation: TerminalOperation) =>
			helper.request<TerminalSnapshot[]>("terminal.peerRequest", { owner: peer, operation, cwd: dir, env: {} });

		const [{ id: otherId }] = await create(other, shell.path, 81);
		const [first, , later] = await Promise.all([
			create(owner, shell.path, 82),
			helper.request("terminal.peerDispose", { owner }),
			create(owner, nearMatch, 83),
		]);
		expect(first).toMatchObject([{ cols: 82 }]);
		expect(later).toMatchObject([{ cols: 83 }]);
		const [{ id }] = later;
		expect(id).not.toBe(first[0].id);
		expect(await fs.readFile(path.join(dir, "kills"), "utf8")).toBe("x");
		const launches = (await fs.readFile(launchLog, "utf8")).trimEnd().split("\n");
		expect(launches.map(line => JSON.parse(line))).toEqual([
			{ application: shell.path, args: shell.args, cwd: dir, cols: 81, rows: 31 },
			{ application: shell.path, args: shell.args, cwd: dir, cols: 82, rows: 31 },
			{
				application: path.join(dir, "worker-default"),
				args: process.platform === "win32" ? [] : ["-l"],
				cwd: dir,
				cols: 83,
				rows: 31,
			},
		]);
		await peerRequest(owner, { action: "write", id, data: "\ud800" });
		expect(await peerRequest(owner, { action: "list" })).toMatchObject([{ id, output: "\ud800", offset: 1 }]);
		expect(await peerRequest(other, { action: "list" })).toMatchObject([{ id: otherId, output: "", exited: false }]);
	});

	it("reads each viewer's UTF-16 budget across worker replies, restarts, clears and retention cuts", async () => {
		const [{ id }] = await request({ action: "create", cols: 80, rows: 24 });
		const list = (from: number, budget: number) => request({ action: "list", offsets: { [id]: from }, budget });
		const waiting = request({ action: "list", offsets: { [id]: 0 }, budget: 3, waitMs: 1000 });
		await request({ action: "write", id, data: "ab😀cd\ud800" });
		expect(await waiting).toMatchObject([{ id, output: "ab", offset: 2 }]);
		expect(await list(2, 3)).toMatchObject([{ output: "😀c", offset: 5 }]);
		expect(await list(5, 4)).toMatchObject([{ output: "d\ud800", offset: 7 }]);
		expect(await list(3, 1)).toMatchObject([{ output: "\ude00", offset: 4 }]);
		expect(await list(400, 4)).toMatchObject([{ output: "", offset: 7 }]);
		expect(await request({ action: "list", offsets: {} })).toMatchObject([{ output: "", offset: 7 }]);
		expect(await request({ action: "list" }, "b")).toEqual([]);
		await request({ action: "restart", id });
		expect(await request({ action: "list" })).toMatchObject([{ output: "ab😀cd\ud800", offset: 7 }]);
		await request({ action: "clear", id });
		expect(await request({ action: "list" })).toMatchObject([{ output: "", offset: 7 }]);
		await request({ action: "write", id, data: "😀" });
		await request({ action: "write", id, data: "x".repeat(999_999) });
		expect(await list(0, 2)).toMatchObject([{ output: "\ude00x", offset: 10 }]);
		await helper.request("terminal.dispose", { owner: "a" });
		expect(await request({ action: "list" })).toEqual([]);
	});
});
