import { describe, expect, it, vi } from "vitest";
import { osc52Handler, parseOsc52 } from "./terminal-osc52";

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

describe("OSC 52", () => {
	it("decodes a program's copy, line-wrapped or not, and refuses reads, clears, junk and oversized payloads", () => {
		expect(parseOsc52(`c;${b64("héllo 한글")}`)).toEqual({ kind: "write", text: "héllo 한글" });
		expect(parseOsc52(`;${b64("tmux")}`)).toEqual({ kind: "write", text: "tmux" });
		const wrapped = b64("a long copy");
		expect(parseOsc52(`c;${wrapped.slice(0, 4)}\n${wrapped.slice(4)}`)).toEqual({
			kind: "write",
			text: "a long copy",
		});
		expect(parseOsc52("c;?")).toEqual({ kind: "query" });
		expect(parseOsc52("c;")).toMatchObject({ kind: "invalid", reason: "empty" });
		expect(parseOsc52("c;not*base64")).toMatchObject({ kind: "invalid", reason: "base64" });
		expect(parseOsc52(`x;${b64("a")}`)).toMatchObject({ kind: "invalid", reason: "selection" });
		expect(parseOsc52(`c;${"A".repeat(128 * 1024 + 4)}`)).toMatchObject({ kind: "invalid", reason: "size" });
	});
	it("copies only live output, the last of a burst, and reports a clipboard that refused", async () => {
		let replaying = true;
		const write = vi.fn().mockResolvedValue(undefined);
		const onFailure = vi.fn();
		const handle = osc52Handler({ replaying: () => replaying, write, onFailure });
		expect(handle(`c;${b64("old copy")}`)).toBe(true);
		await Promise.resolve();
		expect(write).not.toHaveBeenCalled();
		replaying = false;
		handle(`c;${b64("first")}`);
		handle(`c;${b64("second")}`);
		await Promise.resolve();
		expect(write.mock.calls).toEqual([["second"]]);
		write.mockRejectedValueOnce(new Error("denied"));
		handle(`c;${b64("third")}`);
		await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce());
	});
});
