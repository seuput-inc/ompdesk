import { afterEach, describe, expect, it, vi } from "vitest";
import { loadHostedSessions, useHostedSessionsStore } from "./hosted-sessions";
import { loadRemoteState, useRemoteStore } from "./remote";

afterEach(() => {
	vi.unstubAllGlobals();
	useRemoteStore.getState().reset();
	useHostedSessionsStore.setState({ summaries: {}, held: [], heldRevision: 0, remoteOpened: [], remoteOpenedRevision: 0 });
});

describe("recovery read outcomes", () => {
	it("does not report a failed remote-state read as fresh", async () => {
		vi.stubGlobal("window", { omp: { remote: { getState: async () => { throw new Error("offline"); } } } });
		expect(await loadRemoteState()).toBe(false);
		expect(useRemoteStore.getState().loadError).toBeInstanceOf(Error);
	});

	it("keeps held sessions and reports an unsuccessful read", async () => {
		useHostedSessionsStore.setState({ held: ["/kept"] });
		vi.stubGlobal("window", { omp: {
			sessions: {
				held: async () => { throw new Error("offline"); },
				remoteOpened: async () => [],
				summaries: async () => ({ version: "e.1", sessions: [] }),
			},
			remote: { getState: async () => ({ hosts: [] }) },
		} });
		expect(await loadHostedSessions()).toBe(false);
		expect(useHostedSessionsStore.getState().held).toEqual(["/kept"]);
	});

	it("does not treat an older host's unavailable summaries as a fresh empty list", async () => {
		const cached = { version: "e.1", sessions: [] };
		useHostedSessionsStore.setState({ summaries: { host: cached } });
		const summaries = vi.fn(async (device?: string) => device ? null : { version: "e.1", sessions: [] });
		vi.stubGlobal("window", { omp: {
			sessions: { held: async () => [], remoteOpened: async () => [], summaries },
			remote: { getState: async () => ({ hosts: [{ deviceId: "host", state: "online" }] }) },
		} });
		expect(await loadHostedSessions()).toBe(false);
		expect(useHostedSessionsStore.getState().summaries.host).toBe(cached);
	});

	it("does not request summaries from an offline host or discard its last snapshot", async () => {
		const cached = { version: "e.1", sessions: [] };
		useHostedSessionsStore.setState({ summaries: { host: cached } });
		const summaries = vi.fn(async () => ({ version: "e.1", sessions: [] }));
		vi.stubGlobal("window", { omp: {
			sessions: { held: async () => [], remoteOpened: async () => [], summaries },
			remote: { getState: async () => ({ hosts: [{ deviceId: "host", state: "offline" }] }) },
		} });
		expect(await loadHostedSessions()).toBe(false);
		expect(summaries).not.toHaveBeenCalledWith("host");
		expect(useHostedSessionsStore.getState().summaries.host).toBe(cached);
	});

	it("does not overwrite a newer host incarnation with an earlier summaries read", async () => {
		const pending = Promise.withResolvers<{ version: string; sessions: never[] }>();
		const newer = { version: "new.1", sessions: [] };
		vi.stubGlobal("window", { omp: {
			sessions: { held: async () => [], remoteOpened: async () => [], summaries: () => pending.promise },
			remote: { getState: async () => ({ hosts: [] }) },
		} });
		const read = loadHostedSessions();
		useHostedSessionsStore.setState({ summaries: { "": newer } });
		pending.resolve({ version: "old.9", sessions: [] });
		expect(await read).toBe(false);
		expect(useHostedSessionsStore.getState().summaries[""]).toBe(newer);
	});
});
