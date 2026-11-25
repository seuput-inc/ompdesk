/**
 * Terminal operations against the stock helper's PTYs (stock `PtySession`), shared by this
 * machine's Terminal IPC (`ipc.ts`) and a paired device's tab served here (`remote/host-services.ts`).
 */
import {
	TERMINAL_OUTPUT_BUDGET,
	TERMINAL_POLL_MAX_WAIT_MS,
	type TerminalOperation,
	type TerminalRead,
	type TerminalSnapshot,
} from "../../shared/terminal-types";
import { stockHelperRequest } from "../stock-helper";
import { restoreTerminals, terminalsQuitting, watchTerminalHistory } from "./history";

export function validTerminalOperation(value: TerminalOperation): boolean {
	if (!value || typeof value !== "object") return false;
	if (value.action === "list") {
		const { offsets, waitMs, budget } = value;
		const offsetsOk =
			offsets === undefined ||
			(typeof offsets === "object" &&
				offsets !== null &&
				Object.values(offsets).every(offset => Number.isSafeInteger(offset) && offset >= 0));
		const waitOk =
			waitMs === undefined || (Number.isInteger(waitMs) && waitMs >= 0 && waitMs <= TERMINAL_POLL_MAX_WAIT_MS);
		const budgetOk =
			budget === undefined || (Number.isInteger(budget) && budget > 0 && budget <= TERMINAL_OUTPUT_BUDGET);
		return offsetsOk && waitOk && budgetOk;
	}
	if (value.action !== "create" && typeof value.id !== "string") return false;
	if (value.action === "create" && value.shell !== undefined && typeof value.shell !== "string") return false;
	if (value.action === "create" || value.action === "resize")
		return (
			Number.isInteger(value.cols) &&
			value.cols > 0 &&
			value.cols <= 1000 &&
			Number.isInteger(value.rows) &&
			value.rows > 0 &&
			value.rows <= 1000
		);
	if (value.action === "write") return typeof value.data === "string" && value.data.length <= 1_000_000;
	return (
		value.action === "close" ||
		value.action === "restart" ||
		value.action === "clear" ||
		value.action === "claim" ||
		value.action === "redraw"
	);
}

type TerminalOwner = string | { deviceId: string; rtab: string };

/** Bumped at each disposal of an owner's terminals: a request that was on its way then must not leave one (P89). */
const generations = new Map<string, number>();
/** Each owner's restore of its saved terminals, run once before its first request in this launch. */
const restoring = new Map<string, Promise<void>>();

const ownerKey = (owner: TerminalOwner) => (typeof owner === "string" ? owner : `peer:${owner.deviceId}:${owner.rtab}`);

/**
 * One operation on `owner`'s terminals, a new one started in `cwd` with `env` over the worker's own (the control
 * socket's variables, `controlEnvFor`: a terminal of a tab run for another device is told control is off). `session`
 * is a window tab's session file (null: none yet), which keeps its terminals across a restart (`history.ts`).
 */
export async function terminalRequest(
	owner: TerminalOwner,
	cwd: string,
	operation: TerminalOperation,
	env: Record<string, string>,
	viewer?: number,
	session?: string | null,
): Promise<TerminalSnapshot[]> {
	if (!validTerminalOperation(operation)) throw new Error("Invalid terminal operation");
	const key = ownerKey(owner);
	const generation = generations.get(key) ?? 0;
	// The owner's terminals were let go while this was on its way (its tab closed while the worker started or its
	// history came back): whatever it restored or created goes too.
	const closed = () => {
		if ((generations.get(key) ?? 0) === generation) return false;
		disposeTerminals(owner);
		return true;
	};
	if (typeof owner === "string" && session) {
		let restore = restoring.get(owner);
		if (!restore) {
			restore = restoreTerminals(owner, cwd, env, session);
			restoring.set(owner, restore);
		}
		await restore;
		if (closed()) return [];
		watchTerminalHistory();
	}
	// The worker reads "" as no session file: a JSON null would read as not said on its way through the core.
	const said = session === undefined ? undefined : (session ?? "");
	const method =
		viewer !== undefined
			? "terminal.viewerRequest"
			: operation.action === "create" && operation.shell
				? "terminal.create"
				: typeof owner === "string"
					? "terminal.request"
					: "terminal.peerRequest";
	const result = await stockHelperRequest<TerminalSnapshot[]>(
		method,
		viewer !== undefined
			? { owner, cwd, operation, env, viewer, now: Date.now(), session: said }
			: { owner, cwd, operation, env, session: said },
	);
	return closed() ? [] : result;
}

export function readTerminalOutput(owner: TerminalOwner, cwd: string, read: TerminalRead): Promise<string | null> {
	return stockHelperRequest(typeof owner === "string" ? "terminal.request" : "terminal.peerRequest", {
		owner,
		cwd,
		operation: { action: "list" },
		read,
	});
}

/**
 * Ends `owner`'s terminals; the worker's reader removes their saved history (scrollback can hold secrets). During a
 * quit nothing is ended here: the terminals end with the worker and keep their history for the next launch.
 */
export function disposeTerminals(owner: TerminalOwner): void {
	if (terminalsQuitting()) return;
	const key = ownerKey(owner);
	generations.set(key, (generations.get(key) ?? 0) + 1);
	void stockHelperRequest(typeof owner === "string" ? "terminal.dispose" : "terminal.peerDispose", { owner }).catch(
		() => {},
	);
}
