import { afterEach, expect, it, vi } from "vitest";
import { IPC_EVENTS } from "../../shared/ipc-types";

class NoStorageImport {
	status = 204;
	open(): void {}
	send(): void {}
	getResponseHeader(): null { return null; }
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it("keeps a partial UTF-8 event in order across a reader reconnect and signals resync", async () => {
	vi.useFakeTimers();
	const win = Object.assign(new EventTarget(), { setTimeout, clearTimeout });
	vi.stubGlobal("window", win);
	vi.stubGlobal("document", new EventTarget());
	vi.stubGlobal("XMLHttpRequest", NoStorageImport);
	const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
	const responses = Array.from({ length: 2 }, () =>
		new Response(new ReadableStream<Uint8Array>({ start: controller => { controllers.push(controller); } })),
	);
	vi.stubGlobal("fetch", vi.fn(async () => {
		const response = responses.shift();
		if (!response) throw new Error("unexpected reconnect");
		return response;
	}));
	await import("../../preload/shell");
	const seen: unknown[] = [];
	const stop = window.omp.events.onLogBatch(value => seen.push(value));
	const bytes = new TextEncoder().encode(`${JSON.stringify({ channel: IPC_EVENTS.LOG_LINE, args: [{ text: "한글" }] })}\n`);
	const split = bytes.indexOf(0xed) + 1;
	expect(split).toBeGreaterThan(1);
	controllers[0].enqueue(bytes.slice(0, split));
	await vi.advanceTimersByTimeAsync(0);
	controllers[0].close();
	await vi.advanceTimersByTimeAsync(250);
	controllers[1].enqueue(bytes.slice(split));
	await vi.advanceTimersByTimeAsync(0);
	expect(seen).toEqual([{ text: "한글" }]);
	const signal = Reflect.get(win, "__ompShellStream");
	expect(signal && Reflect.apply(Reflect.get(signal, "pending"), signal, [])).toBeTruthy();
	stop();
});
