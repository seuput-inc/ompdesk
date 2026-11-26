/**
 * A2UI's pure rules (docs/design/a2ui.md §1, §4): what the `a2ui` tool accepts. The schema check is stock's JSON-Schema
 * validator over the merged v1.0 schema (`a2ui-schema.json`, scripts/gen-a2ui-schema.ts), injected so this file stays
 * free of omp. On top of it, what the schema cannot say or stock does not enforce:
 * - stock treats `unevaluatedProperties` as permissive, so unknown component properties and unknown function-call keys
 *   and arguments are refused here (the renderer's web_core would refuse them, and the person would see a broken card);
 * - stock compiles `\p{…}` patterns without the `u` flag, so metadata extension keys and component ids (UAX #31) are
 *   checked here;
 * - the state rules: one `root`, every child reference resolves, no cycles, surface ids unique in the session, a surface
 *   changes only in the turn that created it, and the size caps.
 * No agent-invoked renderer functions: `callRendererFunction` and `agentFunctionResponse` are refused.
 */
import catalog from "./a2ui-catalog.json";
import { A2UI_CATALOG_ID, type A2uiAction, type A2uiError, type A2uiToolDetails } from "./a2ui-contracts";
import schema from "./a2ui-schema.json";

type Rec = Record<string, unknown>;

export interface SchemaIssue {
	path: PropertyKey[];
	message: string;
	fromUnionBranch?: boolean;
}
/** Stock's `validateJsonSchemaValue(schema, value, root)`. */
export type SchemaValidate = (
	schema: unknown,
	value: unknown,
	root: unknown,
) => { success: boolean; issues: SchemaIssue[] };

export const A2UI_LIMITS = {
	messagesBytes: 256 * 1024,
	components: 200,
	depth: 20,
	dataModelBytes: 256 * 1024,
	/** Errors reported per call: enough to fix several at once, few enough to read. */
	errors: 8,
} as const;

/** An earlier `a2ui` call on the session's branch. */
export interface PriorCall {
	messages: unknown;
	/** It returned without error: what it sent was drawn. */
	ok: boolean;
	/** It belongs to the current turn (after the latest user message). */
	sameTurn: boolean;
	/** It sits before this call in the same assistant message: stock runs the two side by side, unordered. */
	sibling?: boolean;
}

export interface CheckResult {
	errors: A2uiError[];
	/** Surfaces this call created or changed and that still exist after it. */
	touched: string[];
	/** A touched surface holds a component whose action sends an event to the agent: the call waits for the person. */
	interactive: boolean;
}

interface Surface {
	components: Map<string, Rec>;
	dataModel: unknown;
}

const KINDS = ["createSurface", "updateComponents", "updateDataModel", "deleteSurface"] as const;
type Kind = (typeof KINDS)[number];
const REFUSED_KINDS: Record<string, string> = {
	callRendererFunction: "OMPdesk runs no renderer function for the agent; send only surface messages.",
	agentFunctionResponse: "OMPdesk's surfaces call no agent function; there is nothing to answer.",
};
const V08_KINDS = ["surfaceUpdate", "beginRendering", "dataModelUpdate"];
const UAX31 = /^[\p{XID_Start}_][\p{XID_Continue}]*$/u;
/** Pointer steps that would reach Object.prototype in omp's process (prototype pollution). */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const DEFS: Record<string, Rec> = schema.$defs;
const COMPONENTS: Record<string, Rec> = catalog.components;
const FUNCTIONS: Record<string, Rec> = catalog.functions;
export const A2UI_COMPONENT_NAMES = Object.keys(COMPONENTS);

function isRec(value: unknown): value is Rec {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolve(node: unknown): Rec {
	if (!isRec(node)) return {};
	const ref = node.$ref;
	if (typeof ref === "string" && ref.startsWith("#/$defs/")) return resolve(DEFS[ref.slice("#/$defs/".length)]);
	return node;
}

/** Every property name a schema node declares, through `$ref` and `allOf`. */
function declaredKeys(node: unknown, into = new Set<string>()): Set<string> {
	const target = resolve(node);
	if (isRec(target.properties)) for (const key of Object.keys(target.properties)) into.add(key);
	if (Array.isArray(target.allOf)) for (const part of target.allOf) declaredKeys(part, into);
	return into;
}

type RefPath = { path: string[]; list: boolean };

/** Where a component schema holds child ids: `ComponentId`/`Child` (one) and `ChildList` (an array or a template). */
function refPaths(node: unknown, path: string[] = [], out: RefPath[] = []): RefPath[] {
	if (!isRec(node)) return out;
	const ref = node.$ref;
	if (ref === "#/$defs/ComponentId" || ref === "#/$defs/Child") out.push({ path, list: false });
	else if (ref === "#/$defs/ChildList") out.push({ path, list: true });
	if (isRec(node.properties)) {
		for (const [key, child] of Object.entries(node.properties)) refPaths(child, [...path, key], out);
	}
	if (Array.isArray(node.allOf)) for (const part of node.allOf) refPaths(part, path, out);
	if (isRec(node.items)) refPaths(node.items, [...path, "*"], out);
	return out;
}

const COMMON_KEYS = declaredKeys(DEFS.ComponentCommon);
const COMPONENT_KEYS = new Map(
	A2UI_COMPONENT_NAMES.map(name => [name, declaredKeys(DEFS[`catalog_component_${name}`], new Set(COMMON_KEYS))]),
);
const COMPONENT_REFS = new Map(
	A2UI_COMPONENT_NAMES.map(name => [
		name,
		refPaths(DEFS[`catalog_component_${name}`]).filter(ref => ref.path[0] !== "id"),
	]),
);
const FUNCTION_ARGS = new Map<string, Set<string>>([
	...Object.entries(FUNCTIONS).map(([name, def]): [string, Set<string>] => [
		name,
		declaredKeys(isRec(def.properties) ? def.properties.args : undefined),
	]),
	[
		"@index",
		declaredKeys(isRec(DEFS.IndexSystemFunction.properties) ? DEFS.IndexSystemFunction.properties.args : undefined),
	],
]);

function pointer(path: readonly PropertyKey[]): string {
	return path.map(part => `/${String(part).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

function byteLength(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value) ?? "").length;
}

/** The ids a component names as children, with where. */
function childRefs(component: Rec): Array<{ id: unknown; path: string[] }> {
	const refs: Array<{ id: unknown; path: string[] }> = [];
	const walk = (value: unknown, rest: string[], at: string[], list: boolean) => {
		if (rest.length === 0) {
			if (!list) refs.push({ id: value, path: at });
			else if (Array.isArray(value)) {
				for (const [index, id] of value.entries()) refs.push({ id, path: [...at, String(index)] });
			} else if (isRec(value)) refs.push({ id: value.componentId, path: [...at, "componentId"] });
			return;
		}
		const [head, ...tail] = rest;
		if (head === "*") {
			if (Array.isArray(value)) {
				for (const [index, item] of value.entries()) walk(item, tail, [...at, String(index)], list);
			}
		} else if (isRec(value) && value[head] !== undefined) walk(value[head], tail, [...at, head], list);
	};
	for (const ref of COMPONENT_REFS.get(String(component.component)) ?? []) walk(component, ref.path, [], ref.list);
	return refs;
}

/** Function calls anywhere in a component: their keys and arguments are the catalog's, and their catalog is ours. */
function checkCalls(value: unknown, path: string[], report: (path: string[], message: string) => void): void {
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) checkCalls(item, [...path, String(index)], report);
		return;
	}
	if (!isRec(value)) return;
	const name = value["@call"];
	const args = typeof name === "string" ? FUNCTION_ARGS.get(name) : undefined;
	if (args) {
		for (const key of Object.keys(value)) {
			if (key === "@call" || key === "args") continue;
			if (key === "catalogId" && name !== "@index") {
				if (value.catalogId !== A2UI_CATALOG_ID)
					report([...path, key], `Only ${A2UI_CATALOG_ID} is available here.`);
				continue;
			}
			report([...path, key], `Function call "${name}" takes no "${key}" property.`);
		}
		if (isRec(value.args)) {
			for (const key of Object.keys(value.args)) {
				if (!args.has(key)) report([...path, "args", key], `"${name}" takes no argument "${key}".`);
			}
			// The schema's `format: uri`, which stock does not check; OMPdesk opens only web pages.
			const url = value.args.url;
			if (name === "openUrl" && typeof url === "string" && !/^https?:\/\/[^\s/]+/i.test(url)) {
				report([...path, "args", "url"], "openUrl opens only an http(s) address.");
			}
		}
	}
	for (const [key, item] of Object.entries(value)) checkCalls(item, [...path, key], report);
}

/** Metadata extensions: the schema's UAX #31 key rule, which stock cannot check. */
function checkMetadata(value: unknown, path: string[], report: (path: string[], message: string) => void): void {
	if (!isRec(value)) {
		report(path, "Metadata must be an object.");
		return;
	}
	for (const [key, extensions] of Object.entries(value)) {
		if (key !== "extensions") {
			report([...path, key], `Metadata holds only "extensions", not "${key}".`);
			continue;
		}
		if (!isRec(extensions)) {
			report([...path, key], "Extensions must be an object.");
			continue;
		}
		for (const name of Object.keys(extensions)) {
			if (!UAX31.test(name)) report([...path, key, name], `Extension name "${name}" is not a Unicode identifier.`);
		}
	}
}

/** A JSON Pointer's unescaped tokens (`/` and `""` are the root). */
function pointerTokens(path: string | undefined): string[] {
	return (path ?? "/")
		.split("/")
		.slice(1)
		.filter(token => token !== "")
		.map(token => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** Sets `value` at a JSON Pointer with the spec's upsert rules (`null` removes). An unsafe token changes nothing. */
function setAt(root: unknown, path: string | undefined, value: unknown): unknown {
	const tokens = pointerTokens(path);
	if (tokens.some(token => UNSAFE_KEYS.has(token))) return root;
	if (tokens.length === 0) return value === null ? {} : structuredClone(value);
	const top: Rec = isRec(root) ? root : {};
	let node: Rec | unknown[] = top;
	for (const [index, token] of tokens.entries()) {
		const last = index === tokens.length - 1;
		if (Array.isArray(node)) {
			const at = Number(token);
			if (last) {
				if (value === null) node.splice(at, 1);
				else node[at] = structuredClone(value);
				break;
			}
			const next: unknown = node[at];
			node = node[at] = isRec(next) || Array.isArray(next) ? next : {};
		} else {
			if (last) {
				if (value === null) delete node[token];
				else node[token] = structuredClone(value);
				break;
			}
			const next: unknown = node[token];
			node = node[token] = isRec(next) || Array.isArray(next) ? next : {};
		}
	}
	return top;
}

/** A valid envelope's kind, body and surface. */
function bodyOf(envelope: unknown): { kind: Kind; body: Rec; id: string } | undefined {
	if (!isRec(envelope)) return undefined;
	const kind = KINDS.find(name => name in envelope);
	const body = kind ? envelope[kind] : undefined;
	return kind && isRec(body) ? { kind, body, id: String(body.surfaceId) } : undefined;
}

/** Applies a valid envelope to the session state. */
function apply(envelope: unknown, turn: Map<string, Surface>, alive: Set<string>): void {
	const parsed = bodyOf(envelope);
	if (!parsed) return;
	const { kind, body, id } = parsed;
	if (kind === "createSurface") {
		alive.add(id);
		const surface: Surface = { components: new Map(), dataModel: {} };
		turn.set(id, surface);
		if (body.dataModel !== undefined) surface.dataModel = structuredClone(body.dataModel);
		for (const component of Array.isArray(body.components) ? body.components : []) {
			if (isRec(component)) surface.components.set(String(component.id), component);
		}
		return;
	}
	if (kind === "deleteSurface") {
		alive.delete(id);
		turn.delete(id);
		return;
	}
	const surface = turn.get(id);
	if (!surface) return;
	if (kind === "updateComponents") {
		for (const component of Array.isArray(body.components) ? body.components : []) {
			if (isRec(component)) surface.components.set(String(component.id), component);
		}
	} else
		surface.dataModel = setAt(surface.dataModel, typeof body.path === "string" ? body.path : undefined, body.value);
}

/** One envelope's shape: its kind, the catalog, unknown keys, and the schema. */
function checkEnvelope(envelope: unknown, at: string[], validate: SchemaValidate, errors: A2uiError[]): void {
	const report = (path: string[], message: string, surfaceId?: string) =>
		errors.push({
			code: "VALIDATION_FAILED",
			...(surfaceId ? { surfaceId } : {}),
			path: pointer([...at, ...path]),
			message,
		});
	if (!isRec(envelope)) {
		report([], "Each message must be an object.");
		return;
	}
	const refused = Object.keys(REFUSED_KINDS).find(key => key in envelope);
	if (refused) {
		report([refused], REFUSED_KINDS[refused]);
		return;
	}
	if (V08_KINDS.some(key => key in envelope)) {
		report(
			[],
			"This is A2UI v0.8. Send v1.0 messages: createSurface, updateComponents, updateDataModel, deleteSurface.",
		);
		return;
	}
	if (envelope.version !== "1.0") {
		report(["version"], 'Every message needs "version": "1.0".');
		return;
	}
	const kinds = KINDS.filter(kind => kind in envelope);
	if (kinds.length !== 1) {
		report([], `A message holds exactly one of ${KINDS.join(", ")}.`);
		return;
	}
	const kind = kinds[0];
	const body = envelope[kind];
	if (!isRec(body)) {
		report([kind], `${kind} must be an object.`);
		return;
	}
	const surfaceId = typeof body.surfaceId === "string" ? body.surfaceId : undefined;
	const local = (path: string[], message: string) => report([kind, ...path], message, surfaceId);
	if (
		kind === "updateDataModel" &&
		pointerTokens(typeof body.path === "string" ? body.path : undefined).some(token => UNSAFE_KEYS.has(token))
	) {
		local(["path"], "A data model path cannot step through __proto__, constructor or prototype.");
	}
	// Strip what stock cannot validate (UAX #31 patterns), after checking it here.
	const stripped: Rec = { ...body };
	if (kind === "createSurface") {
		if (body.catalogId !== undefined && body.catalogId !== A2UI_CATALOG_ID) {
			local(["catalogId"], `Only ${A2UI_CATALOG_ID} is available here (or leave catalogId out).`);
		}
		if ("metadata" in body) checkMetadata(body.metadata, [kind, "metadata"], local);
		delete stripped.metadata;
	}
	const components = body.components;
	if (Array.isArray(components)) {
		stripped.components = components.map((component, index) => {
			const path = ["components", String(index)];
			if (!isRec(component)) return component;
			const type = component.component;
			if (typeof type !== "string" || !COMPONENT_KEYS.has(type)) {
				local(
					[...path, "component"],
					`Unknown component ${JSON.stringify(type)}. OMPdesk draws: ${A2UI_COMPONENT_NAMES.join(", ")}.`,
				);
				return component;
			}
			if (typeof component.id !== "string" || !UAX31.test(component.id)) {
				local(
					[...path, "id"],
					`Component id ${JSON.stringify(component.id)} must be an identifier: letters, digits and _, not starting with a digit.`,
				);
			}
			const allowed = COMPONENT_KEYS.get(type) ?? new Set<string>();
			for (const key of Object.keys(component)) {
				if (!allowed.has(key)) local([...path, key], `${type} has no property "${key}".`);
			}
			if (component["@catalogId"] !== undefined && component["@catalogId"] !== A2UI_CATALOG_ID) {
				local([...path, "@catalogId"], `Only ${A2UI_CATALOG_ID} is available here.`);
			}
			if ("@metadata" in component) checkMetadata(component["@metadata"], [...path, "@metadata"], local);
			checkCalls(component, path, local);
			const { "@metadata": _metadata, ...rest } = component;
			// One component against its own schema: pointed errors instead of a failed oneOf over the catalog.
			const own = validate(
				{ allOf: [{ $ref: "#/$defs/ComponentCommon" }, { $ref: `#/$defs/catalog_component_${type}` }] },
				rest,
				schema,
			);
			for (const issue of pickIssues(own.issues)) local([...path, ...issue.path.map(String)], issue.message);
			return rest;
		});
	}
	if (errors.length > 0) return;
	const whole = validate(schema, { ...envelope, [kind]: stripped }, schema);
	if (!whole.success)
		for (const issue of pickIssues(whole.issues)) report(issue.path.map(String), issue.message, surfaceId);
}

/** The issues worth showing: outside failed union branches first, else the deepest (most specific) guesses. */
function pickIssues(issues: readonly SchemaIssue[]): SchemaIssue[] {
	const direct = issues.filter(issue => !issue.fromUnionBranch);
	if (direct.length > 0) return direct.slice(0, 3);
	const deepest = Math.max(0, ...issues.map(issue => issue.path.length));
	return issues.filter(issue => issue.path.length === deepest).slice(0, 3);
}

/** A surface the call left: one root, references that resolve, no cycles, bounded size and depth. */
function checkSurface(id: string, surface: Surface, errors: A2uiError[]): void {
	const fail = (path: string, message: string, code: A2uiError["code"] = "VALIDATION_FAILED") =>
		errors.push({ code, surfaceId: id, path, message });
	if (surface.components.size > A2UI_LIMITS.components) {
		fail("", `Surface ${id} has ${surface.components.size} components; at most ${A2UI_LIMITS.components}.`);
	}
	if (byteLength(surface.dataModel) > A2UI_LIMITS.dataModelBytes) {
		fail("", `Surface ${id}'s data model is over ${A2UI_LIMITS.dataModelBytes / 1024} KB.`);
	}
	if (!surface.components.has("root")) {
		fail("", `Surface ${id} has no component with id "root"; it is what the surface shows.`, "INTEGRITY_ERROR");
		return;
	}
	for (const [componentId, component] of surface.components) {
		for (const ref of childRefs(component)) {
			if (typeof ref.id !== "string" || !surface.components.has(ref.id)) {
				fail(
					`/${componentId}/${ref.path.join("/")}`,
					`${componentId} names child ${JSON.stringify(ref.id)}, which this surface does not have.`,
					"INTEGRITY_ERROR",
				);
			}
		}
	}
	const visit = (componentId: string, trail: string[]): boolean => {
		if (trail.includes(componentId)) {
			fail(
				`/${componentId}`,
				`Components ${[...trail, componentId].join(" → ")} contain each other.`,
				"INTEGRITY_ERROR",
			);
			return false;
		}
		if (trail.length >= A2UI_LIMITS.depth) {
			fail(`/${componentId}`, `Surface ${id} nests deeper than ${A2UI_LIMITS.depth} levels.`);
			return false;
		}
		const component = surface.components.get(componentId);
		if (!component) return true;
		for (const ref of childRefs(component)) {
			if (typeof ref.id === "string" && !visit(ref.id, [...trail, componentId])) return false;
		}
		return true;
	};
	visit("root", []);
}

function hasEventAction(surface: Surface): boolean {
	return [...surface.components.values()].some(component => isRec(component.action) && isRec(component.action.event));
}

/** The messages' shape alone (no session state): each envelope against the schema, the catalog and the caps. */
export function checkA2uiMessages(messages: unknown, validate: SchemaValidate): A2uiError[] {
	const errors: A2uiError[] = [];
	if (!Array.isArray(messages) || messages.length === 0) {
		errors.push({
			code: "VALIDATION_FAILED",
			path: "/messages",
			message: "messages must be a non-empty array of A2UI v1.0 messages.",
		});
	} else if (byteLength(messages) > A2UI_LIMITS.messagesBytes) {
		errors.push({
			code: "VALIDATION_FAILED",
			path: "/messages",
			message: `messages are over ${A2UI_LIMITS.messagesBytes / 1024} KB; send a smaller surface.`,
		});
	} else {
		for (const [index, envelope] of messages.entries()) {
			checkEnvelope(envelope, ["messages", String(index)], validate, errors);
		}
	}
	return errors.slice(0, A2UI_LIMITS.errors);
}

/**
 * Checks one call's `messages` against the catalog and the session's earlier calls; nothing is drawn unless `errors` is
 * empty.
 */
export function checkA2uiCall(messages: unknown, prior: readonly PriorCall[], validate: SchemaValidate): CheckResult {
	const shape = checkA2uiMessages(messages, validate);
	if (shape.length > 0 || !Array.isArray(messages)) return { errors: shape, touched: [], interactive: false };
	if (prior.some(call => call.sibling)) {
		const message =
			"Send one a2ui call per message: stock runs calls of one message side by side, so this one's surfaces would race the earlier call's. Put every surface message in that one call.";
		return { errors: [{ code: "INTEGRITY_ERROR", path: "/messages", message }], touched: [], interactive: false };
	}
	const errors: A2uiError[] = [];
	const done = (): CheckResult => ({ errors: errors.slice(0, A2UI_LIMITS.errors), touched: [], interactive: false });

	// The session so far: surface ids alive in it, and this turn's surfaces in full.
	const alive = new Set<string>();
	const turn = new Map<string, Surface>();
	for (const call of prior) {
		if (!call.ok || !Array.isArray(call.messages)) continue;
		for (const envelope of call.messages) {
			const parsed = bodyOf(envelope);
			if (!parsed) continue;
			if (call.sameTurn) apply(envelope, turn, alive);
			else if (parsed.kind === "createSurface") alive.add(parsed.id);
			else if (parsed.kind === "deleteSurface") alive.delete(parsed.id);
		}
	}
	const touched = new Set<string>();
	for (const [index, envelope] of messages.entries()) {
		const parsed = bodyOf(envelope);
		if (!parsed) continue;
		const { kind, id } = parsed;
		const path = `/messages/${index}/${kind}/surfaceId`;
		if (kind === "createSurface" && alive.has(id)) {
			errors.push({
				code: "INTEGRITY_ERROR",
				surfaceId: id,
				path,
				message: `Surface ${id} already exists in this session; use a new surfaceId.`,
			});
			continue;
		}
		if (kind !== "createSurface" && !turn.has(id)) {
			errors.push({
				code: "INTEGRITY_ERROR",
				surfaceId: id,
				path,
				message: alive.has(id)
					? `Surface ${id} belongs to an earlier turn and can no longer change; create a new surface.`
					: `There is no surface ${id} in this turn; create it first.`,
			});
			continue;
		}
		apply(envelope, turn, alive);
		if (kind === "deleteSurface") touched.delete(id);
		else touched.add(id);
	}
	if (errors.length > 0) return done();
	const left = [...touched].flatMap(id => {
		const surface = turn.get(id);
		return surface ? [{ id, surface }] : [];
	});
	for (const { id, surface } of left) checkSurface(id, surface, errors);
	if (errors.length > 0) return done();
	return { errors: [], touched: [...touched], interactive: left.some(({ surface }) => hasEventAction(surface)) };
}

/** The agent-facing text of refused messages. */
export function a2uiErrorText(errors: readonly A2uiError[]): string {
	return [
		"Not shown: the messages are not valid A2UI for OMPdesk. Fix these and call a2ui again.",
		...errors.map(error => JSON.stringify(error)),
	].join("\n");
}

/**
 * Why nobody can press an event button in this session, or undefined when someone can. An unattended run (Autopilot
 * turns `ask` off) or a session without a window would leave the call waiting forever.
 */
export function a2uiUnanswerable(activeTools: readonly string[], canAsk: boolean): A2uiError | undefined {
	const why = !activeTools.includes("ask")
		? "Nobody is there to press a button: this is an unattended run."
		: !canAsk
			? "Nobody can press a button here: this session has no OMPdesk window."
			: undefined;
	if (!why) return undefined;
	return {
		code: "VALIDATION_FAILED",
		path: "/messages",
		message: `${why} Show the surface without an event button, or decide yourself.`,
	};
}

/** One line per component: its props, `*` when required, enum values after `:`. */
function componentLine(name: string): string {
	const def = resolve(DEFS[`catalog_component_${name}`]);
	const parts = [def, ...(Array.isArray(def.allOf) ? def.allOf.map(resolve) : [])];
	const required = new Set(parts.flatMap(part => (Array.isArray(part.required) ? part.required.map(String) : [])));
	const props = parts.flatMap(part =>
		Object.entries(isRec(part.properties) ? part.properties : {})
			.filter(([key]) => key !== "component" && key !== "weight")
			.map(([key, prop]) => {
				const values = isRec(prop) && Array.isArray(prop.enum) ? `: ${prop.enum.join("|")}` : "";
				return `${key}${required.has(key) ? "*" : ""}${values}`;
			}),
	);
	return `${name}(${props.join(", ")})`;
}

const EXAMPLE = [
	{
		version: "1.0",
		createSurface: {
			surfaceId: "deploy_confirm",
			components: [
				{ id: "root", component: "Card", child: "body" },
				{ id: "body", component: "Column", children: ["title", "env", "ok"] },
				{ id: "title", component: "Text", text: "Deploy v2.3 to production?", variant: "body" },
				{
					id: "env",
					component: "ChoicePicker",
					label: "Region",
					options: [
						{ label: "EU", value: "eu" },
						{ label: "US", value: "us" },
					],
					value: { "@path": "/region" },
				},
				{
					id: "ok",
					component: "Button",
					variant: "primary",
					child: "ok_label",
					action: { event: { name: "deploy", context: { region: { "@path": "/region" } } } },
				},
				{ id: "ok_label", component: "Text", text: "Deploy" },
			],
			dataModel: { region: ["eu"] },
		},
	},
];

/** The tool's description: when to use it, the rules, OMPdesk's catalog in one line per component, one example. */
export function a2uiToolDescription(): string {
	return [
		"Show the person a small UI in the chat, drawn with OMPdesk's own controls on their computer and phone (A2UI v1.0): a form to fill in, a confirmation with details, a choice that needs context, a chart. For one quick question use ask; for free drawing use gui_visualize or an svg block.",
		'messages: A2UI v1.0 messages, each {"version":"1.0", <one of createSurface | updateComponents | updateDataModel | deleteSurface>}. A surface is a flat list of components; exactly one has id "root"; containers name children by id (ids: letters, digits, _). Bind values with {"@path":"/json/pointer"}; inputs write to the surface\'s data model.',
		'A Button whose action is {"event":{"name","context":{...}}} makes this call wait until the person presses it; the result is that action with its context resolved (sendDataModel: true on createSurface adds the whole data model). Without such a button the call returns at once.',
		"Surface ids are unique in the session. Change a surface only in the turn that created it; later, create a new one. Never ask for a password or other secret here: answers are kept in the session.",
		`Components (* required): ${A2UI_COMPONENT_NAMES.map(componentLine).join("; ")}.`,
		`Functions ({"@call": name, "args": {...}} in values and in a component's "@checks": [{"condition", "message"}]): ${Object.keys(FUNCTIONS).join(", ")}, @index.`,
		`Example: ${JSON.stringify(EXAMPLE)}`,
	].join("\n");
}

/** Earlier `a2ui` calls on the branch, oldest first, with whether each succeeded and belongs to this turn. */
export function a2uiPriorCalls(entries: readonly unknown[], tool: string, current: string): PriorCall[] {
	const messages = entries.flatMap(entry =>
		isRec(entry) && entry.type === "message" && isRec(entry.message) ? [entry.message] : [],
	);
	const turnStart = messages.findLastIndex(message => message.role === "user");
	const failed = new Map<string, boolean>();
	for (const message of messages) {
		if (message.role === "toolResult" && typeof message.toolCallId === "string")
			failed.set(message.toolCallId, message.isError === true);
	}
	const calls: PriorCall[] = [];
	for (const [index, message] of messages.entries()) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		const blocks = message.content.filter(block => isRec(block) && block.type === "toolCall" && block.name === tool);
		const own = blocks.findIndex(block => isRec(block) && block.id === current);
		for (const [position, block] of blocks.entries()) {
			if (!isRec(block) || position === own || (own >= 0 && position > own)) continue;
			const id = String(block.id);
			calls.push({
				messages: isRec(block.arguments) ? block.arguments.messages : undefined,
				ok: failed.get(id) === false,
				sameTurn: index > turnStart,
				...(own >= 0 ? { sibling: true } : {}),
			});
		}
	}
	return calls;
}

/** The person's answer (the marker form's one field) as the tool's text and details. */
export function a2uiAnswer(raw: unknown): { text: string; details: A2uiToolDetails } {
	const text = typeof raw === "string" ? raw : "";
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = undefined;
	}
	if (
		isRec(parsed) &&
		typeof parsed.name === "string" &&
		typeof parsed.surfaceId === "string" &&
		typeof parsed.sourceComponentId === "string" &&
		isRec(parsed.context)
	) {
		const action: A2uiAction = {
			name: parsed.name,
			surfaceId: parsed.surfaceId,
			sourceComponentId: parsed.sourceComponentId,
			...(typeof parsed.timestamp === "string" ? { timestamp: parsed.timestamp } : {}),
			...(typeof parsed.userMessage === "string" ? { userMessage: parsed.userMessage } : {}),
			context: parsed.context,
			...(isRec(parsed.dataModel) ? { dataModel: parsed.dataModel } : {}),
		};
		return {
			text: [
				`The person pressed ${action.sourceComponentId} (action "${action.name}") on surface ${action.surfaceId}.`,
				...(action.userMessage ? [action.userMessage] : []),
				JSON.stringify(action),
			].join("\n"),
			details: { action },
		};
	}
	return {
		text: `The person answered in text (their OMPdesk showed the surface as a plain question):\n${text}`,
		details: { text },
	};
}
