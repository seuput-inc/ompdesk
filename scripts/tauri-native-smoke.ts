import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import * as path from "node:path";
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

	async element(selector: string): Promise<string> {
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

async function main(): Promise<void> {
	assert(["darwin", "win32"].includes(process.platform), "Native smoke requires the actual shipping OS");
	const binary = process.env.OMPDESK_TAURI_TEST_BINARY;
	const output = process.env.OMPDESK_TAURI_TEST_OUTPUT;
	assert(binary && path.isAbsolute(binary), "OMPDESK_TAURI_TEST_BINARY must name the built Tauri executable");
	assert(output && path.isAbsolute(output), "OMPDESK_TAURI_TEST_OUTPUT must name the caller's private evidence root");
	await mkdir(output, { recursive: true });
	const profile = await mkdtemp(path.join(output, "native-smoke-"));
	const desktop = path.join(profile, "desktop");
	const project = path.join(profile, "project");
	const agent = path.join(profile, "agent");
	await Promise.all([desktop, project, agent].map(directory => mkdir(directory)));
	await writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const port = await availablePort();
	const options = await appLaunchOptions({ project, desktop, agent, profile });
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
	assert(await Bun.file(pinnedNode).exists(), "The original pinned Node runtime must be staged");
	env.OMPDESK_NODE = pinnedNode;
	const child = Bun.spawn([binary, ...options.args], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	const stdout = Bun.write(path.join(profile, "stdout.log"), child.stdout);
	const stderr = Bun.write(path.join(profile, "stderr.log"), child.stderr);
	const exited = child.exited.then(code => {
		throw new Error(`Native app exited during smoke (${code})`);
	});
	void exited.catch(() => undefined);
	const driver = new Driver(port);
	let quitRequested = false;
	try {
		await until(
			"Native WebDriver startup",
			async () => {
				try {
					return object(await driver.request("GET", "/status")).ready === true;
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
		await driver.connect();
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
			await Promise.race([child.exited, delay(15_000).then(() => "timeout")]),
			0,
			"The actual native app did not quit cleanly",
		);
		console.log(`Actual native smoke passed; evidence: ${profile}`);
	} finally {
		if (child.exitCode === null) {
			const owned = processesBelow(child.pid);
			child.stdin.end();
			child.kill();
			await child.exited;
			await waitForProcessesToExit(owned, 10_000);
		}
		await Promise.all([stdout, stderr]);
		if (!quitRequested) console.error(`Native smoke failed; original output preserved in ${profile}`);
	}
}

if (import.meta.main) await main();
