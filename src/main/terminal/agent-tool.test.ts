import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { codedError } from "../../shared/ipc-error-codes";
import type { TerminalOperation, TerminalSnapshot } from "../../shared/terminal-types";
import { TERMINAL_READ_DEFINITION } from "./agent-tool";
import { readTabTerminals } from "./ipc";
import { terminalTestHelper } from "./test-helper";

const tab = { tabId: "t", webContentsId: 1, device: "host", cwd: "/" };

describe("gui_terminal_read", () => {
	it("reads only the chosen PTY's plain-text tail, without cutting a requested line", async ({ onTestFinished }) => {
		const dir = await mkdtemp(join(tmpdir(), "terminal-read-"));
		const helper = await terminalTestHelper(dir);
		onTestFinished(async () => {
			try {
				await helper.stop();
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		});
		const tabArgs = { owner: "tab", cwd: dir, env: {} };
		const request = (operation: TerminalOperation) =>
			helper.request<TerminalSnapshot[]>("terminal.request", { ...tabArgs, operation });
		const read = (pick: string) =>
			helper.request<string | null>("terminal.request", {
				...tabArgs,
				operation: { action: "list" },
				read: { pick, lines: 2 },
			});

		expect(await read("1")).toBeNull();
		const [{ id: first }] = await request({ action: "create", cols: 80, rows: 24 });
		const [, { id: second }] = await request({ action: "create", cols: 80, rows: 24 });
		const header = "Terminal 1: running\nTerminal 2: running\n\n";
		const longLine = "x".repeat(100_000);
		await request({ action: "write", id: second, data: longLine });
		await request({
			action: "write",
			id: first,
			data: "$ npm test\r\nprogress 10%\r\x1b[31mFAIL\x1b[0m \ud800\r\r\n\u0085\r\n\ufeff\u00a0\n",
		});
		expect(await read("1")).toBe(`${header}Terminal 1, last 2 of 3 lines:\nFAIL \ud800\n\u0085`);
		expect(await read("2")).toBe(`${header}Terminal 2, 1 lines:\n${longLine}`);
		expect(await read("1e+21")).toBe(`${header}There is no terminal 1e+21.`);
		await request({ action: "clear", id: first });
		expect(await read("1")).toBe(`${header}Terminal 1, 0 lines:\n`);
	});

	it("requests text from a paired host and lists snapshots only for an unsupported read", async () => {
		const body = "finished 😀\ud800";
		const text = `Terminal 1: exited 0\nTerminal 2: exited ?\nTerminal 3: failed: launch\n\nTerminal 1, 1 lines:\n${body}`;
		const readCall = ["host", "terminal.read", { rtab: "t", read: { pick: "1", lines: 200 } }];
		const request = vi.fn().mockResolvedValueOnce(text);
		expect(await readTabTerminals({ request }, tab, {})).toBe(text);
		expect(request.mock.calls).toEqual([readCall]);

		request.mockClear();
		const rows: TerminalSnapshot[] = [
			{ id: "a", output: `${body}\r\n`, offset: body.length + 2, exited: true, exitCode: 0 },
			{ id: "b", output: "", offset: 0, exited: true },
			{ id: "c", output: "", offset: 0, exited: true, error: "launch" },
		];
		request
			.mockRejectedValueOnce(codedError("unsupported", "Unknown method terminal.read"))
			.mockResolvedValueOnce(rows);
		expect(await readTabTerminals({ request }, tab, {})).toBe(text);
		expect(request.mock.calls).toEqual([
			readCall,
			["host", "terminal.request", { rtab: "t", operation: { action: "list" } }],
		]);
	});

	it("propagates other paired-host errors without requesting output again", async () => {
		const error = new Error("connection closed");
		const request = vi.fn().mockRejectedValue(error);
		await expect(readTabTerminals({ request }, tab, {})).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("is registered read-only with a JSON schema stock accepts", () => {
		expect(TERMINAL_READ_DEFINITION.name).toBe("gui_terminal_read");
		expect(TERMINAL_READ_DEFINITION.parameters).toMatchObject({ type: "object", additionalProperties: false });
	});
});
