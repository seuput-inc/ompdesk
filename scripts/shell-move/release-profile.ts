// bun release-profile.ts <OMPdesk.app> [read|write|quit|shots <conversation> <language> <token>]: the page of a SHIPPED Tauri app
// (the published release: no WebDriver server in it, scripts/tauri-release-automation-check.ts), reached the way the e2e
// harness reaches main: Node's inspector (OMP_GUI_TEST_NODE_INSPECT=1 makes the host start Node with --inspect=127.0.0.1:0,
// whose port is found from the Node process under the bundle), then `webContents.executeJavaScript` on the app's own page
// through the shim's module (`globalThis.__ompdeskElectron`). WKWebView has no DevTools endpoint, so a photograph is the
// window server's: `screencapture -l <window>` (window-id.swift); the page is asserted first (seed-state.ts `takeSeedShots`).
// The same answers as native-profile.ts (the test build's WebDriver), for move-mac.sh's real-feed run. Macs only.
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateExpression, Inspector } from "../../e2e/fixture/shell-launch";
import { PNG_MAGIC, QUIT_FROM_PAGE, READ_PROFILE_PAGE, takeSeedShots, WRITE_AFTER_MIGRATION } from "./seed-state";

const app = process.argv[2];
const mode = process.argv[3] ?? "read";
assert(app && existsSync(join(app, "Contents", "MacOS")), "release-profile.ts needs the OMPdesk.app bundle");
assert(["read", "write", "quit", "shots"].includes(mode));
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function out(command: string[]): string {
	const ran = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
	return ran.stdout.toString();
}

/** The WebSocket URL of Node's inspector under the bundle: a Node process of this app, a listening port that answers /json/list. */
async function inspectorUrl(): Promise<string | undefined> {
	const node = `${app}/Contents/Resources/node/node`;
	for (const pid of out(["pgrep", "-f", node]).split("\n").filter(Boolean)) {
		const ports = out(["lsof", "-nP", "-a", "-p", pid, "-iTCP", "-sTCP:LISTEN", "-Fn"])
			.split("\n")
			.map(line => /^n127\.0\.0\.1:(\d+)$/.exec(line)?.[1])
			.filter((port): port is string => port !== undefined);
		for (const port of ports) {
			const targets: unknown = await fetch(`http://127.0.0.1:${port}/json/list`, {
				signal: AbortSignal.timeout(2_000),
			})
				.then(response => response.json())
				.catch(() => []);
			const url = Array.isArray(targets)
				? targets.map(target => target?.webSocketDebuggerUrl as unknown).find(found => typeof found === "string")
				: undefined;
			if (url) return url;
		}
	}
	return undefined;
}

let inspector: Inspector | undefined;
for (let attempt = 0; attempt < 240 && !inspector; attempt++) {
	const url = await inspectorUrl();
	if (url) inspector = await Inspector.connect(url, 10_000).catch(() => undefined);
	if (!inspector) await sleep(1_000);
}
assert(
	inspector,
	`no Node inspector under ${app} in 240 s: OMP_GUI_TEST_NODE_INSPECT=1 not in the app's environment, or no Node running`,
);

const PAGE_EVAL = `async (electron, code) => {
	const windows = electron.BrowserWindow.getAllWindows().filter(window => !window.isDestroyed());
	const window = windows.find(window => window.webContents.getURL().startsWith("app://ompdesk/")) ?? windows[0];
	if (!window) throw new Error("the app has no window");
	return await window.webContents.executeJavaScript(code);
}`;
const pageEval = (code: string): Promise<unknown> => inspector.evaluate(evaluateExpression(PAGE_EVAL, code));

// The page is ready once it is the app's and `window.omp` is there (as native-profile.ts waits for its preload).
let ready = false;
for (let attempt = 0; attempt < 240 && !ready; attempt++) {
	ready =
		(await pageEval(
			"(location.href.startsWith('app://ompdesk/') && typeof window.omp?.updater?.authInfo === 'function')",
		).catch(() => false)) === true;
	if (!ready) await sleep(1_000);
}
assert(ready, "the app's page never became ready in 240 s");

function windowId(): string | undefined {
	const id = out(["swift", join(import.meta.dir, "window-id.swift")]).trim();
	return /^[1-9]\d*$/.test(id) ? id : undefined;
}

/** The window as the window server shows it; the whole display when no window is found. */
async function screenshot(file: string): Promise<void> {
	const id = windowId();
	const ran = Bun.spawnSync(["screencapture", "-x", ...(id ? ["-o", "-l", id] : []), file], { stderr: "pipe" });
	assert(ran.exitCode === 0, `screencapture failed (${ran.exitCode}): ${ran.stderr.toString().trim()}`);
	const png = readFileSync(file);
	assert(png.subarray(0, 8).equals(PNG_MAGIC), "the screenshot was not a PNG");
	assert(statSync(file).size > 10_000, `the screenshot is ${statSync(file).size} bytes: nothing was captured`);
	if (!id) writeFileSync(`${file}.whole-display`, "no window of OMPdesk was listed, the whole display was captured\n");
}

if (mode === "shots") {
	const [conversation, language, token] = process.argv.slice(4);
	assert(conversation && language && token, "shots needs three files");
	const taken = await takeSeedShots({ evaluate: pageEval, screenshot }, { conversation, language, token });
	console.log(
		JSON.stringify({ shots: [conversation, language, token], taken, transport: "node-inspector+screencapture" }),
	);
} else if (mode === "quit") {
	await pageEval(QUIT_FROM_PAGE);
	console.log(JSON.stringify({ quit: "requested", transport: "node-inspector" }));
} else {
	if (mode === "write") await pageEval(WRITE_AFTER_MIGRATION);
	const observed = await pageEval(READ_PROFILE_PAGE);
	assert(observed !== null && typeof observed === "object");
	assert(
		"userAgent" in observed && typeof observed.userAgent === "string" && !observed.userAgent.includes("Electron/"),
	);
	const seed = "seedSession" in observed && typeof observed.seedSession === "object" ? observed.seedSession : null;
	console.log(
		JSON.stringify({
			...observed,
			seedSessionId: seed && "id" in seed ? seed.id : undefined,
			seedSessionTitle: seed && "title" in seed ? seed.title : undefined,
		}),
	);
}
process.exit(0);
