/**
 * Delegation strength (the composer's delegation chip) wired to stock omp:
 * rules in ./delegation-core.ts, values in ./delegation-contracts.ts.
 *
 * - Spawn: main passes the strength new tabs start with in
 *   `OMP_GUI_DELEGATION`; index.ts awaits `applyGuiDelegation` inside the
 *   extension factory, like the thinking default, so the first session's
 *   system prompt and tool set already follow it.
 * - Live: `modes.set_delegation` re-holds the overrides on the session's
 *   Settings; stock's own listeners rebuild the prompt (`task.eager`) and add
 *   or remove the task tool (`task.maxRecursionDepth`) from the next turn.
 * - Subagents snapshot the effective values through stock's
 *   `createSubagentSettings`.
 * - Stock's settings registry loads where a strength is held or released: settings.ts imports this module, and a
 *   static import would tie every settings action to the registry at link time.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { guard } from "../health";
import type { BridgeMethods } from "../types";
import { isDelegationMode } from "./delegation-contracts";
import {
	applyDelegation,
	asDelegationSetting,
	type DelegationHandles,
	heldDelegation,
	releaseDelegationFor,
} from "./delegation-core";
import { attach, record } from "./shared";

async function handles(): Promise<DelegationHandles> {
	const { lookup } = await import("../omp/pi-coding-agent/config/registry");
	return id => asDelegationSetting(lookup(id));
}

/** Before the first session: hold the strength main asked for at spawn, if any. */
export async function applyGuiDelegation(pi: ExtensionAPI): Promise<void> {
	const mode = process.env.OMP_GUI_DELEGATION;
	if (!mode || mode === "default") return;
	if (!isDelegationMode(mode)) {
		pi.logger.warn("gui-bridge: unknown delegation strength", { mode });
		return;
	}
	applyDelegation(await handles(), pi.pi.Settings.instance, mode);
}

/** A Settings write of `settingId` is the user's choice: drop a strength that holds it. */
export async function releaseDelegationForWrite(settingId: string, scope: object): Promise<void> {
	releaseDelegationFor(settingId, scope, await handles());
}

export const methods: BridgeMethods = guard("delegation", {
	"modes.get_delegation": async (_params, env) => ({
		mode: heldDelegation(attach(env).settings as unknown as object),
	}),
	"modes.set_delegation": async (params, env) => {
		const mode = record(params).mode;
		if (!isDelegationMode(mode)) throw new Error("set_delegation needs {mode: DelegationMode}");
		return { mode: applyDelegation(await handles(), attach(env).settings as unknown as object, mode) };
	},
});
