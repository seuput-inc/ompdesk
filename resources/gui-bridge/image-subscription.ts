/**
 * Every `generate_image` call runs on the subscription's image model (rule: image-subscription-core.ts), through the
 * public `tool_call` hook: its `input` revision is what stock validates, approves and executes, including calls
 * mounted in bash or under `xd://`. `block` refuses a call that names another model. Imports nothing from omp.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { guard } from "./health";
import { imageCallVerdict } from "./image-subscription-core";

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	pi.on("tool_call", event => {
		if (event.toolName !== "generate_image") return undefined;
		const verdict = imageCallVerdict(event.input);
		return "block" in verdict ? { block: true, reason: verdict.block } : { input: verdict.input };
	});
}

export const methods = guard("imageSubscription", {});
