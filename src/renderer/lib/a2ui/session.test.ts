import { getValue, NodeResolver } from "@a2ui/web_core";
import { describe, expect, it } from "vitest";
import catalogDocument from "../../../../resources/gui-bridge/modes/a2ui-catalog.json";
import type { AgentMessage } from "../../../shared/rpc-types";
import { createToolsStore, selectToolEntry, toolEntryKey } from "../../stores/tools";
import { parseStreamingArgs } from "../streaming-json";
import { A2uiSession, a2uiCalls } from "./session";

const A2UI_CATALOG_ID = catalogDocument.catalogId;
const env = (body: Record<string, unknown>) => ({ version: "1.0", ...body });

const FORM = [
	env({ createSurface: { surfaceId: "contact", catalogId: A2UI_CATALOG_ID, sendDataModel: true } }),
	env({
		updateComponents: {
			surfaceId: "contact",
			components: [
				{ id: "root", component: "Column", children: ["name", "send"] },
				{ id: "name", component: "TextField", label: "Name", value: { "@path": "/name" } },
				{ id: "send", component: "Button", child: "send_label", action: { event: { name: "submit" } } },
				{ id: "send_label", component: "Text", text: "Send" },
			],
		},
	}),
	env({ updateDataModel: { surfaceId: "contact", value: { name: "" } } }),
];

const CHART = [
	env({ createSurface: { surfaceId: "chart", catalogId: A2UI_CATALOG_ID } }),
	env({
		updateComponents: {
			surfaceId: "chart",
			components: [{ id: "root", component: "Text", text: "Weekly totals" }],
		},
	}),
];

const assistant = (id: string, messages: unknown[]): AgentMessage => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name: "a2ui", arguments: { messages } }],
});
const result = (id: string, details: unknown, isError = false): AgentMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "a2ui",
	isError,
	details,
	content: [{ type: "text", text: "…" }],
});

/** The fold of a session, as plain data: each surface's components and data model, and who draws it. */
function snapshot(session: A2uiSession, surfaceIds: string[]) {
	return Object.fromEntries(
		surfaceIds.map(id => {
			const surface = session.surface(id);
			return [
				id,
				surface && {
					owner: session.owner(id),
					components: [...surface.componentsModel.keys].sort(),
					dataModel: surface.dataModel.get("/"),
				},
			];
		}),
	);
}

function fold(transcript: AgentMessage[]): A2uiSession {
	const session = new A2uiSession("en-US");
	session.sync(a2uiCalls(transcript));
	return session;
}

describe("a2uiCalls", () => {
	it("reads the a2ui calls in transcript order and pairs each result with its call", () => {
		const transcript: AgentMessage[] = [
			{ role: "user", content: "show me" },
			assistant("c1", CHART),
			result("c1", { shown: ["chart"] }),
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls" } }],
			},
			assistant("c2", FORM),
			result("c2", { action: { name: "submit", surfaceId: "contact", sourceComponentId: "send", context: {} } }),
			assistant("c3", [{ broken: true }]),
			result("c3", { errors: [{ code: "VALIDATION_FAILED", surfaceId: "x", path: "/", message: "bad" }] }, true),
			assistant("c4", CHART),
			result("c4", {}, true),
		];
		const calls = a2uiCalls(transcript, [{ id: "c5", key: "c5", args: { messages: [] } }]);
		expect(calls.map(c => [c.id, c.refused, c.streaming, c.answer?.sourceComponentId])).toEqual([
			["c1", false, false, undefined],
			["c2", false, false, "send"],
			["c3", true, false, undefined],
			// A Stop throws: stock reports `details: {}`, so its card stays drawn.
			["c4", false, false, undefined],
			["c5", false, true, undefined],
		]);
	});

	it("pairs a reused call id with the newest call of that id, each keyed as the tools store keys it", () => {
		const transcript = [
			{
				role: "assistant" as const,
				content: [{ type: "toolCall" as const, id: "call_0", name: "read", arguments: { path: "a" } }],
			},
			assistant("call_0", CHART),
			result("call_0", { shown: ["chart"] }),
			assistant("call_0", FORM),
			result("call_0", { dismissed: true }),
		];
		const tools = createToolsStore();
		tools.getState().hydrateMessages(transcript);
		const keys = transcript
			.flatMap(m => (m.role === "assistant" && Array.isArray(m.content) ? m.content : []))
			.map(b => toolEntryKey(b as never));
		const calls = a2uiCalls(transcript);
		expect(calls.map(c => [c.key, c.messages.length])).toEqual([
			[keys[1], 2],
			[keys[2], 3],
		]);
		// The tools store numbers every call of the id, a `read` included: the card's key is the store's.
		expect(new Set(keys).size).toBe(3);
		expect(calls.map(c => selectToolEntry(tools.getState(), c.key)?.toolName)).toEqual(["a2ui", "a2ui"]);
	});

	it("adds a streaming call only while the transcript does not hold its key", () => {
		const answered = [assistant("c1", CHART), result("c1", { shown: ["chart"] })];
		const streaming = [{ id: "c2", key: "c2", args: { messages: FORM } }];
		expect(a2uiCalls(answered, streaming).map(c => [c.key, c.streaming])).toEqual([
			["c1", false],
			["c2", true],
		]);
		expect(a2uiCalls([...answered, assistant("c2", FORM)], streaming).map(c => [c.key, c.streaming])).toEqual([
			["c1", false],
			["c2", false],
		]);
	});
});

describe("A2uiSession with a reused call id", () => {
	it("keeps each call's surfaces apart and names the newest as the owner", () => {
		const session = new A2uiSession("en-US");
		const first = [assistant("call_0", CHART), result("call_0", { shown: ["chart"] })];
		session.sync(a2uiCalls(first, [{ id: "call_0", key: "second", args: { messages: [...FORM, {}] } }]));
		expect(session.owner("contact")).toBe("second");
		const block = { type: "toolCall" as const, id: "call_0", name: "a2ui", arguments: { messages: FORM } };
		const second: AgentMessage = { role: "assistant", content: [block] };
		const tools = createToolsStore();
		tools.getState().hydrateMessages([...first, second]);
		session.sync(a2uiCalls([...first, second]));
		const secondKey = toolEntryKey(block);
		expect(secondKey).not.toBe("call_0");
		expect([...(session.call("call_0")?.surfaces ?? [])]).toEqual(["chart"]);
		expect([...(session.call(secondKey)?.surfaces ?? [])]).toEqual(["contact"]);
		expect([session.owner("chart"), session.owner("contact")]).toEqual(["call_0", secondKey]);
	});
});

describe("A2uiSession", () => {
	it("folds a transcript into its surfaces, each drawn by the newest call that touched it", () => {
		const update = env({ updateDataModel: { surfaceId: "chart", path: "/week", value: 48 } });
		const session = fold([
			assistant("c1", CHART),
			result("c1", { shown: ["chart"] }),
			assistant("c2", [...FORM, update]),
		]);
		expect(snapshot(session, ["chart", "contact"])).toEqual({
			chart: { owner: "c2", components: ["root"], dataModel: { week: 48 } },
			contact: { owner: "c2", components: ["name", "root", "send", "send_label"], dataModel: { name: "" } },
		});
		expect([...(session.call("c1")?.surfaces ?? [])]).toEqual(["chart"]);
		expect([...(session.call("c2")?.surfaces ?? [])].sort()).toEqual(["chart", "contact"]);
		expect(session.call("c2")?.errors).toEqual([]);
	});

	it("applies streamed arguments one complete envelope at a time, each once", () => {
		const text = JSON.stringify({ messages: [...CHART, ...FORM] });
		const streamed = new A2uiSession("en-US");
		const createsSeen: number[] = [];
		for (let end = 1; end < text.length; end++) {
			streamed.sync(a2uiCalls([], [{ id: "c1", key: "c1", args: parseStreamingArgs(text.slice(0, end)) }]));
			createsSeen.push(streamed.surface("contact") ? 1 : 0);
		}
		// While streaming, the form's last envelope (its data model) is held back even once it parsed whole.
		expect(streamed.surface("contact")?.dataModel.get("/")).toEqual({});
		streamed.sync(a2uiCalls([assistant("c1", [...CHART, ...FORM])]));
		expect(streamed.call("c1")?.errors).toEqual([]);
		expect(snapshot(streamed, ["chart", "contact"])).toEqual(
			snapshot(fold([assistant("c1", [...CHART, ...FORM])]), ["chart", "contact"]),
		);
		// The surface appeared once and never went away: nothing was rebuilt along the way.
		expect(createsSeen.indexOf(1)).toBeGreaterThan(0);
		expect(createsSeen.slice(createsSeen.indexOf(1))).not.toContain(0);
	});

	it("rebuilds the same state on reload, including what the person submitted", () => {
		const live = new A2uiSession("en-US");
		const asked = [assistant("c1", FORM)];
		live.sync(a2uiCalls(asked));
		const field = new NodeResolver(live.surface("contact") as never);
		expect(getValue(field.rootNode)?.type).toBe("Column");
		live.surface("contact")?.dataModel.set("/name", "Ann");
		const action = {
			name: "submit",
			surfaceId: "contact",
			sourceComponentId: "send",
			context: {},
			dataModel: { name: "Ann" },
		};
		const answered = [...asked, result("c1", { action })];
		live.sync(a2uiCalls(answered));
		const reloaded = fold(answered);
		expect(snapshot(reloaded, ["contact"])).toEqual(snapshot(live, ["contact"]));
		expect(reloaded.surface("contact")?.dataModel.get("/name")).toBe("Ann");
	});

	it("keeps what the person typed while the transcript only grows", () => {
		const session = fold([assistant("c1", FORM)]);
		let notified = 0;
		session.subscribe(() => notified++);
		session.surface("contact")?.dataModel.set("/name", "Bo");
		session.sync(a2uiCalls([assistant("c1", FORM)]));
		expect(notified).toBe(0);
		session.sync(a2uiCalls([assistant("c1", FORM), result("c1", { dismissed: true }), assistant("c2", CHART)]));
		expect(session.surface("contact")?.dataModel.get("/name")).toBe("Bo");
		expect(session.owner("chart")).toBe("c2");
		expect(notified).toBe(1);
	});

	it("drops a call the bridge refused, even after it was drawn while streaming", () => {
		const session = new A2uiSession("en-US");
		session.sync(a2uiCalls([], [{ id: "c1", key: "c1", args: { messages: [...CHART, {}] } }]));
		expect(session.surface("chart")).toBeDefined();
		session.sync(a2uiCalls([assistant("c1", CHART), result("c1", { errors: [{ code: "INTEGRITY_ERROR" }] }, true)]));
		expect(session.surface("chart")).toBeUndefined();
		expect(session.call("c1")).toBeUndefined();
	});

	it("rebuilds in transcript order when an older page brings earlier calls", () => {
		const session = fold([assistant("c2", [env({ updateDataModel: { surfaceId: "chart", value: { n: 2 } } })])]);
		expect(session.call("c2")?.errors.map(e => e.error.code)).toEqual(["INTEGRITY_ERROR"]);
		session.sync(
			a2uiCalls([
				assistant("c1", CHART),
				assistant("c2", [env({ updateDataModel: { surfaceId: "chart", value: { n: 2 } } })]),
			]),
		);
		expect(session.call("c2")?.errors).toEqual([]);
		expect(session.surface("chart")?.dataModel.get("/")).toEqual({ n: 2 });
	});

	it("hands a pressed button's action, with its resolved context, to its listeners", async () => {
		const session = fold([
			assistant("c1", [
				env({ createSurface: { surfaceId: "s", catalogId: A2UI_CATALOG_ID } }),
				env({
					updateComponents: {
						surfaceId: "s",
						components: [
							{
								id: "root",
								component: "Button",
								child: "l",
								action: { event: { name: "go", context: { who: { "@path": "/who" } } } },
							},
							{ id: "l", component: "Text", text: "Go" },
						],
					},
				}),
				env({ updateDataModel: { surfaceId: "s", value: { who: "Ann" } } }),
			]),
		]);
		const actions: unknown[] = [];
		session.onAction(action => void actions.push(action));
		const root = getValue(new NodeResolver(session.surface("s") as never).rootNode);
		await (getValue(root?.props ?? ({} as never)) as { action: () => Promise<void> }).action();
		expect(actions).toMatchObject([
			{ name: "go", surfaceId: "s", sourceComponentId: "root", context: { who: "Ann" } },
		]);
	});
});
