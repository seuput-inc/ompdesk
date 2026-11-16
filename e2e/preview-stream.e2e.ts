import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { appDirOfEntry, assertShellBuilt, copyShellDiagnostics, usePinnedNode } from "./fixture/shell-launch";
import { processesBelow, processKey, waitForProcessesToExit } from "./process-tree";

/**
 * A paired phone's preview, on real offscreen pages (design §7.1): `e2e/fixture/preview-stream-main.ts` runs the
 * real preview host and WebSocket router as the Node main of the Tauri host (the shim in place of `electron`)
 * against a fake WebSocket client and a local test page, so the host's own Preview browser paints the pages and no
 * app window or pairing is involved. The frames
 * that arrive are JPEGs of the size the phone's surface asks for; the ack pacing holds (no frame without the
 * ack, at most 12 a second, nothing for a still page); a tap, keys, committed text and a wheel reach the page
 * as trusted events; a pinch zooms; the page's dialogs wait for the phone. The numbers it measures are written
 * to the test's output (`preview-stream-numbers` attachment).
 */

interface Numbers {
	firstFrame: {
		bytes: number;
		width: number;
		height: number;
		rect: Record<string, number>;
		tab: boolean;
		hostScale: number;
	};
	click: { trusted: boolean; target: string; active: boolean; x: number; y: number };
	typing: { value: string; allTrusted: boolean; keys: string[] };
	enter: string;
	wheel: { trusted: boolean; dy: number };
	zoom: { before: number; after: number };
	idle: { seconds: number; frames: number; bytes: number; cpuCorePercent: number };
	busy: {
		seconds: number;
		frames: number;
		fps: number;
		maxFramesInAnySecond: number;
		bytesPerFrame: number;
		kbitPerSecond: number;
		cpuCorePercent: number;
		sizes: string[];
	};
	ackHold: { frameWithoutAck: boolean; heldMs: number };
	ackRelease: { frameAfterAck: boolean };
	blockedBeforeAnswer: boolean;
	dialogs: {
		asked: Array<{ kind: string; message: string; initial: string | null }>;
		confirm: unknown;
		prompt: unknown;
		resumed: boolean;
	};
}

/** Everything the host and its children wrote while the fixture ran, and the processes it left below it. */
async function runFixture(work: string, bundle: string): Promise<{ output: string; code: number | null }> {
	const host = assertShellBuilt();
	const userData = path.join(work, "userData");
	const env: NodeJS.ProcessEnv = { ...process.env, OMP_PREVIEW_E2E_USERDATA: userData };
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	// The host starts its Node child on the bundle as its main script, from the built `out/` beside it (the host
	// reads the renderer and preload next to `main/`); nothing opens a window, the fixture drives the preview alone.
	env.OMPDESK_APP_DIR = appDirOfEntry(bundle);
	env.OMPDESK_APP_ENTRY = bundle;
	usePinnedNode(env);
	const child = spawn(host, [`--user-data-dir=${userData}`], {
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	for (const stream of [child.stdout, child.stderr])
		stream.on("data", chunk => {
			output += String(chunk);
		});
	const { promise: exited, resolve: exit } = Promise.withResolvers<number | null>();
	child.once("exit", code => exit(code));
	const stuck = Promise.withResolvers<"stuck">();
	const timer = setTimeout(() => stuck.resolve("stuck"), 120_000);
	const owned = () => (child.pid === undefined ? [] : processesBelow(child.pid));
	let below = owned();
	const watch = setInterval(() => {
		below = [...new Map([...below, ...owned()].map(entry => [processKey(entry), entry])).values()];
	}, 2_000);
	try {
		if ((await Promise.race([exited, stuck.promise])) === "stuck") child.kill("SIGKILL");
		return { output, code: await exited };
	} finally {
		clearTimeout(timer);
		clearInterval(watch);
		await waitForProcessesToExit(below, 10_000);
		// The test's own `finally` removes `work` next, and with it the host's native log.
		try {
			copyShellDiagnostics(userData, test.info().outputPath("shell-logs", String(child.pid ?? "fixture")), output);
		} catch (error) {
			console.warn(`[shell diagnostics] ${String(error)}`);
		}
	}
}

test("a phone's preview streams paced JPEG frames and its gestures reach the offscreen page as trusted input", async () => {
	test.setTimeout(150_000);
	const work = mkdtempSync(path.join(os.tmpdir(), "omp-preview-stream-"));
	// Inside the built `out/main/`, where the host finds the renderer and preload its main script sits beside.
	const bundle = path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main", `preview-stream-main-${process.pid}.mjs`);
	try {
		execFileSync(
			"bun",
			[
				"build",
				"e2e/fixture/preview-stream-main.ts",
				"--target=node",
				"--format=esm",
				"--tsconfig-override=e2e/fixture/preview-stream.tsconfig.json",
				"--outfile",
				bundle,
			],
			{ stdio: "pipe" },
		);
		const { output, code } = await runFixture(work, bundle);
		const failed = /^FAILED (.*)$/ms.exec(output);
		expect(failed?.[1], `the fixture failed (exit ${code})`).toBeUndefined();
		const line = /^RESULT (.+)$/m.exec(output)?.[1];
		expect(line, `the fixture printed no result (exit ${code}):\n${output}`).toBeDefined();
		const numbers = JSON.parse(line ?? "{}") as Numbers;
		await test.info().attach("preview-stream-numbers", {
			body: JSON.stringify(numbers, null, 2),
			contentType: "application/json",
		});
		console.log(`preview-stream numbers: ${JSON.stringify(numbers.busy)} idle: ${JSON.stringify(numbers.idle)}`);

		// Frames: a 390×700 surface on a 3× phone is drawn at 2× (780×1400), whatever the host screen's density.
		expect(numbers.firstFrame.width).toBe(780);
		expect(numbers.firstFrame.height).toBe(1400);
		expect(numbers.firstFrame.rect).toEqual({ x: 0, y: 0, width: 390, height: 700 });
		expect(numbers.firstFrame.tab).toBe(true);
		expect(numbers.busy.sizes).toEqual(["780x1400"]);

		// Pacing: no frame without the ack, at most 12 a second on a page that changes every pixel, none for a still page.
		expect(numbers.ackHold).toMatchObject({ frameWithoutAck: false });
		expect(numbers.ackHold.heldMs).toBeGreaterThanOrEqual(1100);
		expect(numbers.ackRelease.frameAfterAck).toBe(true);
		expect(numbers.busy.maxFramesInAnySecond).toBeLessThanOrEqual(12);
		expect(numbers.busy.fps).toBeGreaterThanOrEqual(5);
		expect(numbers.busy.fps).toBeLessThanOrEqual(12.5);
		expect(numbers.idle.frames).toBe(0);
		expect(numbers.idle.bytes).toBe(0);

		// Input: trusted, with user activation (so `choose` and gesture-gated APIs work).
		expect(numbers.click).toMatchObject({ trusted: true, target: "btn", active: true });
		expect(Math.abs(numbers.click.x - 100)).toBeLessThanOrEqual(2);
		expect(Math.abs(numbers.click.y - 58)).toBeLessThanOrEqual(2);
		expect(numbers.typing.allTrusted).toBe(true);
		expect(numbers.typing.value).toBe("a한글");
		expect(numbers.typing.keys).toEqual(["a", "b", "Backspace"]);
		expect(JSON.parse(numbers.enter)).toBe("x\ny");
		expect(numbers.wheel).toEqual({ trusted: true, dy: 240 });
		expect(numbers.zoom).toEqual({ before: 1, after: 1.5 });

		// Dialogs: asked of the phone, the page blocked until it answers, then resumed with the answers.
		expect(numbers.blockedBeforeAnswer).toBe(true);
		expect(numbers.dialogs.asked).toEqual([
			{ kind: "confirm", message: "Delete everything?", initial: null },
			{ kind: "prompt", message: "Name?", initial: "dflt" },
			{ kind: "alert", message: "done", initial: null },
		]);
		expect(numbers.dialogs).toMatchObject({ confirm: true, prompt: "Ada", resumed: true });
	} finally {
		rmSync(bundle, { force: true });
		rmSync(work, { recursive: true, force: true });
	}
});
