import { describe, expect, it, vi } from "vitest";
import { IPC_COMMANDS } from "../../shared/ipc-types";
import { type IpcCaller, IpcRegistry } from "../web/ipc-registry";
import { registerToolsIpc } from "./ipc";

const CALLER: IpcCaller = { win: null, browserWindow: null, sender: { id: 1, once: () => {} } };

function registered() {
	const channels: string[] = [];
	const ipc = new IpcRegistry({ handle: channel => channels.push(channel), on: () => {} });
	const tools = {
		setupGitAslr: vi.fn(async () => ({ ok: true as const, images: 3 })),
	};
	registerToolsIpc(ipc, tools);
	const call = (channel: string, ...args: unknown[]) => ipc.invoke(channel, CALLER, args);
	return { tools, call, channels };
}

describe("tools IPC", () => {
	it("serves only setup:git-aslr in main (the other 9 setup/updater channels route directly to ompdesk-core)", () => {
		expect(registered().channels).toEqual([IPC_COMMANDS.SETUP_GIT_ASLR]);
	});

	it("passes only fix or undo to the Git ASLR step", async () => {
		const { call, tools } = registered();
		expect(await call(IPC_COMMANDS.SETUP_GIT_ASLR, "undo")).toEqual({ ok: true, images: 3 });
		for (const value of ["Fix", "system", { action: "fix" }, undefined]) {
			await expect(call(IPC_COMMANDS.SETUP_GIT_ASLR, value)).rejects.toThrow(/Unknown Git ASLR action/);
		}
		expect(tools.setupGitAslr.mock.calls).toEqual([["undo"]]);
	});
});
