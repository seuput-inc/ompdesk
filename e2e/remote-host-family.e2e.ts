/**
 * A paired computer's section for a host nests the sessions the host's own agent opened under their opener, as the
 * host's sidebar does (the user's report, 25 Oct 2026: viewed from a paired computer, the children of a host session
 * were loose rows of its project beside the opener). The children are tabs of the host's window, not the device's, so
 * the device knows who opened them only from the host's session list (`SessionInfo.openedBySession`). Two apps on the
 * fake omp (remote-harness.ts); the rules are unit-tested in Sidebar.test.tsx ("the sessions a host's own agents
 * opened").
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { controlToolCaller, cssString, exitApp, openedSessions, untilAnswered } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, type RemoteInstance } from "./remote-harness";

test("a paired device reopens an ordinary host's saved child under its exact parent after reconnect, not its namesake", async () => {
	test.setTimeout(240_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-host-family-")));
	let host: RemoteInstance | undefined;
	let client: RemoteInstance | undefined;
	try {
		const hostProfile = await makeRemoteProfile(parent, "host", { language: "en", theme: "light" });
		const clientProfile = await makeRemoteProfile(parent, "client", {
			language: "en",
			theme: "light",
			port: hostProfile.port,
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		let b = host.page;
		const a = client.page;
		await a.evaluate(() => window.omp.remote.setDeviceName("PC-A"));
		const deviceId = await connectHost(b, a, "PC-B");
		await expect
			.poll(async () => (await a.evaluate(() => window.omp.remote.getState())).hosts[0]?.state, { timeout: 30_000 })
			.toBe("online");

		// On the host, its own window's session opens a session that keeps working.
		const hostTabs = () => b.evaluate(() => window.omp.tabs.list());
		const originalOpener = (await hostTabs()).find(tab => tab.active)?.tabId ?? "";
		expect(originalOpener).not.toBe("");
		await expect
			.poll(async () => (await hostTabs()).find(tab => tab.tabId === originalOpener)?.status, { timeout: 60_000 })
			.toBe("ready");
		await b.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "hello" }), originalOpener);
		await expect
			.poll(async () => (await hostTabs()).find(tab => tab.tabId === originalOpener)?.lastRun?.reply, {
				timeout: 30_000,
			})
			.toBe("Local fixture reply");
		const title = "Redesign the header";
		const openChild = await controlToolCaller(b, hostProfile.record, originalOpener);
		const open = await openChild("ompdesk_session_open", { message: `Title: ${title}\nDetails follow.` });
		expect(open.isError, open.text).toBe(false);
		const [originalChild] = openedSessions(open.text);
		if (!originalChild) throw new Error(open.text);
		await untilAnswered(b, originalChild);
		const independent = (await b.evaluate(cwd => window.omp.tabs.spawn({ cwd }), hostProfile.project))?.tabId;
		if (!independent) throw new Error("No independent project tab");
		await expect
			.poll(async () => (await hostTabs()).find(t => t.tabId === independent)?.status, { timeout: 60_000 })
			.toBe("ready");
		await b.evaluate(
			id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "Independent work" }),
			independent,
		);
		await untilAnswered(b, independent);
		await b.evaluate(({ id, name }) => window.omp.rpc.commandForTab(id, { type: "set_session_name", name }), {
			id: independent,
			name: title,
		});
		const saved = await hostTabs();
		const openerSession = saved.find(t => t.tabId === originalOpener)?.sessionPath;
		const childSession = saved.find(t => t.tabId === originalChild)?.sessionPath;
		const independentSession = saved.find(t => t.tabId === independent)?.sessionPath;
		if (!openerSession || !childSession || !independentSession) throw new Error("Missing saved session");
		expect(new Set([openerSession, childSession, independentSession]).size).toBe(3);

		const section = a.locator(`[data-sidebar-device="${deviceId}"]`);
		const namesake = section.locator(`[data-device-session=${cssString(independentSession)}]`);
		await expect(namesake).toContainText(title);
		const openerRow = section.locator(`[data-device-session=${cssString(openerSession)}]`);
		const toggle = openerRow.locator("[data-sidebar-subagents-toggle]");
		const family = section.locator(`[data-sidebar-family=${cssString(`device:${deviceId}:${openerSession}`)}]`);
		const childRow = family.locator(`[data-sidebar-opened-session][data-session-path=${cssString(childSession)}]`);
		const runWhileFolded = async (id: string) => {
			await b.evaluate(
				tab => window.omp.rpc.commandForTab(tab, { type: "prompt", message: "fixture steer work" }),
				id,
			);
			await expect(openerRow.locator("[data-family-running]")).toHaveText("1", { timeout: 30_000 });
			await expect(section.locator(`[data-device-session=${cssString(childSession)}]`)).toHaveCount(0);
			await expect(toggle).toHaveAttribute("aria-expanded", "false");
			await expect(childRow).toHaveCount(0);
		};
		await runWhileFolded(originalChild);
		const firstStop = await openChild("ompdesk_session_stop", { session: originalChild });
		expect(firstStop.isError, firstStop.text).toBe(false);
		await expect.poll(async () => (await hostTabs()).find(t => t.tabId === originalChild)?.status).toBe("ready");
		await exitApp(host.app);
		expect(host.errors).toEqual([]);
		host = undefined;
		await expect(section).not.toHaveAttribute("data-device-state", "online", { timeout: 30_000 });
		host = await launchRemote(hostProfile, { project: false });
		b = host.page;
		await expect(section).toHaveAttribute("data-device-state", "online", { timeout: 60_000 });
		const restored = await hostTabs();
		const opener = restored.find(t => t.sessionPath === openerSession)?.tabId;
		const child = restored.find(t => t.sessionPath === childSession)?.tabId;
		if (!opener || !child) throw new Error("Parent or child missing from the restored layout");
		expect(opener).not.toBe(originalOpener);
		expect(child).not.toBe(originalChild);
		for (const [id, file] of [
			[opener, openerSession],
			[child, childSession],
		] as const) {
			await b.evaluate(tab => window.omp.tabs.setActive(tab), id);
			await expect
				.poll(async () => (await hostTabs()).find(t => t.tabId === id)?.status, { timeout: 60_000 })
				.toBe("ready");
			expect(await b.evaluate(tab => window.omp.rpc.commandForTab(tab, { type: "get_state" }), id)).toMatchObject({
				success: true,
				data: { sessionFile: file },
			});
		}
		const call = await controlToolCaller(b, hostProfile.record, opener);
		expect((await a.evaluate(() => window.omp.tabs.list())).filter(tab => tab.device === deviceId)).toEqual([]);
		await runWhileFolded(child);
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-expanded", "true");
		await expect(childRow).toHaveAttribute("data-child-status", "running");
		await expect(childRow).toContainText(title);
		await expect(namesake).toContainText(title);
		await expect(
			section.locator(`[data-sidebar-opened-session][data-session-path=${cssString(independentSession)}]`),
		).toHaveCount(0);
		await expect(
			section.locator(`[data-sidebar-opened-session][data-session-path=${cssString(childSession)}]`),
		).toHaveCount(1);
		await childRow.locator(`[data-roving-item=${cssString(`session:device:${deviceId}:${childSession}`)}]`).click();
		const active = () => a.evaluate(async () => (await window.omp.tabs.list()).find(tab => tab.active));
		await expect.poll(active, { timeout: 60_000 }).toMatchObject({ device: deviceId, sessionPath: childSession });
		const view = await active();
		if (!view) throw new Error("No paired view of the saved child");
		await expect
			.poll(() => a.evaluate(id => window.omp.rpc.commandForTab(id, { type: "get_state" }), view.tabId), {
				timeout: 60_000,
			})
			.toMatchObject({ success: true, data: { sessionFile: childSession } });
		await expect(toggle).toHaveAttribute("aria-expanded", "true");
		await a.evaluate(id => window.omp.tabs.close(id), view.tabId);

		await b.evaluate(
			id => window.omp.rpc.commandForTab(id, { type: "set_session_name", name: "Renamed since" }),
			opener,
		);
		const stop = await call("ompdesk_session_stop", { session: child });
		expect(stop.isError, stop.text).toBe(true);
		expect(stop.text).toContain("the user typed into it");
		expect((await hostTabs()).find(tab => tab.tabId === child)?.status).toBe("running");
		await expect(openerRow).toContainText("Renamed since", { timeout: 30_000 });
		await expect(childRow).toHaveAttribute("data-child-status", "running");
	} finally {
		for (const instance of [client, host]) if (instance) await exitApp(instance.app);
		for (const instance of [client, host]) expect(instance?.errors ?? []).toEqual([]);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
