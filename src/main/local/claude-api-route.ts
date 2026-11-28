import { isClaudeKeyAccount } from "../../../resources/gui-bridge/claude-key-models";
import { core } from "../core/process";
import { listModelsProviders } from "../models-config";
import type { LocalHandler } from "./types";

export const handlers: Record<string, LocalHandler> = {
	set_claude_api_auto_model: async ({ modelId }, ctx) => {
		if (typeof modelId !== "string" || !modelId.trim()) throw new Error("Missing Claude API model id");
		const providers = (await listModelsProviders()).filter(isClaudeKeyAccount).map(p => p.id);
		const { eligible, pinned, ticket } = await ctx.bridge.request<{
			eligible: string[];
			pinned?: string;
			ticket: number;
		}>("claude_api.offers", { modelId, providers }, { timeoutMs: 20_000 });
		const { result: provider } = await core().call<string>("models.claudeRoutePick", { eligible, pinned });
		return ctx.bridge.request("claude_api.select", { ticket, provider });
	},
};
