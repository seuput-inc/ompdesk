import { mkdir, mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { assertAppBuilt } from "../scripts/e2e-app-entry";
import { assertShellBuilt, exitShellApp, launchShell } from "./fixture/shell-launch";
import { appLaunchOptions } from "./harness";

/** How long the warm-up launch may take: a fresh runner's first WebView2 start took 50 s (run 45646449982). */
const WARMUP_TIMEOUT_MS = 180_000;

/**
 * The first WebView2 start on a fresh hosted runner is slow before its browser process even runs: in run 45646449982
 * the first launch of each shard took 5-8 s to start msedgewebview2 (runtime 157.0.4341.46) and 35-50 s on runners
 * that had 157.0.4341.60, against ~1 s for every later launch. That cost landed in the shard's first test and failed
 * its 60 s launch. One app launch here pays it before any test, and its time and runtime are printed.
 */
async function warmWebView2(): Promise<void> {
	const profile = await mkdtemp(path.join(os.tmpdir(), "omp-gui-webview2-warmup-"));
	const world = {
		project: path.join(profile, "project"),
		desktop: path.join(profile, "desktop"),
		agent: path.join(profile, "agent"),
		profile,
	};
	await Promise.all([world.project, world.desktop, world.agent].map(dir => mkdir(dir, { recursive: true })));
	const started = Date.now();
	try {
		const app = await launchShell({ ...(await appLaunchOptions(world)), timeout: WARMUP_TIMEOUT_MS });
		try {
			const page = await app.firstWindow({ timeout: WARMUP_TIMEOUT_MS });
			const engine = await page.evaluate(() => /Edg\/[\d.]+/.exec(navigator.userAgent)?.[0] ?? navigator.userAgent);
			console.log(`[e2e] WebView2 warm-up: the first launch took ${Date.now() - started} ms (${engine})`);
		} finally {
			await exitShellApp(app);
		}
	} catch (error) {
		// The tests still run: one that then cannot launch fails with its own evidence.
		console.warn(`[e2e] WebView2 warm-up failed after ${Date.now() - started} ms: ${String(error)}`);
	}
}

// Runs once, before any worker: a missing build (the app's `out/`, or the Tauri host that runs it) fails the whole run
// here instead of every test's launch failing on its own (scripts/e2e-app-entry.ts, e2e/fixture/shell-launch.ts).
// macOS has no host to check: Playwright cannot drive WKWebView, so each launch there refuses with its reason
// (`assertPageAutomation`), and a spec that never launches the app still runs.
export default async function globalSetup(): Promise<void> {
	assertAppBuilt();
	if (process.platform === "win32") assertShellBuilt();
	const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
	if (process.platform === "win32" && major === 24 && minor < 16) {
		console.warn(
			`Node ${process.versions.node} (libuv 1.51) can kill a Playwright worker with 0xC0000409 on a loopback connect (nodejs/node#63620, fixed in 24.16.0): a test then fails with "worker process exited unexpectedly". Install Node 24.16 or later (docs/windows-dev.md).`,
		);
	}
	// A developer's machine has started WebView2 before; a hosted runner is fresh every job.
	if (process.platform === "win32" && process.env.GITHUB_ACTIONS) await warmWebView2();
}
