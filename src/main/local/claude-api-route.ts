import { isClaudeKeyAccount } from "../../../resources/gui-bridge/claude-key-models";
import { listModelsProviders } from "../models-config";
import type { LocalHandler } from "./types";

// Main owns every local tab. Reserve synchronously so simultaneous fresh sessions take different keys.
const assigned = new Map<string, number>();
let sequence = 0;

export const handlers: Record<string, LocalHandler> = {
	set_claude_api_auto_model: async ({ modelId }, ctx) => {
		if (typeof modelId !== "string" || !modelId.trim()) throw new Error("Missing Claude API model id");
		const providers = (await listModelsProviders()).filter(isClaudeKeyAccount).map(p => p.id);
		const { eligible, pinned, ticket } = await ctx.bridge.request<{
			eligible: string[];
			pinned?: string;
			ticket: number;
		}>("claude_api.offers", { modelId, providers }, { timeoutMs: 20_000 });
		const provider =
			pinned ??
			eligible.reduce<string | undefined>(
				(least, id) => (least === undefined || (assigned.get(id) ?? 0) < (assigned.get(least) ?? 0) ? id : least),
				undefined,
			);
		if (!provider || !eligible.includes(provider))
			throw new Error(
				pinned
					? "The pinned Claude API key does not offer this model"
					: "No verified Claude API key offers this model",
			);
		if (!pinned) assigned.set(provider, ++sequence);
		return ctx.bridge.request("claude_api.select", { ticket, provider });
	},
};
