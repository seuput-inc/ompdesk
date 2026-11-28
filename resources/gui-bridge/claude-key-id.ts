export function isClaudeKeyProvider(id: string): boolean {
	return /^anthropic-api-key(?:-\d+)?$/.test(id);
}
