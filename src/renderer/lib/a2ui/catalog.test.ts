import { type ComponentNode, getValue, NodeResolver } from "@a2ui/web_core";
import { describe, expect, it, vi } from "vitest";
import catalogDocument from "../../../../resources/gui-bridge/modes/a2ui-catalog.json";
import { createA2uiCatalog } from "./catalog";
import { A2uiSession } from "./session";

const A2UI_CATALOG_ID = catalogDocument.catalogId;

const env = (body: Record<string, unknown>) => ({ version: "1.0", ...body });
const create = (surfaceId = "s") => env({ createSurface: { surfaceId, catalogId: A2UI_CATALOG_ID } });
const components = (list: Record<string, unknown>[], surfaceId = "s") =>
	env({ updateComponents: { surfaceId, components: list } });

function show(messages: unknown[]): A2uiSession {
	const session = new A2uiSession("en-US");
	session.sync([{ id: "call", messages, streaming: false, refused: false }]);
	return session;
}

/** Every node under the surface's root, depth first. */
function nodes(session: A2uiSession, surfaceId = "s"): ComponentNode[] {
	const surface = session.surface(surfaceId);
	if (!surface) throw new Error(`no surface ${surfaceId}`);
	const root = getValue(new NodeResolver(surface).rootNode);
	const out: ComponentNode[] = [];
	const walk = (node: ComponentNode | undefined) => {
		if (!node) return;
		out.push(node);
		const props = getValue(node.props) as { children?: ComponentNode[]; child?: ComponentNode };
		for (const child of props.children ?? []) walk(child);
		walk(props.child);
	};
	walk(root);
	return out;
}

describe("OMPdesk's A2UI catalog", () => {
	it("is the bridge's catalog document, every declared function implemented by the renderer", () => {
		const catalog = createA2uiCatalog("en-US");
		expect(catalog.id).toBe(catalogDocument.catalogId);
		expect([...catalog.components.keys()].sort()).toEqual(Object.keys(catalogDocument.components).sort());
		expect([...catalog.functions.keys()].sort()).toEqual(Object.keys(catalogDocument.functions).sort());
		expect(catalog.agentFunctions.size).toBe(0);
		for (const fn of catalog.functions.values()) expect(typeof fn.execute, fn.name).toBe("function");
	});

	it("opens only http(s) links, through the link opener", () => {
		const open = vi.fn();
		const openUrl = createA2uiCatalog("en-US", open).functions.get("openUrl");
		for (const url of ["javascript:alert(1)", "file:///etc/passwd", "omp://settings", "https://example.com/a"]) {
			openUrl?.execute({ url }, undefined as never);
		}
		expect(open.mock.calls).toEqual([["https://example.com/a"]]);
	});
});

describe("§4 security rules in the renderer", () => {
	it("draws an unknown component as a placeholder node, never an element by that name (rule 1)", () => {
		const session = show([
			create(),
			components([
				{ id: "root", component: "Column", children: ["v", "b"] },
				{ id: "v", component: "Video", url: "https://example.com/v.mp4" },
				{ id: "b", component: "Blink", text: "hi" },
			]),
		]);
		const [, video, blink] = nodes(session);
		expect([video?.state, blink?.state]).toEqual(["unknown-type", "unknown-type"]);
		expect(getValue(video?.props ?? ({} as never))).toEqual({});
	});

	it("keeps an unknown function inside the renderer: no agent routing, no action (rule 2)", async () => {
		const session = show([
			create(),
			components([
				{ id: "root", component: "Column", children: ["t", "b"] },
				{ id: "t", component: "Text", text: { "@call": "readSecrets", args: {} } },
				{ id: "b", component: "Button", child: "bt", action: { functionCall: { "@call": "sendHome", args: {} } } },
				{ id: "bt", component: "Text", text: "Go" },
			]),
		]);
		const surface = session.surface("s");
		expect(surface?.agentFunctionCaller).toBeUndefined();
		const errors: unknown[] = [];
		surface?.onError.subscribe(error => void errors.push(error));
		const actions = vi.fn();
		session.onAction(actions);
		const button = nodes(session).find(node => node.componentId === "b");
		const props = getValue(button?.props ?? ({} as never)) as { action?: () => unknown };
		await Promise.resolve(props.action?.()).catch(() => undefined);
		expect(actions).not.toHaveBeenCalled();
		const text = nodes(session).find(node => node.componentId === "t");
		expect(JSON.stringify(getValue(text?.props ?? ({} as never)))).not.toContain("readSecrets(");
	});

	it("refuses renderer-function calls and messages of other protocol versions (rules 2 and 1)", () => {
		const session = show([
			env({ callRendererFunction: { functionCallId: "f", surfaceId: "s", call: { "@call": "openUrl", args: {} } } }),
			{ surfaceUpdate: { surfaceId: "s", components: [{ id: "root", component: { Text: { text: "x" } } }] } },
			{ version: "0.9", createSurface: { surfaceId: "s", catalogId: A2UI_CATALOG_ID } },
		]);
		expect(session.surface("s")).toBeUndefined();
		expect(session.call("call")?.errors).toHaveLength(3);
	});

	it("takes an image URL only as a literal, so typed input cannot be spelled into it (rule 4)", () => {
		const session = show([
			create(),
			components([
				{ id: "root", component: "Column", children: ["i"] },
				{ id: "i", component: "Image", url: { "@path": "/typed" } },
			]),
		]);
		expect(session.call("call")?.errors.map(e => e.error.code)).toEqual(["VALIDATION_FAILED"]);
		expect(session.surface("s")?.componentsModel.has("i")).toBe(false);
	});

	it("has no password field (rule 5)", () => {
		const session = show([
			create(),
			components([
				{ id: "root", component: "Column", children: ["p"] },
				{ id: "p", component: "TextField", label: "Password", value: { "@path": "/p" }, variant: "obscured" },
			]),
		]);
		expect(session.call("call")?.errors.map(e => e.error.code)).toEqual(["VALIDATION_FAILED"]);
	});
});
