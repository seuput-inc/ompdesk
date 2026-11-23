/**
 * Session-bound commands use the gui-bridge. For plugin doctor and the update check, the core
 * runs the resolved stock CLI. `ompUpdateEnv` points stock at this install and its registry.
 * Installing stays with the computer's OmpUpdater, including on a paired host.
 */
import type { RpcOmpUpdateResult, RpcPluginDoctorResult } from "../../shared/rpc-types";
import { clearAgentWorktrees, listAgentWorktrees, type OmpCliLaunch } from "../agent-worktrees";
import { CoreError, core } from "../core/process";
import { ompRunEnv, ompUpdateEnv } from "../omp-runtime";
import { spawnPath } from "../shell-env";
import { type LocalCommandContext, LocalCommandError, type LocalHandler } from "./types";

function ompLaunch({ omp }: LocalCommandContext, action: string, env?: Record<string, string>): OmpCliLaunch {
	if (omp.basePath === undefined) throw new Error(`No resolved omp launcher for ${action}`);
	return { bin: omp.bin, env: ompRunEnv(omp.bin, omp.basePath, env) };
}

async function ompFact(method: "omp.pluginDoctor" | "omp.checkUpdate", ctx: LocalCommandContext) {
	const env = method === "omp.checkUpdate" ? ompUpdateEnv(ctx.omp.bin, await spawnPath()) : undefined;
	const launch = ompLaunch(ctx, method, env);
	try {
		// Stock has 60 seconds. Leave the core time to return its own timeout.
		const { result } = await core().call<RpcOmpUpdateResult | RpcPluginDoctorResult>(
			method,
			{ ...launch, cwd: ctx.cwd },
			{ timeoutMs: 70_000 },
		);
		return result;
	} catch (error) {
		if (error instanceof CoreError && (error.code === "doctor_failed" || error.code === "update_check_failed")) {
			throw new LocalCommandError(error.message, error.code);
		}
		throw error;
	}
}

/** Forward to a gui-bridge method with the command's own fields as params. */
function viaBridge(method: string): LocalHandler {
	return ({ type: _type, id: _id, ...params }, ctx) => ctx.bridge.request(method, params);
}

export const handlers: Record<string, LocalHandler> = {
	project_ask_form: viaBridge("project_ask_form"),
	transcribe_audio: viaBridge("transcribe_audio"),
	synthesize_speech: viaBridge("synthesize_speech"),
	stt_prepare: viaBridge("stt_prepare"),
	debug: viaBridge("debug"),
	// Preview panel agent browsing: stock's browser relay inside this tab's omp (gui-bridge browser-relay.ts).
	browser_relay_start: viaBridge("browser.relay_start"),
	browser_relay_stop: viaBridge("browser.relay_stop"),
	get_security_dashboard: viaBridge("security_dashboard"),
	get_security_scan: viaBridge("security_scan"),
	security_start: viaBridge("security_start"),
	security_cancel: viaBridge("security_cancel"),
	security_set_disposition: viaBridge("security_set_disposition"),
	security_validate: async (command, ctx) => {
		const { prompt } = await ctx.bridge.request<{ prompt: string }>("security_validation_prompt", {
			scanId: command.scanId,
			findingId: command.findingId,
		});
		// A normal user turn; while the agent streams it queues as a follow-up (fork parity).
		await ctx.send({ type: "prompt", message: prompt, streamingBehavior: "followUp" });
		return { accepted: true };
	},
	get_ssh_hosts: viaBridge("ssh_hosts"),
	ssh_manage: viaBridge("ssh_manage"),
	ssh_test: viaBridge("ssh_test"),
	get_omp_update: (_command, ctx) => ompFact("omp.checkUpdate", ctx),
	get_plugin_doctor: (_command, ctx) => ompFact("omp.pluginDoctor", ctx),
	// Agent-managed worktrees under ~/.omp/wt (stock `omp worktree list|clear --json`, orphaned only).
	get_agent_worktrees: (_command, ctx) => listAgentWorktrees(ompLaunch(ctx, "worktrees"), ctx.cwd),
	clear_agent_worktrees: (_command, ctx) => clearAgentWorktrees(ompLaunch(ctx, "worktrees"), ctx.cwd),
};
