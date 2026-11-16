/**
 * Proves the packaged RELEASE Tauri host carries no WebDriver server (the `test-automation` cargo feature never ships):
 *
 *   bun scripts/tauri-release-automation-check.ts
 *     (a) the host binary holds none of the plugin's crate names;
 *     (b) the host, launched with every test variable that would turn the server on (the Node test inspector, a private
 *         test profile that is the app's user data, a free port), starts and leaves that port closed.
 *   bun scripts/tauri-release-automation-check.ts --expect-automation <binary>
 *     the positive control: a test build's host must hold those strings, or (a) would pass for any binary.
 *
 * Takes the environment tauri-native-smoke.ts does (OMPDESK_TAURI_TEST_BINARY, _OUTPUT, _NODE, OMP_GUI_E2E_OUT).
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launchNative, type NativeApp, stopNative, until } from "./tauri-native-smoke";

/** What `tauri-plugin-wdio-webdriver` leaves in a host that compiled it: its crate name, in panic paths and as the plugin's name. */
export const AUTOMATION_STRINGS = [
	"tauri-plugin-wdio-webdriver",
	"tauri_plugin_wdio_webdriver",
	"wdio-webdriver",
	"wdio_webdriver",
] as const;

export function automationStringsIn(bytes: Uint8Array): string[] {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return AUTOMATION_STRINGS.filter(needle => buffer.includes(needle));
}

function listening(host: string, port: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = connect({ host, port });
	socket.once("connect", () => {
		socket.destroy();
		resolve(true);
	});
	socket.once("error", () => resolve(false));
	return promise;
}

async function freePort(): Promise<number> {
	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert(address && typeof address !== "string");
	const closed = Promise.withResolvers<void>();
	server.close(() => closed.resolve());
	await closed.promise;
	return address.port;
}

function expectAutomation(binary: string): void {
	const found = automationStringsIn(readFileSync(binary));
	assert(
		found.length > 0,
		`${binary} holds no WebDriver plugin string: the scan in this check cannot tell a test build from a release one`,
	);
	console.log(`test host ${binary} holds ${found.join(", ")}: the scan sees the plugin when it is there`);
}

async function checkRelease(): Promise<void> {
	const binary = process.env.OMPDESK_TAURI_TEST_BINARY;
	assert(binary && path.isAbsolute(binary), "OMPDESK_TAURI_TEST_BINARY must name the released Tauri executable");
	const bytes = readFileSync(binary);
	const found = automationStringsIn(bytes);
	assert(
		found.length === 0,
		`The released host ${binary} contains the WebDriver plugin (${found.join(", ")}): the test-automation feature leaked into a release build`,
	);
	console.log(`release host ${binary} (${bytes.byteLength} bytes) holds none of ${AUTOMATION_STRINGS.join(", ")}`);

	// On Windows two routes would open a WebView2 DevTools port: the loader's own variable (read in any host) and the test
	// host's OMP_GUI_TEST_WEBVIEW2_DEBUG_PORT. The released host must honour neither, so nothing may listen on either port.
	const loaderPort = process.platform === "win32" ? await freePort() : undefined;
	const hostPort = process.platform === "win32" ? await freePort() : undefined;
	let app: NativeApp;
	try {
		if (loaderPort !== undefined)
			process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${loaderPort}`;
		if (hostPort !== undefined) process.env.OMP_GUI_TEST_WEBVIEW2_DEBUG_PORT = String(hostPort);
		app = await launchNative("release-automation-");
	} finally {
		Reflect.deleteProperty(process.env, "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");
		Reflect.deleteProperty(process.env, "OMP_GUI_TEST_WEBVIEW2_DEBUG_PORT");
	}
	try {
		await until("Released app start", async () => existsSync(path.join(app.desktop, "app-started.json")), app.exited);
		const probed = [
			{
				port: app.port,
				name: "OMP_GUI_TEST_WEBDRIVER_PORT",
				what: "the test WebDriver environment (a WebDriver server is running, or another process took the port)",
			},
			...(loaderPort === undefined || hostPort === undefined
				? []
				: [
						{
							port: loaderPort,
							name: "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port",
							what: "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS (WebView2 opened a DevTools port, or another process took the port)",
						},
						{
							port: hostPort,
							name: "OMP_GUI_TEST_WEBVIEW2_DEBUG_PORT",
							what: "OMP_GUI_TEST_WEBVIEW2_DEBUG_PORT (the host opened a DevTools port, or another process took the port)",
						},
					]),
		];
		for (let probe = 0; probe < 3; probe++) {
			for (const { port, what } of probed) {
				for (const host of ["127.0.0.1", "::1"]) {
					assert(
						!(await Promise.race([listening(host, port), app.exited])),
						`${host}:${port} accepts connections although the released host got ${what}`,
					);
				}
			}
			await Promise.race([delay(300), app.exited]);
		}
		console.log(
			`released app started with the test profile and ${probed.map(({ name, port }) => `${name}=${port}`).join(", ")}; nothing listens on 127.0.0.1 or [::1] at ${probed.map(({ port }) => port).join(", ")}`,
		);
	} finally {
		await stopNative(app);
	}
}

async function main(): Promise<void> {
	const flag = process.argv.indexOf("--expect-automation");
	if (flag === -1) await checkRelease();
	else {
		const binary = process.argv[flag + 1];
		assert(binary, "--expect-automation needs the test host's path");
		expectAutomation(binary);
	}
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		console.error(`Release automation check failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
