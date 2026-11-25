/**
 * The one way this repository's scripts run gh. On Windows a bun script's `gh` is the real gh.exe, not OMPdesk's gh
 * guard (`resources/gui-bridge/gh-bin` has only the sh launcher there: a `gh.cmd` made bun refuse every argument with
 * a cmd.exe special character), so the guard's quota floor is applied here too, with its own rule and the computer's
 * shared reading (`gh-guard.ts` `wideRefusal`): a wide read (a list, paging, a whole run's log, a watch) is refused
 * below the floor, a narrow read or a dispatch always runs.
 */
import { spawnSync } from "node:child_process";
import { wideRefusal } from "../resources/gui-bridge/gh-guard";
import { classify, type GhResource } from "../resources/gui-bridge/gh-guard-core";

export interface GhResult {
	ok: boolean;
	out: string;
	err: string;
}

/** The quota resource a wide call of `args` spends, or undefined for a narrow or free one. */
function wideResource(args: readonly string[]): GhResource | undefined {
	const call = classify(args);
	if (call.kind === "wide" || call.kind === "watch") return call.resource;
	if (call.kind === "log" && call.wide) return "core";
	return undefined;
}

/**
 * The refusal of an agent's wide call while the account's quota is under the floor; undefined when it may run. A
 * person's command (no `PI_TOOL_CALL_ID`, which stock sets only for an agent's tool calls) is never refused, as the
 * guard leaves it alone.
 */
export function wideReadRefusal(args: readonly string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (!env.PI_TOOL_CALL_ID) return undefined;
	const resource = wideResource(args);
	return resource ? wideRefusal(args, resource, "gh", env) : undefined;
}

/** Runs gh; a failure names its cause also when gh never ran (no stderr then: a spawn error or a signal). */
export function gh(args: string[], options: { maxBuffer?: number } = {}): GhResult {
	const refused = wideReadRefusal(args);
	if (refused) return { ok: false, out: "", err: refused };
	const result = spawnSync("gh", args, {
		encoding: "utf8",
		maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
		windowsHide: true,
	});
	if (result.status === 0) return { ok: true, out: result.stdout ?? "", err: "" };
	const err =
		(result.stderr ?? "").trim() ||
		(result.error ? `gh did not run: ${result.error.message}` : "") ||
		(result.signal ? `gh ended by ${result.signal}` : `gh exited ${result.status} with no output`);
	return { ok: false, out: result.stdout ?? "", err };
}
