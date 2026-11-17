import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { IMAGE_MODEL_REFUSED, SUBSCRIPTION_IMAGE_MODEL } from "../../resources/gui-bridge/image-subscription-core";
import { fakeAgent, onCleanup, sse, startOmp, startProvider, toolCall } from "./bridge-todo-stock-rig";
import { INSTALLED_OMP as omp } from "./test-bridge-probe";

/**
 * Image generation stays on the subscription (image-subscription.ts) on the installed omp, no spend: the agent has an
 * image model reachable with an API key (`paid/img`, the billed path) and no ChatGPT login. Stock alone would generate
 * on `paid/img`; with the bridge, a call without `model` runs on the subscription model only and fails, and a call
 * naming `paid/img` is refused. Either way the paid endpoint never hears a request.
 */

/** An image endpoint that counts what reaches it and fails every request. */
async function startPaidImages(): Promise<{ url: string; hits: string[] }> {
	const hits: string[] = [];
	const server = http.createServer((req, res) => {
		hits.push(req.url ?? "");
		req.resume();
		res.writeHead(500, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: "paid endpoint reached" } }));
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	onCleanup(() => {
		server.closeAllConnections();
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		return closed.promise;
	});
	return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, hits };
}

/** The image call as the session offers it: the tool itself, or its `xd://` device when stock mounts it there. */
function imageCall(firstRequest: string, args: Record<string, unknown>): unknown[] {
	const tools = (JSON.parse(firstRequest) as { tools?: Array<{ function?: { name?: string } }> }).tools ?? [];
	return tools.some(tool => tool.function?.name === "generate_image")
		? toolCall("generate_image", args)
		: toolCall("write", { path: "xd://generate_image", content: JSON.stringify(args) });
}

async function run(args: Record<string, unknown>): Promise<{ next: string; paidHits: string[] }> {
	const paid = await startPaidImages();
	const provider = await startProvider(step =>
		step === 1 ? sse(imageCall(provider.bodies[0], args), "tool_calls") : sse([{ content: "DONE" }], "stop"),
	);
	const agent = fakeAgent(provider.url);
	appendFileSync(
		join(agent.agentDir, "models.yml"),
		`  paid:\n    baseUrl: ${paid.url}\n    apiKey: y\n    api: openai-completions\n    models:\n      - id: img\n        name: img\n        api: openai-images\n        reasoning: false\n        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }\n`,
	);
	// The image role names the paid model, as a user's config or an inherited one could: stock alone generates there.
	writeFileSync(
		join(agent.agentDir, "config.yml"),
		"generate_image:\n  enabled: true\nmodelRoles:\n  image: paid/img\n",
	);
	const session = await startOmp({ ...agent, model: "fake/m1", bridge: resolve("resources/gui-bridge/index.ts") });
	await session.turn("Draw a cat");
	return { next: provider.bodies[1] ?? "", paidHits: paid.hits };
}

describe.skipIf(!existsSync(omp))("image generation on the subscription only, on stock omp", () => {
	it("runs a call without a model on the subscription model and never falls through to a paid one", async () => {
		const { next, paidHits } = await run({ subject: "a cat" });
		expect(paidHits).toEqual([]);
		expect(next).toContain(SUBSCRIPTION_IMAGE_MODEL);
		expect(next).not.toContain("paid/img");
	}, 180_000);

	it("refuses a call that names another image model", async () => {
		const { next, paidHits } = await run({ subject: "a cat", model: "paid/img" });
		expect(paidHits).toEqual([]);
		expect(next).toContain(IMAGE_MODEL_REFUSED.slice(0, 60));
	}, 180_000);
});
