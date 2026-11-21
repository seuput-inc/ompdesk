import assert from "node:assert/strict";
import { type ChildProcessByStdio, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import * as path from "node:path";
import type { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { appDirOfEntry } from "../e2e/fixture/shell-launch";
import { appLaunchOptions } from "../e2e/harness";
import { processesBelow, waitForProcessesToExit } from "../e2e/process-tree";

const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

function object(value: unknown): Record<string, unknown> {
	assert(value !== null && typeof value === "object" && !Array.isArray(value), "Invalid WebDriver object");
	return value as Record<string, unknown>;
}

export class Driver {
	#session = "";
	constructor(readonly port: number) {}

	async request(method: string, endpoint: string, data?: unknown): Promise<unknown> {
		const response = await fetch(`http://127.0.0.1:${this.port}${endpoint}`, {
			method,
			redirect: "error",
			signal: AbortSignal.timeout(65_000),
			...(data === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }),
		});
		const envelope = object(await response.json());
		assert(
			response.ok,
			`Native WebDriver ${method} ${endpoint} returned ${response.status}: ${JSON.stringify(envelope.value)}`,
		);
		return envelope.value;
	}

	async connect(): Promise<void> {
		const result = object(await this.request("POST", "/session", { capabilities: { alwaysMatch: {} } }));
		assert.equal(typeof result.sessionId, "string");
		this.#session = String(result.sessionId);
		await this.command("POST", "/timeouts", { implicit: 60_000, script: 60_000, pageLoad: 60_000 });
	}

	/** Waits for the host's WebDriver server (`/status` ready), then opens the session. */
	async attach(exited: Promise<never>): Promise<void> {
		await until(
			"Native WebDriver startup",
			async () => {
				try {
					return object(await this.request("GET", "/status")).ready === true;
				} catch (error) {
					if (
						error instanceof Error &&
						"code" in error &&
						["ECONNREFUSED", "ConnectionRefused"].includes(String(error.code))
					)
						return false;
					if (
						error instanceof TypeError &&
						error.message === "fetch failed" &&
						"cause" in error &&
						error.cause instanceof Error &&
						"code" in error.cause &&
						error.cause.code === "ECONNREFUSED"
					)
						return false;
					throw error;
				}
			},
			exited,
		);
		await this.connect();
	}

	command(method: string, endpoint: string, data?: unknown): Promise<unknown> {
		assert(this.#session, "Native WebDriver session was not attached");
		return this.request(method, `/session/${encodeURIComponent(this.#session)}${endpoint}`, data);
	}

	async evaluate(expression: string): Promise<unknown> {
		const reply = object(
			await this.command("POST", "/execute/async", {
				script: `const done=arguments[arguments.length-1]; Promise.resolve().then(()=>(${expression})).then(value=>done({ok:true,value}),error=>done({ok:false,error:String(error)}));`,
				args: [],
			}),
		);
		assert.equal(reply.ok, true, `Actual WebView evaluation failed: ${String(reply.error)}`);
		return reply.value;
	}

	/**
	 * Finds the element, waiting up to 60 s as WebDriver's implicit wait would (the Tauri plugin answers `no such element`
	 * at once): the packaged app's first launch mounts the composer 2.4 s after its omp answers, and Settings' page loads
	 * its own chunk after the click (dry runs 43890507100, 43914587785).
	 */
	async element(selector: string): Promise<string> {
		const deadline = Date.now() + 60_000;
		while (
			(await this.evaluate(`document.querySelector(${JSON.stringify(selector)}) !== null`)) !== true &&
			Date.now() < deadline
		)
			await delay(100);
		const element = object(await this.command("POST", "/element", { using: "css selector", value: selector }));
		assert.equal(typeof element[ELEMENT], "string");
		return `/element/${encodeURIComponent(String(element[ELEMENT]))}`;
	}

	async chord(key: string): Promise<void> {
		const modifier = process.platform === "darwin" ? "\uE03D" : "\uE009";
		await this.command("POST", "/actions", {
			actions: [
				{
					type: "key",
					id: "native-smoke-keyboard",
					actions: [
						{ type: "keyDown", value: modifier },
						{ type: "keyDown", value: key },
						{ type: "keyUp", value: key },
						{ type: "keyUp", value: modifier },
					],
				},
			],
		});
	}
}

async function availablePort(): Promise<number> {
	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert(address && typeof address !== "string");
	await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
	return address.port;
}

export async function until(label: string, probe: () => Promise<boolean>, exited: Promise<never>): Promise<void> {
	const deadline = Date.now() + 60_000;
	while (!(await Promise.race([probe(), exited]))) {
		assert(Date.now() < deadline, `${label} did not complete in 60 seconds`);
		await Promise.race([delay(50), exited]);
	}
}

export interface NativeApp {
	child: ChildProcessByStdio<Writable, Readable, Readable>;
	binary: string;
	/** The evidence folder: the app's stdout and stderr, and what a failed step saved. */
	profile: string;
	/** The app's userData (`--user-data-dir`). */
	desktop: string;
	port: number;
	logs: Promise<unknown>;
	/** The app's exit code (null: a signal ended it). */
	code: Promise<number | null>;
	exited: Promise<never>;
}

/** The folders of one run of the app, as a caller that already made them hands them in. */
export interface NativeProfile {
	/** The private root: `PI_CONFIG_DIR` and the fake omp's folder (`appLaunchOptions`' `profile`). */
	root: string;
	desktop: string;
	project: string;
	agent: string;
}

export interface NativeLaunch {
	/** Folders the caller made (and wrote `prefs.json` into); default: a fresh profile inside the evidence folder. */
	profile?: NativeProfile;
	/** Added to the app's environment over `appLaunchOptions`' defaults; `undefined` removes a variable. */
	env?: Record<string, string | undefined>;
	/** Where the evidence folder is made; default OMPDESK_TAURI_TEST_OUTPUT. */
	output?: string;
}

/**
 * Starts the host on a private profile with the test inspector, that profile and a free port named, as every native check
 * does. Plain Node APIs only: a Playwright worker (e2e/mobile-attach.e2e.ts on macOS) runs it as well as bun.
 */
export async function launchNative(prefix = "native-smoke-", launch: NativeLaunch = {}): Promise<NativeApp> {
	assert(["darwin", "win32"].includes(process.platform), "Native smoke requires the actual shipping OS");
	const binary = process.env.OMPDESK_TAURI_TEST_BINARY;
	const output = launch.output ?? process.env.OMPDESK_TAURI_TEST_OUTPUT;
	assert(binary && path.isAbsolute(binary), "OMPDESK_TAURI_TEST_BINARY must name the built Tauri executable");
	assert(output && path.isAbsolute(output), "OMPDESK_TAURI_TEST_OUTPUT must name the caller's private evidence root");
	await mkdir(output, { recursive: true });
	const profile = await mkdtemp(path.join(output, prefix));
	let own = launch.profile;
	if (!own) {
		own = {
			root: profile,
			desktop: path.join(profile, "desktop"),
			project: path.join(profile, "project"),
			agent: path.join(profile, "agent"),
		};
		await Promise.all([own.desktop, own.project, own.agent].map(directory => mkdir(directory)));
		await writeFile(path.join(own.desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	}
	const { desktop, project, agent, root } = own;
	const port = await availablePort();
	const options = await appLaunchOptions({ project, desktop, agent, profile: root, env: launch.env });
	const entry = options.args.shift();
	assert(entry);
	const env: Record<string, string> = {
		...options.env,
		OMPDESK_APP_DIR: appDirOfEntry(entry),
		OMPDESK_APP_ENTRY: path.resolve(entry),
		OMP_GUI_TEST_NODE_INSPECT: "1",
		OMP_GUI_TEST_USER_DATA_DIR: desktop,
		OMP_GUI_TEST_WEBDRIVER_PORT: String(port),
	};
	// A packaged app brings its own pinned Node (OMPDESK_TAURI_TEST_NODE: <Resources>/node/node); otherwise the staged one.
	const pinnedNode = process.env.OMPDESK_TAURI_TEST_NODE
		? path.resolve(process.env.OMPDESK_TAURI_TEST_NODE)
		: path.resolve(
				"resources/node",
				`${process.platform}-${process.arch}`,
				process.platform === "win32" ? "node.exe" : "node",
			);
	assert(
		await access(pinnedNode).then(
			() => true,
			() => false,
		),
		"The original pinned Node runtime must be staged",
	);
	env.OMPDESK_NODE = pinnedNode;
	const child = spawn(binary, options.args, { env, stdio: ["pipe", "pipe", "pipe"] });
	// Ending the app's stdin after it died must not be an uncaught EPIPE.
	child.stdin.on("error", () => undefined);
	const stdout = pipeline(child.stdout, createWriteStream(path.join(profile, "stdout.log")));
	const stderr = pipeline(child.stderr, createWriteStream(path.join(profile, "stderr.log")));
	const closed = Promise.withResolvers<number | null>();
	child.once("error", closed.reject);
	child.once("exit", exitCode => closed.resolve(exitCode));
	const code = closed.promise;
	const exited = code.then(exitCode => {
		throw new Error(`Native app exited during smoke (${exitCode})`);
	});
	void exited.catch(() => undefined);
	return { child, binary, profile, desktop, port, logs: Promise.all([stdout, stderr]), code, exited };
}

/** Ends what `launchNative` started: the app and every process below it, then its logs. */
export async function stopNative({ child, code, logs }: NativeApp): Promise<void> {
	if (child.exitCode === null && child.signalCode === null) {
		assert(child.pid !== undefined, "The native app has no process id");
		const owned = processesBelow(child.pid);
		child.stdin.end();
		child.kill();
		await code;
		await waitForProcessesToExit(owned, 10_000);
	}
	await logs;
}

/**
 * Read in the page when a step failed, into failure.json: why a pane is blank. The page's own early errors and refused
 * IPC calls (`window.__ompDiagnostics`, src/preload/tauri.ts), the scripts and styles that failed or never loaded, the
 * shape of the main column, and what main answers to the calls the first screen makes (each bounded, so a call that
 * never answers is a finding, not a hang). Plain JavaScript in a string: it runs in the WebView, not here.
 */
export const PAGE_DIAGNOSIS = `(async () => {
	const within = (promise, ms) =>
		Promise.race([Promise.resolve(promise), new Promise(resolve => setTimeout(() => resolve("no answer in " + ms + " ms"), ms))]).catch(
			error => "rejected: " + String(error),
		);
	const entries = performance.getEntriesByType("resource");
	const resources = entries.map(entry => ({
		name: entry.name.replace(location.origin, ""),
		type: entry.initiatorType,
		status: entry.responseStatus,
		size: entry.transferSize,
		ms: Math.round(entry.duration),
	}));
	const loadable = 'script[src],link[rel="stylesheet"],link[rel="modulepreload"]';
	const label = el =>
		el.tagName.toLowerCase() +
		(typeof el.className === "string" && el.className ? "." + el.className.split(" ").slice(0, 3).join(".") : "") +
		(el.dataset && el.dataset.tabId ? "[tab " + el.dataset.tabId + "]" : "") +
		(el.hidden || (el.className && String(el.className).split(" ").includes("hidden")) ? " (hidden)" : "");
	const tree = (el, depth) => (!el || depth < 0 ? [] : [...el.children].slice(0, 12).map(child => ({ el: label(child), children: tree(child, depth - 1) })));
	const navigation = performance.getEntriesByType("navigation")[0];
	const main = document.querySelector("main");
	const root = document.getElementById("root");
	const tabs = await within(
		window.omp.tabs.list().then(list => list.map(tab => ({ id: tab.tabId, status: tab.status, active: tab.active === true, visible: tab.visible === true, cwd: tab.cwd }))),
		5000,
	);
	const sessions = await within(window.omp.sessions.list("global").then(list => list.length), 5000);
	const sidecar = await within(window.omp.sidecar.getStatus(), 5000);
	const log = await within(window.omp.runtime.logTail(40), 5000);
	return {
		href: location.href,
		title: document.title,
		page: {
			readyState: document.readyState,
			visibility: document.visibilityState,
			focused: document.hasFocus(),
			size: innerWidth + "x" + innerHeight,
			sinceNavigationMs: Math.round(performance.now()),
			navigation: navigation ? { type: navigation.type, responseEndMs: Math.round(navigation.responseEnd), domInteractiveMs: Math.round(navigation.domInteractive), loadEventEndMs: Math.round(navigation.loadEventEnd) } : null,
		},
		diagnostics: window.__ompDiagnostics ?? "the preload installed none",
		resources: { total: resources.length, failed: resources.filter(r => r.status >= 400 || (r.size === 0 && ["script", "link", "css"].includes(r.type))), withoutEntry: [...document.querySelectorAll(loadable)].map(el => el.src || el.href).filter(url => !entries.some(entry => entry.name === url)) },
		dom: {
			rootChildren: root ? root.children.length : null,
			bootShell: document.querySelector(".boot-shell") !== null,
			textareas: document.querySelectorAll("textarea").length,
			sessionPanes: document.querySelectorAll(".omp-session-pane").length,
			paneTabIds: [...document.querySelectorAll("[data-tab-id]")].map(el => el.dataset.tabId),
			alerts: [...document.querySelectorAll('[role="alert"],[data-app-stale]')].map(el => (el.textContent || "").slice(0, 300)),
			main: tree(main, 3),
			text: (document.body ? document.body.innerText : "").slice(0, 4000),
		},
		main: { tabs, sessions, sidecar, log },
	};
})()`;

/** What the page showed when a step failed (`PAGE_DIAGNOSIS`), the step's error and a screenshot, beside the output. */
export async function saveFailure(driver: Driver, profile: string, error: unknown): Promise<void> {
	const diagnosis = await driver.evaluate(PAGE_DIAGNOSIS).catch((reason: unknown) => ({ unreadable: String(reason) }));
	const state = { error: error instanceof Error ? error.message : String(error), ...object(diagnosis) };
	await writeFile(path.join(profile, "failure.json"), `${JSON.stringify(state, null, 2)}\n`).catch(() => undefined);
	const png = await driver.command("GET", "/screenshot").catch(() => undefined);
	if (typeof png === "string")
		await writeFile(path.join(profile, "failure.png"), Buffer.from(png, "base64")).catch(() => undefined);
}

async function main(): Promise<void> {
	console.log("test build: release bytes + feature test-automation (tauri-plugin-wdio-webdriver)");
	const edit = process.env.OMPDESK_TEST_EDIT_MENU === "1";
	if (edit) assert(process.platform === "darwin" && process.env.RUNNER_ENVIRONMENT === "github-hosted");
	const app = await launchNative(
		"native-smoke-",
		edit ? { env: { OMP_GUI_HEADLESS: "0", OMPDESK_TEST_EDIT_MENU: "1" } } : {},
	);
	const { binary, profile, port, exited, code } = app;
	const driver = new Driver(port);
	let quitRequested = false;
	try {
		await driver.attach(exited);
		await until(
			"Native preload and sidecar",
			async () =>
				driver
					.evaluate("window.omp ? window.omp.sidecar.getStatus().then(s=>s.status==='ready') : false")
					.then(value => value === true),
			exited,
		);
		const settings = object(await driver.evaluate("window.omp.rpc.getSettings(['compaction.enabled'])"));
		assert.equal(settings.success, true, "The actual Node/stock bridge did not answer");
		const textarea = await driver.element("textarea");
		const firstTab = await driver.evaluate("window.omp.tabs.list().then(t=>t[0]?.tabId)");
		await driver.chord("t");
		await until(
			"Native new-tab shortcut",
			async () =>
				driver
					.evaluate(
						`window.omp.tabs.list().then(t=>t.length===1&&t[0].tabId!==${JSON.stringify(firstTab)}&&t[0].status==='ready')`,
					)
					.then(value => value === true),
			exited,
		);
		const input = await driver.element("textarea");
		assert(textarea && input);
		await driver.command("POST", `${input}/clear`, {});
		await driver.command("POST", `${input}/value`, { text: "smoke hello", value: [..."smoke hello"] });
		const send = await driver.element('button[aria-label="Send"]');
		await driver.command("POST", `${send}/click`, {});
		await until(
			"Actual fixture answer",
			async () =>
				driver
					.evaluate(
						"[...document.querySelectorAll('[data-transcript-kind]')].filter(n=>n.textContent.includes('Local fixture reply')).length",
					)
					.then(value => value === 1),
			exited,
		);
		if (edit) {
			const sample = "맥 복사 검증 123";
			execFileSync("/usr/bin/pbcopy", { input: "sentinel" });
			const composer = await driver.element(".omp-composer-input");
			await driver.command("POST", `${composer}/click`, {});
			await driver.command("POST", `${composer}/value`, { text: sample, value: [...sample] });
			assert.equal(
				await driver.evaluate(
					"(()=>{const t=document.querySelector('.omp-composer-input');t.focus();t.select();return t.value.slice(t.selectionStart,t.selectionEnd)})()",
				),
				sample,
			);
			await writeFile(path.join(app.desktop, "Copy"), "");
			await until(
				"real Edit > Copy",
				async () => execFileSync("/usr/bin/pbpaste", { encoding: "utf8" }) === sample,
				exited,
			);
			await driver.command("POST", `${composer}/clear`, {});
			assert.equal(
				await driver.evaluate(
					"(()=>{const t=document.querySelector('.omp-composer-input');t.focus();return t.value})()",
				),
				"",
			);
			await writeFile(path.join(app.desktop, "Paste"), "");
			await until(
				"real Edit > Paste",
				async () => (await driver.evaluate("document.querySelector('.omp-composer-input').value")) === sample,
				exited,
			);
			console.log("Verified Edit > Copy and Edit > Paste in the OMPdesk WKWebView composer.");
		}
		await driver.chord(",");
		await driver.element('[data-settings-page] [data-settings-section="appearance"]');
		const png = await driver.command("GET", "/screenshot");
		assert.equal(typeof png, "string");
		const bytes = Buffer.from(String(png), "base64");
		assert(
			bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
			"The actual native screenshot was not PNG",
		);
		await writeFile(path.join(profile, "native-settings.png"), bytes);
		await driver.command("POST", "/actions", {
			actions: [
				{
					type: "key",
					id: "native-smoke-keyboard",
					actions: [
						{ type: "keyDown", value: "\uE00C" },
						{ type: "keyUp", value: "\uE00C" },
					],
				},
			],
		});
		assert.equal(await driver.evaluate("document.querySelector('[data-settings-page]')===null"), true);
		const userAgent = await driver.evaluate("navigator.userAgent");
		assert.equal(typeof userAgent, "string");
		assert(!String(userAgent).includes("Electron/"), "The smoke attached to the old Electron renderer");
		await writeFile(
			path.join(profile, "result.json"),
			`${JSON.stringify({ engine: process.platform === "darwin" ? "WKWebView" : "WebView2", userAgent, binary, profile, checks: ["preload", "bridge", "native-new-tab", "native-prompt-input", "actual-answer", "native-settings", "screenshot"] }, null, 2)}\n`,
		);
		await driver.evaluate("(setTimeout(()=>window.omp.app.quit(),0),true)");
		quitRequested = true;
		assert.equal(
			await Promise.race([code, delay(15_000).then(() => "timeout")]),
			0,
			"The actual native app did not quit cleanly",
		);
		console.log(`Actual native smoke passed; evidence: ${profile}`);
	} catch (error) {
		await saveFailure(driver, profile, error);
		throw error;
	} finally {
		await stopNative(app);
		if (!quitRequested) console.error(`Native smoke failed; original output preserved in ${profile}`);
	}
}

if (import.meta.main) await main();
