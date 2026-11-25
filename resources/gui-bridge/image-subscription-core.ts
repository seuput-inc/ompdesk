/**
 * Image generation runs on the ChatGPT (Codex) subscription only, never on a billed API key (the owner's rule,
 * 17 Nov 2026). Stock `generate_image` without a `model` walks the whole image chain and, when one provider fails,
 * tries the next one with credentials (an OpenAI API key, OpenRouter, Gemini). Given a `model`, it uses that one model
 * and nothing else, so pinning the argument removes the fallback: a missing or failing subscription is an error.
 */
export const SUBSCRIPTION_IMAGE_MODEL = "openai-codex/gpt-image-2";

export const IMAGE_MODEL_REFUSED = `OMPdesk runs generate_image only on the ChatGPT subscription model ${SUBSCRIPTION_IMAGE_MODEL}, so no billed API key is ever used. Call it again without \`model\`. If that fails, report the failure; do not try another image model.`;

export type ImageCallVerdict = { input: Record<string, unknown> } | { block: string };

/** The arguments a `generate_image` call runs with, or why it may not run. */
export function imageCallVerdict(input: Record<string, unknown>): ImageCallVerdict {
	const model = input.model;
	if (model === undefined || model === "" || model === SUBSCRIPTION_IMAGE_MODEL)
		return { input: { ...input, model: SUBSCRIPTION_IMAGE_MODEL } };
	return { block: IMAGE_MODEL_REFUSED };
}
