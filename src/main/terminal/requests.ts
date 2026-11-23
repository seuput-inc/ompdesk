/**
 * Terminal operations against the stock helper's PTYs (stock `PtySession`), shared by this
 * machine's Terminal IPC (`ipc.ts`) and a paired device's tab served here (`remote/host-services.ts`).
 */
import {
	TERMINAL_OUTPUT_BUDGET,
	TERMINAL_POLL_MAX_WAIT_MS,
	type TerminalOperation,
	type TerminalSnapshot,
} from "../../shared/terminal-types";
import { stockHelperRequest } from "../stock-helper";

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
		value.action === "close" || value.action === "restart" || value.action === "clear" || value.action === "claim"
	);
}

type TerminalOwner = string | { deviceId: string; rtab: string };

/**
 * One operation on `owner`'s terminals, a new one started in `cwd` with `env` over the worker's own (the control
 * socket's variables, `controlEnvFor`: a terminal of a tab run for another device is told control is off).
 */
export function terminalRequest(
	owner: TerminalOwner,
	cwd: string,
	operation: TerminalOperation,
	env: Record<string, string>,
	viewer?: number,
): Promise<TerminalSnapshot[]> {
	if (!validTerminalOperation(operation)) return Promise.reject(new Error("Invalid terminal operation"));
	if (viewer !== undefined)
		return stockHelperRequest<TerminalSnapshot[]>("terminal.viewerRequest", {
			owner,
			cwd,
			operation,
			env,
			viewer,
			now: Date.now(),
		});
	const method =
		operation.action === "create" && operation.shell
			? "terminal.create"
			: typeof owner === "string"
				? "terminal.request"
				: "terminal.peerRequest";
	return stockHelperRequest<TerminalSnapshot[]>(method, { owner, cwd, operation, env });
}

export function disposeTerminals(owner: TerminalOwner): void {
	void stockHelperRequest(typeof owner === "string" ? "terminal.dispose" : "terminal.peerDispose", { owner }).catch(
		() => {},
	);
}
