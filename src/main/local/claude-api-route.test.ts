import { expect, it, vi } from "vitest";
import { handlers } from "./claude-api-route";
import type { LocalCommandContext } from "./types";

vi.mock("../models-config", () => ({
	listModelsProviders: async () =>
		["anthropic-api-key", "anthropic-api-key-2", "anthropic", "custom"].map(id => ({
			id,
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			hasApiKey: true,
			auth: "apiKey",
		})),
}));

it("reserves different verified keys for simultaneous new sessions and refuses to replace an unavailable pin", async () => {
	const eligible = ["anthropic-api-key", "anthropic-api-key-2"];
	const ctx = (pinned?: string): LocalCommandContext => ({
		cwd: "/fixture",
		omp: {
			bin: "fixture",
			version: "fixture",
			run: async () => {
				throw Error("no CLI");
			},
		},
		send: async () => {
			throw Error("no prompts");
		},
		bridge: {
			connected: true,
			async request<T>(method: string, params?: unknown): Promise<T> {
				if (method === "claude_api.offers") {
					expect(params).toEqual({ providers: eligible, modelId: "shared" });
					return { ticket: 1, eligible, pinned } as T;
				}
				expect(method).toBe("claude_api.select");
				if (!params || typeof params !== "object" || !("provider" in params)) throw new Error("no provider");
				return params.provider as T;
			},
		},
	});
	const command = { type: "set_claude_api_auto_model", modelId: "shared" };
	const pick = (pinned?: string) => handlers.set_claude_api_auto_model(command, ctx(pinned));
	await expect(Promise.all([pick(), pick()])).resolves.toEqual(eligible);
	await expect(pick(eligible[1])).resolves.toBe(eligible[1]);
	await expect(pick("anthropic-api-key-3")).rejects.toThrow("pinned");
});
