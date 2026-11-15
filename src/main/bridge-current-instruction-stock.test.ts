import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { atEnd, HOLD, runCleanups, startOmp, startProvider } from "./bridge-agent-mail-stock-harness";
import { INSTALLED_OMP } from "./test-bridge-probe";

afterAll(runCleanups);

describe.skipIf(!existsSync(INSTALLED_OMP))("current-instruction admission on installed stock", () => {
	it("keeps idle RPC admission and never mutates original pending messages during busy preflight", async () => {
		const provider = await startProvider();
		atEnd(() => provider.close());
		const session = await startOmp(provider);
		expect(await session.bridge.request("composer.prepare_prompt", {})).toEqual({});
		const first = await session.send({ type: "prompt", message: HOLD });
		expect(first.success).toBe(true);
		await provider.held;

		// Create historical stock input directly, not through the product's retired public mode selector.
		for (let n = 0; n < 2; n++) {
			const admitted = await session.send({
				type: "prompt",
				message: "same original text",
				streamingBehavior: "followUp",
			});
			expect(admitted.success).toBe(true);
		}
		const before = await session.bridge.request<{ instance: string; entries: { id: string; text: string }[] }>(
			"composer.get_queue",
			{},
		);
		expect(before.entries.map(entry => entry.text)).toEqual(["same original text", "same original text"]);
		expect(before.entries[0].id).not.toBe(before.entries[1].id);
		const capabilities = await session.bridge.request<{ unavailable: { feature: string; missing: string[] }[] }>(
			"capabilities",
			{},
		);
		const unavailable = capabilities.unavailable.find(feature => feature.feature === "currentInstruction");
		if (unavailable) {
			await expect(session.bridge.request("composer.prepare_prompt", {})).rejects.toMatchObject({
				code: "unsupported_omp",
			});
		} else {
			expect(await session.bridge.request("composer.prepare_prompt", {})).toEqual({});
		}
		expect(await session.bridge.request("composer.get_queue", {})).toEqual(before);
		expect(provider.bodies).toHaveLength(1);
		provider.release();
		await session.stop();
	}, 90_000);
});
