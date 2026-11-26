import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../shared/rpc-types";
import { lastExchange } from "./last-exchange";

const user = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }] });
const reply = (text: string): AgentMessage => ({ role: "assistant", content: [{ type: "text", text }] });
const tool = (): AgentMessage => ({ role: "toolResult", content: [{ type: "text", text: "ok" }] });

describe("lastExchange", () => {
	it("pairs the newest prompt with the last reply after it, skipping tool rows", () => {
		expect(
			lastExchange([
				user("old"),
				reply("old answer"),
				user("fix   the\nbuild"),
				reply("first"),
				tool(),
				reply("done"),
			]),
		).toEqual({ prompt: "fix the build", reply: "done" });
	});

	it("keeps a prompt with no reply yet and clips a long one", () => {
		const long = "x".repeat(400);
		const exchange = lastExchange([reply("before"), user(long)]);
		expect(exchange?.reply).toBeUndefined();
		expect(exchange?.prompt).toHaveLength(280);
		expect(exchange?.prompt?.endsWith("…")).toBe(true);
	});

	it("says nothing for a transcript without text", () => {
		expect(lastExchange([tool()])).toBeNull();
	});
});
