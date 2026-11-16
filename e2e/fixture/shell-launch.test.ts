import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	appDirOfEntry,
	assertPageAutomation,
	assertTestAutomationHost,
	copyShellDiagnostics,
	evaluateExpression,
	inspectorUrl,
	isAppPageUrl,
	leavesTheApp,
	shellExecutable,
	stagedShell,
	userDataFromArgs,
} from "./shell-launch";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the shell launcher's pure parts", () => {
	it("retains both native and Node logs before the profile goes, and tolerates a missing early-start log", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "shell-diagnostics-"));
		dirs.push(dir);
		const output = path.join(dir, "output", "app-1");
		writeFileSync(path.join(dir, "tauri-shell.jsonl"), '{"event":"preview.events.lagged","skipped":40}\n');
		expect(copyShellDiagnostics(dir, output)).toEqual(["tauri-shell.jsonl"]);
		writeFileSync(path.join(dir, "gui-runtime.jsonl"), '{"event":"preview-state"}\n');
		expect(copyShellDiagnostics(dir, output)).toEqual(["tauri-shell.jsonl", "gui-runtime.jsonl"]);
		rmSync(path.join(dir, "tauri-shell.jsonl"));
		rmSync(path.join(dir, "gui-runtime.jsonl"));
		expect(readFileSync(path.join(output, "tauri-shell.jsonl"), "utf8")).toBe(
			'{"event":"preview.events.lagged","skipped":40}\n',
		);
		expect(readFileSync(path.join(output, "gui-runtime.jsonl"), "utf8")).toBe('{"event":"preview-state"}\n');
	});
	it("stages the Tauri host per platform and arch", () => {
		expect(stagedShell("win32", "x64", "/r")).toBe(
			path.join("/r", "resources", "ompdesk-tauri", "win32-x64", "ompdesk-shell.exe"),
		);
		expect(stagedShell("darwin", "arm64", "/r")).toBe(
			path.join("/r", "resources", "ompdesk-tauri", "darwin-arm64", "ompdesk-shell"),
		);
	});

	it("runs a packaged host when OMP_GUI_E2E_SHELL names one, else the staged build", () => {
		expect(shellExecutable({ OMP_GUI_E2E_SHELL: "/x/OMPdesk.exe" })).toBe(path.resolve("/x/OMPdesk.exe"));
		expect(shellExecutable({})).toBe(stagedShell());
	});

	it("finds the user-data dir in both switch spellings", () => {
		expect(userDataFromArgs(["/p", "--user-data-dir=/a b"])).toBe("/a b");
		expect(userDataFromArgs(["--user-data-dir", "/c"])).toBe("/c");
		expect(userDataFromArgs(["/p"])).toBeUndefined();
	});

	it("takes the checkout of a snapshot or of out/", () => {
		expect(appDirOfEntry(path.join("/repo", "out-0123456789ab", "main", "index.js"))).toBe(path.resolve("/repo"));
		expect(appDirOfEntry(path.join("/repo", "out", "main", "index.js"))).toBe(path.resolve("/repo"));
	});

	it("reads Node's inspector url from the host's stderr", () => {
		const stderr =
			"Debugger listening on ws://127.0.0.1:51234/0a1b-2c\nFor help, see: https://nodejs.org/en/docs/inspector\n";
		expect(inspectorUrl(stderr)).toBe("ws://127.0.0.1:51234/0a1b-2c");
		expect(inspectorUrl("Debugger listening on ws://127.0.0.1:5")).toBe("ws://127.0.0.1:5");
		expect(inspectorUrl("nothing yet")).toBeUndefined();
	});

	it("recognises the app's pages on both engines' origins", () => {
		expect(isAppPageUrl("app://ompdesk/index.html")).toBe(true);
		expect(isAppPageUrl("http://app.localhost/?window=1")).toBe(true);
		expect(isAppPageUrl("http://app.localhost.evil.test/")).toBe(false);
		expect(isAppPageUrl("about:blank")).toBe(false);
		expect(isAppPageUrl("https://example.com/")).toBe(false);
	});

	it("counts a network request except to the app's own WebView2 origins", () => {
		expect(leavesTheApp("http://app.localhost/assets/main.js")).toBe(false);
		expect(leavesTheApp("http://ipc.localhost/omp_ipc")).toBe(false);
		expect(leavesTheApp("app://ompdesk/index.html")).toBe(false);
		expect(leavesTheApp("data:image/svg+xml;charset=utf-8,%3Csvg%3E")).toBe(false);
		expect(leavesTheApp("https://app.localhost/")).toBe(true);
		expect(leavesTheApp("http://app.localhost.evil.test/")).toBe(true);
		expect(leavesTheApp("http://127.0.0.1:9229/json")).toBe(true);
		expect(leavesTheApp("wss://example.com/socket")).toBe(true);
	});

	it("drives pages on Windows only, and says why macOS cannot", () => {
		expect(() => assertPageAutomation("win32")).not.toThrow();
		expect(() => assertPageAutomation("darwin")).toThrow(/WKWebView.*tauri-native-smoke\.ts/);
		expect(() => assertPageAutomation("linux")).toThrow("ships on macOS and Windows only");
	});

	it("refuses a host whose build record lacks test-automation, since it would open no DevTools port", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "omp-host-record-"));
		dirs.push(dir);
		const exe = path.join(dir, "ompdesk-shell.exe");
		expect(() => assertTestAutomationHost(exe)).toThrow("cannot read");
		writeFileSync(path.join(dir, "ompdesk-tauri.build.json"), JSON.stringify({ features: [] }));
		expect(() => assertTestAutomationHost(exe)).toThrow("without the test-automation feature");
		writeFileSync(path.join(dir, "ompdesk-tauri.build.json"), JSON.stringify({ engine: "tauri" }));
		expect(() => assertTestAutomationHost(exe)).toThrow('"unrecorded"');
		writeFileSync(path.join(dir, "ompdesk-tauri.build.json"), JSON.stringify({ features: ["test-automation"] }));
		expect(() => assertTestAutomationHost(exe)).not.toThrow();
	});

	it("evaluates fn(electron, arg) with an undefined arg spelled as undefined", async () => {
		const run = (expression: string, electron: unknown) =>
			new Function("globalThis", `return ${expression}`)({ __ompdeskElectron: electron });
		const electron = { app: { name: "x" } };
		expect(
			await run(
				evaluateExpression(({ app }: { app: { name: string } }, n: number) => `${app.name}${n}`, 2),
				electron,
			),
		).toBe("x2");
		expect(
			await run(
				evaluateExpression((_e: unknown, arg: unknown) => arg === undefined, undefined),
				electron,
			),
		).toBe(true);
		await expect(
			run(
				evaluateExpression(() => 1, undefined),
				undefined,
			),
		).rejects.toThrow("__ompdeskElectron");
	});
});
