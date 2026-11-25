import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readPace } from "./session-pace";

// Its own file: Vitest runs each node test file in a process of its own, so the peak below is this read's alone.
it("reads a journal far larger than the memory it takes", { timeout: 60_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pace-memory-"));
	const file = join(dir, "s.jsonl");
	const text = [{ type: "text", text: "x".repeat(8_000) }];
	const calls = 16_000;
	const handle = await open(file, "w");
	try {
		for (let i = 0; i < calls; i++) {
			const at = 1_700_000_000_000 + i * 15_000;
			const id = `c${i}`;
			const call = { role: "assistant", timestamp: at, content: [...text, { type: "toolCall", id, name: "bash" }] };
			const result = { role: "toolResult", timestamp: at + 10_000, toolCallId: id, toolName: "bash", content: text };
			await handle.write(
				`${JSON.stringify({ type: "message", message: call })}\n${JSON.stringify({ type: "message", message: result })}\n`,
			);
		}
	} finally {
		await handle.close();
	}
	try {
		// About 256 MB. Read whole and split, it took 565 MB more before (a Buffer, its string and the lines); now 13.
		const before = process.resourceUsage().maxRSS;
		const read = await readPace(file);
		const grewMb = (process.resourceUsage().maxRSS - before) / 1024;
		expect(read?.modelCalls).toBe(calls);
		expect(grewMb).toBeLessThan(96);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
