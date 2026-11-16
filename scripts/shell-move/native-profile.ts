// bun native-profile.ts <port> [read|write|quit|shot <file>]: the Tauri page of the moved profile through its WebDriver.
// `read` also reports the Settings preference and the seeded conversation through window.omp (seed-state.ts).
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { Driver, until } from "../tauri-native-smoke";
import { FIND_SEED_SESSION, OPEN_SEED_SESSION, PNG_MAGIC } from "./seed-state";

const port = Number(process.argv[2]);
const mode = process.argv[3] ?? "read";
assert(Number.isInteger(port) && port >= 1024 && port <= 65535);
assert(["read", "write", "quit", "shot"].includes(mode));
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
if (mode === "shot") {
	const file = process.argv[4];
	assert(file, "shot needs a file");
	await driver.evaluate(FIND_SEED_SESSION);
	await driver.evaluate(OPEN_SEED_SESSION);
	await new Promise(resolve => setTimeout(resolve, 2_000));
	const base64 = await driver.command("GET", "/screenshot");
	assert(typeof base64 === "string");
	const png = Buffer.from(base64, "base64");
	assert(png.subarray(0, 8).equals(PNG_MAGIC), "the native screenshot was not a PNG");
	writeFileSync(file, png);
	console.log(JSON.stringify({ shot: file, bytes: png.length }));
} else if (mode === "quit") {
	await driver.evaluate("(setTimeout(()=>window.omp.app.quit(),0),true)");
	console.log(JSON.stringify({ quit: "requested", transport: "native-webdriver" }));
} else {
	if (mode === "write") {
		await driver.evaluate("(localStorage.setItem('ompdesk.seed.afterMigration','Tauri 저장 후 다시 열기 ✓'),true)");
	}
	const observed = await driver.evaluate(
		`(async()=>({href:location.href,auth:await window.omp.updater.authInfo(),draft:localStorage.getItem('ompdesk.seed.draft'),korean:localStorage.getItem('ompdesk.seed.korean'),large:(localStorage.getItem('ompdesk.seed.large')??'').length,replyLanguage:await window.omp.prefs.get('replyLanguage'),seedSession:await ${FIND_SEED_SESSION},afterMigration:localStorage.getItem('ompdesk.seed.afterMigration'),userAgent:navigator.userAgent}))()`,
	);
	assert(observed !== null && typeof observed === "object");
	assert(
		"userAgent" in observed && typeof observed.userAgent === "string" && !observed.userAgent.includes("Electron/"),
	);
	const seed = (observed as { seedSession?: { id?: string; title?: string | null } | null }).seedSession;
	console.log(JSON.stringify({ ...observed, seedSessionId: seed?.id, seedSessionTitle: seed?.title }));
}
