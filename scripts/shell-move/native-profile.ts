import assert from "node:assert/strict";
import { Driver, until } from "../tauri-native-smoke";

const port = Number(process.argv[2]);
const mode = process.argv[3] ?? "read";
assert(Number.isInteger(port) && port >= 1024 && port <= 65535);
assert(["read", "write", "quit"].includes(mode));
const driver = new Driver(port);
const alive = new Promise<never>(() => undefined);
await until(
	"Native migration WebDriver",
	async () => {
		try {
			const state = await driver.request("GET", "/status");
			return state !== null && typeof state === "object" && "ready" in state && state.ready === true;
		} catch (error) {
			if (
				error instanceof Error &&
				"code" in error &&
				["ECONNREFUSED", "ConnectionRefused"].includes(String(error.code))
			)
				return false;
			throw error;
		}
	},
	alive,
);
await driver.connect();
await until(
	"Native migration preload",
	async () => (await driver.evaluate("typeof window.omp?.updater?.authInfo === 'function'")) === true,
	alive,
);
if (mode === "quit") {
	await driver.evaluate("(setTimeout(()=>window.omp.app.quit(),0),true)");
	console.log(JSON.stringify({ quit: "requested", transport: "native-webdriver" }));
} else {
	if (mode === "write") {
		await driver.evaluate("(localStorage.setItem('ompdesk.seed.afterMigration','Tauri 저장 후 다시 열기 ✓'),true)");
	}
	const observed = await driver.evaluate(
		"(async()=>({href:location.href,auth:await window.omp.updater.authInfo(),draft:localStorage.getItem('ompdesk.seed.draft'),korean:localStorage.getItem('ompdesk.seed.korean'),large:(localStorage.getItem('ompdesk.seed.large')??'').length,afterMigration:localStorage.getItem('ompdesk.seed.afterMigration'),userAgent:navigator.userAgent}))()",
	);
	assert(observed !== null && typeof observed === "object");
	assert(
		"userAgent" in observed && typeof observed.userAgent === "string" && !observed.userAgent.includes("Electron/"),
	);
	console.log(JSON.stringify(observed));
}
