import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixture } from "./test-context";

/** Captured from the deleted TS clip. Exercise its code-point limits through real native session notices. */
const rows = (
	JSON.parse(
		readFileSync(join(__dirname, "../../../native/ompdesk/crates/core/src/routines/captured.json"), "utf8"),
	) as { clip: [string, number, string][] }
).clip;

describe("clip", () => {
	it("keeps every captured row in a waiting session's question", async () => {
		const f = await fixture();
		f.tabs.push({ tabId: "t", sessionFile: "/t", cwd: "/p", title: "T" });
		await f.add({ source: "session", events: ["waiting"] });
		expect(rows).toHaveLength(150);
		for (const [index, [text, max, line]] of rows.entries()) {
			const prefix = "x".repeat(200 - max);
			await f.emit({
				type: "ask",
				tabId: "t",
				requestId: String(index),
				text: prefix + (prefix ? text.trimStart() : text),
			});
			const detail = prefix + line;
			expect(f.fired[index]).toBe(`Session "T" in /p is waiting for an answer${detail ? `: ${detail}` : ""}`);
		}
	}, 90_000);
});
