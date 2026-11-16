// bun native-profile.ts <port> [read|write|quit|shots <conversation> <language> <token>]: the Tauri page of the moved profile through its WebDriver.
// `read` also reports the Settings preference and the seeded conversation through window.omp (seed-state.ts).
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { Driver, until } from "../tauri-native-smoke";
import { PNG_MAGIC, QUIT_FROM_PAGE, READ_PROFILE_PAGE, takeSeedShots, WRITE_AFTER_MIGRATION } from "./seed-state";

const port = Number(process.argv[2]);
const mode = process.argv[3] ?? "read";
assert(Number.isInteger(port) && port >= 1024 && port <= 65535);
assert(["read", "write", "quit", "shots"].includes(mode));
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
if (mode === "shots") {
	const [conversation, language, token] = process.argv.slice(4);
	assert(conversation && language && token, "shots needs three files");
	const screenshot = async (file: string): Promise<void> => {
		const base64 = await driver.command("GET", "/screenshot");
		assert(typeof base64 === "string");
		const png = Buffer.from(base64, "base64");
		assert(png.subarray(0, 8).equals(PNG_MAGIC), "the native screenshot was not a PNG");
		writeFileSync(file, png);
	};
	const taken = await takeSeedShots(
		{ evaluate: expression => driver.evaluate(expression), screenshot },
		{ conversation, language, token },
	);
	console.log(JSON.stringify({ shots: [conversation, language, token], taken }));
} else if (mode === "quit") {
	await driver.evaluate(QUIT_FROM_PAGE);
	console.log(JSON.stringify({ quit: "requested", transport: "native-webdriver" }));
} else {
	if (mode === "write") {
		await driver.evaluate(WRITE_AFTER_MIGRATION);
	}
	const observed = await driver.evaluate(READ_PROFILE_PAGE);
	assert(observed !== null && typeof observed === "object");
	assert(
		"userAgent" in observed && typeof observed.userAgent === "string" && !observed.userAgent.includes("Electron/"),
	);
	const seed = (observed as { seedSession?: { id?: string; title?: string | null } | null }).seedSession;
	console.log(JSON.stringify({ ...observed, seedSessionId: seed?.id, seedSessionTitle: seed?.title }));
}
