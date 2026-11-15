import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";

export interface QueuedInstruction {
	id: string;
	text: string;
	images?: ImageContent[];
	state: "ready" | "in_flight" | "approval_safety";
}

export interface InstructionSnapshot {
	instance: string;
	entries: QueuedInstruction[];
}

export type WithdrawnInstruction =
	| { removed: false }
	| {
			removed: true;
			recoveryId: string;
			intent: "draft" | "discard";
			entry: { id: string; text: string; images?: ImageContent[]; envelope: AgentMessage };
	  };

interface QueueSession {
	agent: {
		peekSteeringQueue(): readonly AgentMessage[];
		peekFollowUpQueue(): readonly AgentMessage[];
		peekUndeliveredQueuedMessages(): readonly AgentMessage[];
	};
	heldQueuedMessages: ReadonlySet<AgentMessage>;
	withdrawQueuedMessage(message: AgentMessage): boolean;
}

export interface QueuePresentation {
	isDisplayableQueuedMessage(message: AgentMessage): boolean;
	isUserAuthoredQueuedMessage(message: AgentMessage): boolean;
	toRestoredQueuedMessage(message: AgentMessage): { text: string; images?: ImageContent[] };
}

/** Handles refer only to stock's originals. This owns neither a message queue nor delivery authority. */
export class InstructionQueueView {
	readonly instance = randomUUID();
	readonly #session: QueueSession;
	readonly #presentation: QueuePresentation;
	readonly #approvalBlocked: () => boolean;
	readonly #ids = new WeakMap<AgentMessage, string>();
	#next = 0;

	constructor(session: QueueSession, presentation: QueuePresentation, approvalBlocked: () => boolean) {
		this.#session = session;
		this.#presentation = presentation;
		this.#approvalBlocked = approvalBlocked;
	}

	#originals(): { originals: AgentMessage[]; inFlight: ReadonlySet<AgentMessage> } {
		const inFlight = new Set(this.#session.agent.peekUndeliveredQueuedMessages());
		const originals = [
			...new Set([
				...inFlight,
				...this.#session.agent.peekSteeringQueue(),
				...this.#session.agent.peekFollowUpQueue(),
				...this.#session.heldQueuedMessages,
			]),
		].filter(message => message.role !== "developer" && this.#presentation.isDisplayableQueuedMessage(message));
		// Timestamps belong to original admission, not this view. Stable sorting preserves equal-time queue order.
		originals.sort((a, b) => a.timestamp - b.timestamp);
		return { originals, inFlight };
	}

	#id(message: AgentMessage): string {
		let id = this.#ids.get(message);
		if (id === undefined) {
			id = String(++this.#next);
			this.#ids.set(message, id);
		}
		return id;
	}

	snapshot(): InstructionSnapshot {
		const { originals, inFlight } = this.#originals();
		const blocked = this.#approvalBlocked();
		return {
			instance: this.instance,
			entries: originals.map(message => ({
				id: this.#id(message),
				...this.#presentation.toRestoredQueuedMessage(message),
				state: inFlight.has(message) ? "in_flight" : blocked ? "approval_safety" : "ready",
			})),
		};
	}

	capture(
		instance: string,
		id: string,
	): { id: string; text: string; images?: ImageContent[]; envelope: AgentMessage } | undefined {
		if (instance !== this.instance) throw new Error("The queued instruction belongs to an earlier session instance.");
		const { originals, inFlight } = this.#originals();
		const message = originals.find(original => this.#ids.get(original) === id);
		if (!message || inFlight.has(message) || !this.#presentation.isUserAuthoredQueuedMessage(message))
			return undefined;
		return { id, ...this.#presentation.toRestoredQueuedMessage(message), envelope: message };
	}

	withdrawOriginal(instance: string, id: string, original: AgentMessage): boolean {
		const current = this.capture(instance, id);
		if (!current || current.envelope !== original) return false;
		// The stock operation owns hidden companions and preparation rollback; this view never recreates them.
		return this.#session.withdrawQueuedMessage(original);
	}
}
