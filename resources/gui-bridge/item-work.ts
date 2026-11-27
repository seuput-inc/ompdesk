import { createHash, randomUUID } from "node:crypto";
import type { JournalEntry } from "./prompt-sections";

export const ITEM_WORK = "OMP_GUI_ITEM_WORK";
export const WORKER_ENTRY = "ompdesk.worker";
export const ITEM_WORK_REFUSAL =
	"This managed worker has no current lease. Reconnect to its item owner before starting another tool.";

interface Link {
	write(frame: string): unknown;
}

export function managedWorkerEntry(entry: JournalEntry): boolean {
	const data = entry.data;
	return entry.customType === WORKER_ENTRY && typeof data === "object" && data !== null && "managed" in data && data.managed === true;
}

/** Per tool, not per turn: a delayed answer cannot start a tool on a renewed or replacement connection. */
export class ItemToolFence {
	readonly #assignment?: { item: string; generation: number; core: string };
	#link?: Link;
	readonly #waiting = new Map<string, (validMs: number) => void>();

	constructor(descriptor: string) {
		try {
			const value = JSON.parse(descriptor);
			if (typeof value?.item === "string" && Number.isSafeInteger(value.generation) && typeof value.core === "string")
				this.#assignment = value;
		} catch {
			// An unreadable managed launch stays fenced.
		}
	}

	attach(link: Link, proof: unknown): boolean {
		if (typeof proof !== "string" || createHash("sha256").update(proof).digest("hex") !== this.#assignment?.core)
			return false;
		if (this.#link) this.disconnect(this.#link);
		this.#link = link;
		return true;
	}

	disconnect(link: Link): void {
		if (link !== this.#link) return;
		this.#link = undefined;
		for (const finish of this.#waiting.values()) finish(0);
	}

	answer(link: Link, params: unknown): boolean {
		if (link !== this.#link || typeof params !== "object" || params === null || !("request" in params) || typeof params.request !== "string")
			return false;
		const finish = this.#waiting.get(params.request);
		if (!finish) return false;
		finish("validMs" in params && typeof params.validMs === "number" ? params.validMs : 0);
		return true;
	}

	async check(session: string | undefined | null): Promise<boolean> {
		const link = this.#link;
		if (!link || !session || !this.#assignment) return false;
		const { item, generation } = this.#assignment;
		const request = randomUUID();
		const started = performance.now();
		const { promise, resolve } = Promise.withResolvers<number>();
		const timer = setTimeout(() => finish(0), 1500);
		const finish = (ms: number) => {
			clearTimeout(timer);
			this.#waiting.delete(request);
			resolve(ms);
		};
		this.#waiting.set(request, finish);
		try {
			link.write(`${JSON.stringify({ event: { type: "item_work_check", item, generation, session, request } })}\n`);
		} catch {
			finish(0);
		}
		const validMs = await promise;
		return this.#link === link && performance.now() - started < Math.min(1500, validMs - 250);
	}
}

type Refusal = { block: true; reason: string } | undefined;
interface ToolFenceHost {
	on(event: "session_start" | "session_switch", handler: () => void): void;
	on(event: "tool_call", handler: (event: unknown, ctx: {
		sessionManager: { getSessionFile(): string | undefined | null; getEntries(): readonly JournalEntry[] };
	}) => Refusal | Promise<Refusal>): void;
}

export function installItemToolFence(pi: ToolFenceHost, fence: ItemToolFence | undefined): void {
	if (fence) {
		pi.on("tool_call", async (_event, ctx) =>
			(await fence.check(ctx.sessionManager.getSessionFile())) ? undefined : { block: true, reason: ITEM_WORK_REFUSAL },
		);
		return;
	}
	// A saved worker can outlive its board. An ordinary session never asks for an item lease.
	let orphan: boolean | undefined;
	const reset = () => {
		orphan = undefined;
	};
	pi.on("session_start", reset);
	pi.on("session_switch", reset);
	pi.on("tool_call", (_event, ctx) => {
		orphan ??= ctx.sessionManager.getEntries().some(entry => entry.type === "custom" && managedWorkerEntry(entry));
		return orphan ? { block: true, reason: ITEM_WORK_REFUSAL } : undefined;
	});
}
