/** Pure parsers/projections for the GUI-side git commands (unit-tested). */
import * as path from "node:path";

/** A branch or tag name git accepts (`git check-ref-format --branch` rules, checked without spawning git). */
export function isValidRefName(name: string): boolean {
	return (
		name.length > 0 &&
		name.length <= 200 &&
		!name.startsWith("-") &&
		!name.startsWith("/") &&
		!name.endsWith("/") &&
		!name.endsWith(".") &&
		!name.endsWith(".lock") &&
		!name.includes("..") &&
		!name.includes("//") &&
		!name.includes("@{") &&
		name !== "@" &&
		!/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name) &&
		!name.split("/").some(part => part.startsWith("."))
	);
}

/** True when `child` is strictly inside `root` (both already real paths). */
export function isInside(root: string, child: string): boolean {
	const relative = path.relative(root, child);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export const WORKTREE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** Lowercase, spaces→`-`, strip everything outside [a-z0-9-], collapse runs, trim dashes. */
export function slugifyName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9-]/g, "")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Slug for a GUI worktree name, or null when the raw name has disallowed characters. */
export function worktreeSlug(raw: string): string | null {
	const slug = slugifyName(raw);
	if (/[^a-z0-9 -]/i.test(raw) || !WORKTREE_NAME_PATTERN.test(slug)) return null;
	return slug;
}

/** Minimal `{{var}}` / `{{#if var}}…{{/if}}` renderer for the bundled pr-draft prompts. */
export function renderPrompt(template: string, vars: Record<string, string>): string {
	return template
		.replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, key: string, body: string) => (vars[key] ? body : ""))
		.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}

/** First balanced `{title, body}` JSON object in model output (tolerates fences/noise around it). */
export function extractDraftJson(output: string): { title: string; body: string } | null {
	for (let start = output.indexOf("{"); start !== -1; start = output.indexOf("{", start + 1)) {
		let depth = 0;
		let inString = false;
		for (let i = start; i < output.length; i++) {
			const ch = output[i];
			if (inString) {
				if (ch === "\\") i++;
				else if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') inString = true;
			else if (ch === "{") depth++;
			else if (ch === "}" && --depth === 0) {
				try {
					const parsed: unknown = JSON.parse(output.slice(start, i + 1));
					if (
						typeof parsed === "object" &&
						parsed !== null &&
						"title" in parsed &&
						"body" in parsed &&
						typeof parsed.title === "string" &&
						typeof parsed.body === "string"
					)
						return { title: parsed.title, body: parsed.body };
				} catch {
					// Not JSON — try the next opening brace.
				}
				break;
			}
		}
	}
	return null;
}
