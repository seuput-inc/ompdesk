import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { CoreError, core } from "./core/process";
import { cutOffCallers, installMainFailureLogging } from "./main-failures";
import type { RuntimeLogReport } from "./runtime-log-core";

const v8Default = Error.stackTraceLimit;

afterEach(() => {
	Error.stackTraceLimit = v8Default;
});

function fakeMain() {
	const exits: number[] = [];
	const target = Object.assign(new EventEmitter(), {
		exit: (code: number): never => {
			exits.push(code);
			throw new Error(`exit ${code}`);
		},
	});
	const lines: RuntimeLogReport[] = [];
	installMainFailureLogging(target, report => lines.push(report));
	return { target, exits, lines };
}

// Deeper than V8's ten frames with the core's own on top, as the pool's #call → Hub.callOnce → Hub.open → … was.
function a(n: number): void {
	if (n === 0) core().hubEndpoint();
	else a(n - 1);
}
function persistLayoutsAfterQuit(): void {
	a(9);
}

function refusal(): unknown {
	try {
		persistLayoutsAfterQuit();
	} catch (error) {
		return error;
	}
	throw new Error("the core did not refuse");
}

it("handles calls into the core after the quit shut it down, each naming its caller, without ending main", async () => {
	Error.stackTraceLimit = 10;
	await core().shutdown();
	const { target, exits, lines } = fakeMain();

	for (let i = 0; i < 3; i++) target.emit("unhandledRejection", refusal());
	const thrown = refusal();
	target.emit("uncaughtExceptionMonitor", thrown, "uncaughtException");
	target.emit("uncaughtException", thrown, "uncaughtException");

	expect(exits).toEqual([]);
	expect(lines.map(line => line.source)).toEqual(Array(4).fill("core-shutdown"));
	expect(lines[0]?.message).toBe("ompdesk-core is shutting down");
	expect(lines[0]?.stack).toContain("persistLayoutsAfterQuit");
});

it("logs any other failure as before, and an uncaught one still ends main", () => {
	const { target, exits, lines } = fakeMain();
	const failure = new Error("something else broke");
	const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);

	target.emit("unhandledRejection", failure);
	target.emit("uncaughtExceptionMonitor", failure, "uncaughtException");
	expect(() => target.emit("uncaughtException", failure, "uncaughtException")).toThrow("exit 1");
	quiet.mockRestore();

	expect(exits).toEqual([1]);
	expect(lines.map(line => [line.source, line.message])).toEqual([
		["main-unhandled-rejection", "something else broke"],
		["main-uncaught", "something else broke"],
	]);
});

it("keeps main up when a hub call main gave up escapes a timer or a promise, each logged once with the call and the caller", () => {
	const { target, exits, lines } = fakeMain();
	const before = cutOffCallers();
	// What ConnectivityMonitor.poll's interval threw on a starved CI runner before it caught it (run 45866211067).
	function pollTick(): never {
		throw new CoreError("hub_unknown", "poll: the hub did not answer, so the call was given up");
	}
	let thrown: unknown;
	try {
		pollTick();
	} catch (error) {
		thrown = error;
	}
	target.emit("uncaughtExceptionMonitor", thrown, "uncaughtException");
	target.emit("uncaughtException", thrown, "uncaughtException");
	target.emit("unhandledRejection", thrown);

	expect(exits).toEqual([]);
	expect(lines.map(line => [line.source, line.message])).toEqual([
		["hub", "poll: the hub did not answer, so the call was given up"],
		["hub", "poll: the hub did not answer, so the call was given up"],
	]);
	expect(lines[0]?.stack).toContain("pollTick");
	expect(cutOffCallers()).toBe(before + 2);
});
