import { describe, expect, it } from "vitest";
import { wrapAgentMessage } from "../../shared/agent-control";
import type { AgentMessage } from "../../shared/rpc-types";
import { talkingWith } from "./talking-with";

const prompt = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }] });
const mail = (fromTitle: string): AgentMessage => ({
	role: "custom",
	customType: "ompdesk.mail",
	content: "",
	display: true,
	details: { id: fromTitle, kind: "note", from: "x", fromTitle, text: "" },
	timestamp: 1,
});

describe("talkingWith", () => {
	it("names who wrote to the session, newest first, once each, without its family or the person", () => {
		const messages = [
			prompt(wrapAgentMessage("hi", "Release prep", "a1")),
			prompt("my own prompt"),
			mail("Docs"),
			prompt(wrapAgentMessage("again", "Release prep", "a1")),
			mail("Child A"),
			prompt(wrapAgentMessage("untitled sender", "")),
		];
		expect(talkingWith(messages, new Set(["Child A"]))).toEqual(["Release prep", "Docs"]);
	});
});
