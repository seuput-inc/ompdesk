import { describe, expect, it, vi } from "vitest";
import type { RpcCommand, RpcResponse } from "../../shared/rpc-types";
import { RpcClient } from "../rpc-client";
import { localHandlerFor, runLocalCommand } from ".";
import type { LocalCommandContext } from "./types";

/** A tab's RpcClient as sidecar.ts builds it: local handlers first, everything else to omp. */
function client() {
	const send = vi.fn(
		async (command: RpcCommand): Promise<RpcResponse> => ({ type: "response", command: command.type, success: true }),
	);
	const rpc = new RpcClient({
		send,
		local: command => {
			const handler = localHandlerFor(command.type);
			return handler ? runLocalCommand(handler, command, {} as LocalCommandContext) : undefined;
		},
	});
	return { rpc, send };
}

describe("the removed Plan and Auto modes on a tab's RpcClient", () => {
	it("refuses turning plan mode on, and every auto mode command, before omp hears them", async () => {
		const { rpc, send } = client();
		const raw = (command: Record<string, unknown>) => rpc.command(command as unknown as RpcCommand);
		await expect(raw({ type: "set_plan_mode", enabled: true })).resolves.toMatchObject({
			success: false,
			code: "mode_removed",
			error: expect.stringMatching(/Plan mode was removed/),
		});
		for (const type of [
			"get_plan_mode",
			"plan_approval",
			"auto_mode_decide",
			"auto_mode_prefetch",
			"auto_mode_undo",
			"auto_mode_end",
		])
			await expect(raw({ type }), type).resolves.toMatchObject({ success: false, code: "mode_removed" });
		expect(send).not.toHaveBeenCalled();
	});

	it("answers plan mode off as already off, so an older client's 'off' still succeeds", async () => {
		const { rpc, send } = client();
		await expect(rpc.command({ type: "set_plan_mode", enabled: false })).resolves.toMatchObject({
			success: true,
			data: { enabled: false },
		});
		expect(send).not.toHaveBeenCalled();
	});
});
