/**
 * The channel the shell's Preview owner asks a page's JS dialog on: the request is checked, only a streamed page's
 * viewer is asked, the viewer's late answer and the shell's withdrawal are honoured, and nothing else is left blocking
 * a page. (`PageStream.openDialog` itself is pinned by `preview-stream.test.ts`.)
 */
import { describe, expect, it, vi } from "vitest";
import { type DialogChannelEvent, type DialogStream, dialogChannel, dialogReturnValue } from "./preview-dialog";

function event(id: number, signal?: AbortSignal): DialogChannelEvent {
	return { sender: { id }, ...(signal ? { signal } : {}) };
}

/** A stream whose viewer answers when the test says so. */
function viewer() {
	const asked: Array<{ request: Parameters<DialogStream["openDialog"]>[0]; signal: AbortSignal | undefined }> = [];
	const answers: Array<(answer: { accept: boolean; text: string | null }) => void> = [];
	const stream: DialogStream = {
		openDialog: (request, signal) => {
			asked.push({ request, signal });
			const { promise, resolve } = Promise.withResolvers<{ accept: boolean; text: string | null }>();
			answers.push(resolve);
			return promise;
		},
	};
	return { stream, asked, answers };
}

describe("dialogReturnValue", () => {
	it("gives each function what the page expects", () => {
		const answer = { accept: true, text: "Ada" };
		const none = { accept: false, text: null };
		expect(dialogReturnValue({ kind: "alert", message: "", initial: null }, answer)).toBeNull();
		expect(dialogReturnValue({ kind: "confirm", message: "", initial: null }, answer)).toBe(true);
		expect(dialogReturnValue({ kind: "confirm", message: "", initial: null }, none)).toBe(false);
		expect(dialogReturnValue({ kind: "prompt", message: "", initial: "dflt" }, answer)).toBe("Ada");
		expect(dialogReturnValue({ kind: "prompt", message: "", initial: "dflt" }, { accept: true, text: null })).toBe(
			"dflt",
		);
		expect(
			dialogReturnValue({ kind: "prompt", message: "", initial: "dflt" }, { accept: false, text: "x" }),
		).toBeNull();
	});
});

describe("dialogChannel", () => {
	it("asks the page's stream and answers the shell when the viewer does, long after the handler returned", async () => {
		const { stream, asked, answers } = viewer();
		const listener = dialogChannel(new Map([[7, stream]]));
		const shell = event(7);
		listener(shell, { kind: "prompt", message: "Name?", initial: "dflt" });
		expect(asked.map(entry => entry.request)).toEqual([{ kind: "prompt", message: "Name?", initial: "dflt" }]);
		expect(shell.returnValue).toBeUndefined();
		answers[0]?.({ accept: true, text: "Ada" });
		await vi.waitFor(() => expect(shell.returnValue).toBe("Ada"));
	});

	it("dismisses a page that is not streamed, and a request that is not a dialog", () => {
		const { stream, asked } = viewer();
		const listener = dialogChannel(new Map([[7, stream]]));
		const ordinary = event(8);
		listener(ordinary, { kind: "confirm", message: "Sure?", initial: null });
		expect(ordinary.returnValue).toBeNull();
		for (const raw of [
			{ kind: "beforeunload", message: "", initial: null },
			{ kind: "alert", message: "x".repeat(2001), initial: null },
			{ kind: "prompt", message: "m" },
			"alert",
			null,
		]) {
			const invalid = event(7);
			listener(invalid, raw);
			expect(invalid.returnValue).toBeNull();
		}
		expect(asked).toEqual([]);
	});

	it("hands the stream the shell's own withdrawal signal, and dismisses when the stream does", async () => {
		const { stream, asked, answers } = viewer();
		const listener = dialogChannel(new Map([[7, stream]]));
		const ended = new AbortController();
		const shell = event(7, ended.signal);
		listener(shell, { kind: "confirm", message: "Sure?", initial: null });
		expect(asked[0]?.signal).toBe(ended.signal);
		ended.abort();
		answers[0]?.({ accept: false, text: null });
		await vi.waitFor(() => expect(shell.returnValue).toBe(false));
	});
});
