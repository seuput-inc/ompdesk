import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShellStreamReset } from "../../preload/shell";
import { installShellResync } from "./resync";

function stream() {
	let pending: object | null = null;
	const listeners = new Set<() => void>();
	const signal: ShellStreamReset = {
		onReset(listener) {
			listeners.add(listener);
			if (pending) listener();
			return () => listeners.delete(listener);
		},
		pending: () => pending,
		acknowledge(token) {
			if (pending === token) pending = null;
		},
	};
	return {
		signal,
		lose() {
			pending = {};
			for (const listener of listeners) listener();
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("desktop stream resync", () => {
	it("retains the loss after three failed passes and retries on visibility, without reloading", async () => {
		vi.useFakeTimers();
		const win = new EventTarget();
		const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
		vi.stubGlobal("window", win);
		vi.stubGlobal("document", doc);
		const source = stream();
		source.lose();
		const run = vi.fn(async () => false);
		const failure = vi.fn();
		const stop = installShellResync(source.signal, run, failure);
		try {
			await vi.advanceTimersByTimeAsync(6000);
			expect(run).toHaveBeenCalledTimes(3);
			expect(failure).toHaveBeenCalledWith(3);
			expect(source.signal.pending()).not.toBeNull();
			run.mockResolvedValue(true);
			doc.dispatchEvent(new Event("visibilitychange"));
			await vi.advanceTimersByTimeAsync(0);
			expect(run).toHaveBeenCalledTimes(4);
			expect(source.signal.pending()).toBeNull();
		} finally {
			stop();
		}
	});

	it("runs again when events are lost during an authoritative read", async () => {
		vi.stubGlobal("window", new EventTarget());
		vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
		const source = stream();
		const first = Promise.withResolvers<boolean>();
		const run = vi.fn<() => Promise<boolean>>().mockReturnValueOnce(first.promise).mockResolvedValue(true);
		const stop = installShellResync(source.signal, run, vi.fn());
		try {
			source.lose();
			source.lose();
			first.resolve(true);
			await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
			await vi.waitFor(() => expect(source.signal.pending()).toBeNull());
		} finally {
			stop();
		}
	});

	it("waits for an offline host to return before trying again", async () => {
		vi.useFakeTimers();
		let notify = (_state: { hosts: { deviceId: string; state: string }[] }) => {};
		const win = Object.assign(new EventTarget(), {
			omp: { remote: { onState: (listener: typeof notify) => { notify = listener; return () => {}; } } },
		});
		vi.stubGlobal("window", win);
		vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
		const source = stream();
		source.lose();
		const run = vi.fn(async () => false);
		const stop = installShellResync(source.signal, run, vi.fn());
		try {
			await vi.advanceTimersByTimeAsync(6000);
			notify({ hosts: [{ deviceId: "host", state: "offline" }] });
			await vi.advanceTimersByTimeAsync(0);
			expect(run).toHaveBeenCalledTimes(3);
			run.mockResolvedValue(true);
			notify({ hosts: [{ deviceId: "host", state: "online" }] });
			await vi.advanceTimersByTimeAsync(0);
			expect(run).toHaveBeenCalledTimes(4);
			expect(source.signal.pending()).toBeNull();
		} finally {
			stop();
		}
	});
});
