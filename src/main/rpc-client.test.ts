import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "./rpc-client";

describe("current instruction admission", () => {
	it.each([
		{ type: "follow_up", message: "later" },
		{ type: "set_steering_mode", mode: "one-at-a-time" },
		{ type: "set_follow_up_mode", mode: "all" },
		{ type: "set_interrupt_mode", mode: "wait" },
		{ type: "prompt", message: "later", streamingBehavior: "followUp" },
		{ type: "prompt", message: "now", streamingBehavior: "steer" },
		{ type: "set_setting", path: "steeringMode", value: "one-at-a-time" },
		{ type: "set_setting", path: "followUpMode", value: "all" },
		{ type: "set_setting", path: "interruptMode", value: "wait" },
		{ type: "get_settings", paths: ["steeringMode"] },
		{ type: "get_settings", paths: ["followUpMode"] },
		{ type: "get_settings", paths: ["advisor.enabled", "interruptMode"] },
	])("rejects obsolete mode payload $type before local or stock dispatch", async command => {
		const send = vi.fn();
		const local = vi.fn();
		const client = new RpcClient({ send, local });
		await expect(Reflect.apply(client.command, client, [command])).rejects.toThrow("Delivery modes");
		expect(local).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});

	it("hands one current instruction and its pictures to the canonical handler", async () => {
		const response = {
			type: "response" as const,
			command: "prompt",
			success: true as const,
			data: { accepted: true },
		};
		const send = vi.fn();
		const local = vi.fn(async () => response);
		const client = new RpcClient({ send, local });
		const images = [{ type: "image" as const, data: "AAAA", mimeType: "image/png" }];
		await expect(
			client.command({ type: "prompt", message: "apply now", images, deliveryId: "original-id" }),
		).resolves.toBe(response);
		expect(local).toHaveBeenCalledWith({
			type: "prompt",
			message: "apply now",
			images,
			deliveryId: "original-id",
			id: "gui-1",
		});
		expect(send).not.toHaveBeenCalled();
	});
});
