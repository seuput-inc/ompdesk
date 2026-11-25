/**
 * Built-in prompt suggestions: the guarded bridge methods and the extension hooks. The engine
 * (./next-prompt-engine.ts) holds the behaviour; this file puts it behind the compatibility guard, so a
 * missing stock internal refuses the methods with `unsupported_omp` (capabilities.ts `nextPrompt`, and
 * `inlineCompletion` for the one method that reads stock's secret-draft rule), and names the stock modules
 * the engine calls.
 */
import { UnsupportedOmpError } from "../capabilities";
import { guard } from "../health";
import type { BridgeMethods } from "../types";
import { handlers, install, type NextPromptStock, setNextPromptStockLoader } from "./next-prompt-engine";

export { install };

setNextPromptStockLoader(async () => {
	const [ai, roles, resolver, input] = await Promise.all([
		import("../omp/pi-ai"),
		import("../omp/pi-coding-agent/config/model-roles"),
		import("../omp/pi-coding-agent/config/model-resolver"),
		// Only inline completion reads it: an omp without the module still makes suggestions.
		import("../omp/pi-coding-agent/modes/controllers/input-controller").catch(() => undefined),
	]);
	return {
		completeSimple: ai.completeSimple as unknown as NextPromptStock["completeSimple"],
		roleCandidatePool: roles.roleCandidatePool as unknown as NextPromptStock["roleCandidatePool"],
		resolveRoleChain: resolver.resolveRoleChain as unknown as NextPromptStock["resolveRoleChain"],
		shouldSkipHistory: draft => {
			if (!input) {
				throw new UnsupportedOmpError([
					{ feature: "inlineCompletion", missing: ["modes/controllers/input-controller"] },
				]);
			}
			return input.shouldSkipHistory(draft);
		},
	};
});

const { next_prompt_inline, ...suggestions } = handlers;

// One guard per action (capabilities.ts): a missing internal refuses only the methods that use it.
export const methods: BridgeMethods = {
	...guard("nextPrompt", suggestions),
	...guard("inlineCompletion", { next_prompt_inline }),
};
