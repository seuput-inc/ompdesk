/**
 * A2UI (docs/design/a2ui.md): the contract between the bridge's `a2ui` tool (modes/a2ui.ts) and the renderer that
 * draws its surfaces. Dependency-free: main and the renderer import it.
 *
 * The tool waits for the person through stock's blocking form channel: one `extension_ui_request {method: "form"}`
 * whose html is the marker form below. The renderer finds the call by the marker, draws the surface in the call's
 * card instead of an ask card, and answers `{data: {[A2UI_ANSWER_FIELD]: JSON.stringify(action)}}`. An OMPdesk that does
 * not know the marker shows it as an ordinary one-field ask; its free text comes back as `{text}`.
 */

export const A2UI_TOOL = "a2ui";
export const A2UI_CATALOG_ID = "https://github.com/seuput-inc/ompdesk/a2ui/v1";
export const A2UI_MARKER_ATTRIBUTE = "data-ompdesk-a2ui";
export const A2UI_ANSWER_FIELD = "a2ui_answer";
/** The answer's length cap: stock refuses a longer textarea value (`maxlength`), well under its RPC frame limit. */
export const A2UI_ANSWER_MAX_CHARS = 65_536;

/** The spec's error object (A2UI v1.0 "Standard validation error format", plus the integrity codes). */
export interface A2uiError {
	code: "VALIDATION_FAILED" | "INTEGRITY_ERROR" | "UNALLOWED_PARENT" | "UNALLOWED_CHILD";
	/** The surface the error concerns, when there is one. */
	surfaceId?: string;
	/** JSON Pointer into the tool's arguments (`/messages/0/createSurface/components/2/text`). */
	path: string;
	message: string;
}

/** What the person did: the spec's `action` message, plus the surface's whole data model when it set `sendDataModel`. */
export interface A2uiAction {
	name: string;
	surfaceId: string;
	sourceComponentId: string;
	timestamp?: string;
	userMessage?: string;
	context: Record<string, unknown>;
	/** That one surface's whole data model (present only with `sendDataModel`); the renderer re-applies it on replay. */
	dataModel?: Record<string, unknown>;
}

/**
 * The tool result's `details`, one shape per outcome. `errors` rides a result marked `isError` and nothing was shown
 * (the renderer drops the call from its fold); a stopped call is a thrown error and carries no details.
 */
export type A2uiToolDetails =
	| { errors: A2uiError[] }
	| { shown: string[] }
	| { action: A2uiAction }
	| { dismissed: true }
	/** Free text from an OMPdesk that drew the marker form as an ordinary ask. */
	| { text: string };

function escapeAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The stock html-form the tool asks while its surface waits for the person. */
export function a2uiMarkerForm(toolCallId: string): string {
	return `<form ${A2UI_MARKER_ATTRIBUTE}="${escapeAttribute(toolCallId)}"><p>The agent is waiting for your answer in the form above.</p><textarea name="${A2UI_ANSWER_FIELD}" maxlength="${A2UI_ANSWER_MAX_CHARS}"></textarea></form>`;
}

const MARKER = new RegExp(`^<form ${A2UI_MARKER_ATTRIBUTE}="([^"]*)">`);

/** The tool call a form request waits for, when the request is an a2ui marker form. */
export function a2uiMarkerToolCallId(html: string): string | undefined {
	const id = MARKER.exec(html)?.[1];
	return id === undefined
		? undefined
		: id
				.replace(/&quot;/g, '"')
				.replace(/&lt;/g, "<")
				.replace(/&gt;/g, ">")
				.replace(/&amp;/g, "&");
}
