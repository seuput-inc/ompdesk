/**
 * A session's A2UI surfaces, folded from its transcript (docs/design/a2ui.md §2 › Streaming and replay).
 *
 * The transcript is the only state: the surfaces are the `a2ui` tool calls' `messages` in transcript order through
 * one web_core `MessageProcessor`, plus each answered call's submitted data model on top, so every view and every
 * reload rebuilds the same surfaces. `sync` applies only what is new, so what the person typed (the processor's data
 * model) survives a transcript that only grew; anything else rebuilds from scratch.
 */

import {
	type ActionPayload,
	MessageProcessor,
	RELAXED_VALIDATION,
	type RendererErrorMessage,
	type SurfaceModel,
} from "@a2ui/web_core";
import type { AgentMessage } from "../../../shared/rpc-types";
import { createA2uiCatalog } from "./catalog";

const TOOL_NAME = "a2ui";
const ENVELOPE_KINDS = ["createSurface", "updateComponents", "updateDataModel", "deleteSurface"] as const;

/** The person's action as the bridge's tool result carries it (`details.action`, `modes/a2ui-contracts.ts`). */
export interface A2uiAnswer {
	surfaceId?: string;
	sourceComponentId?: string;
	/** That surface's whole data model as the person sent it (only for a surface with `sendDataModel`). */
	dataModel?: unknown;
	[key: string]: unknown;
}

/** One `a2ui` tool call as the transcript holds it. */
export interface A2uiCall {
	/** The stock call id; providers may reuse one within a session. */
	id: string;
	/** Unique per call: the id for its first occurrence in transcript order, `<id>#<n>` for the n-th repeat. */
	key: string;
	/** The call's `messages` argument, as far as it arrived. */
	messages: readonly unknown[];
	/** Its arguments are still streaming: the last element may be cut off. */
	streaming: boolean;
	/** The bridge refused the payload, so nothing of it was shown. */
	refused: boolean;
	answer?: A2uiAnswer;
}

/** A call whose arguments are still streaming (the tools store's pending entry). */
export interface A2uiStreamingCall {
	id: string;
	args: Record<string, unknown>;
}

/** What one call drew: the surfaces it touched and what of it could not be applied. */
export interface A2uiCallState {
	surfaces: ReadonlySet<string>;
	errors: readonly RendererErrorMessage[];
}

type Step = { kind: "envelope"; value: unknown } | { kind: "answer"; surfaceId: string; dataModel: object };

const messagesOf = (args: Record<string, unknown>): readonly unknown[] =>
	Array.isArray(args.messages) ? args.messages : [];

/**
 * The `a2ui` calls of a transcript in order, then the calls still streaming. A result pairs with the newest call of
 * its id that has none yet, because some providers reuse call ids.
 */
export function a2uiCalls(
	transcript: readonly AgentMessage[],
	streaming: readonly A2uiStreamingCall[] = [],
): A2uiCall[] {
	const calls: A2uiCall[] = [];
	const unanswered = new Map<string, number>();
	const occurrences = new Map<string, number>();
	const add = (id: string, args: Record<string, unknown>, isStreaming: boolean): number => {
		const n = occurrences.get(id) ?? 0;
		occurrences.set(id, n + 1);
		const key = n === 0 ? id : `${id}#${n}`;
		calls.push({ id, key, messages: messagesOf(args), streaming: isStreaming, refused: false });
		return calls.length - 1;
	};
	for (const message of transcript) {
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type === "toolCall" && block.name === TOOL_NAME) {
					unanswered.set(block.id, add(block.id, block.arguments, false));
				}
			}
		} else if (message.role === "toolResult" && message.toolName === TOOL_NAME && message.toolCallId) {
			const at = unanswered.get(message.toolCallId);
			const call = at === undefined ? undefined : calls[at];
			if (at === undefined || !call) continue;
			unanswered.delete(message.toolCallId);
			const details = isObject(message.details) ? message.details : undefined;
			// A refused payload returns `{errors}`; a Stop throws, with no details, and its card stays drawn.
			if (message.isError && Array.isArray(details?.errors)) calls[at] = { ...call, refused: true };
			else if (!message.isError && isObject(details?.action)) calls[at] = { ...call, answer: details.action };
		}
	}
	// A streaming call whose id's newest transcript call is still unanswered is that call; otherwise it is a new one.
	for (const call of streaming) {
		if (!unanswered.has(call.id)) add(call.id, call.args, true);
	}
	return calls;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stepsOf(call: A2uiCall): Step[] {
	// While the arguments stream, the last element may be an envelope cut off mid-way: it waits for the next one.
	const complete = call.streaming ? call.messages.slice(0, -1) : call.messages;
	const steps: Step[] = complete.map(value => ({ kind: "envelope", value }));
	const { answer } = call;
	if (answer && typeof answer.surfaceId === "string" && isObject(answer.dataModel)) {
		steps.push({ kind: "answer", surfaceId: answer.surfaceId, dataModel: answer.dataModel });
	}
	return steps;
}

/** The surface an A2UI v1.0 envelope of an allowed kind names, or the reason it is not one. */
function envelopeTarget(value: unknown): { surfaceId: string; kind: (typeof ENVELOPE_KINDS)[number] } | string {
	if (!isObject(value) || value.version !== "1.0") return "not an A2UI v1.0 message";
	const kinds = ENVELOPE_KINDS.filter(kind => kind in value);
	const kind = kinds[0];
	if (kinds.length !== 1 || !kind || Object.keys(value).length !== 2) {
		return `a message must hold exactly one of ${ENVELOPE_KINDS.join(", ")}`;
	}
	const body = value[kind];
	if (!isObject(body) || typeof body.surfaceId !== "string") return `${kind} names no surfaceId`;
	return { surfaceId: body.surfaceId, kind };
}

interface Applied {
	id: string;
	steps: number;
}

export class A2uiSession {
	readonly #locale: string;
	#processor: MessageProcessor;
	#applied: Applied[] = [];
	#calls = new Map<string, { surfaces: Set<string>; errors: RendererErrorMessage[] }>();
	#owners = new Map<string, string>();
	#version = 0;
	readonly #listeners = new Set<() => void>();
	readonly #actionListeners = new Set<(action: ActionPayload) => void>();

	constructor(locale: string) {
		this.#locale = locale;
		this.#processor = this.#createProcessor();
	}

	/** Bumps whenever a surface was created, changed or deleted by `sync`; for `useSyncExternalStore`. */
	get version(): number {
		return this.#version;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	/** Hears every action a surface fires; whether it may reach the agent is the caller's decision. */
	onAction(listener: (action: ActionPayload) => void): () => void {
		this.#actionListeners.add(listener);
		return () => this.#actionListeners.delete(listener);
	}

	surface(surfaceId: string): SurfaceModel | undefined {
		return this.#processor.getSurface(surfaceId);
	}

	/** The `key` of the newest call that touched the surface: the one card that draws it. */
	owner(surfaceId: string): string | undefined {
		return this.#owners.get(surfaceId);
	}

	/** What the call with this `key` (`A2uiCall.key`) drew. */
	call(key: string): A2uiCallState | undefined {
		return this.#calls.get(key);
	}

	sync(calls: readonly A2uiCall[]): void {
		const plan = calls.filter(call => !call.refused).map(call => ({ id: call.key, steps: stepsOf(call) }));
		const last = this.#applied.length - 1;
		const grows =
			this.#applied.length <= plan.length &&
			this.#applied.every((done, i) => {
				const next = plan[i];
				// Only the newest applied call can still grow (streaming, then its answer); the others are settled.
				return (
					next?.id === done.id && (i === last ? next.steps.length >= done.steps : next.steps.length === done.steps)
				);
			});
		let changed = false;
		if (!grows) {
			this.#reset();
			changed = true;
		}
		for (const [i, { id, steps }] of plan.entries()) {
			const done = this.#applied[i]?.steps ?? 0;
			if (done === steps.length && this.#applied[i]) continue;
			for (const step of steps.slice(done)) this.#apply(id, step);
			this.#applied[i] = { id, steps: steps.length };
			changed = true;
		}
		if (changed) this.#notify();
	}

	dispose(): void {
		this.#processor.dispose();
		this.#listeners.clear();
		this.#actionListeners.clear();
	}

	#createProcessor(): MessageProcessor {
		// No `outboundListener`: a function the catalog does not implement fails here and never reaches the agent.
		// Relaxed: a surface draws from its root while children still stream, and an unknown component is a
		// placeholder node (an older renderer than the host's bridge), never an element by that name.
		return new MessageProcessor([createA2uiCatalog(this.#locale)], action => this.#action(action), {
			version: "v1.0",
			validationConfig: { ...RELAXED_VALIDATION, targetVersion: "v1.0", allowedMessages: [...ENVELOPE_KINDS] },
		});
	}

	#action(action: ActionPayload): void {
		for (const listener of this.#actionListeners) listener(action);
	}

	#reset(): void {
		this.#processor.dispose();
		this.#processor = this.#createProcessor();
		this.#applied = [];
		this.#calls.clear();
		this.#owners.clear();
	}

	#apply(callId: string, step: Step): void {
		let state = this.#calls.get(callId);
		if (!state) {
			state = { surfaces: new Set(), errors: [] };
			this.#calls.set(callId, state);
		}
		if (step.kind === "answer") {
			const errors = this.#processor.processMessagesWithErrors({
				version: "1.0",
				updateDataModel: { surfaceId: step.surfaceId, value: step.dataModel },
			});
			state.errors.push(...errors);
			return;
		}
		const target = envelopeTarget(step.value);
		if (typeof target === "string") {
			state.errors.push({ version: "1.0", error: { code: "VALIDATION_FAILED", path: "/", message: target } });
			return;
		}
		const errors = this.#processor.processMessagesWithErrors(step.value);
		state.errors.push(...errors);
		if (errors.length > 0) return;
		state.surfaces.add(target.surfaceId);
		if (target.kind === "deleteSurface") this.#owners.delete(target.surfaceId);
		else this.#owners.set(target.surfaceId, callId);
	}

	#notify(): void {
		this.#version++;
		for (const listener of this.#listeners) listener();
	}
}
