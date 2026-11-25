import { describe, expect, it, vi } from "vitest";
import { handlers } from "./extensions";
import type { LocalCommandContext } from "./types";

function context() {
	const request = vi.fn(async (_method: string, _params?: unknown): Promise<unknown> => ({ ok: true }));
	const ctx: LocalCommandContext = {
		cwd: "/tmp",
		omp: { bin: "omp", version: "18.8.7", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
		send: async <T>() => undefined as T,
		bridge: {
			request: async <T>(method: string, params?: unknown): Promise<T> => {
				// The controlled fixture above supplies the requested bridge method's shape.
				const reply = await request(method, params);
				return reply as T;
			},
			connected: true,
		},
	};
	return { ctx, request };
}

describe("MCP server actions", () => {
	it("passes a user's server name to stock without an OMPdesk lookup", async () => {
		const { ctx, request } = context();
		await expect(handlers.mcp_action({ type: "mcp_action", name: "rea", action: "disable" }, ctx)).resolves.toEqual({
			ok: true,
		});
		expect(request).toHaveBeenCalledTimes(1);
		expect(request).toHaveBeenLastCalledWith("mcp_action", { name: "rea", action: "disable" });
	});
});
