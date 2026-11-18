/**
 * Clicks Quit in the running app's menu bar menu (`app`) or the tray's menu (`tray`), through main's test inspector: the
 * shim's own `menu.click` delivery (`__ompdeskMenus`, src/main/shell-host/electron/menu.ts), as the shell delivers a
 * person's click. No synthetic OS input. scripts/mac-launch-check.sh runs it.
 *
 *   bun scripts/mac-menu-quit.ts <inspector port> app|tray
 *
 * Prints the menu id, item id and label it clicked; exits 1 when the inspector or the item is missing.
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

// Runs in main: the item to click, then the click on the next turn, so this evaluation answers before the quit starts.
const expression = `(() => {
	const hooks = globalThis.__ompdeskMenus;
	if (!hooks) throw new Error("no __ompdeskMenus: not a test-inspector run");
	const appMenu = hooks.applicationMenuId();
	const menus = hooks.menus();
	const menu = ${where === "app" ? "menus.find(m => m.menuId === appMenu)" : "menus.find(m => m.menuId !== appMenu && m.items.some(i => i.label === 'Quit'))"};
	const item = menu && menu.items.find(i => ${where === "app" ? "i.role === 'quit'" : "i.label === 'Quit'"});
	if (!item) throw new Error("no Quit item: " + JSON.stringify(menus));
	setTimeout(() => hooks.click({ menuId: menu.menuId, itemId: item.itemId }), 0);
	return JSON.stringify({ menuId: menu.menuId, itemId: item.itemId, label: item.label });
})()`;

const socket = new WebSocket(url);
const answer = Promise.withResolvers<string>();
socket.addEventListener("open", () =>
	socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } })),
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
