/**
 * A session a paired device (A) runs on this computer (B) whose turn stands in a call only A runs, while A is away:
 * B says so (remote-devices.md › A host tab never waits silently). Two apps on the fake omp (remote-harness.ts), the
 * link cut through a relay (`linkProxy`). B's window views A's session; a prompt from B's view makes the omp call a
 * host tool, which B hands to A's link just as A goes to sleep (the relay holds it, then the link drops), so A may have
 * it and B never runs it (formal/away-calls). Past the grace (`OMP_GUI_TEST_HOST_WAIT_MS`) B's title bar reads
 * "Waiting for PC-A" and B posts one OS notification; once A is back B hands it the call again, A runs it once, and
 * the bar clears. The rules are unit-tested in src/main/remote/host-services.test.ts.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { capture, cssString, exitApp, readRecords } from "./harness";
import {
	connectHost,
	freePort,
	launchRemote,
	linkProxy,
	makeRemoteProfile,
	openHostFolder,
	type RemoteInstance,
} from "./remote-harness";

test("a host's window says when a paired device's session waits on that device while it is away, once, until it is back", async () => {
	test.setTimeout(240_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-host-wait-")));
	const hostPort = await freePort();
	const proxy = await linkProxy(hostPort);
	let host: RemoteInstance | undefined;
	let client: RemoteInstance | undefined;
	try {
		const hostProfile = await makeRemoteProfile(parent, "host", {
			language: "en",
			theme: "light",
			port: hostPort,
			env: { OMP_GUI_TEST_HOST_WAIT_MS: "3000" },
		});
		const clientProfile = await makeRemoteProfile(parent, "client", {
			language: "en",
			theme: "light",
			port: Number(proxy.address.split(":")[1]),
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const b = host.page;
		const a = client.page;
		await a.evaluate(() => window.omp.remote.setDeviceName("PC-A"));
		const deviceId = await connectHost(b, a, "PC-B");
		// Observe show() before the headless shell adapter suppresses OS delivery.
		await host.app.evaluate(({ Notification }) => {
			const shown: Array<{ title: string; body: string }> = [];
			Reflect.set(globalThis, "__shownNotifications", shown);
			Notification.prototype.show = function show(this: { title: string; body: string }) {
				shown.push({ title: this.title, body: this.body });
			};
		});
		const notifications = () =>
			host?.app.evaluate(
				() => Reflect.get(globalThis, "__shownNotifications") as Array<{ title: string; body: string }>,
			);

		await openHostFolder(a, deviceId, hostProfile.project);
		const input = a.locator("textarea").first();
		await input.fill("Start here");
		await input.press("Enter");
		await expect(a.getByText("Local fixture reply").first()).toBeVisible({ timeout: 30_000 });

		let sessionPath = "";
		await expect
			.poll(
				async () => {
					const hosted = await b.evaluate(() =>
						window.omp.sessions
							.summaries()
							.then(all => all?.sessions.filter(row => row.openFor !== undefined) ?? []),
					);
					sessionPath = hosted[0]?.sessionPath ?? "";
					return sessionPath;
				},
				{ timeout: 30_000 },
			)
			.not.toBe("");
		const hostRow = b.locator(`.omp-sidebar-session-row[data-session-path=${cssString(sessionPath)}]`);
		await hostRow.locator("button").first().click();
		await expect
			.poll(
				async () =>
					(await b.evaluate(() => window.omp.tabs.list())).find(tab => tab.sessionPath === sessionPath)?.active,
				{ timeout: 30_000 },
			)
			.toBe(true);
		const status = b.locator(".omp-titlebar-status");

		await test.step("A sleeps under a call B's link already handed it: B never runs that one, and says it waits for A, once", async () => {
			// A sleeping computer's link stays up on B until it is seen dead: the call B hands it then never arrives.
			proxy.setLatency(60_000);
			const hostInput = b.locator("textarea").first();
			await hostInput.fill("fixture blocking tool:ompdesk_sessions");
			await hostInput.press("Enter");
			await expect
				.poll(
					async () =>
						(await b.evaluate(() => window.omp.sessions.summaries()))?.sessions.find(
							row => row.sessionPath === sessionPath,
						)?.status,
				)
				.toBe("running");
			// The omp's call follows its turn's start within the same burst of frames; nothing marks it on the page.
			await b.waitForTimeout(1_000);
			await proxy.drop();
			proxy.setLatency(0);
			await expect(a.locator(`[data-remote-reconnecting="${deviceId}"]`)).toBeVisible({ timeout: 30_000 });
			await expect(status).toHaveAttribute("title", "Waiting for PC-A", { timeout: 30_000 });
			await expect
				.poll(
					async () =>
						(await b.evaluate(() => window.omp.sessions.summaries()))?.sessions.find(
							row => row.sessionPath === sessionPath,
						)?.waitsForDevice,
				)
				.toBe("PC-A");
			await expect
				.poll(notifications)
				.toEqual([{ title: "Waiting for PC-A", body: expect.stringContaining("PC-A") }]);
			await capture(b, "host-waits-for-device");
		});

		await test.step("A is back: B hands it the call again, A runs it, B's bar clears and nothing more is posted", async () => {
			await proxy.restore();
			await expect(a.locator(`[data-remote-reconnecting="${deviceId}"]`)).toHaveCount(0, { timeout: 60_000 });
			await expect
				.poll(
					async () =>
						(await readRecords(hostProfile.record)).filter(
							frame => frame.type === "host_tool_result" && frame.recordedBy !== undefined,
						).length,
					{ timeout: 60_000 },
				)
				.toBe(1);
			await expect(status).not.toHaveAttribute("title", "Waiting for PC-A", { timeout: 30_000 });
			expect(
				(await b.evaluate(() => window.omp.sessions.summaries()))?.sessions.find(
					row => row.sessionPath === sessionPath,
				)?.waitsForDevice,
			).toBeUndefined();
			expect(await notifications()).toHaveLength(1);
		});
		for (const instance of [client, host]) expect(instance.errors).toEqual([]);
	} finally {
		for (const instance of [client, host]) if (instance) await exitApp(instance.app);
		await proxy.close();
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
