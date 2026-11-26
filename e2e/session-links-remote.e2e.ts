/**
 * A paired host's session links are the host's (panels-sidebar.md › The host owns its rows; 26 Nov 2026: the row menu
 * on a paired computer had no "Link a PR or issue…", the phone page did). A link the device adds lands in the host's
 * own list, and one the host adds reaches the device's row through `host.sessionLinks.changed`. The dialog and the row
 * words are SidebarSessionLinks.test.tsx's and Sidebar.test.tsx's ("a paired host's session menu").
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { cssString, exitApp } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, openHostFolder, type RemoteInstance } from "./remote-harness";

const PR = "https://github.com/acme/app/pull/7";
const ISSUE = "https://github.com/acme/app/issues/9";

const linksOn = (page: Page, sessionPath: string, device?: string) =>
	page.evaluate(
		async ({ file, device }) =>
			((await window.omp.sessions.links({ type: "session_links" }, device)) as Record<string, { url: string }[]>)[
				file
			]?.map(link => link.url) ?? [],
		{ file: sessionPath, device },
	);

test("a paired computer reads and changes a host's session links on the host", async () => {
	test.setTimeout(240_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-links-remote-")));
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
		const a = client.page;
		const b = host.page;
		await a.evaluate(() => window.omp.remote.setDeviceName("PC-A"));
		const deviceId = await connectHost(b, a, "PC-B");
		const remoteTab = await openHostFolder(a, deviceId, hostProfile.project);
		const input = a.locator(".omp-composer-input").first();
		await input.fill("hello host");
		await input.press("Enter");
		await expect(a.getByText("Local fixture reply")).toHaveCount(1, { timeout: 30_000 });
		let sessionPath = "";
		await expect
			.poll(async () => {
				const tabs = await a.evaluate(() => window.omp.tabs.list());
				sessionPath = tabs.find(tab => tab.tabId === remoteTab)?.sessionPath ?? "";
				return sessionPath;
			})
			.not.toBe("");

		// Added from the paired computer: kept on the host, not here.
		await a.evaluate(
			({ file, device, url }) =>
				window.omp.sessions.links({ type: "session_link_add", sessionPath: file, url }, device),
			{ file: sessionPath, device: deviceId, url: PR },
		);
		expect(await linksOn(b, sessionPath)).toEqual([PR]);
		expect(await linksOn(a, sessionPath)).toEqual([]);
		const row = a.locator(`[data-sidebar-device="${deviceId}"] [data-device-session=${cssString(sessionPath)}]`);
		await expect(row).toContainText("1 linked", { timeout: 30_000 });

		// Added on the host itself: the paired computer's row follows.
		await b.evaluate(
			({ file, url }) => window.omp.sessions.links({ type: "session_link_add", sessionPath: file, url }),
			{ file: sessionPath, url: ISSUE },
		);
		await expect(row).toContainText("2 linked", { timeout: 30_000 });
		expect(await linksOn(a, sessionPath, deviceId)).toEqual([PR, ISSUE]);
	} finally {
		for (const instance of [client, host]) if (instance) await exitApp(instance.app);
		for (const instance of [client, host]) expect(instance?.errors ?? []).toEqual([]);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
