import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { isOmpdeskFolderPrompt, parseTccPrompt, type TccPrompt, watchTccPrompts } from "./mac-tcc-watch";

// The shape of tccd's AUTHREQ_PROMPTING line in `log stream --style compact`, as Orca's parser reads it.
const line = (service: string, responsible: string) =>
	`2026-11-25 10:00:00.000 Df tccd[123:abc] [com.apple.TCC:access] AUTHREQ_PROMPTING: msgID=1.2, service=${service}, subject=Sub:{/Users/me/.bun/bin/omp}Resp:{TCCDProcess: identifier=${responsible}, pid=456, auid=501, euid=501, binary_path=/Applications/OMPdesk.app/Contents/MacOS/OMPdesk},`;

/** A stand-in for the wrapped `log stream`: its stdout is written by the test, its exit emitted by it. */
function fakeLog() {
	const child = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stdin: new PassThrough(),
		killed: false,
		kill() {
			child.killed = true;
			return true;
		},
	});
	return child;
}

describe("macOS folder dialogs on OMPdesk's account", () => {
	it("tells OMPdesk's folder dialogs from other apps' and other services", () => {
		const documents = parseTccPrompt(line("kTCCServiceSystemPolicyDocumentsFolder", "com.seuput.ompdesk"));
		expect(documents).toEqual({
			service: "kTCCServiceSystemPolicyDocumentsFolder",
			responsible: "com.seuput.ompdesk",
		});
		expect(documents && isOmpdeskFolderPrompt(documents)).toBe(true);

		const other = parseTccPrompt(line("kTCCServiceSystemPolicyDocumentsFolder", "com.apple.Terminal"));
		expect(other && isOmpdeskFolderPrompt(other)).toBe(false);
		const camera = parseTccPrompt(line("kTCCServiceCamera", "com.seuput.ompdesk"));
		expect(camera && isOmpdeskFolderPrompt(camera)).toBe(false);
		expect(parseTccPrompt("tccd: AUTHREQ_RESULT service=kTCCServiceSystemPolicyDocumentsFolder")).toBeNull();
	});

	it("passes on OMPdesk's dialog as it arrives", async () => {
		const log = fakeLog();
		const { promise, resolve } = Promise.withResolvers<TccPrompt>();
		const stop = watchTccPrompts(resolve, () => log as never);
		log.stdout.write(`${line("kTCCServiceSystemPolicyAllFiles", "com.apple.Terminal")}\n`);
		log.stdout.write(`${line("kTCCServiceSystemPolicyDesktopFolder", "com.seuput.ompdesk")}\n`);
		expect(await promise).toEqual({
			service: "kTCCServiceSystemPolicyDesktopFolder",
			responsible: "com.seuput.ompdesk",
		});
		stop();
		expect(log.killed).toBe(true);
		expect(log.stdin.destroyed).toBe(true);
	});

	it("starts the log again once when it ends by itself", () => {
		vi.useFakeTimers();
		try {
			const logs: ReturnType<typeof fakeLog>[] = [];
			const stop = watchTccPrompts(
				() => {},
				() => {
					const log = fakeLog();
					logs.push(log);
					return log as never;
				},
			);
			logs[0]?.emit("exit", 1);
			expect(logs[0]?.stdin.destroyed).toBe(true);
			vi.advanceTimersByTime(1_000);
			expect(logs).toHaveLength(2);
			logs[1]?.emit("exit", 1);
			vi.advanceTimersByTime(10_000);
			expect(logs).toHaveLength(2);
			stop();
		} finally {
			vi.useRealTimers();
		}
	});
});
