/**
 * Handing this computer's session to a paired computer (session-mutations.ts `handOffSession`, the host's
 * `sessions.handoff.*` and the core's remote/handoff.rs), two apps on the fake omp (remote-harness.ts): the row
 * menu's "Move to PC-B" moves the session, its file then lives on B, A shows it as a tab of B and no longer runs it,
 * and a prompt there reaches B's omp; an agent's `ompdesk_app` `sessions.hand_off` does the same; a session whose
 * project B has no folder of is refused with nothing moved; a relaunched A brings back no local copy. The protocol's
 * failures (a lost answer, a restart mid-transfer, a retry, a late commit) are covered by
 * src/main/session-handoff.test.ts and the Rust tests of remote/handoff.rs.
 */
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { capture, controlToolCaller, cssString, exitApp, readRecords } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, type RemoteInstance } from "./remote-harness";

/** A tab of `page`'s own in `cwd` that answered one turn: its session file is written. */
async function answeredSession(page: Page, cwd: string, prompt: string): Promise<{ tabId: string; file: string }> {
	const spawned = await page.evaluate(folder => window.omp.tabs.spawn({ cwd: folder, kind: "agent" }), cwd);
	const tabId = spawned?.tabId ?? "";
	expect(tabId).not.toBe("");
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === tabId)?.status, {
			timeout: 60_000,
		})
		.toBe("ready");
	await page.evaluate(([id, message]) => window.omp.rpc.commandForTab(id, { type: "prompt", message }), [
		tabId,
		prompt,
	] as const);
	let file = "";
	await expect
		.poll(
			async () => {
				const tab = (await page.evaluate(() => window.omp.tabs.list())).find(entry => entry.tabId === tabId);
				file = tab?.sessionPath ?? "";
				return file !== "" && existsSync(file) && tab?.status === "ready";
			},
			{ timeout: 60_000 },
		)
		.toBe(true);
	// Listed by the index, so its row is a stored session's (whose menu has the edits), not a tab's before its file.
	await expect
		.poll(
			async () => (await page.evaluate(() => window.omp.sessions.list("global"))).some(row => row.path === file),
			{
				timeout: 30_000,
			},
		)
		.toBe(true);
	return { tabId, file };
}

test("a session handed to a paired computer lives and runs there only", async () => {
	test.setTimeout(300_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-handoff-")));
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
		const b = host.page;
		const a = client.page;
		await a.evaluate(() => window.omp.remote.setDeviceName("PC-A"));
		const hostId = await connectHost(b, a, "PC-B");
		await expect
			.poll(async () => (await a.evaluate(() => window.omp.remote.getState())).hosts[0]?.state, { timeout: 30_000 })
			.toBe("online");
		const hostPrompts = async () =>
			(await readRecords(hostProfile.record))
				.filter(frame => frame.type === "prompt")
				.map(frame => String(frame.message));

		const first = await answeredSession(a, clientProfile.project, "Before the move");
		let moved = "";

		await test.step("the row menu's Move to PC-B moves it: A shows it as a tab of B, B lists it", async () => {
			const row = a.locator(`[data-session-path=${cssString(first.file)}]`).first();
			await row.click({ button: "right" });
			const item = a.getByRole("menuitem", { name: "Move to PC-B" });
			await expect(item).toBeVisible();
			await capture(a, "handoff-row-menu");
			await item.click();
			await expect
				.poll(
					async () => {
						const tab = (await a.evaluate(() => window.omp.tabs.list())).find(entry => entry.device === hostId);
						moved = tab?.sessionPath ?? "";
						return tab?.status;
					},
					{ timeout: 60_000 },
				)
				.toBe("ready");
			expect(moved.startsWith(path.join(hostProfile.root, "agent", "sessions"))).toBe(true);
			expect(existsSync(moved)).toBe(true);
			expect(existsSync(first.file)).toBe(false);
			const local = await a.evaluate(() => window.omp.tabs.list());
			expect(local.filter(tab => tab.device === undefined && tab.sessionPath === first.file)).toEqual([]);
			await expect(a.locator(`[data-session-path=${cssString(first.file)}]`)).toHaveCount(0);
			await expect
				.poll(
					async () => (await b.evaluate(() => window.omp.sessions.list("global"))).some(row => row.path === moved),
					{ timeout: 30_000 },
				)
				.toBe(true);
			await capture(a, "handoff-moved");
		});

		await test.step("a prompt in it reaches B's omp", async () => {
			const tab = (await a.evaluate(() => window.omp.tabs.list())).find(entry => entry.device === hostId);
			await a.evaluate(
				id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "After the move" }),
				tab?.tabId ?? "",
			);
			await expect
				.poll(async () => (await hostPrompts()).some(text => text.includes("After the move")), { timeout: 30_000 })
				.toBe(true);
			const clientPrompts = (await readRecords(clientProfile.record))
				.filter(frame => frame.type === "prompt")
				.map(frame => String(frame.message));
			expect(clientPrompts.some(text => text.includes("After the move"))).toBe(false);
		});

		const second = await answeredSession(a, clientProfile.project, "Second session");
		const gone = path.join(parent, "gone");
		await fs.mkdir(gone);
		const orphan = await answeredSession(a, gone, "A folder B lacks");
		const caller = await answeredSession(a, clientProfile.project, "The caller");
		const call = await controlToolCaller(a, clientProfile.record, caller.tabId);

		await test.step("an agent hands a session on with ompdesk_app sessions.hand_off", async () => {
			const result = await call("ompdesk_app", {
				action: "sessions.hand_off",
				args: { sessionPath: second.file, to: "PC-B" },
			});
			expect(result.isError, result.text).toBe(false);
			expect(result.text).toContain("Moved to PC-B");
			expect(existsSync(second.file)).toBe(false);
			const remoteFile = path.join(hostProfile.root, "agent", "sessions", "fixture", path.basename(second.file));
			expect(existsSync(remoteFile)).toBe(true);
			await expect
				.poll(
					async () =>
						(await a.evaluate(() => window.omp.tabs.list())).find(
							tab => tab.device === hostId && tab.sessionPath === remoteFile,
						)?.status,
					{ timeout: 60_000 },
				)
				.toBe("ready");
		});

		await test.step("a session of a folder B does not have is refused and stays here", async () => {
			// Its tab's omp works in that folder, and Windows keeps a folder a process works in: close the tab first.
			expect(await a.evaluate(id => window.omp.tabs.close(id), orphan.tabId)).toBe(true);
			await fs.rm(gone, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
			const refused = await call("ompdesk_app", {
				action: "sessions.hand_off",
				args: { sessionPath: orphan.file, to: "PC-B" },
			});
			expect(refused.isError).toBe(true);
			expect(refused.text).toContain("no folder for gone");
			expect(existsSync(orphan.file)).toBe(true);
			expect(
				existsSync(path.join(hostProfile.root, "agent", "sessions", "fixture", path.basename(orphan.file))),
			).toBe(false);
		});

		await test.step("a relaunched A brings back no local copy of what it handed on", async () => {
			if (client) await exitApp(client.app);
			client = await launchRemote(clientProfile, { project: false });
			const relaunched = client.page;
			await expect
				.poll(async () => (await relaunched.evaluate(() => window.omp.remote.getState())).hosts[0]?.state, {
					timeout: 30_000,
				})
				.toBe("online");
			const tabs = await relaunched.evaluate(() => window.omp.tabs.list());
			expect(
				tabs.filter(tab => tab.device === undefined && [first.file, second.file].includes(tab.sessionPath ?? "")),
			).toEqual([]);
			await expect(relaunched.locator(`[data-session-path=${cssString(first.file)}]`)).toHaveCount(0);
			await expect(relaunched.locator(`[data-session-path=${cssString(second.file)}]`)).toHaveCount(0);
		});
	} finally {
		if (client) await exitApp(client.app).catch(() => undefined);
		if (host) await exitApp(host.app).catch(() => undefined);
		await fs.rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});
