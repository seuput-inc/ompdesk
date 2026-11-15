import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { InstructionQueueView, WithdrawnInstruction } from "./composer-queue";

export const MANUAL_INSTRUCTION_ENTRY = "ompdesk.manual-instruction";

interface OriginalInstruction {
	id: string;
	text: string;
	images?: ImageContent[];
	envelope: AgentMessage;
}

interface Journal {
	getBranch(): readonly { type: string; customType?: string; data?: unknown }[];
	getSessionFile(): string | undefined;
	ensureOnDisk(): Promise<void>;
	appendCustomEntry(type: string, data: unknown): unknown;
	flush(): Promise<void>;
}

export type ManualIntent = "draft" | "discard";

function manualIntent(value: unknown): ManualIntent {
	if (value !== "draft" && value !== "discard")
		throw new Error("Manual withdrawal requires its original draft or discard intent.");
	return value;
}

interface Prepared {
	recoveryId: string;
	instance: string;
	id: string;
	intent: ManualIntent;
	entry: OriginalInstruction;
}

export type ManualDisposition = { kind: "draft"; draftId: string } | { kind: "discard" };

function disposition(value: unknown): ManualDisposition {
	const data = object(value);
	if (data.kind === "draft") return { kind: "draft", draftId: nonempty(data.draftId) };
	if (data.kind === "discard") return { kind: "discard" };
	throw new Error("Manual recovery needs an explicit draft or discard disposition.");
}

function sameDisposition(left: ManualDisposition, right: ManualDisposition): boolean {
	return (
		left.kind === right.kind &&
		(left.kind === "discard" || (right.kind === "draft" && left.draftId === right.draftId))
	);
}

interface Archived extends Prepared {
	state: "unconfirmed" | "withdrawn" | "not_withdrawn";
	disposition?: ManualDisposition;
}

export interface ManualRecovery {
	recoveryId: string;
	instance: string;
	id: string;
	intent: ManualIntent;
	state: "unconfirmed" | "withdrawn";
	entry: OriginalInstruction;
}

function object(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("The manual instruction archive is damaged; its original record was retained.");
	}
	return value as Record<string, unknown>;
}

function nonempty(value: unknown): string {
	if (typeof value !== "string" || !value) throw new Error("The manual instruction archive has an invalid identity.");
	return value;
}

function prepared(value: Record<string, unknown>): Prepared {
	const instance = nonempty(value.instance);
	const id = nonempty(value.id);
	const recoveryId = nonempty(value.recoveryId);
	if (recoveryId !== JSON.stringify([instance, id])) throw new Error("The manual archive identities disagree.");
	const entry = object(value.entry);
	const envelope = object(entry.envelope);
	if (entry.id !== id || typeof entry.text !== "string" || !["user", "custom"].includes(String(envelope.role))) {
		throw new Error("The original manual instruction is damaged; it was not replaced.");
	}
	if (
		entry.images !== undefined &&
		(!Array.isArray(entry.images) ||
			entry.images.some(image => {
				const part = object(image);
				return part.type !== "image" || typeof part.data !== "string" || typeof part.mimeType !== "string";
			}))
	)
		throw new Error("The archived instruction's original images are damaged.");
	// Archived envelopes are data for explicit editor recovery, never message/agent authority.
	return {
		recoveryId,
		instance,
		id,
		intent: manualIntent(value.intent),
		entry: entry as unknown as OriginalInstruction,
	};
}

/** Durable explicit editor handoff in the stock journal. It never queues, resumes or sends a message. */
export class ManualInstructionArchive {
	readonly #journal: Journal;
	readonly #assertCurrent: () => void;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(journal: Journal, assertCurrent: () => void) {
		this.#journal = journal;
		this.#assertCurrent = assertCurrent;
	}

	async #flush(): Promise<void> {
		if (!this.#journal.getSessionFile())
			throw new Error("Manual recovery requires the original saved session journal.");
		// flush alone is a no-op for a lazy, never-materialized session. Stock owns initial creation and all retries.
		await this.#journal.ensureOnDisk();
		await this.#journal.flush();
	}

	#read(): Map<string, Archived> {
		const records = new Map<string, Archived>();
		for (const event of this.#journal.getBranch()) {
			if (event.type !== "custom" || event.customType !== MANUAL_INSTRUCTION_ENTRY) continue;
			const data = object(event.data);
			const recoveryId = nonempty(data.recoveryId);
			if (data.state === "prepared") {
				if (records.has(recoveryId)) throw new Error("A manual recovery identity was prepared twice.");
				records.set(recoveryId, { ...prepared(data), state: "unconfirmed" });
				continue;
			}
			const record = records.get(recoveryId);
			if (!record) throw new Error("A manual archive completion has no original payload.");
			if (data.state === "withdrawn" || data.state === "not_withdrawn") {
				if (record.state !== "unconfirmed") throw new Error("The manual withdrawal was completed twice.");
				record.state = data.state;
			} else if (data.state === "acknowledged") {
				const accepted = disposition(data.disposition);
				if (accepted.kind !== record.intent) throw new Error("The manual disposition changes its original intent.");
				if (record.disposition && !sameDisposition(record.disposition, accepted))
					throw new Error("The manual recovery has conflicting dispositions.");
				if (accepted.kind === "discard" && record.state !== "withdrawn")
					throw new Error("An unconfirmed instruction cannot be discarded.");
				record.disposition = accepted;
			} else {
				throw new Error("The manual archive contains an unknown state; its original data was retained.");
			}
		}
		return records;
	}

	#serial<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation);
		this.#tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	withdraw(view: InstructionQueueView, instance: string, id: string, value: unknown): Promise<WithdrawnInstruction> {
		return this.#serial(async () => {
			this.#assertCurrent();
			const intent = manualIntent(value);
			const original = view.capture(instance, id);
			const recoveryId = JSON.stringify([instance, id]);
			const known = this.#read().get(recoveryId);
			if (known) {
				if (known.intent !== intent)
					throw new Error("This original instruction already has a different manual intent.");
				await this.#flush();
				this.#assertCurrent();
				if (known.state === "withdrawn") return { removed: true, recoveryId, intent, entry: known.entry };
				if (known.state === "not_withdrawn") return { removed: false };
				throw new Error(
					`Manual withdrawal is unconfirmed. Recover the original payload with ${recoveryId}; do not resend automatically.`,
				);
			}
			if (!original) return { removed: false };
			const archived = structuredClone(original);
			this.#journal.appendCustomEntry(MANUAL_INSTRUCTION_ENTRY, {
				state: "prepared",
				recoveryId,
				instance,
				id,
				intent,
				entry: archived,
			});
			await this.#flush();
			this.#assertCurrent();
			const removed = view.withdrawOriginal(instance, id, original.envelope);
			this.#journal.appendCustomEntry(MANUAL_INSTRUCTION_ENTRY, {
				state: removed ? "withdrawn" : "not_withdrawn",
				recoveryId,
			});
			await this.#flush();
			this.#assertCurrent();
			return removed ? { removed: true, recoveryId, intent, entry: archived } : { removed: false };
		});
	}

	recover(): Promise<{ entries: ManualRecovery[] }> {
		return this.#serial(async () => {
			this.#assertCurrent();
			await this.#flush();
			this.#assertCurrent();
			return {
				entries: [...this.#read().values()].flatMap(record =>
					record.disposition || record.state === "not_withdrawn" ? [] : [{ ...record, state: record.state }],
				),
			};
		});
	}

	acknowledge(
		recoveryId: string,
		value: unknown,
	): Promise<{ acknowledged: true; recoveryId: string; disposition: ManualDisposition }> {
		return this.#serial(async () => {
			this.#assertCurrent();
			const record = this.#read().get(nonempty(recoveryId));
			if (!record || record.state === "not_withdrawn")
				throw new Error("No manual recovery owns this original instruction.");
			const accepted = disposition(value);
			if (accepted.kind !== record.intent) throw new Error("The manual disposition changes its original intent.");
			if (accepted.kind === "discard" && record.state !== "withdrawn")
				throw new Error("An unconfirmed instruction cannot be discarded.");
			if (record.disposition && !sameDisposition(record.disposition, accepted))
				throw new Error("A different disposition already owns this recovery.");
			if (!record.disposition)
				this.#journal.appendCustomEntry(MANUAL_INSTRUCTION_ENTRY, {
					state: "acknowledged",
					recoveryId,
					disposition: accepted,
				});
			await this.#flush();
			this.#assertCurrent();
			return { acknowledged: true, recoveryId, disposition: accepted };
		});
	}
}
