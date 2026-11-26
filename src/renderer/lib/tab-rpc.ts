import { useMemo } from "react";
import { createSessionRpcClient, type SessionRpcClient } from "../../shared/rpc-client";
import { activeTabCommand, focusedSessionRuntime, useSessionRuntime } from "../stores/session-runtime-context";

export type TabRpc = SessionRpcClient;
export const createTabRpc = createSessionRpcClient;

export function useTabRpc(): TabRpc {
	const runtime = useSessionRuntime();
	return useMemo(() => {
		if (runtime) return createTabRpc(runtime.command);
		return typeof window !== "undefined" && window.omp?.rpc ? window.omp.rpc : createTabRpc(activeTabCommand);
	}, [runtime]);
}

/** Capture the selected task once for an imperative action, before its first await. */
export function focusedTabRpc(): TabRpc {
	const runtime = focusedSessionRuntime();
	return runtime ? createTabRpc(runtime.command) : window.omp.rpc;
}

/**
 * The tab's client for one repository inside its folder (`repo`, relative), when the folder holds several checkouts:
 * every command carries `repo`, and main runs the Changes panel's git there (local/git.ts `NESTED_COMMANDS`).
 */
export function repoRpc(rpc: TabRpc, repo: string): TabRpc {
	return createTabRpc((command, timeoutMs) => rpc.command(Object.assign({}, command, { repo }), timeoutMs));
}
