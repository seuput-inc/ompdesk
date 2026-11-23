import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyLaunchDecision, type LaunchDecision, type LaunchStart } from "./gpu-fallback";
import { writeRuntimeLog } from "./runtime-log";
import { prepareShellPolicyFixture, type ShellPolicyFixture, shellPolicyFixture } from "./shell-policy-test-rig";

const electron = vi.hoisted(() => ({
	userData: "",
	switches: new Set<string>(),
	relaunches: 0,
	exits: 0,
	softwareCalls: 0,
}));

vi.mock("electron", () => ({
	app: {
		getPath: () => electron.userData,
		getVersion: () => "0.0.0-test",
		relaunch: () => {
			const history = JSON.parse(readFileSync(join(electron.userData, "launch-history.json"), "utf8"));
			expect(history.at(-1)?.gpuRelaunchAt).toEqual(expect.any(Number));
			expect(readFileSync(join(electron.userData, "gpu-fallback.json"), "utf8")).toContain('"policy":3');
			expect(electron.exits).toBe(electron.relaunches);
			electron.relaunches++;
		},
		exit: () => {
			electron.exits++;
		},
	},
}));

const crash = { type: "GPU", reason: "crashed", exitCode: -1073741819 };
let fixture: ShellPolicyFixture;

async function event(op: string, args: object = {}): Promise<void> {
	applyLaunchDecision(await fixture.call<LaunchDecision>("launch.event", { op, args }));
}

const gpuEvents = {
	handleGpuProcessGone: (details: typeof crash) =>
		event("crash", { ...details, now: Date.now(), testLaunch: process.env.OMP_GUI_HEADLESS === "1" }),
	confirmHardwareTrial: () => event("healthy"),
};

async function keepsDying(gpu: typeof gpuEvents): Promise<void> {
	await gpu.handleGpuProcessGone(crash);
	await gpu.handleGpuProcessGone(crash);
}

async function launch(): Promise<typeof gpuEvents> {
	const result = await fixture.call<LaunchStart>("launch.start", {
		profile: electron.userData,
		now: Date.now(),
		guard: true,
		enableGpu: electron.switches.has("enable-gpu"),
		disableGpu: electron.switches.has("disable-gpu"),
	});
	for (const log of result.logs) writeRuntimeLog(log);
	if (result.software) electron.softwareCalls++;
	return gpuEvents;
}

beforeAll(prepareShellPolicyFixture, 180_000);
beforeEach(async () => {
	fixture = await shellPolicyFixture();
	electron.userData = mkdtempSync(join(tmpdir(), "gpu-loop-"));
	electron.switches.clear();
	electron.relaunches = 0;
	electron.exits = 0;
	electron.softwareCalls = 0;
});

afterEach(async () => {
	await fixture.close();
	rmSync(electron.userData, { recursive: true, force: true });
});

describe("GPU crash relaunch", () => {
	it("never relaunches a launch that already renders in software (the marker's own launch)", async () => {
		// Windows still runs a GPU process for SwiftShader/WARP with hardware acceleration off; when that one
		// dies too, a relaunch from here starts the same software launch again: on, off, on, off.
		writeFileSync(
			join(electron.userData, "gpu-fallback.json"),
			JSON.stringify({ at: new Date().toISOString(), reason: "crashed", exitCode: -1, policy: 3 }),
		);
		const gpu = await launch();
		expect(electron.softwareCalls).toBe(1);
		await gpu.handleGpuProcessGone(crash);
		expect(electron.relaunches).toBe(0);
		expect(electron.exits).toBe(0);
		const log = readFileSync(join(electron.userData, "logs", "gui-runtime.jsonl"), "utf8");
		expect(log).toContain("no relaunch");
	});

	it("never relaunches a launch started with --disable-gpu", async () => {
		electron.switches.add("disable-gpu");
		const gpu = await launch();
		await gpu.handleGpuProcessGone(crash);
		expect(electron.relaunches).toBe(0);
		expect(electron.exits).toBe(0);
	});

	it("relaunches a hardware launch whose GPU keeps dying once into software, and that launch then stays up", async () => {
		const first = await launch();
		await keepsDying(first);
		expect(electron.relaunches).toBe(1);
		expect(electron.exits).toBe(1);

		const second = await launch();
		expect(electron.softwareCalls).toBe(1);
		await second.handleGpuProcessGone(crash);
		await second.handleGpuProcessGone(crash);
		expect(electron.relaunches).toBe(1);
		expect(electron.exits).toBe(1);
	});

	it("relaunches at most once per 10 minutes, even when the user turns hardware acceleration back on", async () => {
		await keepsDying(await launch());
		expect(electron.relaunches).toBe(1);

		// --enable-gpu clears the marker, so this launch is a hardware one again; its GPU process dies too.
		electron.switches.add("enable-gpu");
		const again = await launch();
		expect(electron.softwareCalls).toBe(0);
		await keepsDying(again);
		expect(electron.relaunches).toBe(1);
		expect(electron.exits).toBe(1);
		// The marker is written, so the next plain launch renders in software.
		electron.switches.clear();
		await launch();
		expect(electron.softwareCalls).toBe(1);
	});

	it("never relaunches in safe mode, which renders in software whatever the switches say", async () => {
		electron.switches.add("enable-gpu");
		for (let i = 0; i < 3; i++) await launch(); // three launches that never became stable
		const safe = await launch();
		expect(electron.softwareCalls).toBe(1);
		await safe.handleGpuProcessGone(crash);
		expect(electron.relaunches).toBe(0);
	});

	it("never relaunches a test launch (OMP_GUI_HEADLESS): nothing follows the new process, which outlives the test", async () => {
		// Seen under parallel e2e load: the GPU helper crashed, the app relaunched and exited, Playwright's page went
		// with it ("Target page, context or browser has been closed") and the relaunched app kept running unwatched.
		vi.stubEnv("OMP_GUI_HEADLESS", "1");
		try {
			const gpu = await launch();
			await gpu.handleGpuProcessGone(crash);
			expect(electron.relaunches).toBe(0);
			expect(electron.exits).toBe(0);
			const log = readFileSync(join(electron.userData, "logs", "gui-runtime.jsonl"), "utf8");
			expect(log).toContain("no relaunch (test-launch)");
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

// Intel iGPU of a laptop, before and after the user updates its driver. Chromium's basic info names the real
// adapter even in a software launch; the SwiftShader device (vendor 0xffff) is never an identity.
const iGpu = (driverVersion: string) => ({
	active: true,
	vendorId: 0x8086,
	deviceId: 0x9a49,
	driverVersion,
	driverDate: "2021-6-14",
});
const swiftShader = { active: false, vendorId: 0xffff, deviceId: 0xffff, driverVersion: "5.0.0" };

/** A launch that also reads the GPU once ready and outlives the crash-loop window, as index.ts does. */
async function launchWith(device: Record<string, unknown>): Promise<typeof gpuEvents> {
	const gpu = await launch();
	await event("identity", { devices: [swiftShader, device] });
	await event("stable");
	return gpu;
}

function readLog(): string {
	return readFileSync(join(electron.userData, "logs", "gui-runtime.jsonl"), "utf8");
}

describe("hardware acceleration comes back by itself", () => {
	it("stays in software while the driver that crashed is still installed", async () => {
		await keepsDying(await launchWith(iGpu("27.20.100.9466")));
		expect(electron.relaunches).toBe(1);
		await launchWith(iGpu("27.20.100.9466"));
		await launchWith(iGpu("27.20.100.9466"));
		expect(electron.softwareCalls).toBe(2);
	});

	it("tries hardware once after the driver changed, and keeps it when that launch stays up", async () => {
		await keepsDying(await launchWith(iGpu("27.20.100.9466")));
		// The software launch after the update sees the new driver.
		await launchWith(iGpu("31.0.101.5186"));
		expect(electron.softwareCalls).toBe(1);
		const trial = await launchWith(iGpu("31.0.101.5186"));
		expect(electron.softwareCalls).toBe(1);
		expect(readLog()).toContain("trying hardware acceleration again (driver-changed)");
		await trial.confirmHardwareTrial();
		expect(readLog()).toContain("hardware acceleration works again");
		await launchWith(iGpu("31.0.101.5186"));
		expect(electron.softwareCalls).toBe(1);
	});

	it("tries hardware once only: a trial launch that ends without a verdict leaves the next one in software", async () => {
		await keepsDying(await launchWith(iGpu("27.20.100.9466")));
		await launchWith(iGpu("31.0.101.5186"));
		await launchWith(iGpu("31.0.101.5186")); // the trial, closed before it proved anything
		await launchWith(iGpu("31.0.101.5186"));
		expect(electron.softwareCalls).toBe(2);
	});

	it("one crash in the trial goes back to software, without a second relaunch inside the cap", async () => {
		await keepsDying(await launchWith(iGpu("27.20.100.9466")));
		await launchWith(iGpu("31.0.101.5186"));
		const trial = await launchWith(iGpu("31.0.101.5186"));
		await trial.handleGpuProcessGone(crash);
		// The trial's 20 s confirmation still runs: the crash already decided, so the marker stays.
		await trial.confirmHardwareTrial();
		expect(electron.relaunches).toBe(1);
		expect(electron.exits).toBe(1);
		// Back in software with the new driver recorded: the same driver does not try again.
		await launchWith(iGpu("31.0.101.5186"));
		await launchWith(iGpu("31.0.101.5186"));
		expect(electron.softwareCalls).toBe(3);
	});

	it("tries hardware once again after a 7-day cool-off", async () => {
		const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
		writeFileSync(
			join(electron.userData, "gpu-fallback.json"),
			JSON.stringify({ at: eightDaysAgo, reason: "crashed", exitCode: -1, policy: 3 }),
		);
		await launchWith(iGpu("27.20.100.9466"));
		expect(electron.softwareCalls).toBe(0);
		expect(readLog()).toContain("trying hardware acceleration again (cool-off)");
	});
});

describe("one GPU crash is WebView2's to recover", () => {
	it("leaves the first crash of a hardware launch to WebView2: no relaunch, no marker, hardware next time", async () => {
		const gpu = await launchWith(iGpu("27.20.100.9466"));
		await gpu.handleGpuProcessGone(crash);
		expect(electron.relaunches).toBe(0);
		expect(electron.exits).toBe(0);
		expect(readLog()).toContain("WebView2 restarts it and repaints, hardware acceleration stays");
		await launchWith(iGpu("27.20.100.9466"));
		expect(electron.softwareCalls).toBe(0);
	});

	it("a second crash within the cooldown of the first is a GPU that keeps dying: marker and relaunch", async () => {
		await keepsDying(await launchWith(iGpu("27.20.100.9466")));
		expect(electron.relaunches).toBe(1);
		expect(electron.exits).toBe(1);
		await launchWith(iGpu("27.20.100.9466"));
		expect(electron.softwareCalls).toBe(1);
	});

	it("a marker an older policy wrote for a single crash gets one hardware trial under this one", async () => {
		for (const policy of [undefined, 2]) {
			writeFileSync(
				join(electron.userData, "gpu-fallback.json"),
				JSON.stringify({
					at: new Date().toISOString(),
					reason: "crashed",
					exitCode: 34,
					gpu: iGpu("32.0.16.2101"),
					policy,
				}),
			);
			const trial = await launchWith(iGpu("32.0.16.2101"));
			expect(electron.softwareCalls).toBe(0);
			expect(readLog()).toContain("trying hardware acceleration again (policy)");
			await trial.confirmHardwareTrial();
			await launchWith(iGpu("32.0.16.2101"));
			expect(electron.softwareCalls).toBe(0);
		}
	});
});
