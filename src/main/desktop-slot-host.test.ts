import { EventEmitter } from "node:events";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { DesktopSlotState } from "../../resources/gui-bridge/desktop-slot-contracts";
import type { RpcCommand, RpcResponse } from "../shared/rpc-types";
import { stopCore } from "./core/process";
import { desktopExitReceipt } from "./desktop-slot-exit";
import { DesktopSlotHost } from "./desktop-slot-host";
import type { DesktopSlotProcess, SidecarLike } from "./sidecar-types";

interface BridgeCall {
	tab: string;
	method: string;
	params: unknown;
}

class FakeSidecar extends EventEmitter {
	device: string | undefined;
	aborted = 0;
	restarts = 0;
	/** The omp process: its exit is what proves the session is gone. */
	readonly exit = Promise.withResolvers<boolean>();
	readonly execution: DesktopSlotProcess;
	/** Whether a restart ends the process (SIGTERM honoured). */
	exitsOnRestart = true;
	readonly rpcClient: { command(command: RpcCommand): Promise<RpcResponse> };
	constructor(
		readonly cwd: string,
		private readonly world: World,
		private readonly tab: string,
	) {
		super();
		this.rpcClient = {
			command: async command => {
				if (command.type === "abort") this.aborted++;
				if (command.type === "desktop_slot_bridge") {
					this.world.calls.push({ tab: this.tab, method: command.method, params: command.params });
					await this.world.revokeGate?.();
					if (command.method === "desktop_slot.revoke" && this.world.revokeFails) {
						return {
							type: "response",
							success: false,
							error: "Timed out revoking computer control",
						} as RpcResponse;
					}
				}
				return { type: "response", success: true } as RpcResponse;
			},
		};
		this.execution = {
			client: this.rpcClient,
			exited: this.exit.promise,
			gone: () => false,
			stop: restart => {
				this.aborted++;
				if (restart) this.restart();
			},
		};
	}

	desktopSlotProcess(): DesktopSlotProcess {
		return this.execution;
	}

	restart(): void {
		this.restarts++;
		if (this.exitsOnRestart) this.exit.resolve(true);
	}

	/** The process exits, then the manager reports it. */
	die(status = "exited"): void {
		this.exit.resolve(true);
		this.emit("status", { status });
	}
}

const hosts = new Set<DesktopSlotHost>();
afterEach(() => {
	for (const host of hosts) host.dispose();
	hosts.clear();
});
afterAll(stopCore);

class World {
	calls: BridgeCall[] = [];
	states: DesktopSlotState[] = [];
	stopped: string[] = [];
	titles = new Map<string, string>();
	revokeGate: (() => Promise<void>) | undefined;
	revokeFails = false;
	readonly host = new DesktopSlotHost({
		killConfirmMs: 50,
		pool: {
			tabFacts: tabId => (this.titles.has(tabId) ? { title: this.titles.get(tabId) ?? "" } : null),
			noteStopped: tabId => this.stopped.push(tabId),
		},
		broadcast: state => this.states.push(state),
	});

	constructor() {
		hosts.add(this.host);
	}

	tab(tabId: string, title: string): FakeSidecar {
		const sidecar = new FakeSidecar(`/work/${tabId}`, this, tabId);
		this.titles.set(tabId, title);
		this.host.attachSidecar(tabId, sidecar as unknown as SidecarLike);
		return sidecar;
	}

	frame(sidecar: FakeSidecar, frame: Record<string, unknown>): void {
		this.host.frame(sidecar as unknown as SidecarLike, { processId: 123, ...frame });
	}
}

const flush = async (): Promise<void> => {
	for (let i = 0; i < 25; i++) await Promise.resolve();
};

describe("DesktopSlotHost", () => {
	it("grants a free slot through the bridge and shows the session by its title", async () => {
		const world = new World();
		const a = world.tab("a", "Fix the build");
		world.frame(a, { type: "desktop_slot_acquire", requestId: "r1" });
		await flush();
		expect(world.calls).toEqual([
			{ tab: "a", method: "desktop_slot.grant", params: { requestId: "r1", waited: false } },
		]);
		expect(world.states.at(-1)?.holder).toMatchObject({ tabId: "a", title: "Fix the build" });
	});

	it("queues a second tab, and grants it as waited once the holder releases", async () => {
		const world = new World();
		const a = world.tab("a", "A");
		const b = world.tab("b", "B");
		world.frame(a, { type: "desktop_slot_acquire", requestId: "r1" });
		world.frame(b, { type: "desktop_slot_acquire", requestId: "r2" });
		await flush();
		expect(world.host.state().queue).toEqual([{ tabId: "b", title: "B" }]);
		expect(world.calls.filter(call => call.tab === "b")).toEqual([]);
		world.frame(a, { type: "desktop_slot_release", reason: "turn_end" });
		await flush();
		expect(world.calls.at(-1)).toEqual({
			tab: "b",
			method: "desktop_slot.grant",
			params: { requestId: "r2", waited: true },
		});
	});

	it("revokes a released (closed) holder's tab before the next session is granted", async () => {
		const world = new World();
		const a = world.tab("a", "A");
		const b = world.tab("b", "B");
		const gate = Promise.withResolvers<void>();
		world.frame(a, { type: "desktop_slot_acquire", requestId: "r1" });
		world.frame(b, { type: "desktop_slot_acquire", requestId: "r2" });
		await flush();
		world.revokeGate = () => gate.promise;
		world.host.observeActivity({ type: "released", tabId: "a" });
		await flush();
		expect(world.calls.at(-1)).toEqual({ tab: "a", method: "desktop_slot.revoke", params: { reason: "closed" } });
		expect(world.calls.filter(call => call.tab === "b")).toEqual([]);
		gate.resolve();
		await flush();
		expect(world.calls.at(-1)).toMatchObject({ tab: "b", method: "desktop_slot.grant" });
	});

	it("drops a holder whose process went away, without a revoke", async () => {
		const world = new World();
		const a = world.tab("a", "A");
		const b = world.tab("b", "B");
		world.frame(a, { type: "desktop_slot_acquire", requestId: "r1" });
		world.frame(b, { type: "desktop_slot_acquire", requestId: "r2" });
		a.die();
		await flush();
		expect(world.calls.some(call => call.method === "desktop_slot.revoke")).toBe(false);
		expect(world.host.state().holder?.tabId).toBe("b");
	});

	it("keeps the slot through a health-check `error` over a live process", async () => {
		const world = new World();
		const a = world.tab("a", "A");
		world.frame(a, { type: "desktop_slot_acquire", requestId: "r1" });
		a.emit("status", { status: "error" });
		expect(world.host.state().holder?.tabId).toBe("a");
	});

	it("stop aborts the holder's run, revokes it and hands the slot on", async () => {
		const world = new World();
		const a = world.tab("a", "A");
		const b = world.tab("b", "B");
		world.frame(a, { type: "desktop_slot_acquire", requestId: "r1" });
		world.frame(b, { type: "desktop_slot_acquire", requestId: "r2" });
		await flush();
		await world.host.stop();
		expect(a.aborted).toBe(1);
		expect(world.stopped).toEqual(["a"]);
		expect(world.calls.map(call => `${call.tab}:${call.method}`)).toEqual([
			"a:desktop_slot.grant",
			"a:desktop_slot.revoke",
			"b:desktop_slot.grant",
		]);
	});

	it("does not hand over when the holder's revoke fails; the process exiting afterwards does", async () => {
		const world = new World();
		const a = world.tab("a", "A");
		const b = world.tab("b", "B");
		world.frame(a, { type: "desktop_slot_acquire", requestId: "r1" });
		world.frame(b, { type: "desktop_slot_acquire", requestId: "r2" });
		await flush();
		world.revokeFails = true;
		await world.host.stop();
		expect(world.host.state().holder).toMatchObject({ tabId: "a", revokeFailed: true });
		expect(world.calls.filter(call => call.tab === "b")).toEqual([]);
		a.die();
		await flush();
		expect(world.host.state().holder?.tabId).toBe("b");
		expect(world.calls.at(-1)).toMatchObject({ tab: "b", method: "desktop_slot.grant" });
	});

	it("does not treat a status change as the holder's death until its process has exited", async () => {
		const world = new World();
		const a = world.tab("a", "A");
		const b = world.tab("b", "B");
		world.frame(a, { type: "desktop_slot_acquire", requestId: "r1" });
		world.frame(b, { type: "desktop_slot_acquire", requestId: "r2" });
		a.emit("status", { status: "ready" });
		a.emit("status", { status: "starting" });
		await flush();
		expect(world.host.state().holder?.tabId).toBe("a");
		a.exit.resolve(true);
		await flush();
		expect(world.host.state().holder?.tabId).toBe("b");
	});

	it("retries the revoke on the user's try-again and frees the slot once it is confirmed", async () => {
		const world = new World();
		const a = world.tab("a", "A");
		world.frame(a, { type: "desktop_slot_acquire", requestId: "r1" });
		await flush();
		world.revokeFails = true;
		await world.host.stop();
		expect(world.host.state().holder?.revokeFailed).toBe(true);
		world.revokeFails = false;
		world.host.retry();
		await flush();
		expect(world.host.state().holder).toBeNull();
	});

	it("kills the failed session's omp and frees the slot only when it has exited", async () => {
		const world = new World();
		const a = world.tab("a", "A");
		const b = world.tab("b", "B");
		world.frame(a, { type: "desktop_slot_acquire", requestId: "r1" });
		world.frame(b, { type: "desktop_slot_acquire", requestId: "r2" });
		await flush();
		world.revokeFails = true;
		await world.host.stop();
		// An omp that ignores the signal is not confirmed gone: the slot stays with it.
		a.exitsOnRestart = false;
		expect(await world.host.killHolder()).toBe(false);
		expect(a.restarts).toBe(1);
		expect(world.host.state().holder?.tabId).toBe("a");
		a.exitsOnRestart = true;
		expect(await world.host.killHolder()).toBe(true);
		expect(world.host.state().holder?.tabId).toBe("b");
	});

	it("keeps a closed owner when revoke and its exit watcher both fail", async () => {
		const world = new World();
		const a = world.tab("a", "A");
		const b = world.tab("b", "B");
		world.frame(a, { type: "desktop_slot_acquire", requestId: "a1" });
		world.frame(b, { type: "desktop_slot_acquire", requestId: "b1" });
		world.revokeFails = true;
		world.host.observeActivity({ type: "released", tabId: "a" });
		a.exit.resolve(false);
		await flush();
		expect(await world.host.killHolder()).toBe(false);
		expect(world.host.state().holder).toMatchObject({ tabId: "a", revokeFailed: true });
		expect(world.calls.some(call => call.tab === "b")).toBe(false);
		world.revokeFails = false;
		world.host.retry();
		await flush();
		expect(world.host.state().holder?.tabId).toBe("b");
	});

	it("never uses an old spawn's late exit to free a replacement in the same tab", async () => {
		const world = new World();
		const old = world.tab("a", "A");
		world.frame(old, { type: "desktop_slot_acquire", requestId: "old" });
		const replacement = world.tab("a", "A");
		world.frame(replacement, { type: "desktop_slot_acquire", requestId: "new" });
		expect(world.calls).toEqual([
			{ tab: "a", method: "desktop_slot.grant", params: { requestId: "old", waited: false } },
		]);
		world.frame(old, { type: "desktop_slot_release" });
		const b = world.tab("b", "B");
		world.frame(b, { type: "desktop_slot_acquire", requestId: "b1" });
		old.exit.resolve(true);
		await flush();
		expect(world.calls.at(-1)).toMatchObject({ tab: "a", params: { requestId: "new", waited: true } });
		expect(world.host.state().queue.map(row => row.tabId)).toEqual(["b"]);
	});

	it("does nothing on stop when nobody holds the slot", async () => {
		const world = new World();
		await world.host.stop();
		expect(world.calls).toEqual([]);
		expect(world.stopped).toEqual([]);
	});

	it("leaves a tab on a paired host to that host's slot", async () => {
		const world = new World();
		const remote = new FakeSidecar("/x", world, "r");
		remote.device = "dev-1";
		world.host.attachSidecar("remote-tab", remote as unknown as SidecarLike);
		remote.emit("status", { status: "exited" });
		expect(world.host.state()).toEqual({ holder: null, queue: [] });
	});

	it("serves a tab this host runs for a paired device, named after its folder", async () => {
		const world = new World();
		const hosted = new FakeSidecar("/work/shared-project", world, "hosted");
		world.frame(hosted, { type: "desktop_slot_acquire", requestId: "h1" });
		await flush();
		expect(world.host.state().holder?.title).toBe("shared-project");
		expect(world.calls).toEqual([
			{ tab: "hosted", method: "desktop_slot.grant", params: { requestId: "h1", waited: false } },
		]);
	});

	it("ignores an acquire without a request id", () => {
		const world = new World();
		const a = world.tab("a", "A");
		world.frame(a, { type: "desktop_slot_acquire" });
		expect(world.host.state().holder).toBeNull();
	});
});

describe("desktop process exit evidence", () => {
	const identity = { launcher: 2, owner: 3, core: 1, wrapped: true };

	it("does not grant the waiter on cmd.exe exit while the bridge process lives or cannot be inspected", async () => {
		const world = new World();
		const a = world.tab("a", "A");
		const b = world.tab("b", "B");
		let body: "present" | "absent" | "unknown" = "present";
		Object.assign(
			a.execution,
			desktopExitReceipt(
				identity,
				a.exit.promise,
				() => false,
				() => body,
			),
		);
		world.frame(a, { type: "desktop_slot_acquire", requestId: "a1" });
		world.frame(b, { type: "desktop_slot_acquire", requestId: "b1" });
		world.revokeFails = true;
		await world.host.stop();
		a.exit.resolve(true);
		await flush();
		for (const state of ["unknown", "present"] as const) {
			body = state; // Access denied, then a live (possibly reused) pid.
			expect(await world.host.killHolder()).toBe(false);
			expect(world.host.state().holder?.tabId).toBe("a");
		}
		body = "absent";
		expect(await world.host.killHolder()).toBe(true);
		expect(world.host.state().holder?.tabId).toBe("b");
	});

	it("requires the original core and both reported processes gone after a broken watch", async () => {
		const present = new Set([1, 2, 3]);
		let replaced = false;
		const receipt = desktopExitReceipt(
			identity,
			Promise.reject(new Error("link lost")),
			() => replaced,
			pid => (present.has(pid) ? "present" : "absent"),
		);
		expect(await receipt.exited).toBe(false);
		present.delete(3);
		expect(receipt.gone()).toBe(false);
		replaced = true;
		present.delete(2);
		expect(receipt.gone()).toBe(false);
		present.delete(1);
		expect(receipt.gone()).toBe(true);
	});

	it("never upgrades a failed wait, an unobserved body, or a wrapper reporting itself into confirmation", async () => {
		let state: "present" | "unknown" | "absent" = "present";
		const failed = desktopExitReceipt(
			identity,
			Promise.resolve(false),
			() => true,
			() => state,
		);
		const wrapper = desktopExitReceipt(
			{ ...identity, owner: identity.launcher },
			Promise.resolve(true),
			() => true,
			() => state,
		);
		state = "unknown";
		const denied = desktopExitReceipt(
			identity,
			Promise.resolve(true),
			() => true,
			() => state,
		);
		state = "absent";
		for (const receipt of [failed, wrapper, denied]) {
			expect(await receipt.exited).toBe(false);
			expect(receipt.gone()).toBe(false);
		}
	});
});
