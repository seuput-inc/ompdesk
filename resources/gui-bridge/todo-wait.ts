/**
 * Skip stock's stop-time reminder when every unfinished item is written as waiting (todo-wait-core.ts).
 *
 * Stock's `TodoTracker.checkCompletion` has no hook and no setting for this; it decides by what it can read (the open
 * items, a pending async job, a closing question). The one seam is the order of its synchronous start: it reads the
 * session's `getActiveToolNames()` before it counts a reminder, and a list without `todo` makes it reset and return
 * false (stock's own "todo is off" path). So `checkCompletion` is wrapped only to say "the check is running now", and
 * the session's `getActiveToolNames` answers without `todo` once, during that window, when the session waits. Nothing
 * else sees a different list. An upstream option (a host callback or setting the tracker consults) would be cleaner;
 * asked for in https://github.com/can1357/oh-my-pi/issues/19151, and this wrapper goes when stock has one.
 *
 * Feature-detected: an omp without either method keeps stock's reminder (`todoWait` in capabilities.ts).
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { hasPath } from "./capabilities";
import { guard } from "./health";
import * as trackerModule from "./omp/pi-coding-agent/session/todo-tracker";
import { onlyWaitingItems, type PhaseLike } from "./todo-wait-core";

const ORIGINAL = Symbol.for("ompdesk.todo-wait.original");

/** True during the synchronous start of one `checkCompletion` call. */
let checking = false;

interface WaitSession {
	getActiveToolNames(): string[];
	getTodoPhases?(): PhaseLike[];
}

type MethodOf<T> = (this: unknown, ...args: never[]) => T;

function mainSession(pi: ExtensionAPI): unknown {
	return pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
}

/** Wraps `TodoTracker.prototype.checkCompletion` once; false when this omp has no such method. */
function patchTracker(pi: ExtensionAPI): boolean {
	const tracker: unknown = trackerModule.TodoTracker;
	if (!hasPath(tracker, "prototype.checkCompletion()")) {
		pi.logger.warn("gui-bridge: todo wait unavailable, TodoTracker.checkCompletion missing");
		return false;
	}
	const proto: Record<string | symbol, unknown> = Reflect.get(Object(tracker), "prototype");
	if (proto[ORIGINAL]) return true;
	const original = Reflect.get(proto, "checkCompletion") as MethodOf<Promise<boolean>>;
	proto[ORIGINAL] = original;
	proto.checkCompletion = function checkCompletion(this: unknown, ...args: never[]): Promise<boolean> {
		checking = true;
		try {
			// An async method runs synchronously up to its first await, and the tool-list read is before it.
			return original.apply(this, args);
		} finally {
			checking = false;
		}
	};
	return true;
}

/** Wraps the session class's `getActiveToolNames` once (the main session and every subagent share the class). */
function patchSession(pi: ExtensionAPI): void {
	const session = mainSession(pi);
	if (!session) return;
	const proto: Record<string | symbol, unknown> = Object.getPrototypeOf(session);
	if (proto[ORIGINAL]) return;
	const original = Reflect.get(proto, "getActiveToolNames");
	if (typeof original !== "function") {
		pi.logger.warn("gui-bridge: todo wait unavailable, AgentSession.getActiveToolNames missing");
		proto[ORIGINAL] = true;
		return;
	}
	const names = original as MethodOf<string[]>;
	proto[ORIGINAL] = names;
	proto.getActiveToolNames = function getActiveToolNames(this: WaitSession): string[] {
		const active = names.call(this);
		if (!checking) return active;
		checking = false;
		if (!onlyWaitingItems(this.getTodoPhases?.() ?? [])) return active;
		pi.logger.debug("gui-bridge: todo reminder skipped, all open items are waiting");
		return active.filter(name => name !== "todo");
	};
}

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	if (!patchTracker(pi)) return;
	patchSession(pi);
	pi.on("session_start", () => patchSession(pi));
	pi.on("before_agent_start", () => {
		patchSession(pi);
	});
}

/** Hook only; `capabilities` reports the feature when an internal it needs is gone. */
export const methods = guard("todoWait", {});
