import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { constants, getPriority, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CoreProcess } from "./core/process";
import { McpHub } from "./mcp-hub";
import { nativeBinPath } from "./native-bin";
import { RM_TEMP } from "./test-fake-omp";

let dir: string;
let client: CoreProcess;
let hub: McpHub;
let events: EventEmitter<{ listening: [number]; exited: []; exhausted: [] }>;
let starts: number[];
let delays: (number | null)[];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mcp-hub-lifetime-"));
	client = new CoreProcess({ binary: () => nativeBinPath("ompdesk-core") });
	events = new EventEmitter();
	starts = [];
	delays = [];
	hub = new McpHub(
		{
			memoryStateFile: join(dir, "recall.json"),
			log: notice => {
				if (notice.message === "listening") {
					starts.push(notice.details.pid);
					events.emit("listening", notice.details.pid);
				} else {
					delays.push(notice.details.restartInMs);
					events.emit("exited");
					if (notice.details.restartInMs === null) events.emit("exhausted");
				}
			},
		},
		client,
	);
});

afterEach(async () => {
	try {
		await hub.kill();
	} finally {
		await client.shutdown();
		await rm(dir, RM_TEMP);
	}
});

function listening(): Promise<number> {
	const { promise, resolve } = Promise.withResolvers<number>();
	events.once("listening", resolve);
	return promise;
}

// GET reaches the real worker's method check only after authentication. Nothing in a failure prints the bearer.
async function status(env: Record<string, string>): Promise<number> {
	const response = await fetch(new URL("/memory", env.OMP_GUI_MCP_HUB), {
		headers: { authorization: env.OMP_GUI_MCP_AUTH, connection: "close" },
	});
	return response.status;
}

async function launch() {
	const { OMP_GUI_MCP_HUB, OMP_GUI_MCP_AUTH } = await hub.ompEnv();
	if (!OMP_GUI_MCP_HUB || !OMP_GUI_MCP_AUTH) throw new Error("The fixture MCP hub did not listen");
	return { OMP_GUI_MCP_HUB, OMP_GUI_MCP_AUTH };
}

it("shares one below-normal worker across concurrent launches and a crashed worker's replacement", async () => {
	await client.call("core.echo");
	const parent = client.pid;
	if (parent === null) throw new Error("The fixture core did not start");
	const parentPriority = getPriority(parent);
	const first = listening();
	const [tab, scheduled] = await Promise.all([launch(), launch()]);
	const pid = await first;
	expect(starts).toHaveLength(1);
	expect(getPriority(pid)).toBe(constants.priority.PRIORITY_BELOW_NORMAL);
	expect(getPriority(parent)).toBe(parentPriority);
	expect(tab.OMP_GUI_MCP_HUB).toBe(scheduled.OMP_GUI_MCP_HUB);
	expect(await status(scheduled)).toBe(405);
	const again = listening();
	process.kill(pid, "SIGKILL");
	const replacement = await again;
	expect(delays).toEqual([1000]);
	expect(getPriority(replacement)).toBe(constants.priority.PRIORITY_BELOW_NORMAL);
	expect(await status(tab)).toBe(405);
});

it("restores the old tab's binding after a core crash without another launch request", async () => {
	const first = listening();
	const tab = await launch();
	await first;
	const again = listening();
	client.abandon("MCP hub fixture");
	await again;
	expect(await status(tab)).toBe(405);
}, 15_000);

it("will not move a published port when it is busy; demand revives the spent ladder", async () => {
	const first = listening();
	const tab = await launch();
	const pid = await first;
	await client.stop();
	expect(() => process.kill(pid, 0)).toThrow();
	const blocker = createServer(socket => socket.destroy());
	const blocked = once(blocker, "listening");
	blocker.listen(Number(new URL(tab.OMP_GUI_MCP_HUB).port), "127.0.0.1");
	await blocked;
	try {
		const exhausted = once(events, "exhausted");
		await client.call("core.echo"); // A new core's ready event, not a new omp environment request.
		await exhausted;
		expect(delays).toEqual([1000, 2000, 4000, null]);
		expect(starts).toHaveLength(1);
	} finally {
		const closed = once(blocker, "close");
		blocker.close();
		await closed;
	}
	const again = listening();
	await Promise.all([hub.ompEnv(), hub.ompEnv()]);
	await again;
	expect(starts).toHaveLength(2);
	expect(await status(tab)).toBe(405);
}, 20_000);

it("a quit during restart joins the stop and a late spawn cannot revive the hub", async () => {
	const first = listening();
	const tab = await launch();
	const pid = await first;
	const exited = once(events, "exited");
	process.kill(pid, "SIGKILL");
	await exited;
	await Promise.all([hub.kill(), hub.kill()]);
	expect(Object.keys(await hub.ompEnv())).toEqual([]);
	await expect(status(tab)).rejects.toThrow();
});

it("quitting while the first launch waits does not publish a late binding", async () => {
	const opening = hub.ompEnv();
	await hub.kill();
	expect(Object.keys(await opening)).toEqual([]);
});

it("a new app does not accept the previous app's bearer", async () => {
	const old = await launch();
	await hub.kill();
	await expect(status(old)).rejects.toThrow();
	await client.shutdown();

	client = new CoreProcess({ binary: () => nativeBinPath("ompdesk-core") });
	hub = new McpHub({ memoryStateFile: join(dir, "recall.json") }, client);
	const fresh = await launch();
	expect(await status({ ...fresh, OMP_GUI_MCP_AUTH: old.OMP_GUI_MCP_AUTH })).toBe(401);
	expect(await status(fresh)).toBe(405);
});
