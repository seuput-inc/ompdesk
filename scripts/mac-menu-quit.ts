/**
 * Clicks Quit in the running app's menu bar menu (`app`) or the tray's menu (`tray`), through main's test inspector:
 * `__ompdeskMenus.click` (src/main/shell-host/electron/index.ts) asks the shell to choose the item as a person's click
 * does (`menu.testClick`, tauri-shell/src/app_menu.rs). No synthetic OS input. scripts/mac-launch-check.sh runs it.
 *
 *   bun scripts/mac-menu-quit.ts <inspector port> app|tray
 *
 * Prints the menu and label it clicked; exits 1 when the inspector or the item is missing.
 */
const [port, where] = process.argv.slice(2);
if (!port || (where !== "app" && where !== "tray")) {
	console.error("usage: bun scripts/mac-menu-quit.ts <inspector port> app|tray");
	process.exit(2);
}
const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
	webSocketDebuggerUrl: string;
}[];
const url = targets[0]?.webSocketDebuggerUrl;
if (!url) throw new Error(`no inspector target on port ${port}`);

const label = where === "app" ? "Quit OMPdesk" : "Quit";
// Runs in main and waits for the shell's answer: the item was found and chosen; the quit then runs on its own.
const expression = `(async () => {
	const hooks = globalThis.__ompdeskMenus;
	if (!hooks) throw new Error("no __ompdeskMenus: not a test-inspector run");
	await hooks.click(${JSON.stringify(where)}, ${JSON.stringify(label)});
	return JSON.stringify({ menu: ${JSON.stringify(where)}, label: ${JSON.stringify(label)} });
})()`;

const socket = new WebSocket(url);
const answer = Promise.withResolvers<string>();
socket.addEventListener("open", () =>
	socket.send(
		JSON.stringify({
			id: 1,
			method: "Runtime.evaluate",
			params: { expression, returnByValue: true, awaitPromise: true },
		}),
	),
);
socket.addEventListener("message", event => {
	const message = JSON.parse(String(event.data)) as {
		id?: number;
		result?: { result?: { value?: string }; exceptionDetails?: { exception?: { description?: string } } };
	};
	if (message.id !== 1) return;
	const failed = message.result?.exceptionDetails;
	if (failed) answer.reject(new Error(failed.exception?.description ?? "evaluation failed"));
	else answer.resolve(message.result?.result?.value ?? "");
});
socket.addEventListener("error", () => answer.reject(new Error(`inspector ${url} failed`)));
const timer = setTimeout(() => answer.reject(new Error("the inspector did not answer in 20 s")), 20_000);
try {
	console.log(`clicked ${where} Quit: ${await answer.promise}`);
} finally {
	clearTimeout(timer);
	socket.close();
}
