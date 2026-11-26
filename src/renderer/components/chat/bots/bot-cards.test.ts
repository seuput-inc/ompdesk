import { describe, expect, it } from "vitest";
import { parseItemMail } from "./BotCards";
import { botCardOf, botTarget } from "./bot-card-kind";

describe("parseItemMail", () => {
	it("reads each item of a several-item mail and keeps a comment's own line breaks", () => {
		const body = [
			"Item #3 “Ship the docs” [done]: The owner set it to done. The owner commented: thanks",
			"and one more line",
			"Item #4 “Fix [CI]” [waiting]: The owner set it to waiting on: the vendor.",
		].join("\n");
		expect(parseItemMail(body)).toEqual([
			{
				number: 3,
				title: "Ship the docs",
				status: "done",
				said: "The owner set it to done. The owner commented: thanks\nand one more line",
			},
			{ number: 4, title: "Fix [CI]", status: "waiting", said: "The owner set it to waiting on: the vendor." },
		]);
	});

	it("reads nothing from a mail that is not an item change", () => {
		expect(parseItemMail("Done: the release is out.")).toEqual([]);
	});
});

describe("botCardOf", () => {
	it("draws a send to a bot, an offer, an item change and an added MCP server as cards", () => {
		expect(botCardOf("ompdesk_session_send", { session: "bot:Ada@studio", message: "hi" })).toBe("botRequests");
		expect(botCardOf("ompdesk_report", { to: "bot:Ada", kind: "note", text: "x" })).toBe("botRequests");
		expect(botCardOf("ompdesk_bot", { action: "offer", name: "Cy" })).toBe("botOffers");
		expect(botCardOf("ompdesk_item", { action: "comment", item: "3", text: "x" })).toBe("itemNotes");
		expect(botCardOf("ompdesk_app", { action: "extensions.install_mcp", args: { name: "x" } })).toBe("toolsAdded");
	});

	it("leaves reads and sends to sessions as tool rows", () => {
		expect(botCardOf("ompdesk_session_send", { session: "work", message: "hi" })).toBeNull();
		expect(botCardOf("ompdesk_item", { action: "list" })).toBeNull();
		expect(botCardOf("ompdesk_bot", { action: "create", name: "Cy" })).toBeNull();
		expect(botCardOf("ompdesk_app", { action: "extensions.list" })).toBeNull();
	});

	it("names the bot and its computer from bot:<name>@<device>", () => {
		expect(botTarget("ompdesk_session_send", { sessions: ["a", "bot:Ada@studio"] })).toEqual({
			name: "Ada",
			device: "studio",
		});
		expect(botTarget("ompdesk_report", { to: "bot:Ada" })).toEqual({ name: "Ada" });
	});
});
