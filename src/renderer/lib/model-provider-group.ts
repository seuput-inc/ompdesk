import { isClaudeKeyProvider } from "../../../resources/gui-bridge/claude-key-id";

/** Only for presentation: stock selection still needs the numbered provider ID. */
export function modelProviderGroup(provider: string): string {
	return isClaudeKeyProvider(provider) ? "anthropic-api-key" : provider;
}

export function claudeApiKeyLabel(
	provider: string,
	displayName: string | undefined,
	t: (key: string, params?: Record<string, string | number>) => string,
): string {
	const label = displayName?.trim();
	return label && label !== provider
		? label
		: t("modelPicker.apiKeyNumber", { number: provider.split("-")[3] ?? "1" });
}
