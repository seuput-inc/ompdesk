import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { controlToolCaller as caller, exitApp, openedSessions as opened, readRecords, untilAnswered } from "./harness";
import {
	connectHost,
	type LinkProxy,
	launchRemote,
	linkProxy,
	makeRemoteProfile,
	type RemoteInstance,
	type RemoteProfile,
} from "./remote-harness";

// Who carries out a session's OMPdesk control tools (`ompdesk_*`, host tools) while the computer that opened it is
// away. A is the client, B the host, paired through a relay whose link the test cuts (`linkProxy`).
//
// 1. A session A opened on B (`ompdesk_session_open {device}`) is A's tab: B's omp sends each host tool call to A
//    (`LocalHostServices` keeps it in `HostTab.hostCalls` and hands it to A's connection). Once A has been away past
//    the notice (`OMP_GUI_TEST_HOST_WAIT_MS`), B answers each call A was never handed: a window of B's viewing the
//    session carries it out as its own tab's (children open on B), a report to A's side is kept on disk and handed to
//    A once it is back, where it reaches the opener once. Nothing runs on both computers.
// 2. A session B's own window holds (here one a session of B's window opened) is B's: its host tool calls run in B's
//    main, so it opens children on B and messages them while A is away. A hands it work with
//    `ompdesk_session_send`, which joins it as a view.
// The rules behind each step are unit-tested in src/main/remote/host-services.test.ts ("carries out here the calls",
// "re-sends the host tool calls"), src/main/sidecar-pool.test.ts (hosted views), src/main/agent-control/service.test.ts
// and model-checked in formal/away-calls.

let parent: string;
let host: RemoteInstance | undefined;
let client: RemoteInstance | undefined;

test.beforeEach(async () => {
	parent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-away-handoff-"));
});

test.afterEach(async () => {
	for (const instance of [client, host]) if (instance) await exitApp(instance.app);
	for (const instance of [client, host]) expect(instance?.errors ?? []).toEqual([]);
	client = undefined;
	host = undefined;
	await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A (client) paired to B (host, "PC-B") through a relay the test can cut; `call` runs a tool as A's focused tab. */
async function pairApps(hostEnv: Record<string, string> = {}) {
	const hostProfile = await makeRemoteProfile(parent, "host", { language: "en", theme: "light", env: hostEnv });
	const link: LinkProxy = await linkProxy(hostProfile.port);
	const clientProfile = await makeRemoteProfile(parent, "client", {
		language: "en",
		theme: "light",
		port: Number(link.address.split(":")[1]),
	});
	host = await launchRemote(hostProfile);
	client = await launchRemote(clientProfile);
	await connectHost(host.page, client.page, "PC-B");
	const linkState = async () => (await client?.page.evaluate(() => window.omp.remote.getState()))?.hosts[0]?.state;
	await expect.poll(linkState, { timeout: 30_000 }).toBe("online");
	return {
		hostProfile,
		link,
		linkState,
		a: client.page,
		b: host.page,
		call: await caller(client.page, clientProfile.record),
	};
}

/** The control-tool results B's omps got back, in order (the fake records each `host_tool_result`). */
async function resultsOn(profile: RemoteProfile): Promise<{ text: string; isError: boolean }[]> {
	return (await readRecords(profile.record))
		.filter(frame => frame.type === "host_tool_result" && frame.recordedBy !== undefined)
		.map(frame => {
			const result = frame.result as { content?: { text?: string }[] } | undefined;
			return { text: result?.content?.[0]?.text ?? "", isError: frame.isError === true };
		});
}

const tabIds = async (page: Page) => (await page.evaluate(() => window.omp.tabs.list())).map(tab => tab.tabId);

test("a session A opened on B keeps working while A is away: B carries out its calls, keeps its report for A and hands it over once", async () => {
	test.setTimeout(240_000);
	const { hostProfile, link, linkState, a, b, call } = await pairApps({ OMP_GUI_TEST_HOST_WAIT_MS: "3000" });
	const hub = (await a.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId ?? "";
	expect(hub).not.toBe("");

	// A's hub opens the coordinator on B: A's tab, B's omp.
	const open = await call("ompdesk_session_open", { device: "PC-B", message: "Title: coordinator\nCoordinate" });
	expect(open.isError, open.text).toBe(false);
	const [coordinator] = opened(open.text);
	await untilAnswered(a, coordinator as string);
	let sessionPath = "";
	await expect
		.poll(async () => {
			sessionPath = (await a.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === coordinator)
				?.sessionPath as string;
			return sessionPath;
		})
		.toBeTruthy();

	// B's own window shows it: a view of A's tab (one omp), not a tab of B's.
	const view = (await b.evaluate(file => window.omp.tabs.spawn({ sessionPath: file }), sessionPath))?.tabId ?? "";
	expect(view).not.toBe("");
	await expect
		.poll(async () => {
			const tab = (await b.evaluate(() => window.omp.tabs.list())).find(entry => entry.tabId === view);
			return tab && { shared: tab.shared, status: tab.status };
		})
		.toEqual({ shared: true, status: "ready" });

	// A goes away. The coordinator's turn goes on on B (driven here from B's view, as its own turn would: the fake emits
	// each host tool call from B's omp).
	const aTabsBefore = await tabIds(a);
	const resultsBefore = (await resultsOn(hostProfile)).length;
	await link.drop();
	await expect.poll(linkState, { timeout: 30_000 }).not.toBe("online");
	const asCoordinator = async (tool: string, args: Record<string, unknown>) => {
		const before = (await resultsOn(hostProfile)).length;
		const sent = await b.evaluate(([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }), [
			view,
			`fixture:host-tool:${tool} ${JSON.stringify(args)}`,
		] as const);
		expect(sent).toMatchObject({ success: true });
		await expect.poll(async () => (await resultsOn(hostProfile)).length, { timeout: 60_000 }).toBe(before + 1);
		return (await resultsOn(hostProfile))[before];
	};

	// Past the notice B's window carries the open out: the worker is a tab on B, and the coordinator is told so.
	const opening = await asCoordinator("ompdesk_session_open", { message: "Title: worker one\nPart one" });
	expect(opening?.isError, opening?.text).toBe(false);
	expect(opening?.text).toContain("PC-B carried this out");
	const children = opened(opening?.text ?? "");
	expect(children).toHaveLength(1);
	await untilAnswered(b, children[0] as string);
	expect(await tabIds(b)).toContain(children[0]);

	// A report for A's hub is kept on B, and the coordinator goes on at once.
	const report = await asCoordinator("ompdesk_report", { kind: "note", text: "Worker one started while A was away" });
	expect(report?.isError, report?.text).toBe(false);
	expect(report?.text).toContain("Kept for");
	expect(await linkState()).not.toBe("online");

	// A is back: the kept report reaches its hub once, and A runs none of the calls B answered.
	await link.restore();
	await expect.poll(linkState, { timeout: 30_000 }).toBe("online");
	const hubMail = async () => {
		const page = await a.evaluate(
			id => window.omp.rpc.commandForTab(id, { type: "get_transcript_page", fromEnd: true, limit: 50 }),
			hub,
		);
		const messages = (page.data as { messages?: { customType?: string }[] } | undefined)?.messages ?? [];
		return messages.filter(
			message => message.customType === "ompdesk.mail" && JSON.stringify(message).includes("while A was away"),
		).length;
	};
	await expect.poll(hubMail, { timeout: 60_000 }).toBe(1);
	// Past the next re-attach's hand-over: still one.
	await link.drop();
	await expect.poll(linkState, { timeout: 30_000 }).not.toBe("online");
	await link.restore();
	await expect.poll(linkState, { timeout: 30_000 }).toBe("online");
	expect(await hubMail()).toBe(1);
	expect((await tabIds(a)).filter(id => !aTabsBefore.includes(id))).toEqual([]);
	expect(await resultsOn(hostProfile)).toHaveLength(resultsBefore + 2);
	await link.close();
});

test("a session B's own window holds runs its control tools on B, so it opens and messages children while A is away", async () => {
	test.setTimeout(240_000);
	const { hostProfile, link, linkState, a, b, call } = await pairApps();

	// A session of B's own window (the person's there, or one such a session opened) opens the hub's coordinator in B's
	// window.
	const hostCall = await caller(b, hostProfile.record);
	const own = await hostCall("ompdesk_session_open", { message: "Title: coordinator on B\nWait for work" });
	expect(own.isError, own.text).toBe(false);
	const [coordinator] = opened(own.text);
	await untilAnswered(b, coordinator as string);

	// A's hub finds it in B's list, marked open in a tab on B, and hands it the work.
	const openThere = /\n- (\S+) "[^\n]*\n[^\n]*; open in a tab on PC-B: idle\n/;
	let stored = "";
	await expect
		.poll(
			async () => {
				stored = (await call("ompdesk_sessions", { scope: "stored", device: "PC-B", query: "coordinator on B" }))
					.text;
				return stored;
			},
			{ timeout: 30_000 },
		)
		.toMatch(openThere);
	const savedId = openThere.exec(stored)?.[1] ?? "";
	const brief = "Coordinate the work: open workers on this computer";
	const sent = await call("ompdesk_session_send", { session: savedId, message: brief });
	expect(sent.isError, sent.text).toBe(false);
	await untilAnswered(b, coordinator as string, { after: brief });

	// A goes away; the coordinator's turn on B opens a worker and messages it.
	await link.drop();
	await expect.poll(linkState, { timeout: 30_000 }).not.toBe("online");
	const asCoordinator = await caller(b, hostProfile.record, coordinator);
	const worker = await asCoordinator("ompdesk_session_open", { message: "Title: worker two\nPart two" });
	expect(worker.isError, worker.text).toBe(false);
	const [child] = opened(worker.text);
	expect(await tabIds(b)).toContain(child);
	await untilAnswered(b, child as string);
	const told = await asCoordinator("ompdesk_session_send", { session: child, message: "Next step" });
	expect(told.isError, told.text).toBe(false);
	await untilAnswered(b, child as string, { after: "Next step" });
	// All of it while A was away.
	expect(await linkState()).not.toBe("online");
	expect(await tabIds(a)).not.toContain(child);

	await link.restore();
	await expect.poll(linkState, { timeout: 30_000 }).toBe("online");
	await link.close();
});
