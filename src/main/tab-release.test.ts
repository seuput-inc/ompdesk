import { describe, expect, it } from "vitest";
import type { AutoCloseTurn, HostCloseTurn } from "../shared/ipc-types";
import { closeWindowTab, type TabReleaseDeps } from "./tab-release";
import type { ClientWindow } from "./web/client-window";
import type { FileEditTarget } from "./web/file-edit-reports";

const PAGE: FileEditTarget = { host: 1, device: "phone" };

const win = (id: number): ClientWindow => ({
	webContents: { id, send: () => undefined },
	isDestroyed: () => false,
	once: () => undefined,
	removeListener: () => undefined,
});

function rig(
	options: {
		owns?: boolean;
		viewer?: boolean;
		hosted?: boolean;
		duringExitPolicy?: () => void;
		canRelease?: (turn?: AutoCloseTurn) => boolean;
		closeHostTurn?: (turn: HostCloseTurn | null) => Promise<boolean>;
	} = {},
) {
	const steps: string[] = [];
	/** What the page's live connections report of the tab, as the core's router keeps it. */
	const page = { dirty: false };
	const sidecar = { closeHostTurn: options.closeHostTurn };
	const deps: TabReleaseDeps = {
		sidecarPool: {
			sidecarForTab: () => (options.owns === false ? null : (sidecar as never)),
			windowOfTab: () => win(options.viewer ? -2 : -1),
			detachViewer: (_win, tabId) => {
				if (options.viewer) steps.push(`detach:${tabId}`);
				return options.viewer === true;
			},
			isHostedView: () => options.hosted === true,
			canReleaseTab: (_tabId, turn) => options.canRelease?.(turn) ?? true,
			fileEdits: () => (page.dirty ? "dirty" : "clean"),
			// The core checks the guard in the step that removes the tab.
			releaseTab: (tabId, turn, unlessDirty) => {
				if (unlessDirty && page.dirty) return false;
				steps.push(`release:${tabId}`);
				return options.canRelease?.(turn) ?? true;
			},
		},
		worktreeLifecycle: {
			refreshExitPolicy: async tabId => {
				steps.push(`exit-policy:${tabId}`);
				await Promise.resolve();
				options.duringExitPolicy?.();
			},
		},
		closeTabTerminals: (windowId, tabId) => void steps.push(`terminals:${windowId}:${tabId}`),
	};
	return { deps, steps, page };
}

describe("closeWindowTab", () => {
	it("refreshes the worktree exit policy, closes the window's terminals, then releases the sidecar", async () => {
		const { deps, steps } = rig();
		expect(await closeWindowTab(deps, win(-1), "t1", -1)).toBe(true);
		expect(steps).toEqual(["exit-policy:t1", "terminals:-1:t1", "release:t1"]);
	});

	it("does nothing for a tab the window does not own", async () => {
		const { deps, steps } = rig({ owns: false });
		expect(await closeWindowTab(deps, win(-1), "t1", -1)).toBe(false);
		expect(steps).toEqual([]);
	});

	it("only leaves a tab another window owns", async () => {
		const { deps, steps } = rig({ viewer: true });
		const expected = { pool: 1, entry: 1, turn: 1 };
		expect(await closeWindowTab(deps, win(-1), "t1", -1, undefined, expected)).toBe(false);
		expect(steps).toEqual([]);
		expect(await closeWindowTab(deps, win(-1), "t1", -1)).toBe(true);
		expect(steps).toEqual(["detach:t1"]);
	});

	it("keeps a paired device's worktree out of it: terminals and release only", async () => {
		const { deps, steps } = rig({ hosted: true });
		expect(await closeWindowTab(deps, win(-1), "t1", -1)).toBe(true);
		expect(steps).toEqual(["terminals:-1:t1", "release:t1"]);
	});

	it("keeps the terminal when a newer turn prevents release after the exit-policy read", async () => {
		let currentTurn = 1;
		const { deps, steps } = rig({
			duringExitPolicy: () => ++currentTurn,
			canRelease: expected => expected === undefined || expected.turn === currentTurn,
		});
		const expected = { pool: 1, entry: 1, turn: currentTurn };
		expect(await closeWindowTab(deps, win(-1), "t1", -1, undefined, expected)).toBe(false);
		expect(steps).toEqual(["exit-policy:t1", "release:t1"]);
	});

	it("does not ask the host to close a locally stale turn, even if the host would accept", async () => {
		const { deps, steps } = rig({
			canRelease: () => false,
			closeHostTurn: () => {
				throw new Error("unexpected host close");
			},
		});
		expect(await closeWindowTab(deps, win(-1), "t1", -1, undefined, { pool: 1, entry: 1, turn: 2 })).toBe(false);
		expect(steps).toEqual(["exit-policy:t1"]);
	});

	it.each(["refused", "dirty", "replaced", "accepted"] as const)(
		"keeps the proxy and terminals until host acceptance and a final local check: %s",
		async outcome => {
			const sent = Promise.withResolvers<HostCloseTurn | null>();
			const reply = Promise.withResolvers<boolean>();
			const expected = { pool: 1, entry: 2, turn: 3, host: { omp: "host-spawn", turn: 7 } };
			const { deps, steps, page } = rig({
				closeHostTurn: turn => {
					sent.resolve(turn);
					return reply.promise;
				},
			});
			const closed = closeWindowTab(deps, win(-1), "t1", -1, PAGE, expected);
			expect(await sent.promise).toEqual(expected.host);
			expect(steps).toEqual(["exit-policy:t1"]);
			if (outcome === "dirty") page.dirty = true;
			if (outcome === "replaced") deps.sidecarPool.sidecarForTab = () => ({}) as never;
			reply.resolve(outcome !== "refused");
			expect(await closed).toBe(outcome === "accepted");
			expect(steps).toEqual(
				outcome === "accepted" ? ["exit-policy:t1", "release:t1", "terminals:-1:t1"] : ["exit-policy:t1"],
			);
		},
	);

	it("asks the page's word again after the exit-policy read and keeps the tab when it turned dirty meanwhile", async () => {
		const kept = rig({ duringExitPolicy: () => (kept.page.dirty = true) });
		expect(await closeWindowTab(kept.deps, win(-1), "t1", -1, PAGE)).toBe(false);
		expect(kept.steps).toEqual(["exit-policy:t1"]);
		const gone = rig();
		expect(await closeWindowTab(gone.deps, win(-1), "t1", -1, PAGE)).toBe(true);
		expect(gone.steps).toEqual(["exit-policy:t1", "release:t1", "terminals:-1:t1"]);
	});

	it("closes no terminal of a tab the core kept because its page names it dirty at the release", async () => {
		const { deps, steps, page } = rig();
		deps.sidecarPool.fileEdits = () => "clean";
		page.dirty = true;
		expect(await closeWindowTab(deps, win(-1), "t1", -1, PAGE)).toBe(false);
		expect(steps).toEqual(["exit-policy:t1"]);
	});
});
