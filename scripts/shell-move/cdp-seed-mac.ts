// bun cdp-seed-mac.ts <port> [read|quit|shot <file>]: in the released app's own page, save a stand-in update token through its
// own IPC (main encrypts it with safeStorage), write file:// Local Storage keys, set a Settings preference through
// `prefs.set` and add a stock session file the app lists as a conversation. Prints one JSON line.
// `shot <file>` saves a PNG of the page (Page.captureScreenshot) with the seeded conversation opened when the page shows it.
import { writeFileSync } from "node:fs";
import { type Browser, chromium, type Page } from "playwright";
import { FIND_SEED_SESSION, OPEN_SEED_SESSION, PNG_MAGIC, SEED_REPLY_LANGUAGE, writeSeedSession } from "./seed-state";

const mode = process.argv[3] ?? "seed";
const port = process.argv[2];
const token = process.env.STAND_IN_TOKEN ?? "ghp_STANDIN_not_a_real_token_0123456789";
let browser: Browser | undefined;
for (let i = 0; i < 120 && !browser; i++) {
	browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5_000 }).catch(() => undefined);
	if (!browser) await new Promise(r => setTimeout(r, 500));
}
if (!browser) throw new Error("no CDP endpoint");
let page: Page | undefined;
/** What the seed reads of the released app's page: its `window.omp` updater calls. */
type SeedWindow = {
	omp?: {
		app?: { quit(): void };
		prefs?: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown> };
		updater?: {
			saveAuth(token: string): Promise<{ access?: string; source?: string | null }>;
			authInfo(): Promise<{ source?: string | null; hasStoredToken?: boolean }>;
		};
	};
};
for (let i = 0; i < 60 && !page; i++) {
	page = browser
		.contexts()
		.flatMap(c => c.pages())
		.find(p => /index\.html|app:\/\/ompdesk/.test(p.url()));
	if (!page) await new Promise(r => setTimeout(r, 500));
}
if (!page) throw new Error("no app page");
await page.waitForFunction(() => typeof (window as unknown as SeedWindow).omp?.updater?.saveAuth === "function", null, {
	timeout: 30_000,
});
if (mode === "quit") {
	await page.waitForFunction(() => typeof (window as unknown as SeedWindow).omp?.app?.quit === "function", null, {
		timeout: 30_000,
	});
	const connected = browser;
	// Playwright's Browser has no waitForEvent: listen for its one "disconnected" event, bounded by the quit's minute.
	const disconnected = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("the released app did not quit within 60 s")), 60_000);
		connected.once("disconnected", () => {
			clearTimeout(timer);
			resolve();
		});
	});
	const requested = page.evaluate(() => {
		const app = (window as unknown as SeedWindow).omp?.app;
		if (!app) throw new Error("the released app has no quit API");
		app.quit();
	});
	await Promise.all([
		disconnected,
		requested.catch(error => {
			if (browser.isConnected() || !/closed/i.test(String(error))) throw error;
		}),
	]);
	console.log(JSON.stringify({ quit: "requested", transport: "disconnected" }));
	process.exit(0);
}
if (mode === "shot") {
	const file = process.argv[4];
	if (!file) throw new Error("shot needs a file");
	await page.evaluate(OPEN_SEED_SESSION).catch(() => false);
	await new Promise(r => setTimeout(r, 2_000));
	const png = await page.screenshot({ type: "png" });
	if (!png.subarray(0, 8).equals(PNG_MAGIC)) throw new Error("the old app's screenshot was not a PNG");
	writeFileSync(file, png);
	console.log(JSON.stringify({ shot: file, bytes: png.length, href: page.url() }));
	process.exit(0);
}
if (mode === "read") {
	// Read the restarted released page before migration, or the shell's page after it, without rewriting either
	// the stored token or Local Storage. The two observations distinguish producer persistence from the move.
	await page.waitForFunction(
		() => typeof (window as unknown as SeedWindow).omp?.updater?.authInfo === "function",
		null,
		{
			timeout: 60_000,
		},
	);
	const seedSession = (await page.evaluate(FIND_SEED_SESSION)) as { id: string; title: string | null } | null;
	const read = await page.evaluate(async () => ({
		href: location.href,
		auth: await (window as unknown as SeedWindow).omp?.updater?.authInfo(),
		draft: localStorage.getItem("ompdesk.seed.draft"),
		korean: localStorage.getItem("ompdesk.seed.korean"),
		large: (localStorage.getItem("ompdesk.seed.large") ?? "").length,
		replyLanguage: await (window as unknown as SeedWindow).omp?.prefs?.get("replyLanguage"),
	}));
	console.log(JSON.stringify({ ...read, seedSessionId: seedSession?.id, seedSessionTitle: seedSession?.title }));
	process.exit(0);
}
writeSeedSession(process.env.SEED_PROJECT_CWD ?? `${process.env.RUNNER_TEMP ?? "/tmp"}/move-seed-project`);
const seedSession = (await page.evaluate(FIND_SEED_SESSION)) as { id: string; title: string | null } | null;
const out = await page.evaluate(
	async ({ t, language }) => {
		const omp = (window as unknown as SeedWindow).omp;
		await omp?.prefs?.set("replyLanguage", language);
		const saved = await (window as unknown as SeedWindow).omp?.updater?.saveAuth(t);
		localStorage.setItem("ompdesk.seed.draft", "a draft typed in Electron");
		localStorage.setItem("ompdesk.seed.korean", "한국어 초안 ✓");
		localStorage.setItem("ompdesk.seed.large", "x".repeat(200000));
		return {
			saved,
			origin: location.origin,
			href: location.href,
			keys: localStorage.length,
			auth: await (window as unknown as SeedWindow).omp?.updater?.authInfo(),
			replyLanguage: await omp?.prefs?.get("replyLanguage"),
		};
	},
	{ t: token, language: SEED_REPLY_LANGUAGE },
);
console.log(JSON.stringify({ seedSession }));
console.log(JSON.stringify(out));
if (
	out.saved?.access !== "ok" ||
	out.saved.source !== "stored" ||
	out.auth?.source !== "stored" ||
	out.auth.hasStoredToken !== true ||
	out.replyLanguage !== SEED_REPLY_LANGUAGE ||
	seedSession === null
) {
	console.error(
		"seed failed: the released app did not validate and store the token, keep the setting, or list the seeded conversation",
	);
	process.exit(1);
}
process.exit(0); // no browser.close(): it would send Browser.close
