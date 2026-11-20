/**
 * Worker thread of the main-thread hang watchdog (built as its own entry,
 * `out/main/hang-watchdog-worker.js`; see `hang-watchdog.ts`). It only watches:
 * a stall is written to the marker file and nothing else happens.
 */
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import {
	createHangDetector,
	createStepRing,
	HANG_MACHINE_MS,
	type HangMarker,
	type HangWorkerData,
	type MainSteps,
	type MainToHangWorkerMessage,
	writeHangMarker,
} from "./hang-watchdog-core";
import { ownFacts, readOwn } from "./machine-state";

function isWorkerData(value: unknown): value is HangWorkerData {
	if (typeof value !== "object" || value === null) return false;
	const data = value as Partial<HangWorkerData>;
	return (
		typeof data.pid === "number" &&
		typeof data.markerPath === "string" &&
		typeof data.timeoutMs === "number" &&
		data.timeoutMs > 0 &&
		typeof data.checkIntervalMs === "number" &&
		data.checkIntervalMs > 0
	);
}

if (!isMainThread && parentPort && isWorkerData(workerData)) {
	const config = workerData;
	const port = parentPort;
	const ring = createStepRing();
	// The steps at the moment of the hang: a recovered stall's rewrite still names the step that stalled.
	let atHang: MainSteps = ring.snapshot();
	let stall = { unresponsiveMs: 0, selfRecovered: false };
	let machine: HangMarker["machine"];
	const record = (): void => {
		try {
			writeHangMarker(config.markerPath, {
				detectedAt: Date.now(),
				pid: config.pid,
				...stall,
				...atHang,
				...(machine ? { machine } : {}),
			});
		} catch {
			// Best effort: a marker that cannot be written must not stop the watchdog.
		}
	};
	const detector = createHangDetector({
		timeoutMs: config.timeoutMs,
		checkIntervalMs: config.checkIntervalMs,
		now: () => Date.now(),
		onHang: unresponsiveMs => {
			atHang = ring.snapshot();
			stall = { unresponsiveMs, selfRecovered: false };
			machine = undefined;
			record();
			// Main's thread is stuck, so this one says how the computer stands: memory now, and over the next second
			// how busy the processors are and how much of them this process takes (little: main waits on something).
			const before = readOwn();
			setTimeout(() => {
				machine = ownFacts(readOwn(), before);
				record();
			}, HANG_MACHINE_MS).unref();
		},
		// Rewriting the marker keeps one record per stall.
		onResolved: unresponsiveMs => {
			stall = { unresponsiveMs, selfRecovered: true };
			record();
		},
	});
	const timer = setInterval(() => detector.tick(), config.checkIntervalMs);
	port.on("message", (message: MainToHangWorkerMessage) => {
		if (message.type === "heartbeat") detector.heartbeat();
		else if (message.type === "step") ring.enter(message.phase, message.step);
		else if (message.type === "resume") detector.reset();
		else {
			clearInterval(timer);
			port.close();
		}
	});
}
