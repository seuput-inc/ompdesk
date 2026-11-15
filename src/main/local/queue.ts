import type { ImageContent, RpcGetQueueResult } from "../../shared/rpc-types";
import type { LocalHandler } from "./types";

/** Opaque original-object handles belong to the live bridge, never to chip text. */
export const handlers: Record<string, LocalHandler> = {
	get_queue: async (_command, ctx): Promise<RpcGetQueueResult> => ctx.bridge.request("composer.get_queue", {}),

	queue_remove: async (command, ctx) => {
		if (typeof command.instance !== "string" || !command.instance)
			throw new Error("instance must be a non-empty string");
		if (typeof command.queueId !== "string" || !command.queueId)
			throw new Error("queueId must be a non-empty string");
		if (command.intent !== "draft" && command.intent !== "discard") throw new Error("invalid withdrawal intent");
		return ctx.bridge.request("composer.queue_remove", {
			instance: command.instance,
			id: command.queueId,
			intent: command.intent,
		});
	},

	get_manual_recovery: async (_command, ctx) => ctx.bridge.request("composer.get_manual_recovery", {}),

	ack_manual_recovery: async (command, ctx) => {
		if (typeof command.recoveryId !== "string" || !command.recoveryId)
			throw new Error("recoveryId must be a non-empty string");
		const disposition = command.disposition;
		if (
			typeof disposition !== "object" ||
			disposition === null ||
			!("kind" in disposition) ||
			(disposition.kind !== "discard" &&
				(disposition.kind !== "draft" ||
					!("draftId" in disposition) ||
					typeof disposition.draftId !== "string" ||
					!disposition.draftId))
		)
			throw new Error("invalid recovery disposition");
		return ctx.bridge.request("composer.ack_manual_recovery", {
			recoveryId: command.recoveryId,
			disposition,
		});
	},

	dequeue: async (_command, ctx) => {
		const popped = await ctx.bridge.request<{ text: string; images?: ImageContent[] } | null>("composer.dequeue");
		return { messages: popped ? [popped] : [] };
	},
};
