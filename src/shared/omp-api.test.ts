/**
 * `createOmpApi` over a recording transport: the wrappers the preload had (active-tab filtering, the
 * default RPC timeout, isolating a throwing listener) hold for any transport.
 */
import { describe, expect, it } from "vitest";
import { BOTS_COMMAND } from "./bots";
import { IPC_COMMANDS, IPC_EVENTS } from "./ipc-types";
import { createOmpApi, type OmpTransport } from "./omp-api";
import { timeoutForCommand } from "./rpc-client";

function recording() {
	const invoked: Array<{ channel: string; args: unknown[] }> = [];
	const sent: Array<{ channel: string; args: unknown[] }> = [];
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const answers = new Map<string, unknown>();
	const transport: OmpTransport = {
		invoke: async <T>(channel: string, ...args: unknown[]) => {
			invoked.push({ channel, args });
			return answers.get(channel) as T;
		},
		send: (channel, ...args) => sent.push({ channel, args }),
		on: (channel, listener) => {
			const set = listeners.get(channel) ?? new Set();
			listeners.set(channel, set);
			set.add(listener);
			return () => set.delete(listener);
		},
	};
	const emit = (channel: string, data: unknown) => {
		for (const listener of listeners.get(channel) ?? []) listener(data);
	};
	return { api: createOmpApi(transport), invoked, sent, emit, answers, listeners };
}

describe("createOmpApi", () => {
	const preview = { chats: 1, workers: 0, kept: 2, digest: "a".repeat(64) };

	it("reads and changes a project's host without sending a profile or a remote device", async () => {
		const { api, invoked, answers } = recording();
		const state = { selected: null, distributions: [] };
		answers.set(IPC_COMMANDS.WSL_PROJECT_GET, state);
		expect(await api.wslHost.get("C:\\project")).toEqual(state);
		await api.wslHost.set("C:\\project", null);
		expect(invoked).toEqual([
			{ channel: IPC_COMMANDS.WSL_PROJECT_GET, args: ["C:\\project"] },
			{ channel: IPC_COMMANDS.WSL_PROJECT_SET, args: ["C:\\project", null] },
		]);
	});

	it("sends only the confirmed counts and membership digest on delete", async () => {
		const { api, invoked, answers } = recording();
		answers.set(BOTS_COMMAND, { ...preview, paths: ["/private/session"] });
		const expected = await api.bots.deletePreview({ id: "b" });
		expect(expected).toEqual(preview);
		answers.set(BOTS_COMMAND, { bots: [], items: [] });
		await api.bots.command({ action: "delete", id: "b", expected });
		expect(invoked).toEqual([
			{ channel: BOTS_COMMAND, args: [{ action: "deletePreview", id: "b" }] },
			{ channel: BOTS_COMMAND, args: [{ action: "delete", id: "b", expected: preview }] },
		]);
	});

	it.each([
		{ version: "old.1", state: { bots: [], items: [] } },
		{ ...preview, workers: -1 },
		{ chats: 1, workers: 0, kept: 2 },
		{ ...preview, digest: "A".repeat(64) },
		{ ...preview, digest: "f".repeat(63) },
		{ ...preview, digest: ["a".repeat(64)] },
	])("rejects a preview without valid counts and a lowercase SHA-256 digest", async answer => {
		const { api, answers } = recording();
		answers.set(BOTS_COMMAND, answer);
		await expect(api.bots.deletePreview({ id: "b" })).rejects.toThrow("deletion preview");
	});

	it("refuses to send an unconfirmed plan and returns a host's replacement preview without paths", async () => {
		const { api, answers, invoked } = recording();
		await expect(
			api.bots.command({ action: "delete", id: "b", expected: { ...preview, digest: "" } }),
		).rejects.toThrow();
		expect(invoked).toEqual([]);
		const replacement = { ...preview, digest: "b".repeat(64) };
		answers.set(BOTS_COMMAND, { bots: [{ id: "b" }], items: [], deleteChanged: { ...replacement, paths: [] } });
		const answer = await api.bots.command({ action: "delete", id: "b", expected: preview });
		expect(answer.deleteChanged).toEqual(replacement);
	});

	it.each([
		undefined,
		{ version: "old.1", state: { bots: [], items: [] } },
		{ bots: [], items: [], deleteChanged: null },
		{ bots: [], items: [], deleteChanged: { chats: 1, workers: 0, kept: 2 } },
		{ bots: [{ id: "b" }], items: [] },
		{ bots: [{}], items: [] },
		{ bots: [], items: [], remote: null },
		{ bots: [], items: [], remote: [{ bots: [{ id: "b" }], items: [] }] },
	])("rejects a malformed or unconfirmed delete reply", async answer => {
		const { api, answers } = recording();
		answers.set(BOTS_COMMAND, answer);
		await expect(api.bots.command({ action: "delete", id: "b", expected: preview })).rejects.toThrow();
	});

	it("sends a focused-tab command with its default timeout", async () => {
		const { api, invoked } = recording();
		const command = { type: "get_state" } as const;
		await api.rpc.command(command);
		expect(invoked).toEqual([
			{ channel: IPC_COMMANDS.RPC_COMMAND, args: [{ command, timeoutMs: timeoutForCommand(command) }] },
		]);
	});

	it("drops other tabs' full-stream envelopes once a tab is active, and passes every tab's to per-tab listeners", async () => {
		const { api, emit, answers } = recording();
		const focused: unknown[] = [];
		const perTab: Array<[unknown, string]> = [];
		api.events.onBatch(events => focused.push(events));
		api.events.onTabBatch((events, tabId) => perTab.push([events, tabId]));
		emit(IPC_EVENTS.EVENTS_BATCH, { tabId: "a", payload: ["before"] });
		answers.set(IPC_COMMANDS.SET_ACTIVE_TAB, true);
		expect(await api.tabs.setActive("b")).toBe(true);
		emit(IPC_EVENTS.EVENTS_BATCH, { tabId: "a", payload: ["hidden"] });
		emit(IPC_EVENTS.EVENTS_BATCH, { tabId: "b", payload: ["shown"] });
		expect(focused).toEqual([["before"], ["shown"]]);
		expect(perTab).toEqual([
			[["before"], "a"],
			[["hidden"], "a"],
			[["shown"], "b"],
		]);
	});

	it("keeps the active tab when main refuses the switch", async () => {
		const { api, emit, answers } = recording();
		const focused: unknown[] = [];
		api.events.onBatch(events => focused.push(events));
		answers.set(IPC_COMMANDS.SET_TAB_VIEW, true);
		await api.tabs.setView("a", ["a"]);
		answers.set(IPC_COMMANDS.SET_TAB_VIEW, false);
		expect(await api.tabs.setView("b", ["b"])).toBe(false);
		emit(IPC_EVENTS.EVENTS_BATCH, { tabId: "b", payload: ["b"] });
		emit(IPC_EVENTS.EVENTS_BATCH, { tabId: "a", payload: ["a"] });
		expect(focused).toEqual([["a"]]);
	});

	it("isolates a throwing listener and reports it, so the others on the channel still run", () => {
		const { api, emit, sent } = recording();
		const seen: unknown[] = [];
		api.events.onTabStatus(() => {
			throw new Error("boom");
		});
		api.events.onTabStatus(payload => seen.push(payload));
		emit(IPC_EVENTS.TAB_STATUS, { tabId: "a" });
		expect(seen).toEqual([{ tabId: "a" }]);
		expect(sent).toEqual([
			{
				channel: IPC_COMMANDS.RUNTIME_ERROR_REPORT,
				args: [
					expect.objectContaining({
						source: "preload",
						message: `IPC handler for "${IPC_EVENTS.TAB_STATUS}" failed: boom`,
						details: { channel: IPC_EVENTS.TAB_STATUS },
					}),
				],
			},
		]);
	});

	it("unsubscribes, and unwraps the payloads the renderer takes apart", () => {
		const { api, emit, listeners } = recording();
		const asks: unknown[] = [];
		const stop = api.events.onExtensionUi((request, tabId, signIn, resent) =>
			asks.push({ request, tabId, signIn, resent }),
		);
		emit(IPC_EVENTS.EXTENSION_UI, { tabId: "a", request: { id: "r" } });
		stop();
		emit(IPC_EVENTS.EXTENSION_UI, { tabId: "a", request: { id: "late" } });
		expect(asks).toEqual([{ request: { id: "r" }, tabId: "a", signIn: undefined, resent: false }]);
		expect(listeners.get(IPC_EVENTS.EXTENSION_UI)?.size).toBe(0);
	});
});
