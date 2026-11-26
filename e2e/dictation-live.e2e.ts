import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { type Browser, chromium, devices, expect, type Page, test, webkit } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { closeBrowser, launchBrowser } from "./harness";

// One live dictation take on a phone page, in Chromium and WebKit (the engine of the shipped Mac app): the page's
// capture (a 16 kHz AudioContext made in the press, a ScriptProcessorNode) hears a fake microphone's tone, streams
// PCM16 to the harness's `stt_stream_audio`, shows the words while speaking, and lands stock's transcript in the draft.
// The rest is covered without a browser: the take's flow, tail, silence stop and Retry (src/renderer/lib/voice.test.ts),
// the press rule (dictation-press.test.ts), the phone slot's held press (ComposerToolbar.phone.test.tsx), the tidy
// pass (dictation-text.test.ts) and the bridge's stream (src/main/bridge-stt-language.test.ts).

test.describe.configure({ retries: 1 });

let server: ViteDevServer | undefined;
let origin = "";
let chromiumBrowser: Browser | undefined;
let webkitBrowser: Browser | undefined;

async function freePort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const probe = createNetServer();
	probe.once("error", reject);
	probe.listen(0, "127.0.0.1", () => {
		const address = probe.address();
		const port = typeof address === "object" && address ? address.port : 0;
		probe.close(() => resolve(port));
	});
	return promise;
}

test.beforeAll(async () => {
	const port = await freePort();
	server = await createServer({
		configFile: path.resolve("vite.harness.config.ts"),
		server: { host: "127.0.0.1", port, strictPort: true },
		logLevel: "error",
	});
	await server.listen();
	origin = `http://127.0.0.1:${port}`;
});

test.afterAll(async () => {
	await chromiumBrowser?.close();
	if (webkitBrowser) await closeBrowser(webkitBrowser);
	await server?.close();
});

async function openPhone(engine: "chromium" | "webkit"): Promise<Page> {
	if (engine === "chromium") chromiumBrowser ??= await chromium.launch();
	else webkitBrowser ??= await launchBrowser(webkit);
	const browser = engine === "chromium" ? chromiumBrowser : webkitBrowser;
	if (!browser) throw new Error(`${engine} did not start`);
	const context = await browser.newContext({ ...devices[engine === "chromium" ? "Pixel 8" : "iPhone 15"] });
	const page = await context.newPage();
	page.on("pageerror", error => {
		throw error;
	});
	await page.goto(`${origin}/harness.html?theme=light&lang=en`);
	await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
	await page.waitForFunction(() => window.__stores?.composer !== undefined, undefined, { timeout: 45_000 });
	await page.evaluate(() => {
		window.__stores?.session.setState({ status: "ready", isStreaming: false });
		window.__stores?.settings.setState({ sttEnabled: true });
		// A microphone that hears a steady tone (no device in CI).
		const getUserMedia = async () => {
			const tone = new AudioContext();
			await tone.resume().catch(() => undefined);
			const oscillator = tone.createOscillator();
			oscillator.frequency.value = 220;
			const destination = tone.createMediaStreamDestination();
			oscillator.connect(destination);
			oscillator.start();
			return destination.stream;
		};
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: Object.assign(navigator.mediaDevices ?? {}, { getUserMedia }),
		});
	});
	return page;
}

/** Bytes of PCM16 the page streamed to the harness so far. */
const streamedBytes = (page: Page): Promise<number> =>
	page.evaluate(() =>
		(window.__harness?.calls ?? []).reduce((sum, call) => {
			const command = (call.args[0] as { command?: { type?: string; audioBase64?: string } } | undefined)?.command;
			return command?.type === "stt_stream_audio" ? sum + atob(command.audioBase64 ?? "").length : sum;
		}, 0),
	);

const draft = (page: Page): Promise<string> =>
	page.evaluate(() => (window.__stores?.composer.getState() as { draft: string } | undefined)?.draft ?? "");

for (const engine of ["chromium", "webkit"] as const)
	test(`a live take streams what the microphone hears and lands its words · ${engine}`, async () => {
		const page = await openPhone(engine);
		try {
			await page.locator('[data-slot="send"] .omp-composer-mic').tap();
			await expect(page.locator('[data-dictation="recording"]')).toBeVisible();
			// A second of audio is 32 000 bytes of PCM16 at 16 kHz: the capture context runs and is not suspended.
			await expect.poll(() => streamedBytes(page), { timeout: 10_000 }).toBeGreaterThan(16_000);
			await expect(page.locator("[data-dictation-words]")).toContainText("Dictated in the harness");
			await page.getByRole("button", { name: "Stop recording and insert text" }).tap();
			await expect.poll(() => draft(page)).toBe("Dictated in the harness. ");
		} finally {
			await page.context().close();
		}
	});
