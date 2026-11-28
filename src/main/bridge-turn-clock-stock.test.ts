import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BOT_METHOD } from "../../resources/gui-bridge/modes/bots-contracts";
import { fakeAgent, sse, startOmp, startProvider } from "./bridge-todo-stock-rig";
import { INSTALLED_OMP as omp } from "./test-bridge-probe";

type WireMessage = { content: string | { text?: string }[] };

describe.skipIf(!existsSync(omp))("the execution host's clock in the model request", () => {
	it.each([false, true])(
		"appends the time without rewriting the first turn (hosted bot: %s)",
		async bot => {
			const provider = await startProvider(() => sse([{ content: "Done." }], "stop"));
			const session = await startOmp({
				...fakeAgent(provider.url),
				model: "fake/m1",
				bridge: resolve("resources/gui-bridge/index.ts"),
				env: {
					TZ: "Asia/Tokyo",
					...(bot && {
						OMP_GUI_PROMPT_ORIGIN: JSON.stringify({ deviceId: "viewer", name: "Phone", hostName: "Studio" }),
					}),
				},
			});
			if (bot) await session.bridge.request(BOT_METHOD, { bot: { id: "b1", name: "Scout", folder: session.root } });
			let prefix: WireMessage[] = [];
			for (const prompt of bot ? ["First clock", "Next clock", "Wake clock"] : ["First clock", "Next clock"]) {
				const before = Date.now();
				if (prompt === "Wake clock") {
					await session.bridge.request("agent_control.mail", { content: prompt, triggerTurn: true });
					await expect.poll(() => provider.bodies.length, { timeout: 30_000 }).toBe(3);
				} else await session.turn(prompt);
				const { messages } = JSON.parse(provider.bodies.at(-1)!) as { messages: WireMessage[] };
				expect(JSON.stringify(messages.slice(0, prefix.length)) === JSON.stringify(prefix)).toBe(true);
				const tail = messages
					.slice(prefix.length)
					.map(({ content }) => (typeof content === "string" ? content : content.map(part => part.text).join("")))
					.join("\n");
				expect(tail.indexOf(prompt)).toBeGreaterThanOrEqual(0);
				expect(tail.indexOf("Session host clock")).toBeGreaterThan(tail.indexOf(prompt));
				const clocks = [
					...tail.matchAll(/Session host clock(.*?): (\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) [^\n]*?\(Asia\/Tokyo\)/g),
				];
				expect(clocks.length).toBe(1);
				const [, host, date, time] = clocks[0]!;
				expect(host).toBe(bot ? ' ("Studio")' : "");
				const stamp = Date.parse(`${date}T${time}+09:00`);
				expect(stamp).toBeGreaterThanOrEqual(before - 999);
				expect(stamp).toBeLessThanOrEqual(Date.now());
				prefix = messages;
			}
		},
		180_000,
	);
});
