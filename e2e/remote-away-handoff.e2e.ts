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
//    (`LocalHostServices` keeps it in `HostTab.hostCalls` and hands it to A's connection), and B's own window
//    viewing that session does not carry it out (`HostedTabView` forwards no `hostToolCall`). So a call made while
//    A is away gets no result until A is back; then A runs it once. A fix that lets B run it flips this case.
// 2. A session B's own window holds (here one a session of B's window opened) is B's: its host tool calls run in B's
//    main, so it opens children on B and messages them while A is away. A hands it work with
//    `ompdesk_session_send`, which joins it as a view.
// The rules behind each step are unit-tested in src/main/remote/host-services.test.ts ("re-sends the host tool
// calls"), src/main/sidecar-pool.test.ts (hosted views) and src/main/agent-control/service.test.ts.

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
async function pairApps() {
	const hostProfile = await makeRemoteProfile(parent, "host", { language: "en", theme: "light" });
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

test("a session A opened on B waits for A to come back before its control tools run, then runs each once", async () => {
	test.setTimeout(240_000);
	const { hostProfile, link, linkState, a, b, call } = await pairApps();

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

	// A goes away. The coordinator's turn goes on on B and calls ompdesk_session_open (driven here from B's view, as
	// its own turn would: the fake emits the host tool call from B's omp).
	const aTabsBefore = await tabIds(a);
	const bTabsBefore = await tabIds(b);
	const resultsBefore = (await resultsOn(hostProfile)).length;
	await link.drop();
	await expect.poll(linkState, { timeout: 30_000 }).not.toBe("online");
	const sent = await b.evaluate(([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }), [
		view,
		`fixture:host-tool:ompdesk_session_open ${JSON.stringify({ message: "Title: worker one\nPart one" })}`,
	] as const);
	expect(sent).toMatchObject({ success: true });

	// No result while A is away: nothing on B carries the call out. A real wait, past the 15 s an agent tool waits for a
	// paired device's link (`LINK_WAIT_MS`), since absence has no event to wait on.
	await b.waitForTimeout(20_000);
	expect(await resultsOn(hostProfile)).toHaveLength(resultsBefore);
	expect(await tabIds(b)).toEqual(bTabsBefore);

	// A is back: its tab re-attaches, gets the call it missed and runs it once.
	await link.restore();
	await expect.poll(linkState, { timeout: 30_000 }).toBe("online");
	await expect.poll(async () => (await resultsOn(hostProfile)).length, { timeout: 90_000 }).toBe(resultsBefore + 1);
	const result = (await resultsOn(hostProfile))[resultsBefore];
	expect(result?.isError, result?.text).toBe(false);
	const children = opened(result?.text ?? "");
	expect(children).toHaveLength(1);
	await untilAnswered(a, children[0] as string);
	const aTabsAfter = await tabIds(a);
	expect(aTabsAfter.filter(id => !aTabsBefore.includes(id))).toEqual(children);
	expect(await resultsOn(hostProfile)).toHaveLength(resultsBefore + 1);
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
