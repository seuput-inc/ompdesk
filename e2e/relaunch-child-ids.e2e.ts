/**
 * After a relaunch every restored tab has a new id, and a child an agent opened has no title of its own (stock names
 * only a person's first message; the GUI's `task` lived in memory). The opener's agent still holds the old id and
 * expects the child's name: `ompdesk_session_send` on the old id reaches the same session, and `ompdesk_sessions`
 * names it by the `Title:` line of its first message. A message the child's omp still held unread when the app quit is
 * handed to its next omp once (main's send outbox), and the done report of the turn it runs reaches the opener's new
 * tab. Fake omp with stock-shaped session files. Unit cases: service.test.ts ("after a relaunch", "messages that
 * outlive the omp"), host.test.ts, send-outbox.test.ts, sidecar-pool.test.ts ("earlier tab ids"), tab-layout.test.ts.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp, readRecords } from "./harness";

interface Profile {
	root: string;
	desktop: string;
	record: string;
	env: Record<string, string>;
}

async function makeProfile(prefs: Record<string, unknown> = {}): Promise<Profile> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-relaunch-ids-")));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", firstRunComplete: true, lastProject: project, ...prefs }),
	);
	const record = path.join(root, "rpc.jsonl");
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	Object.assign(env, {
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(root),
		OMP_GUI_HEADLESS: "1",
		OMP_GUI_TEST_SESSION_FILES: "1",
		OMP_GUI_TEST_RECORD: record,
	});
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	return { root, desktop, record, env };
}

/** No argv folder, so a relaunch restores the saved layout. */
async function launch(profile: Profile): Promise<{ app: ElectronApplication; page: Page }> {
	const app = await electron.launch({
		args: [path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"), `--user-data-dir=${profile.desktop}`],
		env: profile.env,
	});
	const page = await app.firstWindow();
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page };
}

async function quit(app: ElectronApplication): Promise<void> {
	const child = app.process();
	const exited = new Promise<void>(resolve => {
		if (child.exitCode !== null || child.signalCode !== null) resolve();
		else child.once("exit", () => resolve());
	});
	await app.evaluate(({ app, dialog }) => {
		// "Quit anyway" on the card that asks while turns run and interrupted work does not continue after a relaunch.
		dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as never;
		setImmediate(() => app.quit());
	});
	await exited;
}

const tabs = (page: Page) => page.evaluate(() => window.omp.tabs.list());

/** The opener's agent calls a control tool (the fake omp's `fixture:host-tool`); resolves with its result text. */
async function call(profile: Profile, page: Page, opener: string, name: string, args: Record<string, unknown>) {
	const results = async () => (await readRecords(profile.record)).filter(frame => frame.type === "host_tool_result");
	const before = (await results()).length;
	const line = `fixture:host-tool:${name} ${JSON.stringify(args)}`;
	await page.evaluate(([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }), [opener, line]);
	await expect.poll(async () => (await results()).length, { timeout: 60_000 }).toBe(before + 1);
	const frame = (await results())[before];
	const result = frame?.result;
	const first =
		result && typeof result === "object" && "content" in result && Array.isArray(result.content)
			? result.content[0]
			: undefined;
	const text =
		first && typeof first === "object" && "text" in first && typeof first.text === "string" ? first.text : "";
	return { text, isError: frame?.isError === true };
}

/** A turn that keeps running (the fake omp's long turn), as an agent's does while it works with the control tools. */
async function busy(page: Page, tabId: string): Promise<void> {
	await page.evaluate(
		id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture running with job" }),
		tabId,
	);
	await expect.poll(async () => (await tabs(page)).find(tab => tab.tabId === tabId)?.status).toBe("running");
}

test("an opened child keeps its id and its name through a relaunch", async () => {
	test.setTimeout(240_000);
	const profile = await makeProfile();
	let current: ElectronApplication | undefined;
	try {
		const first = await launch(profile);
		current = first.app;
		const opener = (await tabs(first.page)).find(tab => tab.active)?.tabId ?? "";
		await busy(first.page, opener);
		const opened = await call(profile, first.page, opener, "ompdesk_session_open", {
			message: "Title: Fix the parser\nparse.ts drops a field.",
		});
		const oldId = /Opened session (\w+)/.exec(opened.text)?.[1] ?? "";
		expect(oldId).not.toBe("");
		const child = async (page: Page, id: string) => (await tabs(page)).find(tab => tab.tabId === id);
		await expect
			.poll(async () => (await child(first.page, oldId))?.lastRun?.stopReason, { timeout: 60_000 })
			.toBe("stop");
		const childPath = (await child(first.page, oldId))?.sessionPath ?? "";
		expect(childPath).not.toBe("");
		await quit(first.app);
		current = undefined;

		const second = await launch(profile);
		current = second.app;
		const restored = (await tabs(second.page)).find(tab => tab.sessionPath === childPath);
		expect(restored?.tabId).toBeDefined();
		expect(restored?.tabId).not.toBe(oldId);
		const boss = (await tabs(second.page)).find(tab => tab.active)?.tabId ?? "";

		const listed = await call(profile, second.page, boss, "ompdesk_sessions", {});
		expect(listed.text).toContain(`${restored?.tabId} "Fix the parser"`);
		expect(listed.text).not.toContain(`${restored?.tabId} (untitled`);

		const sent = await call(profile, second.page, boss, "ompdesk_session_send", {
			session: oldId,
			message: "carry on",
		});
		expect(sent.isError).toBe(false);
		expect(sent.text).toContain('Sent to "Fix the parser"');
		// The pool knows the name too, so every window shows it.
		await expect.poll(async () => (await child(second.page, restored?.tabId ?? ""))?.task).toBe("Fix the parser");
	} finally {
		if (current) await exitApp(current);
		await fs.rm(profile.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("a busy child takes its opener's message as an aside, read at its next step", async () => {
	test.setTimeout(180_000);
	const profile = await makeProfile();
	let current: ElectronApplication | undefined;
	try {
		const { app, page } = await launch(profile);
		current = app;
		const opener = (await tabs(page)).find(tab => tab.active)?.tabId ?? "";
		await busy(page, opener);
		const opened = await call(profile, page, opener, "ompdesk_session_open", { message: "Title: part A\nDo A" });
		const kid = /Opened session (\w+)/.exec(opened.text)?.[1] ?? "";
		await expect
			.poll(async () => (await tabs(page)).find(tab => tab.tabId === kid)?.lastRun?.stopReason)
			.toBe("stop");
		// The child's next turn keeps running (the fake omp's long turn), as a worker's does while it works.
		await busy(page, kid);

		const sent = await call(profile, page, opener, "ompdesk_session_send", { session: kid, message: "Also do C" });
		expect(sent.text).toContain("delivered as steer (it reads it at its next step");
		expect(sent.text).toContain("Dispatch d2");
		// A working child takes it as stock's aside (gui-bridge `agent_control.aside`), never a queued steer or follow-up.
		const frames = (await readRecords(profile.record)).filter(
			frame => typeof frame.message === "string" && frame.message.includes("Also do C"),
		);
		expect(frames.map(frame => frame.type)).toEqual(["agent_control.aside"]);
	} finally {
		if (current) await exitApp(current);
		await fs.rm(profile.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("a message a busy child had not read survives a relaunch, its done report reaches the relaunched opener, and its old id takes the next message", async () => {
	test.setTimeout(240_000);
	// Interrupted turns stay stopped, so the child's restored tab is idle and takes the message it lost at once.
	const profile = await makeProfile({ resumeInterrupted: false });
	profile.env.OMP_GUI_TEST_AGENT_SWEEP_MS = "500";
	let current: ElectronApplication | undefined;
	// `agent_control.aside` frames count the hand-overs: an idle omp answers one `{idle: true}`, then gets the prompt.
	const marked = async (mark: string, type = "prompt") =>
		(await readRecords(profile.record)).filter(
			frame => frame.type === type && typeof frame.message === "string" && frame.message.includes(mark),
		);
	try {
		const first = await launch(profile);
		current = first.app;
		const opener = (await tabs(first.page)).find(tab => tab.active)?.tabId ?? "";
		await busy(first.page, opener);
		// The child works on its first message (an agent's, so no person typed into it).
		const opened = await call(profile, first.page, opener, "ompdesk_session_open", {
			message: "Title: Combine titles\nDo part A fixture:running-with-job",
		});
		const oldId = /Opened session (\w+)/.exec(opened.text)?.[1] ?? "";
		const child = async (page: Page, id: string) => (await tabs(page)).find(tab => tab.tabId === id);
		await expect.poll(async () => (await child(first.page, oldId))?.status, { timeout: 60_000 }).toBe("running");
		await expect.poll(async () => (await child(first.page, oldId))?.sessionPath ?? "").not.toBe("");
		const childPath = (await child(first.page, oldId))?.sessionPath ?? "";
		// The opener's next message waits in the child's omp, unread while its turn stands in a call.
		const queued = await call(profile, first.page, opener, "ompdesk_session_send", {
			session: oldId,
			message: "Also do C fixture:result-ok",
		});
		expect(queued.text).toContain("delivered as steer");
		expect(queued.text).toContain("Dispatch d2");
		await quit(first.app);
		current = undefined;

		// The relaunch ends that omp and what it held: the message reaches the child's new omp, once.
		const second = await launch(profile);
		current = second.app;
		const boss = (await tabs(second.page)).find(tab => tab.active)?.tabId ?? "";
		// The window lists its restored tabs as they come up; the child's is not necessarily there at the first read.
		await expect
			.poll(async () => (await tabs(second.page)).find(tab => tab.sessionPath === childPath)?.tabId ?? "", {
				timeout: 30_000,
			})
			.not.toBe("");
		const kid = (await tabs(second.page)).find(tab => tab.sessionPath === childPath)?.tabId ?? "";
		expect(kid).not.toBe(oldId);
		await expect
			.poll(async () => (await marked("[ompdesk dispatch d2:", "agent_control.aside")).length, { timeout: 60_000 })
			.toBe(2);
		await expect.poll(async () => (await marked("[ompdesk dispatch d2:")).length, { timeout: 60_000 }).toBe(1);

		// It finishes with Result: ok: main's done report reaches the opener's new tab.
		const doneMails = async () => {
			const page = await second.page.evaluate(
				id => window.omp.rpc.commandForTab(id, { type: "get_transcript_page", fromEnd: true, limit: 50 }),
				boss,
			);
			const messages =
				(page.data as { messages?: { customType?: string; details?: Record<string, unknown> }[] } | undefined)
					?.messages ?? [];
			return messages.filter(
				message =>
					message.customType === "ompdesk.mail" &&
					message.details?.kind === "done" &&
					message.details.dispatch === "d2",
			);
		};
		try {
			await expect.poll(async () => (await doneMails()).length, { timeout: 60_000 }).toBe(1);
		} catch (error) {
			// Where the report stopped: sent by main to an omp (a `agent_control.mail` frame the fake recorded), in the
			// opener's transcript under another shape, or never made (the tabs and their states say whose turn is where).
			const frames = await readRecords(profile.record);
			const mail = frames
				.filter(frame => frame.type === "agent_control.mail")
				.map(frame => JSON.stringify(frame.details ?? {}).slice(0, 160));
			const states = (await tabs(second.page)).map(
				tab => `${tab.tabId === boss ? "boss" : tab.tabId === kid ? "kid" : "?"}:${tab.status}`,
			);
			// The last frames the fake omps recorded, one short line each: what the kid ran after the relaunch, what was
			// asked of main (host tool calls) and what reached the boss's omp.
			const trail = frames.slice(-40).map(frame => JSON.stringify(frame).slice(0, 140));
			throw new Error(
				`${String(error)}\nmail frames: ${JSON.stringify(mail)}\ntabs: ${states.join(" ")}\nlast frames:\n${trail.join("\n")}`,
			);
		}

		// Several more passes later, neither was handed over again.
		await second.page.waitForTimeout(3_000);
		expect(await marked("[ompdesk dispatch d2:", "agent_control.aside")).toHaveLength(2);
		expect(await marked("[ompdesk dispatch d2:")).toHaveLength(1);
		expect(await doneMails()).toHaveLength(1);

		// The id the opener was given before the relaunch still takes its next message (its tab closed meanwhile or not).
		const next = await call(profile, second.page, boss, "ompdesk_session_send", { session: oldId, message: "And D" });
		expect(next.isError, next.text).toBe(false);
		expect(next.text).toContain("Sent to");
		await expect.poll(async () => (await marked("[ompdesk dispatch d3:")).length, { timeout: 60_000 }).toBe(1);
	} finally {
		if (current) await exitApp(current);
		await fs.rm(profile.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
