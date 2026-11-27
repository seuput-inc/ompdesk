/**
 * Main's last-resort failure lines: an exception nothing caught and a rejection nothing handled.
 *
 * Once the quit (or the shell's end) shut the core down, every call into it is refused (`isCoreShutdown`), and the
 * timers, listeners and promise chains still running reach it from dozens of places. The 0.134.0 quit logged 6,175 of
 * those refusals as `main-unhandled-rejection` in 0.23 s and then died of one more as `main-uncaught`, before the quit
 * waited for its omps and its core. Such a call has nothing left to do, so the refusal is handled here, once for every
 * caller: one `core-shutdown` line naming the caller (its stack reaches past the hub, `shutdownRefusal`), whose
 * repeats the runtime log folds into a count.
 *
 * A hub call main gave up (`isHubGivenUp`: the core was silent past the call's bound, and lives) that its caller did
 * not catch is no reason to end main either: ending main ends every session, while the throw cut off one timer tick or
 * listener. It is one `hub` line naming the call (its message starts with the method) and the caller's stack, counted
 * for the diagnostics report (`cutOffCallers`). The callers on a timer catch it themselves; this is the backstop. Any
 * other failure is logged and ends main as Node would.
 */
import { isCoreShutdown, isHubGivenUp } from "./core/process";
import type { RuntimeLogReport } from "./runtime-log-core";

/** The process events this installs on (Node's `process`; a test hands an emitter). */
export interface MainProcess {
	on(event: "uncaughtExceptionMonitor", listener: (error: Error, origin: string) => void): unknown;
	on(event: "uncaughtException", listener: (error: Error, origin: string) => void): unknown;
	on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
	exit(code: number): never;
}

function errorMessage(value: unknown): { message: string; stack?: string } {
	if (value instanceof Error) return { message: value.message, stack: value.stack };
	if (typeof value === "string") return { message: value };
	try {
		return { message: JSON.stringify(value) ?? String(value) };
	} catch {
		return { message: String(value) };
	}
}

let cutOff = 0;

/** How many callers a given-up hub call cut off since main started (diagnostics.ts). */
export function cutOffCallers(): number {
	return cutOff;
}

export function installMainFailureLogging(target: MainProcess, write: (report: RuntimeLogReport) => void): void {
	const refused = (error: unknown) => write({ source: "core-shutdown", ...errorMessage(error) });
	const cut = (error: unknown, origin: string) => {
		cutOff++;
		write({ source: "hub", ...errorMessage(error), details: { cutOff: origin, code: "hub_unknown" } });
	};
	target.on("uncaughtExceptionMonitor", (error, origin) => {
		if (!isCoreShutdown(error) && !isHubGivenUp(error))
			write({ source: "main-uncaught", ...errorMessage(error), details: { origin } });
	});
	target.on("uncaughtException", (error, origin) => {
		if (isCoreShutdown(error)) {
			refused(error);
			return;
		}
		if (isHubGivenUp(error)) {
			cut(error, origin);
			return;
		}
		// What Node does with no listener: the stack on stderr, exit code 1.
		console.error(error);
		target.exit(1);
	});
	target.on("unhandledRejection", reason => {
		if (isCoreShutdown(reason)) refused(reason);
		else if (isHubGivenUp(reason)) cut(reason, "unhandledRejection");
		else write({ source: "main-unhandled-rejection", ...errorMessage(reason) });
	});
}
