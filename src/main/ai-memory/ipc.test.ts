import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiMemoryState } from "../../shared/ai-memory";
import { IPC_COMMANDS } from "../../shared/ipc-types";
import { prepareShellPolicyFixture, type ShellPolicyFixture, shellPolicyFixture } from "../shell-policy-test-rig";
import { type IpcCaller, IpcRegistry } from "../web/ipc-registry";
import { type AiMemoryIpcDeps, registerAiMemoryIpc } from "./ipc";
import type { AiMemoryService } from "./service";

const CALLER: IpcCaller = { win: null, browserWindow: null, sender: { id: 1, once: () => {} } };

type Service = Parameters<typeof registerAiMemoryIpc>[1];

function setup(webUrl: string | null = "http://127.0.0.1:49374/web") {
	const service = {
		state: vi.fn(() => ({ webUrl, dataDir: "/data/ai-memory" }) as AiMemoryState),
		refresh: vi.fn(async () => {}),
		retry: vi.fn(async () => {}),
		purge: vi.fn(async () => {}),
		setTerminal: vi.fn(async (_enabled: boolean) => {}),
		token: vi.fn(async () => "tok" as string | null),
	} satisfies Service;
	const deps = {
		openExternal: vi.fn(async (_url: string) => {}),
		openPath: vi.fn(async (_path: string) => ""),
		copyPassword: vi.fn<(text: string) => Promise<void>>(),
		care: () => null,
	} satisfies AiMemoryIpcDeps;
	const ipc = new IpcRegistry({ handle: () => {}, on: () => {} });
	registerAiMemoryIpc(ipc, service as unknown as AiMemoryService, deps);
	const call = (channel: string, ...args: unknown[]) => ipc.invoke(channel, CALLER, args);
	return { service, deps, call };
}

describe("ai-memory IPC", () => {
	it("get-state refreshes in the background and returns the snapshot", async () => {
		const { service, call } = setup();
		expect(await call(IPC_COMMANDS.AI_MEMORY_GET_STATE)).toMatchObject({ dataDir: "/data/ai-memory" });
		expect(service.refresh).toHaveBeenCalledOnce();
	});

	it("a failing background refresh never fails get-state", async () => {
		const { service, call } = setup();
		service.refresh.mockRejectedValueOnce(new Error("down"));
		await expect(call(IPC_COMMANDS.AI_MEMORY_GET_STATE)).resolves.toBeDefined();
	});

	it("retry returns before the work ends and swallows its failure", async () => {
		const { service, call } = setup();
		service.retry.mockRejectedValueOnce(new Error("boom"));
		await expect(call(IPC_COMMANDS.AI_MEMORY_RETRY)).resolves.toBeUndefined();
	});

	it("set-terminal takes only a boolean and passes the service's refusal through", async () => {
		const { service, call } = setup();
		for (const bad of ["true", 1, null, undefined, {}]) {
			await expect(call(IPC_COMMANDS.AI_MEMORY_SET_TERMINAL, bad)).rejects.toThrow("Invalid argument: enabled");
		}
		expect(service.setTerminal).not.toHaveBeenCalled();
		await call(IPC_COMMANDS.AI_MEMORY_SET_TERMINAL, true);
		await call(IPC_COMMANDS.AI_MEMORY_SET_TERMINAL, false);
		expect(service.setTerminal.mock.calls).toEqual([[true], [false]]);
		service.setTerminal.mockRejectedValueOnce(new Error("ai-memory is not managed by this build."));
		await expect(call(IPC_COMMANDS.AI_MEMORY_SET_TERMINAL, true)).rejects.toThrow("not managed by this build");
	});

	it("purge passes the service's refusal through to the caller", async () => {
		const { service, call } = setup();
		service.purge.mockRejectedValueOnce(new Error("Purge failed: refusing"));
		await expect(call(IPC_COMMANDS.AI_MEMORY_PURGE)).rejects.toThrow("Purge failed: refusing");
		await expect(call(IPC_COMMANDS.AI_MEMORY_PURGE)).resolves.toBeUndefined();
	});

	describe("open-web", () => {
		it("opens the loopback console", async () => {
			const { deps, call } = setup("http://127.0.0.1:49374/web");
			await call(IPC_COMMANDS.AI_MEMORY_OPEN_WEB);
			expect(deps.openExternal).toHaveBeenCalledWith("http://127.0.0.1:49374/web");
			const localhost = setup("http://localhost:1/web");
			await localhost.call(IPC_COMMANDS.AI_MEMORY_OPEN_WEB);
			expect(localhost.deps.openExternal).toHaveBeenCalledOnce();
		});

		it("refuses a non-loopback host, a non-http scheme, and a missing URL", async () => {
			for (const url of [
				"http://192.168.1.5:49374/web",
				"http://example.com/web",
				"https://127.0.0.1:49374/web",
				"file:///etc/passwd",
				"http://127.0.0.1.evil.test/web",
			]) {
				const { deps, call } = setup(url);
				await expect(call(IPC_COMMANDS.AI_MEMORY_OPEN_WEB)).rejects.toThrow("Refusing to open a non-local address");
				expect(deps.openExternal).not.toHaveBeenCalled();
			}
			await expect(setup(null).call(IPC_COMMANDS.AI_MEMORY_OPEN_WEB)).rejects.toThrow("Memory is not running");
		});
	});

	describe("copy-web-password", () => {
		let fixture: ShellPolicyFixture;
		beforeAll(prepareShellPolicyFixture, 180_000);
		beforeEach(async () => {
			fixture = await shellPolicyFixture();
		});
		afterEach(async () => {
			await fixture?.close();
		});

		function copySetup() {
			const rig = setup();
			rig.deps.copyPassword.mockImplementation(text => fixture.call<void>("clipboard.writePassword", { text }));
			return {
				...rig,
				clipboard: () => fixture.call<string>("clipboard.read"),
				advance: (ms: number) => fixture.call("clipboard.advance", { ms }),
			};
		}

		it("puts the token on the clipboard and clears it after the timeout when unchanged", async () => {
			const { call, clipboard, advance } = copySetup();
			await call(IPC_COMMANDS.AI_MEMORY_COPY_WEB_PASSWORD);
			expect(await clipboard()).toBe("tok");
			await advance(59_000);
			expect(await clipboard()).toBe("tok");
			await advance(1_000);
			expect(await clipboard()).toBe("");
		});

		it.each(["something the user copied", "tok"])("leaves another app's copy of %j alone", async text => {
			const { call, clipboard, advance } = copySetup();
			await call(IPC_COMMANDS.AI_MEMORY_COPY_WEB_PASSWORD);
			await fixture.call("clipboard.replace", { text });
			await advance(120_000);
			expect(await clipboard()).toBe(text);
		});

		it("gives a second copy of the same password its full lifetime", async () => {
			const { call, clipboard, advance } = copySetup();
			await call(IPC_COMMANDS.AI_MEMORY_COPY_WEB_PASSWORD);
			await advance(59_000);
			await call(IPC_COMMANDS.AI_MEMORY_COPY_WEB_PASSWORD);
			await advance(1_000);
			expect(await clipboard()).toBe("tok");
			await advance(59_000);
			expect(await clipboard()).toBe("");
		});

		it("refuses while there is no token yet and writes nothing", async () => {
			const { service, call, clipboard } = copySetup();
			service.token.mockResolvedValueOnce(null);
			await expect(call(IPC_COMMANDS.AI_MEMORY_COPY_WEB_PASSWORD)).rejects.toThrow("Memory has no token yet");
			expect(await clipboard()).toBe("");
		});
	});

	describe("reveal-data", () => {
		it("opens the data dir and turns a failure string into an error", async () => {
			const { deps, call } = setup();
			await call(IPC_COMMANDS.AI_MEMORY_REVEAL_DATA);
			expect(deps.openPath).toHaveBeenCalledWith("/data/ai-memory");
			deps.openPath.mockResolvedValueOnce("no such folder");
			await expect(call(IPC_COMMANDS.AI_MEMORY_REVEAL_DATA)).rejects.toThrow("no such folder");
		});
	});
});
