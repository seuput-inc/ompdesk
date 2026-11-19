import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GpuFallback from "./gpu-fallback";

// One fake Electron per test: a "launch" is a fresh import of gpu-fallback.ts over the same userData.
const electron = vi.hoisted(() => ({
	userData: "",
	switches: new Set<string>(),
	relaunches: 0,
	exits: 0,
	softwareCalls: 0,
	/** What `app.getGPUInfo("basic").gpuDevice` answers. */
	gpuDevices: [] as Array<Record<string, unknown>>,
}));

vi.mock("electron", () => ({
	app: {
		getPath: () => electron.userData,
		getVersion: () => "0.0.0-test",
		commandLine: { hasSwitch: (name: string) => electron.switches.has(name) },
		disableHardwareAcceleration: () => {
			electron.softwareCalls++;
		},
		relaunch: () => {
			electron.relaunches++;
		},
		exit: () => {
			electron.exits++;
		},
		getGPUInfo: async () => ({ gpuDevice: electron.gpuDevices }),
	},
}));

const crash = { type: "GPU", reason: "crashed", exitCode: -1073741819 };

/**
 * One launch as index.ts runs it: the launch guard, then the GPU fallback. A fresh module graph per launch, so
 * per-process state never carries over; a static import cannot stand in.
 */
async function launch(): Promise<typeof GpuFallback> {
	vi.resetModules();
	const guard = await import("./launch-guard");
	const gpu = await import("./gpu-fallback");
	const { safeMode } = guard.startLaunchGuard(join(electron.userData, "launch-history.json"));
	gpu.applyGpuFallbackIfNeeded(safeMode);
	return gpu;
}

beforeEach(() => {
	electron.userData = mkdtempSync(join(tmpdir(), "gpu-loop-"));
	electron.switches.clear();
	electron.relaunches = 0;
	electron.exits = 0;
	electron.softwareCalls = 0;
	electron.gpuDevices = [];
});

afterEach(() => {
	rmSync(electron.userData, { recursive: true, force: true });
});

/** A GPU that keeps dying: two crashes of one launch within the 10 minutes. */
function keepsDying(gpu: typeof GpuFallback): void {
	gpu.handleGpuProcessGone(crash);
	gpu.handleGpuProcessGone(crash);
}

describe("a GPU process crash never relaunches the app", () => {
	it("leaves one crash to WebView2: no relaunch, no marker, hardware next time", async () => {
		const gpu = await launch();
		gpu.handleGpuProcessGone(crash);
		expect(electron.relaunches).toBe(0);
		expect(electron.exits).toBe(0);
		expect(readLog()).toContain("WebView2 restarts it, no relaunch (recovers)");
		await launch();
		expect(electron.softwareCalls).toBe(0);
	});

	it("a second crash within 10 minutes leaves the marker: the next launch renders in software, this one goes on", async () => {
		keepsDying(await launch());
		expect(electron.relaunches).toBe(0);
		expect(electron.exits).toBe(0);
		expect(readLog()).toContain("again within 10 minutes: the next launch renders in software");
		const next = await launch();
		expect(electron.softwareCalls).toBe(1);
		// Windows still runs a GPU process for SwiftShader/WARP in software; its crashes change nothing.
		keepsDying(next);
		expect(electron.relaunches).toBe(0);
		expect(readLog()).toContain("no relaunch (software)");
	});

	it("records nothing for a launch started with --disable-gpu or in safe mode", async () => {
		electron.switches.add("disable-gpu");
		keepsDying(await launch());
		electron.switches.clear();
		await launch();
		expect(electron.softwareCalls).toBe(1);

		electron.switches.add("enable-gpu");
		for (let i = 0; i < 3; i++) await launch(); // three launches that never became stable
		const safe = await launch();
		keepsDying(safe);
		expect(readLog()).toContain("no relaunch (safe-mode)");
		expect(electron.relaunches).toBe(0);
	});

	it("a crash in a test launch (OMP_GUI_HEADLESS) follows the same rule and never ends the process the test drives", async () => {
		vi.stubEnv("OMP_GUI_HEADLESS", "1");
		try {
			keepsDying(await launch());
			expect(electron.relaunches).toBe(0);
			expect(electron.exits).toBe(0);
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
async function launchWith(device: Record<string, unknown>): Promise<typeof GpuFallback> {
	electron.gpuDevices = [swiftShader, device];
	const gpu = await launch();
	await gpu.recordGpuIdentity();
	// Same module graph as the launch above (no reset in between).
	(await import("./launch-guard")).markLaunchStable();
	return gpu;
}

function readLog(): string {
	return readFileSync(join(electron.userData, "logs", "gui-runtime.jsonl"), "utf8");
}

describe("hardware acceleration comes back by itself", () => {
	it("stays in software while the driver that crashed is still installed", async () => {
		keepsDying(await launchWith(iGpu("27.20.100.9466")));
		await launchWith(iGpu("27.20.100.9466"));
		await launchWith(iGpu("27.20.100.9466"));
		expect(electron.softwareCalls).toBe(2);
	});

	it("tries hardware once after the driver changed, and keeps it when that launch stays up", async () => {
		keepsDying(await launchWith(iGpu("27.20.100.9466")));
		// The software launch after the update sees the new driver.
		await launchWith(iGpu("31.0.101.5186"));
		expect(electron.softwareCalls).toBe(1);
		const trial = await launchWith(iGpu("31.0.101.5186"));
		expect(electron.softwareCalls).toBe(1);
		expect(readLog()).toContain("trying hardware acceleration again (driver-changed)");
		trial.confirmHardwareTrial();
		expect(readLog()).toContain("hardware acceleration works again");
		await launchWith(iGpu("31.0.101.5186"));
		expect(electron.softwareCalls).toBe(1);
	});

	it("tries hardware once only: a trial launch that ends without a verdict leaves the next one in software", async () => {
		keepsDying(await launchWith(iGpu("27.20.100.9466")));
		await launchWith(iGpu("31.0.101.5186"));
		await launchWith(iGpu("31.0.101.5186")); // the trial, closed before it proved anything
		await launchWith(iGpu("31.0.101.5186"));
		expect(electron.softwareCalls).toBe(2);
	});

	it("one crash in the trial sends the next launch back to software, and the trial goes on", async () => {
		keepsDying(await launchWith(iGpu("27.20.100.9466")));
		await launchWith(iGpu("31.0.101.5186"));
		const trial = await launchWith(iGpu("31.0.101.5186"));
		trial.handleGpuProcessGone(crash);
		expect(readLog()).toContain("in the hardware trial: the next launch renders in software");
		trial.confirmHardwareTrial(); // the crash already decided: the marker stays
		expect(electron.relaunches).toBe(0);
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
			trial.confirmHardwareTrial();
			await launchWith(iGpu("32.0.16.2101"));
			expect(electron.softwareCalls).toBe(0);
		}
	});
});
