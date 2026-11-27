/** Only for presentation: stock selection still needs the numbered provider ID. */
export function modelProviderGroup(provider: string): string {
	return provider.replace(/^(anthropic-api-key)-\d+$/, "$1");
}
