import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	A2UI_ANSWER_MAX_CHARS,
	a2uiMarkerForm,
	a2uiMarkerToolCallId,
} from "../../resources/gui-bridge/modes/a2ui-contracts";
import {
	A2UI_COMPONENT_NAMES,
	a2uiAnswer,
	a2uiPriorCalls,
	a2uiToolDescription,
	checkA2uiCall,
	type PriorCall,
	type SchemaValidate,
} from "../../resources/gui-bridge/modes/a2ui-core";
import { A2UI_SCHEMA_PACKAGE_DIR, a2uiSchemaText, buildA2uiSchema } from "../../scripts/gen-a2ui-schema";

/**
 * The `a2ui` tool's own rules (resources/gui-bridge/modes/a2ui-core.ts). The schema check is stock's validator, run in
 * bridge-a2ui-stock.test.ts; here it always passes, so every refusal below is one of the core's own rules.
 */

const passes: SchemaValidate = () => ({ success: true, issues: [] });

function create(surfaceId: string, components: unknown[], extra: Record<string, unknown> = {}) {
	return { version: "1.0", createSurface: { surfaceId, components, ...extra } };
}
const text = (id: string, value = "hi") => ({ id, component: "Text", text: value });
const column = (id: string, children: string[]) => ({ id, component: "Column", children });
const button = (id: string, child: string) => ({
	id,
	component: "Button",
	child,
	action: { event: { name: "go", context: { pick: { "@path": "/pick" } } } },
});

function check(messages: unknown[], prior: PriorCall[] = []) {
	return checkA2uiCall(messages, prior, passes);
}

describe("an a2ui call", () => {
	it("returns at once for a surface without an event button and waits for one with it", () => {
		expect(check([create("info", [column("root", ["a"]), text("a")])])).toEqual({
			errors: [],
			touched: ["info"],
			interactive: false,
		});
		const form = check([create("form", [column("root", ["b"]), button("b", "l"), text("l", "Go")])]);
		expect(form.errors).toEqual([]);
		expect(form.interactive).toBe(true);
	});

	it("changes a surface only in the turn that created it, and never reuses a surface id", () => {
		const made = { messages: [create("s1", [text("root")])], ok: true, sameTurn: false };
		const update = { version: "1.0", updateDataModel: { surfaceId: "s1", path: "/a", value: 1 } };
		expect(check([update], [made]).errors[0]).toMatchObject({ code: "INTEGRITY_ERROR", surfaceId: "s1" });
		expect(check([update], [made]).errors[0].message).toContain("earlier turn");
		expect(check([create("s1", [text("root")])], [made]).errors[0].message).toContain("already exists");
		expect(check([update], [{ ...made, sameTurn: true }]).errors).toEqual([]);
		// A refused call drew nothing: its surface does not exist.
		expect(check([update], [{ ...made, sameTurn: true, ok: false }]).errors[0].message).toContain("no surface s1");
		// A deleted surface frees its id.
		const deleted = { messages: [{ version: "1.0", deleteSurface: { surfaceId: "s1" } }], ok: true, sameTurn: false };
		expect(check([create("s1", [text("root")])], [made, deleted]).errors).toEqual([]);
	});

	it("needs one root, resolvable children, no cycles and bounded size and depth", () => {
		expect(check([create("s", [text("a")])]).errors[0].message).toContain('"root"');
		expect(check([create("s", [column("root", ["missing"])])]).errors[0].message).toContain('"missing"');
		expect(check([create("s", [column("root", ["a"]), column("a", ["root"])])]).errors[0].message).toContain(
			"contain each other",
		);
		const deep = Array.from({ length: 22 }, (_, index) =>
			column(index === 0 ? "root" : `c${index}`, [`c${index + 1}`]),
		);
		expect(check([create("s", [...deep, text("c22")])]).errors[0].message).toContain("deeper than 20");
		const wide = Array.from({ length: 201 }, (_, index) => text(`t${index}`));
		expect(
			check([
				create("s", [
					column(
						"root",
						wide.map(item => item.id),
					),
					...wide,
				]),
			]).errors[0].message,
		).toContain("at most 200");
		// A template's componentId is a child too.
		const template = { id: "root", component: "List", children: { path: "/rows", componentId: "row" } };
		expect(check([create("s", [template])]).errors[0].message).toContain('"row"');
		expect(check([create("s", [template, text("row")])]).errors).toEqual([]);
	});

	it("refuses what the catalog does not have, with the place it is", () => {
		const first = (messages: unknown[]) => check(messages).errors[0];
		expect(first([create("s", [{ id: "root", component: "Video", url: "x" }])])).toMatchObject({
			path: "/messages/0/createSurface/components/0/component",
		});
		expect(first([create("s", [{ ...text("root"), label: "x" }])]).message).toBe('Text has no property "label".');
		expect(first([create("s", [{ ...text("root"), id: "user-card" }])]).path).toBe(
			"/messages/0/createSurface/components/0/id",
		);
		const extraArg = {
			id: "root",
			component: "TextField",
			label: "Mail",
			value: "",
			"@checks": [{ condition: { "@call": "email", args: { value: "", strict: true } }, message: "m" }],
		};
		expect(first([create("s", [extraArg])]).message).toBe('"email" takes no argument "strict".');
		const link = {
			...button("root", "l"),
			action: { functionCall: { "@call": "openUrl", args: { url: "file:///etc" } } },
		};
		expect(first([create("s", [link, text("l")])]).message).toContain("http(s)");
		expect(first([create("s", [text("root")], { catalogId: "https://example.com/other" })]).path).toBe(
			"/messages/0/createSurface/catalogId",
		);
	});

	it("refuses renderer functions for the agent, v0.8 and unversioned messages", () => {
		const call = { version: "1.0", callRendererFunction: { functionCallId: "f", callFunction: { "@call": "x" } } };
		expect(check([call]).errors[0].path).toBe("/messages/0/callRendererFunction");
		expect(check([{ surfaceUpdate: { surfaceId: "s", components: [] } }]).errors[0].message).toContain("v0.8");
		expect(check([{ createSurface: { surfaceId: "s", components: [text("root")] } }]).errors[0].path).toBe(
			"/messages/0/version",
		);
	});

	it("never writes through __proto__, constructor or prototype in omp's process", () => {
		const made = { messages: [create("s", [text("root")])], ok: true, sameTurn: true };
		for (const path of ["/__proto__/polluted", "/constructor/prototype/polluted"]) {
			const update = { version: "1.0", updateDataModel: { surfaceId: "s", path, value: 1 } };
			expect(check([update], [made]).errors[0].path).toBe("/messages/0/updateDataModel/path");
			// An earlier call is replayed without checks: the write is skipped there too.
			expect(
				check([{ version: "1.0", deleteSurface: { surfaceId: "s" } }], [made, { ...made, messages: [update] }])
					.errors,
			).toEqual([]);
			expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
		}
	});
});

describe("the marker form and the answer", () => {
	it("carries the tool call id through the html", () => {
		for (const id of ["call_abc", 'odd"id<&>']) expect(a2uiMarkerToolCallId(a2uiMarkerForm(id))).toBe(id);
		expect(a2uiMarkerForm("x")).toContain(`maxlength="${A2UI_ANSWER_MAX_CHARS}"`);
		expect(a2uiMarkerToolCallId('<form><textarea name="a"></textarea></form>')).toBeUndefined();
	});

	it("reads the renderer's action, keeps only its fields, and passes free text through", () => {
		const action = {
			name: "go",
			surfaceId: "s",
			sourceComponentId: "b",
			context: { pick: "eu" },
			dataModel: { pick: "eu" },
		};
		const answered = a2uiAnswer(JSON.stringify({ ...action, injected: "x" }));
		expect(answered.details).toEqual({ action });
		expect(answered.text).toContain('pressed b (action "go") on surface s');
		expect(a2uiAnswer("blue, please")).toEqual({
			text: expect.stringContaining("blue, please"),
			details: { text: "blue, please" },
		});
	});
});

describe("earlier calls on the branch", () => {
	it("are the a2ui calls with their outcome and turn, without the current one and the ones after it", () => {
		const call = (id: string) => ({ type: "toolCall", id, name: "a2ui", arguments: { messages: [id] } });
		const entry = (message: Record<string, unknown>) => ({ type: "message", message });
		const entries = [
			entry({ role: "user", content: "one" }),
			entry({ role: "assistant", content: [call("old")] }),
			entry({ role: "toolResult", toolCallId: "old", isError: false }),
			entry({ role: "user", content: "two" }),
			entry({ role: "assistant", content: [call("bad")] }),
			entry({ role: "toolResult", toolCallId: "bad", isError: true }),
			entry({ role: "assistant", content: [call("first"), call("now"), call("later")] }),
		];
		expect(a2uiPriorCalls(entries, "a2ui", "now")).toEqual([
			{ messages: ["old"], ok: true, sameTurn: false },
			{ messages: ["bad"], ok: false, sameTurn: true },
			{ messages: ["first"], ok: false, sameTurn: true, sibling: true },
		]);
		expect(a2uiPriorCalls(entries, "a2ui", "first").filter(prior => prior.sibling)).toEqual([]);
	});

	it("refuse a call that shares its message with an earlier a2ui call: stock runs the two unordered", () => {
		const sibling = { messages: [create("s1", [text("root")])], ok: false, sameTurn: true, sibling: true };
		const update = { version: "1.0", updateDataModel: { surfaceId: "s1", path: "/a", value: 1 } };
		expect(check([update], [sibling]).errors[0].message).toContain("one a2ui call per message");
		expect(check([create("s2", [text("root")])], [sibling]).errors).toHaveLength(1);
	});
});

describe("the tool description", () => {
	it("names every component and fits about 1,200 tokens", () => {
		const description = a2uiToolDescription();
		for (const name of A2UI_COMPONENT_NAMES) expect(description).toContain(`${name}(`);
		expect(description.length).toBeLessThanOrEqual(4_800);
	});
});

const packageSchemas = resolve(A2UI_SCHEMA_PACKAGE_DIR);
describe.skipIf(!existsSync(packageSchemas))("the merged A2UI schema", () => {
	it("is what scripts/gen-a2ui-schema.ts builds from the pinned @a2ui/web_core", () => {
		const committed = readFileSync(join("resources/gui-bridge/modes/a2ui-schema.json"), "utf8");
		expect(a2uiSchemaText(buildA2uiSchema(packageSchemas))).toBe(committed);
	});
});
